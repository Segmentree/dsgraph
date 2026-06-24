/**
 * `similar-to` similarity layer (DESIGN.md §6b).
 *
 * Over the type-scoped RawValue set, connect perceptually/numerically near values.
 * Every value type flows through one engine; a type participates if it has a metric
 * in the registry below. RawValues are grouped by (valueType, scope) — so radius
 * values never compare against font-sizes — and every within-group pair closer than
 * the type's ε gets a weighted edge, `weight = clamp(1 - distance/ε, 0..1)`.
 *
 * Metrics by type:
 *   - color       ΔE2000 on Lab (perceptual).
 *   - dimension   relative |a-b|/max (scale-friendly: 14↔16 near, 2↔4 not), per scope.
 *   - fontWeight  absolute step distance on the 100–900 axis (ordinal).
 *   - fontFamily  normalized edit distance on the family name (LEXICAL, not perceptual —
 *                 catches `inter` vs `inter tight`; true name-matching lives in §7).
 *
 * Exact-equal values already collapsed to one node in the value-first dedup, so these
 * edges are strictly the near-but-not-equal pairs — raw material for bloat analysis (§9).
 * O(n²) within each (type, scope) group is fine at this scale (§6b).
 */

import { deltaE2000 } from "../canonicalize/index.js";
import { EdgeRelation, NodeType, ValueType, type GraphDocument, type GraphEdge, type GraphNode } from "../schema.js";

/** Default ΔE threshold for color similarity (tunable on real data, §17). */
export const DEFAULT_EPSILON = 10;
/** Relative-distance threshold for dimensions (~12%). */
const DIMENSION_EPSILON = 0.12;
/** Absolute step threshold on the 100–900 font-weight axis. */
const FONT_WEIGHT_EPSILON = 150;
/** Normalized edit-distance threshold for family names. */
const FONT_FAMILY_EPSILON = 0.34;

const DISTANCE_PRECISION = 3;
const NO_SCOPE = "";

type Props = Record<string, unknown>;

interface Metric {
  /** Default threshold; pairs strictly below it get an edge. */
  epsilon: number;
  /** Distance between two RawValue prop bags, or null if either lacks the data. */
  distance(a: Props, b: Props): number | null;
}

/** Per-type distance metrics. A type with no entry produces no similarity edges. */
const METRICS: Partial<Record<ValueType, Metric>> = {
  [ValueType.color]: {
    epsilon: DEFAULT_EPSILON,
    distance: (a, b) =>
      isLab(a["lab"]) && isLab(b["lab"]) ? deltaE2000({ lab: a["lab"] }, { lab: b["lab"] }) : null,
  },
  [ValueType.dimension]: {
    epsilon: DIMENSION_EPSILON,
    distance: (a, b) => {
      const x = a["px"];
      const y = b["px"];
      if (typeof x !== "number" || typeof y !== "number") return null;
      return Math.abs(x - y) / Math.max(x, y, 1);
    },
  },
  [ValueType.fontWeight]: {
    epsilon: FONT_WEIGHT_EPSILON,
    distance: (a, b) => {
      const x = a["weight"];
      const y = b["weight"];
      return typeof x === "number" && typeof y === "number" ? Math.abs(x - y) : null;
    },
  },
  [ValueType.fontFamily]: {
    epsilon: FONT_FAMILY_EPSILON,
    distance: (a, b) => {
      const x = a["family"];
      const y = b["family"];
      return typeof x === "string" && typeof y === "string" ? normalizedEdit(x, y) : null;
    },
  },
};

export interface SimilarToOptions {
  /** Per-type threshold overrides; falls back to each metric's default ε. */
  epsilon?: Partial<Record<ValueType, number>>;
}

/** Compute the `similar-to` edges for a graph (does not mutate it). */
export function deriveSimilarTo(doc: GraphDocument, opts: SimilarToOptions = {}): GraphEdge[] {
  const groups = new Map<string, GraphNode[]>();
  for (const node of doc.nodes) {
    if (node.type !== NodeType.RawValue) continue;
    const valueType = node.props?.["valueType"] as ValueType | undefined;
    if (!valueType || !METRICS[valueType]) continue;
    const scope = (node.props?.["scope"] as string | undefined) ?? NO_SCOPE;
    const key = `${valueType}:${scope}`;
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }

  const edges: GraphEdge[] = [];
  for (const nodes of groups.values()) {
    const valueType = nodes[0]!.props!["valueType"] as ValueType;
    const metric = METRICS[valueType]!;
    const epsilon = opts.epsilon?.[valueType] ?? metric.epsilon;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const d = metric.distance(a.props ?? {}, b.props ?? {});
        if (d === null || d >= epsilon) continue;
        edges.push({
          source: a.id,
          target: b.id,
          relation: EdgeRelation.similarTo,
          props: distanceProps(valueType, d),
          weight: clamp01(1 - d / epsilon),
        });
      }
    }
  }
  return edges;
}

/** Color keeps the `deltaE` key (DESIGN §2); other types report a generic `distance`. */
function distanceProps(valueType: ValueType, d: number): Props {
  const rounded = round(d, DISTANCE_PRECISION);
  return valueType === ValueType.color ? { deltaE: rounded, distance: rounded } : { distance: rounded };
}

function isLab(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number");
}

/** Levenshtein edit distance normalized by the longer string → 0 (equal) … 1 (disjoint). */
function normalizedEdit(a: string, b: string): number {
  if (a === b) return 0;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length]! / max;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, p: number) => Math.round(x * 10 ** p) / 10 ** p;
