/**
 * `similar-to` similarity layer (DESIGN.md §6b).
 *
 * One engine over the type-scoped RawValue set. The per-type distance metrics come
 * from the value-type registry (`../values/registry`), so similarity and
 * canonicalization stay in lockstep. RawValues are grouped by (valueType, scope) —
 * so radius never compares to font-size — and every within-group pair closer than
 * the type's ε gets a weighted edge, `weight = clamp(1 - distance/ε, 0..1)`.
 *
 * Exact-equal values already collapsed to one node in the value-first dedup, so these
 * edges are strictly the near-but-not-equal pairs — raw material for bloat analysis (§9).
 */

import { VALUE_TYPES, COLOR_EPSILON } from "../values/registry.js";
import { EdgeRelation, NodeType, ValueType, type GraphDocument, type GraphEdge, type GraphNode } from "../schema.js";

/** Default ΔE threshold for color similarity (re-exported for callers/tests). */
export const DEFAULT_EPSILON = COLOR_EPSILON;

const DISTANCE_PRECISION = 3;
const NO_SCOPE = "";

type Props = Record<string, unknown>;

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
    if (!valueType || !VALUE_TYPES[valueType]?.metric) continue;
    const scope = (node.props?.["scope"] as string | undefined) ?? NO_SCOPE;
    const key = `${valueType}:${scope}`;
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }

  const edges: GraphEdge[] = [];
  for (const nodes of groups.values()) {
    const valueType = nodes[0]!.props!["valueType"] as ValueType;
    const metric = VALUE_TYPES[valueType]!.metric!;
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

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, p: number) => Math.round(x * 10 ** p) / 10 ** p;
