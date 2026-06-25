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
  type GraphNode,
  type ComponentNode,
  type InstanceNode,
} from "../../schema.js";
import type { Adapter, AdapterContext } from "../registry.js";
import type { ResolvedClass } from "./class-resolver.js";
import { cvaDefs, type CvaInfo } from "./cva.js";

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

/** cva variables referenced inside a component body (`cn(buttonVariants(...))`). */
function referencedCva(body: Node, cvaMap: Map<string, CvaInfo>): string[] {
  if (cvaMap.size === 0) return [];
  const refs = new Set<string>();
  body.forEachDescendant((d) => {
    if (Node.isIdentifier(d) && cvaMap.has(d.getText())) refs.add(d.getText());
  });
  return [...refs];
}

/** PascalCase JSX child tags rendered in a component body — candidate child components. */
function childComponentTags(body: Node): string[] {
  const tags: string[] = [];
  body.forEachDescendant((d) => {
    if (Node.isJsxOpeningElement(d) || Node.isJsxSelfClosingElement(d)) {
      const name = d.getTagNameNode().getText();
      if (PASCAL_CASE.test(name)) tags.push(name);
    }
  });
  return tags;
}

const BOOL_TRUE = "true";
const BOOL_FALSE = "false";
/** Props excluded from the variant envelope (not discrete style variants). */
const ENVELOPE_SKIP = new Set(["className", "class", "key", "ref", "style", "id", "children"]);
const ENVELOPE_SKIP_PREFIXES = ["on", "data-", "aria-"];

/** Static prop bindings on a JSX element (string/boolean literals only; skips dynamic). */
function literalBindings(el: Node): Record<string, string> {
  if (!Node.isJsxOpeningElement(el) && !Node.isJsxSelfClosingElement(el)) return {};
  const out: Record<string, string> = {};
  for (const attr of el.getAttributes()) {
    if (!Node.isJsxAttribute(attr)) continue; // spread → dynamic
    const name = attr.getNameNode().getText();
    if (ENVELOPE_SKIP.has(name) || ENVELOPE_SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const init = attr.getInitializer();
    let value: string | null = null;
    if (!init) {
      value = BOOL_TRUE; // boolean shorthand: `disabled`
    } else if (Node.isStringLiteral(init)) {
      value = init.getLiteralValue();
    } else if (Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (expr && Node.isStringLiteral(expr)) value = expr.getLiteralValue();
      else if (expr && (expr.getText() === BOOL_TRUE || expr.getText() === BOOL_FALSE)) {
        value = expr.getText();
      }
    }
    if (value !== null) out[name] = value;
  }
  return out;
}

const componentId = (name: string) => `component:${name}@${COMPONENT_SIDE}`;

// ── routing ───────────────────────────────────────────────────────────────────
// The router renders the route-entry components directly. Modeling it as a node (with
// composed-of edges to those entries) means pages/layouts aren't false "orphans" and the
// graph has a real root. Framework-agnostic by design; Next.js app-router patterns now.

const NEXT_FRAMEWORK = "next";
const ROUTER_ID = `router:${NEXT_FRAMEWORK}`;
/** Next.js app-router special files — each is a route entry rendered by the router. */
const NEXT_ROUTE_FILE_RE = /(^|\/)(page|layout|template|default|error|loading|not-found|global-error)\.[jt]sx$/;

const isRouteFile = (rel: string) => NEXT_ROUTE_FILE_RE.test(rel);

/** Name of a file's default-exported component (the route entry), or null. */
function defaultExportComponentName(sf: SourceFile): string | null {
  const fn = sf.getFunctions().find((f) => f.isDefaultExport());
  if (fn) return fn.getName() ?? null;
  for (const a of sf.getExportAssignments()) {
    if (a.isExportEquals()) continue;
    const e = a.getExpression();
    if (Node.isIdentifier(e)) return e.getText();
  }
  return null;
}

interface ComponentDefRef {
  name: string;
  id: string;
  body: Node;
  file: string;
}

async function extract(ctx: AdapterContext): Promise<GraphFragment> {
  const resolveClass = ctx.resolveClass;
  const files = (await Promise.all((await scanRoots(ctx.root)).map(findTsxFiles))).flat();
  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: 2 /* preserve */ },
  });

  const rootAbs = resolve(ctx.root);

  // Pass A — collect every component definition across all files, so JSX child tags in
  // one file can resolve to components defined in another (cross-file composition).
  const defs: ComponentDefRef[] = [];
  const cvaByFile = new Map<string, Map<string, CvaInfo>>();
  const routeEntries = new Set<string>();
  for (const file of files) {
    let sf: SourceFile;
    try {
      sf = project.addSourceFileAtPath(file);
    } catch {
      continue;
    }
    const rel = relative(rootAbs, file).replace(/\\/g, "/");
    for (const def of componentDefs(sf)) {
      defs.push({ name: def.name, id: componentId(def.name), body: def.body, file: rel });
    }
    const cva = cvaDefs(sf);
    if (cva.size) cvaByFile.set(rel, cva);
    if (isRouteFile(rel)) {
      const name = defaultExportComponentName(sf);
      if (name && PASCAL_CASE.test(name)) routeEntries.add(name);
    }
  }
  const idByName = new Map<string, string>();
  for (const d of defs) idByName.set(d.name, d.id);

  // Pass B — per component: node + uses-token (className) + composed-of (child component tags).
  const nodes = new Map<string, ComponentNode>();
  const usage = new Map<string, { source: string; target: string; slot: string; instances: number }>();
  const composed = new Map<string, { source: string; target: string; instances: number }>();

  for (const def of defs) {
    const node: ComponentNode = nodes.get(def.id) ?? {
      id: def.id,
      type: NodeType.Component,
      label: def.name,
      props: { framework: FRAMEWORK, side: COMPONENT_SIDE },
      sources: [{ adapter: ADAPTER_NAME, file: def.file, loc: `L${def.body.getStartLineNumber()}` }],
      confidence: Confidence.EXTRACTED,
    };
    nodes.set(def.id, node);

    // cva: variant axes (props_schema) + the variant class strings this component carries.
    const cvaMap = cvaByFile.get(def.file);
    const cvaClasses: string[] = [];
    if (cvaMap) {
      for (const varName of referencedCva(def.body, cvaMap)) {
        const info = cvaMap.get(varName)!;
        cvaClasses.push(...info.classes);
        node.props = { ...node.props, props_schema: { ...node.props?.props_schema, ...info.propsSchema } };
      }
    }

    if (resolveClass) {
      const classStrings = [...classStringsInComponent(def.body), ...cvaClasses];
      for (const classString of classStrings) {
        for (const r of resolveClass.resolve(classString)) {
          const key = `${def.id}|${r.tokenId}|${r.slot}`;
          const agg = usage.get(key);
          if (agg) agg.instances += 1;
          else usage.set(key, { source: def.id, target: r.tokenId, slot: r.slot, instances: 1 });
        }
      }
    }

    for (const childName of childComponentTags(def.body)) {
      if (childName === def.name) continue; // self-recursion, not composition
      const childId = idByName.get(childName);
      if (!childId) continue; // external/unknown tag (Radix, icons) or intrinsic — skip
      const key = `${def.id}|${childId}`;
      const agg = composed.get(key);
      if (agg) agg.instances += 1;
      else composed.set(key, { source: def.id, target: childId, instances: 1 });
    }
  }

  // Pass C — usages: aggregate the variant envelope per component (always); emit a node
  // per usage only when requested (DESIGN §4b pass 2).
  const envelope = new Map<string, { instances: number; props: Map<string, Map<string, number>> }>();
  const instanceNodes: InstanceNode[] = [];
  const instanceEdges: GraphEdge[] = [];

  for (const sf of project.getSourceFiles()) {
    const rel = relative(rootAbs, sf.getFilePath()).replace(/\\/g, "/");
    sf.forEachDescendant((d) => {
      if (!Node.isJsxOpeningElement(d) && !Node.isJsxSelfClosingElement(d)) return;
      const name = d.getTagNameNode().getText();
      if (!PASCAL_CASE.test(name)) return;
      const compId = idByName.get(name);
      if (!compId) return; // usage of an external/unknown component

      const bindings = literalBindings(d);
      const env = envelope.get(compId) ?? { instances: 0, props: new Map() };
      env.instances += 1;
      for (const [axis, value] of Object.entries(bindings)) {
        const dist = env.props.get(axis) ?? new Map<string, number>();
        dist.set(value, (dist.get(value) ?? 0) + 1);
        env.props.set(axis, dist);
      }
      envelope.set(compId, env);

      if (ctx.emitInstances) {
        const { line, column } = sf.getLineAndColumnAtPos(d.getStart());
        const loc = `L${line}C${column}`;
        const id = `instance:${rel}:${loc}`;
        instanceNodes.push({
          id,
          type: NodeType.Instance,
          label: name,
          props: { bindings },
          sources: [{ adapter: ADAPTER_NAME, file: rel, loc }],
          confidence: Confidence.EXTRACTED,
        });
        instanceEdges.push({
          source: id,
          target: compId,
          relation: EdgeRelation.instanceOf,
          confidence: Confidence.EXTRACTED,
        });
      }
    });
  }

  // Attach the envelope (usage count + variant-value distribution) to each component.
  for (const [compId, env] of envelope) {
    const node = nodes.get(compId);
    if (!node) continue;
    const props: Record<string, Record<string, number>> = {};
    for (const [axis, dist] of env.props) props[axis] = Object.fromEntries(dist);
    node.props = { ...node.props, usage: { instances: env.instances, props } };
  }

  const edges: GraphEdge[] = [
    ...[...usage.values()].map(
      (u): GraphEdge => ({
        source: u.source,
        target: u.target,
        relation: EdgeRelation.usesToken,
        props: { slot: u.slot, instances: u.instances },
        confidence: Confidence.EXTRACTED,
      }),
    ),
    ...[...composed.values()].map(
      (c): GraphEdge => ({
        source: c.source,
        target: c.target,
        relation: EdgeRelation.composedOf,
        props: { instances: c.instances },
        confidence: Confidence.EXTRACTED,
      }),
    ),
    ...instanceEdges,
  ];

  // Router node + composed-of edges to the route entries it renders directly.
  const routerNodes: GraphNode[] = [];
  if (routeEntries.size) {
    routerNodes.push({
      id: ROUTER_ID,
      type: NodeType.Router,
      label: NEXT_FRAMEWORK,
      props: { framework: NEXT_FRAMEWORK },
      sources: [{ adapter: ADAPTER_NAME }],
      confidence: Confidence.EXTRACTED,
    });
    for (const name of routeEntries) {
      const target = idByName.get(name);
      if (!target) continue;
      edges.push({
        source: ROUTER_ID,
        target,
        relation: EdgeRelation.composedOf,
        confidence: Confidence.EXTRACTED,
      });
    }
  }

  return { nodes: [...nodes.values(), ...instanceNodes, ...routerNodes], edges };
}

export const reactComponentAdapter: Adapter = {
  name: ADAPTER_NAME,
  async detect(ctx) {
    return (await findTsxFiles(resolve(ctx.root))).length > 0;
  },
  extract,
};

export type { ResolvedClass };
