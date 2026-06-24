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
import type { GraphDocument } from "./schema.js";

/** Token/structural adapters, in registration order (DESIGN.md §4). */
export const DEFAULT_ADAPTERS: Adapter[] = [tailwindV4Adapter, tailwindConfigAdapter];

export interface BuildResult {
  doc: GraphDocument;
  /** Names of adapters that fired. */
  activated: string[];
  dangling: number;
  outPath: string;
  vizPath?: string;
}

export interface BuildOptions {
  adapters?: Adapter[];
  /** Skip writing graph.json (in-memory build, for tests/queries). */
  write?: boolean;
  /** Emit graph.html alongside graph.json (default true when writing). */
  viz?: boolean;
}

export async function build(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const adapters = opts.adapters ?? DEFAULT_ADAPTERS;
  const activated = await runAdapters(adapters, { root });
  const doc = mergeFragments(activated.map((a) => a.fragment));
  const outPath = graphPath(root);
  const writing = opts.write !== false;
  if (writing) await writeGraph(outPath, doc);

  let viz: string | undefined;
  if (writing && opts.viz !== false) {
    viz = vizPath(root);
    await writeViz(viz, doc);
  }

  return {
    doc,
    activated: activated.map((a) => a.adapter.name),
    dangling: findDanglingEdges(doc).length,
    outPath,
    vizPath: viz,
  };
}
