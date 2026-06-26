/**
 * Name similarity for reconciliation tie-breaking (DESIGN.md §7).
 *
 * Matching is value-first: names only break ties *within* a value cluster (tokens that
 * already share a RawValue). So this normalizes away the cosmetic differences between a
 * Figma variable name and a code token name — case, separators (`/ - _ .`), mode suffixes,
 * and scale numbers (`50`/`600`, which would otherwise dominate edit distance) — then
 * scores 1 (identical) … 0 (disjoint) via normalized Levenshtein.
 */

import { normalizedEdit } from "../values/registry.js";

/** Mode/qualifier words dropped before comparing (`primary-dark` ~ `primary`). */
const MODE_WORDS_RE = /\b(?:light|dark|default)\b/g;
/** Scale numbers collapsed to one marker so `blue-600` ~ `blue-500` on the name axis. */
const DIGITS_RE = /\d+/g;
const DIGIT_MARKER = "#";
/** Everything that isn't a letter or the digit marker — separators, spaces, punctuation. */
const NON_NAME_RE = /[^a-z#]+/g;

/** Canonical comparison form of a token/variable name. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(MODE_WORDS_RE, "")
    .replace(DIGITS_RE, DIGIT_MARKER)
    .replace(NON_NAME_RE, "");
}

/** 1 (names match after normalization) … 0 (completely different). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === "" && nb === "") return 1;
  return 1 - normalizedEdit(na, nb);
}

/** One matched pair from greedy bipartite matching, with its score. */
export interface NamePair<T> {
  a: T;
  b: T;
  score: number;
}

/**
 * Greedy maximum-weight bipartite matching on name similarity: take the highest-scoring
 * (a,b) pair, remove both, repeat. Good enough for the small clusters here (≤ a handful
 * of tokens sharing one value); Hungarian is overkill (§7). Returns matched pairs plus
 * the leftovers on each side (unmatched tokens → synonyms finding).
 */
export function greedyNameMatch<T>(
  left: T[],
  right: T[],
  nameOf: (t: T) => string,
): { pairs: NamePair<T>[]; leftoverA: T[]; leftoverB: T[] } {
  const candidates: NamePair<T>[] = [];
  for (const a of left) {
    for (const b of right) {
      candidates.push({ a, b, score: nameSimilarity(nameOf(a), nameOf(b)) });
    }
  }
  candidates.sort((x, y) => y.score - x.score);

  const usedA = new Set<T>();
  const usedB = new Set<T>();
  const pairs: NamePair<T>[] = [];
  for (const c of candidates) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    pairs.push(c);
  }
  return {
    pairs,
    leftoverA: left.filter((a) => !usedA.has(a)),
    leftoverB: right.filter((b) => !usedB.has(b)),
  };
}
