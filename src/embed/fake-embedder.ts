/**
 * Deterministic fake Embedder for tests — maps each text to a fixed vector (zeros if
 * unknown), so cosine ranking is fully controllable without loading the real model.
 */

import type { Embedder } from "./embedder.js";

export function fakeEmbedder(table: Record<string, number[]>): Embedder {
  return { async embed(texts) { return texts.map((t) => table[t] ?? [0, 0, 0]); } };
}
