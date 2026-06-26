/**
 * Local embedding model (DESIGN.md §10.0, decision #2) — fastembed / BGE-small (384-d).
 *
 * Runs fully offline: no API key, no per-call cost, nothing leaves the machine. The model
 * (~30MB) downloads once into `dsgraph-out/cache/` and is reused. The library is imported
 * lazily inside `embed()` so merely importing this module — or running any non-embedding
 * build — never pulls in onnxruntime or triggers a download.
 */

import { join } from "node:path";
import { DSGRAPH_OUT } from "../paths.js";
import type { Embedder } from "./embedder.js";

const CACHE_SUBDIR = "cache";

export interface LocalEmbedderOptions {
  /** Project root; the model caches under `<root>/dsgraph-out/cache/`. */
  root?: string;
}

/**
 * A lazily-initialized local Embedder. The first `embed()` loads (and on first ever run
 * downloads) the model; later calls reuse it. Safe to construct eagerly — construction
 * does no I/O.
 */
export function localEmbedder(opts: LocalEmbedderOptions = {}): Embedder {
  const cacheDir = join(opts.root ?? ".", DSGRAPH_OUT, CACHE_SUBDIR);
  // typed as unknown until the lib is imported; kept module-private behind the closure.
  let modelPromise: Promise<{ embed(texts: string[]): AsyncGenerator<number[][]> }> | null = null;

  const model = async () => {
    if (!modelPromise) {
      modelPromise = (async () => {
        const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
        // BGE-small (English, v1.5): 384-d, good quality, fast on CPU.
        return FlagEmbedding.init({
          model: EmbeddingModel.BGESmallENV15,
          cacheDir,
        }) as unknown as { embed(texts: string[]): AsyncGenerator<number[][]> };
      })();
    }
    return modelPromise;
  };

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      const m = await model();
      const out: number[][] = [];
      for await (const batch of m.embed(texts)) {
        for (const vec of batch) out.push(Array.from(vec));
      }
      return out;
    },
  };
}
