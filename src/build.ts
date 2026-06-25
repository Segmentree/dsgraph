/**
 * Build pipeline (DESIGN.md §1, §5): detect → extract → merge → emit.
 *
 * Phase 1 wires the token side: run the registered adapters against the target,
 * merge their fragments (dedup nodes by id, edges by source·relation·target), and
 * write `graph.json`. Derived layers (similar-to, conventions), reconciliation, and
 * analysis attach to this same merged document in later units.
 */

import { mergeFragments, writeGraph, findDanglingEdges } from "./graph.js";
import { graphPath, vizPath } from "./paths.js";
import { writeViz } from "./viz.js";
import { runAdapters, type Adapter } from "./adapters/registry.js";
import { tailwindV4Adapter } from "./adapters/tailwind-v4.js";
import { tailwindConfigAdapter } from "./adapters/tailwind-config.js";
import { reactComponentAdapter } from "./adapters/components/component-adapter.js";
import { buildClassResolver } from "./adapters/components/class-resolver.js";
import { deriveSimilarTo } from "./derive/similar-to.js";
import { deriveComposition } from "./derive/composition.js";
import { deriveCommonlyUsedWith } from "./derive/conventions.js";
import { ValueType, type GraphDocument } from "./schema.js";

/** Token adapters run first — they produce the class→token resolver (DESIGN.md §4a). */
export const TOKEN_ADAPTERS: Adapter[] = [tailwindV4Adapter, tailwindConfigAdapter];
/** Component adapters run second, with the resolver in context (§4b). */
export const COMPONENT_ADAPTERS: Adapter[] = [reactComponentAdapter];
/** All structural adapters (back-compat / single-list callers). */
export const DEFAULT_ADAPTERS: Adapter[] = [...TOKEN_ADAPTERS, ...COMPONENT_ADAPTERS];

export interface BuildResult {
  doc: GraphDocument;
  /** Names of adapters that fired. */
  activated: string[];
  dangling: number;
  /** Count of derived similar-to edges. */
  similar: number;
  /** Tokens whose value couldn't be canonicalized (visible, not silently dropped). */
  unresolvedTokens: number;
  outPath: string;
  vizPath?: string;
}

export interface BuildOptions {
  /** Token adapters (run first → resolver). */
  tokenAdapters?: Adapter[];
  /** Component adapters (run second, given the resolver). */
  componentAdapters?: Adapter[];
  /** Skip writing graph.json (in-memory build, for tests/queries). */
  write?: boolean;
  /** Emit graph.html alongside graph.json (default true when writing). */
  viz?: boolean;
  /** ΔE threshold for the similar-to layer (default DEFAULT_EPSILON). */
  similarEpsilon?: number;
}

export async function build(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
  // Phase A — token adapters → token fragments → class→token resolver.
  const tokenRun = await runAdapters(opts.tokenAdapters ?? TOKEN_ADAPTERS, { root });
  const tokenFrag = mergeFragments(tokenRun.map((a) => a.fragment));
  const resolveClass = buildClassResolver(tokenFrag.nodes);

  // Phase B — component adapters, handed the resolver.
  const componentRun = await runAdapters(opts.componentAdapters ?? COMPONENT_ADAPTERS, {
    root,
    resolveClass,
  });

  const activated = [...tokenRun, ...componentRun];
  const merged = mergeFragments([
    { nodes: tokenFrag.nodes, edges: tokenFrag.edges },
    ...componentRun.map((a) => a.fragment),
  ]);

  // Derived layer 1: materialize composite sub-values + composed-of (§6a). Re-merge so
  // sub-values that equal existing RawValues dedup by id.
  const doc = mergeFragments([
    { nodes: merged.nodes, edges: merged.edges },
    deriveComposition(merged),
  ]);

  // Derived layer 2: perceptual/numeric value similarity (§6b) — now also over the
  // materialized sub-values.
  const similarEdges = deriveSimilarTo(doc, {
    epsilon: opts.similarEpsilon === undefined ? undefined : { [ValueType.color]: opts.similarEpsilon },
  });
  doc.edges.push(...similarEdges);

  // Derived layer 3: convention edges (commonly-used-with) from composed-of (§6c).
  doc.edges.push(...deriveCommonlyUsedWith(doc));

  const outPath = graphPath(root);
  const writing = opts.write !== false;
  if (writing) await writeGraph(outPath, doc);

  let viz: string | undefined;
  if (writing && opts.viz !== false) {
    viz = vizPath(root);
    await writeViz(viz, doc);
  }

  const unresolvedTokens = doc.nodes.filter(
    (n) => n.type === "Token" && n.props?.["unresolvedValue"] !== undefined,
  ).length;

  return {
    doc,
    activated: activated.map((a) => a.adapter.name),
    dangling: findDanglingEdges(doc).length,
    similar: similarEdges.length,
    unresolvedTokens,
    outPath,
    vizPath: viz,
  };
}
