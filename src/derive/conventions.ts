/**
 * Convention layer — `commonly-used-with` (DESIGN.md §6c, §2 convention class).
 *
 * Derived from `composed-of`: two components that are rendered by the same parent are
 * "used together." Aggregated across every parent, a frequently co-occurring pair gets
 * a weighted `commonly-used-with` edge — the signal behind "what's a Card normally used
 * with" for the generation/retrieval workflow.
 *
 * Weight = Jaccard of co-occurrence: `co / (count(a) + count(b) − co)` — 1.0 when the two
 * always appear together, lower when each also appears apart. A minimum co-occurrence
 * threshold drops one-off pairings (a single big parent shouldn't mint conventions).
 */

import { EdgeRelation, type GraphDocument, type GraphEdge } from "../schema.js";

/** A pair must co-occur under at least this many parents to count as a convention. */
export const DEFAULT_MIN_CO_OCCURRENCE = 2;
const WEIGHT_PRECISION = 3;
const PAIR_SEP = "|";

export interface ConventionOptions {
  minCoOccurrence?: number;
}

/** Compute `commonly-used-with` edges from the graph's `composed-of` structure. */
export function deriveCommonlyUsedWith(
  doc: GraphDocument,
  opts: ConventionOptions = {},
): GraphEdge[] {
  const minCo = opts.minCoOccurrence ?? DEFAULT_MIN_CO_OCCURRENCE;

  // parent → distinct child components it renders
  const childrenByParent = new Map<string, Set<string>>();
  for (const e of doc.edges) {
    if (e.relation !== EdgeRelation.composedOf) continue;
    const set = childrenByParent.get(e.source) ?? new Set<string>();
    set.add(e.target);
    childrenByParent.set(e.source, set);
  }

  // count[c] = # parents that render c; co[a|b] = # parents that render both.
  const count = new Map<string, number>();
  const co = new Map<string, number>();
  for (const set of childrenByParent.values()) {
    const children = [...set].sort();
    for (const c of children) count.set(c, (count.get(c) ?? 0) + 1);
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const key = `${children[i]}${PAIR_SEP}${children[j]}`;
        co.set(key, (co.get(key) ?? 0) + 1);
      }
    }
  }

  const edges: GraphEdge[] = [];
  for (const [key, coCount] of co) {
    if (coCount < minCo) continue;
    const [a, b] = key.split(PAIR_SEP) as [string, string];
    const union = (count.get(a) ?? 0) + (count.get(b) ?? 0) - coCount;
    const weight = union > 0 ? round(coCount / union, WEIGHT_PRECISION) : 0;
    edges.push({
      source: a,
      target: b,
      relation: EdgeRelation.commonlyUsedWith,
      props: { coCount },
      weight,
    });
  }
  return edges;
}

const round = (x: number, p: number) => Math.round(x * 10 ** p) / 10 ** p;
