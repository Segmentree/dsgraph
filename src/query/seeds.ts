/**
 * Seed resolution — NL text → graph nodes (DESIGN.md §10.0).
 *
 * Phase 1 uses lexical scoring only (exact / normalized / substring); the embedding
 * cosine term (decision #2) slots in here later as an additional scorer. Inside an
 * agent, exact ids can be passed straight through, bypassing this.
 */

import { labelOf, normalize, nodeOf, type DsGraph } from "./util.js";

const SCORE = { exact: 1.0, normalized: 0.9, substring: 0.6 } as const;
const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.5;
const MIN_SUBSTRING_LEN = 3;

export interface Seed {
  id: string;
  label: string;
  score: number;
}

export interface ResolveOptions {
  limit?: number;
  threshold?: number;
}

/** Score one node's label/id against a normalized query term. */
function scoreNode(label: string, id: string, raw: string, norm: string): number {
  if (label === raw || id === raw) return SCORE.exact;
  const nl = normalize(label);
  if (nl === norm) return SCORE.normalized;
  if (norm.length >= MIN_SUBSTRING_LEN && (nl.includes(norm) || norm.includes(nl))) {
    return SCORE.substring;
  }
  return 0;
}

/** Resolve free text to the best-matching nodes, highest score first. */
export function resolveSeeds(graph: DsGraph, text: string, opts: ResolveOptions = {}): Seed[] {
  const raw = text.trim();
  const norm = normalize(raw);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  const seeds: Seed[] = [];
  graph.forEachNode((id) => {
    const label = labelOf(nodeOf(graph, id));
    const score = scoreNode(label, id, raw, norm);
    if (score >= threshold) seeds.push({ id, label, score });
  });

  seeds.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return seeds.slice(0, limit);
}
