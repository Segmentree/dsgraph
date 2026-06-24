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
import { deriveSimilarTo } from "./derive/similar-to.js";
import { deriveComposition } from "./derive/composition.js";
import { ValueType, type GraphDocument } from "./schema.js";

/** Token/structural adapters, in registration order (DESIGN.md §4). */
export const DEFAULT_ADAPTERS: Adapter[] = [tailwindV4Adapter, tailwindConfigAdapter];

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
  adapters?: Adapter[];
  /** Skip writing graph.json (in-memory build, for tests/queries). */
  write?: boolean;
  /** Emit graph.html alongside graph.json (default true when writing). */
  viz?: boolean;
  /** ΔE threshold for the similar-to layer (default DEFAULT_EPSILON). */
  similarEpsilon?: number;
}

export async function build(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const adapters = opts.adapters ?? DEFAULT_ADAPTERS;
  const activated = await runAdapters(adapters, { root });
  const merged = mergeFragments(activated.map((a) => a.fragment));

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
