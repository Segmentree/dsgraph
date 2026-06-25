/**
 * Tailwind v4 / CSS-first token adapter (DESIGN.md §4a).
 *
 * Tokens live in CSS, not a `tailwind.config.js`. We parse three blocks:
 *   - `:root { --primary: oklch(…) }`    → primitive values, **light** mode
 *   - `.dark { --primary: oklch(…) }`    → **dark** mode overrides (same token)
 *   - `@theme inline { --color-primary: var(--primary); --text-sm: 13.75px }`
 *                                        → semantic tokens + the Tailwind utility names
 *
 * A `@theme` entry of the form `--<namespace>-<rest>: var(--raw)` is shadcn's pattern
 * for *exposing* a primitive var as a utility (`bg-primary`). We collapse the two CSS
 * spellings into one logical token (the semantic one), carrying the primitive's
 * per-mode values and recording the utility for the future class→token resolver. A
 * `@theme` entry with a literal value (`--text-sm: 13.75px`, `--radius-md: calc(…)`)
 * is its own token; `var()`/`calc()` are folded via css-resolve before canonicalizing.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import postcss from "postcss";
import {
  NodeType,
  EdgeRelation,
  Confidence,
  TokenTier,
  TokenCategory,
  type GraphEdge,
  type GraphFragment,
  type TokenNode,
} from "../schema.js";
import { canonicalize, categoryToValueType, isColorSyntax } from "../canonicalize/index.js";
import { TwNamespace } from "../tailwind.js";
import { resolveValue, type VarTable } from "./css-resolve.js";
import type { Adapter, AdapterContext } from "./registry.js";

const ADAPTER_NAME = "tailwind-v4";

const SELECTOR = { root: ":root", dark: ".dark" } as const;
const THEME_AT_RULE = "theme";
const VAR_PREFIX = "--";

/** Per-mode value of a CSS custom property. */
const Mode = { light: "light", dark: "dark" } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

/** Tailwind v4 theme namespaces → our token category (longest prefix wins). */
const NAMESPACE_CATEGORY: Array<[string, TokenCategory]> = [
  [TwNamespace.color, TokenCategory.color],
  [TwNamespace.text, TokenCategory.fontSize],
  [TwNamespace.fontWeight, TokenCategory.fontWeight],
  [TwNamespace.font, TokenCategory.fontFamily],
  [TwNamespace.leading, TokenCategory.lineHeight],
  [TwNamespace.tracking, TokenCategory.letterSpacing],
  [TwNamespace.spacing, TokenCategory.spacing],
  [TwNamespace.radius, TokenCategory.radius],
  [TwNamespace.insetShadow, TokenCategory.shadow],
  [TwNamespace.dropShadow, TokenCategory.shadow],
  [TwNamespace.shadow, TokenCategory.shadow],
  [TwNamespace.blur, TokenCategory.blur],
  [TwNamespace.aspect, TokenCategory.aspectRatio],
  [TwNamespace.ease, TokenCategory.easing],
  [TwNamespace.zIndex, TokenCategory.z],
];

/** Directories never worth scanning for token CSS. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "dsgraph-out", ".turbo"]);
const CSS_EXT = ".css";
const THEME_SIGNAL = /@theme\b/;
const ROOT_VAR_SIGNAL = /:root[^{]*\{[^}]*--/s;
const VAR_ALIAS_RE = /^var\(\s*--([\w-]+)\s*\)$/;
const COMPONENTS_JSON = "components.json";

/** Name-hint patterns to categorize a primitive var whose value type isn't obvious. */
const NAME_HINT: Array<[RegExp, TokenCategory]> = [
  [/radius/, TokenCategory.radius],
  [/shadow/, TokenCategory.shadow],
  [/font|family/, TokenCategory.fontFamily],
  [/text|size|leading/, TokenCategory.fontSize],
];
/** Leading path separator stripped when making a path repo-relative. */
const LEADING_PATH_SEP_RE = /^[/\\]/;

// ── Detection ─────────────────────────────────────────────────────────────────

/** Find token CSS: prefer the path in shadcn `components.json`, else scan for `@theme`. */
async function findTokenCss(root: string): Promise<string[]> {
  const fromConfig = await tokenCssFromComponentsJson(root);
  if (fromConfig.length) return fromConfig;
  return scanForTokenCss(root);
}

async function tokenCssFromComponentsJson(root: string): Promise<string[]> {
  try {
    const raw = await readFile(join(root, COMPONENTS_JSON), "utf8");
    const cfg = JSON.parse(raw) as { tailwind?: { css?: string } };
    const css = cfg.tailwind?.css;
    if (!css) return [];
    const path = resolve(root, css);
    await readFile(path, "utf8"); // existence check
    return [path];
  } catch {
    return [];
  }
}

async function scanForTokenCss(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(CSS_EXT)) {
        const path = join(dir, e.name);
        const content = await readFile(path, "utf8");
        if (THEME_SIGNAL.test(content) || ROOT_VAR_SIGNAL.test(content)) found.push(path);
      }
    }
  }
  await walk(root);
  return found;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

interface RawVar {
  name: string;
  light?: string;
  dark?: string;
  file: string;
}
interface ThemeEntry {
  name: string; // var name without `--`, e.g. `color-primary`
  value: string;
  file: string;
}

interface ParsedCss {
  rawVars: Map<string, RawVar>;
  theme: ThemeEntry[];
}

async function parseFiles(files: string[], root: string): Promise<ParsedCss> {
  const rawVars = new Map<string, RawVar>();
  const theme: ThemeEntry[] = [];

  for (const file of files) {
    const rel = relativeTo(root, file);
    const css = await readFile(file, "utf8");
    const ast = postcss.parse(css);

    ast.walkRules((rule) => {
      const mode = selectorMode(rule.selector);
      if (!mode) return;
      rule.walkDecls((decl) => {
        if (!decl.prop.startsWith(VAR_PREFIX)) return;
        const name = decl.prop.slice(VAR_PREFIX.length);
        const rv = rawVars.get(name) ?? { name, file: rel };
        rv[mode] = decl.value.trim();
        rawVars.set(name, rv);
      });
    });

    ast.walkAtRules(THEME_AT_RULE, (at) => {
      at.walkDecls((decl) => {
        if (!decl.prop.startsWith(VAR_PREFIX)) return;
        theme.push({ name: decl.prop.slice(VAR_PREFIX.length), value: decl.value.trim(), file: rel });
      });
    });
  }

  return { rawVars, theme };
}

/** `:root` → light, `.dark` (or any compound selector containing it) → dark. */
function selectorMode(selector: string): Mode | null {
  const parts = selector.split(",").map((s) => s.trim());
  if (parts.includes(SELECTOR.root)) return Mode.light;
  if (parts.some((p) => p === SELECTOR.dark || p.includes(SELECTOR.dark))) return Mode.dark;
  return null;
}

const NAMESPACE_SEP = "-";

/**
 * Split a `@theme` var name into namespace + rest. A known namespace yields its
 * mapped category; an UNKNOWN namespace returns `category: undefined` (the caller
 * detects it from the value) — we never drop a token just because its namespace
 * isn't in the map.
 */
function splitNamespace(name: string): {
  namespace: string;
  category: TokenCategory | undefined;
  rest: string;
} {
  for (const [ns, category] of NAMESPACE_CATEGORY) {
    if (name === ns) return { namespace: ns, category, rest: ns };
    if (name.startsWith(ns + NAMESPACE_SEP)) {
      return { namespace: ns, category, rest: name.slice(ns.length + 1) };
    }
  }
  // Unknown namespace: best-effort prefix; category is decided from the value.
  const dash = name.indexOf(NAMESPACE_SEP);
  return dash === -1
    ? { namespace: name, category: undefined, rest: name }
    : { namespace: name.slice(0, dash), category: undefined, rest: name.slice(dash + 1) };
}

// ── Extraction ────────────────────────────────────────────────────────────────

async function extract(ctx: AdapterContext): Promise<GraphFragment> {
  const files = await findTokenCss(ctx.root);
  const { rawVars, theme } = await parseFiles(files, ctx.root);

  // Resolution table: every declared var (raw + theme), preferring light values.
  const table: VarTable = new Map();
  for (const rv of rawVars.values()) {
    const v = rv.light ?? rv.dark;
    if (v !== undefined) table.set(rv.name, v);
  }
  for (const t of theme) table.set(t.name, t.value);

  const nodes = new Map<string, TokenNode>();
  const rawValueNodes: GraphFragment["nodes"] = [];
  const edges: GraphEdge[] = [];
  const consumedRawVars = new Set<string>();

  const addValue = (
    token: TokenNode,
    category: TokenCategory,
    rawValue: string,
    mode: Mode | null,
  ) => {
    const resolved = resolveValue(rawValue, table);
    const valueType = categoryToValueType(category);
    const rv = resolved === null ? null : canonicalize(resolved, valueType, { scope: category });
    if (!rv) {
      token.props = { ...token.props, unresolvedValue: rawValue };
      return;
    }
    rawValueNodes.push(rv);
    edges.push({
      source: token.id,
      target: rv.id,
      relation: EdgeRelation.hasValue,
      ...(mode ? { props: { mode } } : {}),
      confidence: Confidence.EXTRACTED,
    });
  };

  // 1. Semantic tokens from @theme entries (these define the Tailwind utilities).
  for (const entry of theme) {
    const ns = splitNamespace(entry.name);
    // Known namespace → its declared category. Unknown namespace → infer conservatively
    // from the value (null if ambiguous → `other`, left unresolved), flagged so the
    // inferred categorization is never presented as declared fact.
    const inferred = ns.category === undefined;
    const category = ns.category ?? inferCategory(resolveValue(entry.value, table) ?? entry.value, entry.name) ?? TokenCategory.other;
    const tokenId = `token:${category}:${ns.rest}`;
    const token: TokenNode = {
      id: tokenId,
      type: NodeType.Token,
      label: ns.rest,
      props: {
        category,
        tier: TokenTier.semantic,
        tailwind: { namespace: ns.namespace, utility: ns.rest },
        ...(inferred ? { uncategorizedNamespace: ns.namespace, categoryInferred: true } : {}),
      },
      sources: [{ adapter: ADAPTER_NAME, file: entry.file, loc: `--${entry.name}` }],
      confidence: inferred ? Confidence.INFERRED : Confidence.EXTRACTED,
    };

    const aliasOf = VAR_ALIAS_RE.exec(entry.value)?.[1];
    const backing = aliasOf ? rawVars.get(aliasOf) : undefined;
    if (backing) {
      // Collapse the exposed primitive var into this semantic token.
      consumedRawVars.add(backing.name);
      if (backing.light !== undefined) addValue(token, category, backing.light, Mode.light);
      if (backing.dark !== undefined) addValue(token, category, backing.dark, Mode.dark);
    } else {
      // Literal theme value (calc/number/px) — mode-agnostic.
      addValue(token, category, entry.value, null);
    }
    nodes.set(tokenId, token);
  }

  // 2. Primitive tokens from raw vars not exposed via @theme.
  for (const rv of rawVars.values()) {
    if (consumedRawVars.has(rv.name)) continue;
    const category = detectCategory(rv, table);
    const tokenId = `token:${category}:${rv.name}`;
    const token: TokenNode = {
      id: tokenId,
      type: NodeType.Token,
      label: rv.name,
      props: { category, tier: TokenTier.primitive },
      sources: [{ adapter: ADAPTER_NAME, file: rv.file, loc: `--${rv.name}` }],
      confidence: Confidence.EXTRACTED,
    };
    if (rv.light !== undefined) addValue(token, category, rv.light, Mode.light);
    if (rv.dark !== undefined) addValue(token, category, rv.dark, Mode.dark);
    nodes.set(tokenId, token);
  }

  return { nodes: [...nodes.values(), ...rawValueNodes], edges };
}

/** A number immediately followed by an explicit length / time unit (unambiguous). */
const LENGTH_UNIT_RE = /\d\s*(?:px|rem|em|%)/;
const TIME_UNIT_RE = /\d\s*(?:ms|s)(?![a-z])/;

/**
 * Category inferable from a value WITHOUT guessing. Returns null for ambiguous values
 * (a bare number could be spacing, z-index, opacity, ms, …) — we keep such tokens but
 * leave them uncategorized rather than fabricate a type. Only unambiguous color syntax,
 * an explicit unit, or a strong name hint yields a category.
 */
function inferCategory(resolved: string, name: string): TokenCategory | null {
  if (isColorSyntax(resolved)) return TokenCategory.color; // #hex / color-fn / named — unambiguous
  for (const [pattern, category] of NAME_HINT) {
    if (pattern.test(name)) return category;
  }
  if (TIME_UNIT_RE.test(resolved)) return TokenCategory.duration;
  if (LENGTH_UNIT_RE.test(resolved)) return TokenCategory.spacing;
  return null; // ambiguous — do not guess
}

function detectCategory(rv: RawVar, table: VarTable): TokenCategory {
  const resolved = resolveValue(rv.light ?? rv.dark ?? "", table) ?? rv.light ?? rv.dark ?? "";
  return inferCategory(resolved, rv.name) ?? TokenCategory.other;
}

function relativeTo(root: string, file: string): string {
  const r = resolve(root);
  const f = resolve(file);
  return f.startsWith(r) ? f.slice(r.length).replace(LEADING_PATH_SEP_RE, "") : f;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const tailwindV4Adapter: Adapter = {
  name: ADAPTER_NAME,
  async detect(ctx) {
    return (await findTokenCss(ctx.root)).length > 0;
  },
  extract,
};

export { findTokenCss };
