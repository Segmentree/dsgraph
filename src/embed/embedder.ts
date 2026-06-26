/**
 * Embeddings for seed resolution (DESIGN.md §10.0, decision #2).
 *
 * An `Embedder` turns text into vectors; `cosine` compares them. This is the pluggable
 * seam: the local model lives in `local.ts`, tests inject a deterministic fake, and the
 * `context`/expressibility verbs depend only on this interface — never on the model lib.
 * Embedding is the fuzzy fallback *behind* exact/normalized/substring lexical scoring,
 * so the verbs degrade gracefully to lexical-only when no embedder is supplied.
 */

export interface Embedder {
  /** Embed each text → a fixed-dimension vector (same dim for all). Order preserved. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity in [-1, 1]; 0 when either vector is degenerate. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface RankedCandidate {
  id: string;
  label: string;
  /** Cosine of the candidate's label embedding against the query embedding. */
  score: number;
}

/**
 * Rank labelled candidates by embedding cosine to `query`. One batch embeds the query
 * plus every candidate label, so it's a single model call. Returns all candidates sorted
 * best-first (the caller applies its own threshold / top-k).
 */
export async function rankByEmbedding(
  embedder: Embedder,
  query: string,
  candidates: { id: string; label: string }[],
): Promise<RankedCandidate[]> {
  if (!candidates.length) return [];
  const vectors = await embedder.embed([query, ...candidates.map((c) => c.label)]);
  const queryVec = vectors[0]!;
  return candidates
    .map((c, i) => ({ id: c.id, label: c.label, score: cosine(queryVec, vectors[i + 1]!) }))
    .sort((a, b) => b.score - a.score);
}
