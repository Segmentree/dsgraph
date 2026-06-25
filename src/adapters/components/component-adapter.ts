/**
 * React/TSX component adapter (DESIGN.md §4b) — Pass 1 (definitions).
 *
 * Uses `ts-morph` (TS compiler AST) to find component definitions and the tokens they
 * bind via `className`. A component is a PascalCase top-level function/const whose body
 * returns JSX. Its `className` literals (incl. the static args of `cn(...)`) are split
 * into utilities and resolved against the class→token index → `uses-token` edges, slot
 * inferred from the utility prefix, aggregated with an instance count.
 *
 * Pass 2 (instances, composed-of, cva variant envelopes) lands in the next unit.
 */

import { readdir } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { Project, Node, type SourceFile } from "ts-morph";
import {
  NodeType,
  EdgeRelation,
  Confidence,
  type GraphEdge,
  type GraphFragment,
  type ComponentNode,
} from "../../schema.js";
import type { Adapter, AdapterContext } from "../registry.js";
import type { ResolvedClass } from "./class-resolver.js";

const ADAPTER_NAME = "react-tsx";
const COMPONENT_SIDE = "code";
const FRAMEWORK = "react";

const TSX_EXT = /\.(tsx|jsx)$/;
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo",
  "__tests__", "__mocks__", "e2e", "dsgraph-out",
]);
const COMPONENTS_JSON = "components.json";
/** Class-merge helpers whose string-literal args are class lists. */
const CLASS_FNS = new Set(["cn", "clsx", "cx", "twMerge", "twJoin"]);

// ── file discovery ────────────────────────────────────────────────────────────

/** Roots to scan: the target, plus the shadcn UI package source if it's a separate dir. */
async function scanRoots(root: string): Promise<string[]> {
  const roots = [resolve(root)];
  const uiSrc = await uiPackageSrc(root);
  if (uiSrc && !uiSrc.startsWith(resolve(root))) roots.push(uiSrc);
  return roots;
}

/** From shadcn components.json, the UI package's src dir (where its components live). */
async function uiPackageSrc(root: string): Promise<string | null> {
  try {
    const cfg = JSON.parse(await readFile(join(root, COMPONENTS_JSON), "utf8")) as {
      tailwind?: { css?: string };
    };
    if (!cfg.tailwind?.css) return null;
    // css is e.g. packages/ui/src/styles/globals.css → src dir is two up.
    return dirname(dirname(resolve(root, cfg.tailwind.css)));
  } catch {
    return null;
  }
}

async function findTsxFiles(root: string): Promise<string[]> {
  const out: string[] = [];
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
      } else if (e.isFile() && TSX_EXT.test(e.name) && !e.name.endsWith(".test.tsx")) {
        out.push(join(dir, e.name));
      }
    }
  }
  await walk(root);
  return out;
}

// ── extraction ────────────────────────────────────────────────────────────────

const JSX_KINDS = new Set(["JsxElement", "JsxSelfClosingElement", "JsxFragment"]);

/** A node "returns JSX" if its subtree contains any JSX element. */
function containsJsx(node: Node): boolean {
  return node.forEachDescendant((d, traversal) => {
    if (JSX_KINDS.has(d.getKindName())) {
      traversal.stop();
      return true;
    }
    return undefined;
  }) === true;
}

interface ComponentDef {
  name: string;
  body: Node;
}

/** Top-level PascalCase function/const definitions whose body returns JSX. */
function componentDefs(sf: SourceFile): ComponentDef[] {
  const defs: ComponentDef[] = [];
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name && PASCAL_CASE.test(name) && containsJsx(fn)) defs.push({ name, body: fn });
  }
  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const name = decl.getName();
      const init = decl.getInitializer();
      if (name && PASCAL_CASE.test(name) && init && containsJsx(init)) {
        defs.push({ name, body: init });
      }
    }
  }
  return defs;
}

/** Collect class strings from a `className` attribute value (literal, or cn()/template). */
function classStringsFrom(attrValue: Node): string[] {
  const out: string[] = [];
  const pushLiteral = (n: Node) => {
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) out.push(n.getLiteralValue());
  };
  pushLiteral(attrValue);
  attrValue.forEachDescendant((d) => pushLiteral(d));
  return out;
}

/** All className strings within a component body (its own markup). */
function classStringsInComponent(body: Node): string[] {
  const strings: string[] = [];
  body.forEachDescendant((d) => {
    if (!Node.isJsxAttribute(d)) return;
    const name = d.getNameNode().getText();
    if (name !== "className" && name !== "class") return;
    const init = d.getInitializer();
    if (init) strings.push(...classStringsFrom(init));
  });
  // also static class args passed to cn()/clsx() not directly on className (rare top-level)
  body.forEachDescendant((d) => {
    if (!Node.isCallExpression(d)) return;
    if (!CLASS_FNS.has(d.getExpression().getText())) return;
    for (const arg of d.getArguments()) {
      if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
        strings.push(arg.getLiteralValue());
      }
    }
  });
  return strings;
}

const componentId = (name: string) => `component:${name}@${COMPONENT_SIDE}`;

async function extract(ctx: AdapterContext): Promise<GraphFragment> {
  const resolveClass = ctx.resolveClass;
  const files = (await Promise.all((await scanRoots(ctx.root)).map(findTsxFiles))).flat();
  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: 2 /* preserve */ },
  });

  const nodes = new Map<string, ComponentNode>();
  // aggregate uses-token by component→token→slot
  const usage = new Map<string, { source: string; target: string; slot: string; instances: number }>();
  const rootAbs = resolve(ctx.root);

  for (const file of files) {
    let sf: SourceFile;
    try {
      sf = project.addSourceFileAtPath(file);
    } catch {
      continue;
    }
    const defs = componentDefs(sf);
    if (!defs.length) {
      project.removeSourceFile(sf);
      continue;
    }
    const rel = relative(rootAbs, file).replace(/\\/g, "/");

    for (const def of defs) {
      const id = componentId(def.name);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          type: NodeType.Component,
          label: def.name,
          props: { framework: FRAMEWORK, side: COMPONENT_SIDE },
          sources: [{ adapter: ADAPTER_NAME, file: rel, loc: `L${def.body.getStartLineNumber()}` }],
          confidence: Confidence.EXTRACTED,
        });
      }
      if (!resolveClass) continue;
      for (const classString of classStringsInComponent(def.body)) {
        for (const r of resolveClass.resolve(classString)) {
          const key = `${id}|${r.tokenId}|${r.slot}`;
          const agg = usage.get(key);
          if (agg) agg.instances += 1;
          else usage.set(key, { source: id, target: r.tokenId, slot: r.slot, instances: 1 });
        }
      }
    }
    project.removeSourceFile(sf);
  }

  const edges: GraphEdge[] = [...usage.values()].map((u) => ({
    source: u.source,
    target: u.target,
    relation: EdgeRelation.usesToken,
    props: { slot: u.slot, instances: u.instances },
    confidence: Confidence.EXTRACTED,
  }));

  return { nodes: [...nodes.values()], edges };
}

export const reactComponentAdapter: Adapter = {
  name: ADAPTER_NAME,
  async detect(ctx) {
    return (await findTsxFiles(resolve(ctx.root))).length > 0;
  },
  extract,
};

export type { ResolvedClass };
