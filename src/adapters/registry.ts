/**
 * Adapter registry (DESIGN.md §4).
 *
 * Each adapter implements `detect(ctx)` + `extract(ctx)`. Auto-detect runs every
 * registered adapter's `detect()` and activates the ones that fire; their fragments
 * are merged in the build step (§5). This keeps extraction open/closed: new token,
 * component, and Figma adapters register here without touching the pipeline.
 */

import type { GraphFragment } from "../schema.js";

/** What an adapter is handed: the scan root plus shared resolution helpers. */
export interface AdapterContext {
  /** Absolute path to the target app root being scanned. */
  root: string;
  /** class→token resolver, built from token adapters' output (set for component adapters, §4b). */
  resolveClass?: import("./components/class-resolver.js").ClassResolver;
}

export interface Adapter {
  /** Stable adapter id, recorded in node `sources[].adapter`. */
  name: string;
  /** True when this adapter applies to the target (cheap checks only). */
  detect(ctx: AdapterContext): boolean | Promise<boolean>;
  /** Produce a graph fragment from the target. Only called when `detect` fired. */
  extract(ctx: AdapterContext): GraphFragment | Promise<GraphFragment>;
}

export interface ActivatedAdapter {
  adapter: Adapter;
  fragment: GraphFragment;
}

/** Run every adapter's detect, then extract from those that fired. */
export async function runAdapters(
  adapters: Adapter[],
  ctx: AdapterContext,
): Promise<ActivatedAdapter[]> {
  const activated: ActivatedAdapter[] = [];
  for (const adapter of adapters) {
    if (await adapter.detect(ctx)) {
      activated.push({ adapter, fragment: await adapter.extract(ctx) });
    }
  }
  return activated;
}
