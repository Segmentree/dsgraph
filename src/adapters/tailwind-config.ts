/**
 * Classic Tailwind (`tailwind.config.{js,cjs,mjs,ts}`) token adapter (DESIGN.md §4a).
 *
 * Where the v4 adapter reads CSS, this reads the resolved JS theme:
 * `resolveConfig(userConfig).theme` is walked section by section (colors, spacing,
 * fontSize, …), each leaf → a Token + canonicalized RawValue + has-value edge, with
 * the section recorded for the class→token resolver. The target dashboard is v4 and
 * won't fire this; it exists for generality on classic-config projects.
 *
 * Two layers, split for testability:
 *   - `walkTheme(theme)` — PURE: a resolved theme object → graph fragment (tested).
 *   - `loadResolvedTheme(root, cfg)` — IO: lazily resolves `tailwindcss/resolveConfig`
 *     from the *target's* node_modules and requires the user config.
 */

import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
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
import { canonicalize, categoryToValueType } from "../canonicalize/index.js";
import type { Adapter, AdapterContext } from "./registry.js";

const ADAPTER_NAME = "tailwind-config";

/** Config filenames Tailwind looks for, in precedence order. */
const CONFIG_NAMES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
] as const;

const RESOLVE_CONFIG_MODULE = "tailwindcss/resolveConfig";
const DEFAULT_KEY = "DEFAULT";
const NAME_SEP = "-";
const FONT_STACK_SEP = ", ";
/** Configs we can load via `require` (the rest go through dynamic import). */
const CJS_CONFIG_RE = /\.(c?js)$/;

/** Theme section → token category. Sections not listed are ignored. */
const SECTION_CATEGORY: Record<string, TokenCategory> = {
  colors: TokenCategory.color,
  spacing: TokenCategory.spacing,
  fontSize: TokenCategory.fontSize,
  fontFamily: TokenCategory.fontFamily,
  fontWeight: TokenCategory.fontWeight,
  lineHeight: TokenCategory.lineHeight,
  borderRadius: TokenCategory.radius,
  boxShadow: TokenCategory.shadow,
  zIndex: TokenCategory.z,
};

// ── Detection ─────────────────────────────────────────────────────────────────

/** Absolute path of the Tailwind config at the root, or null. */
async function findConfig(root: string): Promise<string | null> {
  let names: Set<string>;
  try {
    names = new Set((await readdir(root)).filter((n) => n.length > 0));
  } catch {
    return null;
  }
  for (const candidate of CONFIG_NAMES) {
    if (names.has(candidate)) return join(root, candidate);
  }
  return null;
}

// ── Theme loading (IO) ──────────────────────────────────────────────────────────

type Theme = Record<string, unknown>;
type ResolveConfigFn = (config: unknown) => { theme?: Theme };

/** Lazily resolve `tailwindcss/resolveConfig` from the target, then resolve the user config. */
export async function loadResolvedTheme(
  root: string,
  configPath: string,
): Promise<Theme | null> {
  const requireFromTarget = createRequire(pathToFileURL(join(resolve(root), "_dsgraph.js")));

  let resolveConfig: ResolveConfigFn;
  try {
    const mod = requireFromTarget(RESOLVE_CONFIG_MODULE) as ResolveConfigFn | { default: ResolveConfigFn };
    resolveConfig = (typeof mod === "function" ? mod : mod.default) as ResolveConfigFn;
  } catch {
    return null; // target has no tailwindcss installed
  }

  const userConfig = await importConfig(configPath, requireFromTarget);
  if (userConfig === null) return null;

  try {
    return resolveConfig(userConfig).theme ?? null;
  } catch {
    return null;
  }
}

async function importConfig(
  configPath: string,
  requireFromTarget: NodeJS.Require,
): Promise<unknown> {
  // CJS/JS: require (the config's own requires resolve from its own dir).
  if (CJS_CONFIG_RE.test(configPath)) {
    try {
      const m = requireFromTarget(configPath) as { default?: unknown };
      return m?.default ?? m;
    } catch {
      /* fall through to dynamic import */
    }
  }
  try {
    const m = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
    return m?.default ?? m;
  } catch {
    return null; // .ts configs need a loader we don't assume here
  }
}

// ── Theme walking (pure) ────────────────────────────────────────────────────────

interface Leaf {
  name: string;
  value: unknown;
}

/** Flatten a nested theme section into dotted-then-dashed leaves; `DEFAULT` collapses. */
function flattenSection(section: Theme): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (obj: Theme, prefix: string[]): void => {
    for (const [key, value] of Object.entries(obj)) {
      const path = key === DEFAULT_KEY ? prefix : [...prefix, key];
      if (isPlainObject(value)) {
        walk(value as Theme, path);
      } else {
        leaves.push({ name: path.join(NAME_SEP) || key, value });
      }
    }
  };
  walk(section, []);
  return leaves;
}

function isPlainObject(v: unknown): v is Theme {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reduce a Tailwind leaf value (string, fontSize tuple, font array) to a single string. */
function leafToValue(value: unknown, category: TokenCategory): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (category === TokenCategory.fontFamily) return value.join(FONT_STACK_SEP);
    // fontSize tuple: [size, { lineHeight, ... }] — take the size.
    return typeof value[0] === "string" ? value[0] : null;
  }
  return null; // functions (opacity-aware colors), null, etc.
}

/** Walk a resolved theme into a graph fragment. Pure — no IO. */
export function walkTheme(theme: Theme, sourceFile = ""): GraphFragment {
  const nodes = new Map<string, TokenNode>();
  const rawValues: GraphFragment["nodes"] = [];
  const edges: GraphEdge[] = [];

  for (const [section, category] of Object.entries(SECTION_CATEGORY)) {
    const sectionValue = theme[section];
    if (!isPlainObject(sectionValue)) continue;

    for (const leaf of flattenSection(sectionValue)) {
      const raw = leafToValue(leaf.value, category);
      if (raw === null) continue; // not a representable value (function, null) → no token

      const tokenId = `token:${category}:${leaf.name}`;
      const token: TokenNode = {
        id: tokenId,
        type: NodeType.Token,
        label: leaf.name,
        props: { category, tier: TokenTier.primitive, tailwind: { section, utility: leaf.name } },
        sources: [{ adapter: ADAPTER_NAME, file: sourceFile, loc: `theme.${section}.${leaf.name}` }],
        confidence: Confidence.EXTRACTED,
      };

      const rv = canonicalize(raw, categoryToValueType(category), { scope: category });
      if (rv) {
        rawValues.push(rv);
        edges.push({
          source: tokenId,
          target: rv.id,
          relation: EdgeRelation.hasValue,
          confidence: Confidence.EXTRACTED,
        });
      } else {
        token.props = { ...token.props, unresolvedValue: raw };
      }
      nodes.set(tokenId, token);
    }
  }

  return { nodes: [...nodes.values(), ...rawValues], edges };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const tailwindConfigAdapter: Adapter = {
  name: ADAPTER_NAME,
  async detect(ctx: AdapterContext) {
    return (await findConfig(ctx.root)) !== null;
  },
  async extract(ctx: AdapterContext): Promise<GraphFragment> {
    const configPath = await findConfig(ctx.root);
    if (!configPath) return { nodes: [], edges: [] };
    const theme = await loadResolvedTheme(ctx.root, configPath);
    if (!theme) return { nodes: [], edges: [] };
    return walkTheme(theme, relative(resolve(ctx.root), configPath));
  },
};

export { findConfig };
