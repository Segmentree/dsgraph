/**
 * `match <value>` — value lookup (DESIGN.md §10.6).
 *
 * Canonicalize a literal value → find its RawValue → report the tokens that carry it
 * (exact) and the perceptually/numerically near ones via `similar-to`. If the value
 * isn't in the system, report the nearest in-system values (a snap suggestion, §11).
 */

import {
  canonicalize,
  isColorSyntax,
  parseColor,
  parseDimension,
  deltaE2000,
} from "../canonicalize/index.js";
import { EdgeRelation, NodeType, ValueType, type GraphNode } from "../schema.js";
import { labelOf, nodeOf, edgeOf, type DsGraph } from "./util.js";

const NEAREST_LIMIT = 5;
/** ΔE ceiling for "nearest" suggestions when the value isn't in the system. */
const NEAREST_EPSILON = 10;

export interface TokenRef {
  id: string;
  label: string;
  mode?: string;
}
export interface ValueHit {
  rawValueId: string;
  label: string;
  distance?: number;
  tokens: TokenRef[];
}
export interface MatchResult {
  input: string;
  valueType?: ValueType;
  inSystem: boolean;
  exact?: ValueHit;
  similar: ValueHit[];
  nearest: ValueHit[];
}

/** Tokens that bind a RawValue (has-value in-edges → source token). */
function tokensOf(graph: DsGraph, rawValueId: string): TokenRef[] {
  const refs: TokenRef[] = [];
  if (!graph.hasNode(rawValueId)) return refs;
  graph.forEachInEdge(rawValueId, (key, _attrs, source) => {
    const edge = edgeOf(graph, key);
    if (edge.relation !== EdgeRelation.hasValue) return;
    refs.push({ id: source, label: labelOf(nodeOf(graph, source)), mode: edge.props?.["mode"] as string | undefined });
  });
  return refs;
}

function valueHit(graph: DsGraph, rawValueId: string, distance?: number): ValueHit {
  return {
    rawValueId,
    label: labelOf(nodeOf(graph, rawValueId)),
    ...(distance !== undefined ? { distance } : {}),
    tokens: tokensOf(graph, rawValueId),
  };
}

/** Best-effort canonical RawValue id + value type for a literal input. */
function canonicalIdFor(input: string): { id: string; valueType: ValueType } | null {
  if (isColorSyntax(input)) {
    const n = canonicalize(input, ValueType.color);
    return n ? { id: n.id, valueType: ValueType.color } : null;
  }
  if (parseDimension(input)) {
    const n = canonicalize(input, ValueType.dimension);
    return n ? { id: n.id, valueType: ValueType.dimension } : null;
  }
  return null;
}

export function match(graph: DsGraph, input: string): MatchResult {
  const canon = canonicalIdFor(input.trim());
  const result: MatchResult = {
    input: input.trim(),
    valueType: canon?.valueType,
    inSystem: false,
    similar: [],
    nearest: [],
  };
  if (!canon) return result;

  // Dimensions are scope-keyed; the same px lives under several ids. Match by value.
  const exactIds = canon.valueType === ValueType.dimension
    ? dimensionIdsByPx(graph, input)
    : graph.hasNode(canon.id)
      ? [canon.id]
      : [];

  if (exactIds.length) {
    result.inSystem = true;
    result.exact = valueHit(graph, exactIds[0]!);
    result.similar = similarNeighbors(graph, exactIds[0]!);
    return result;
  }

  // Not in system → nearest by ΔE over color RawValues (snap suggestion).
  if (canon.valueType === ValueType.color) result.nearest = nearestColors(graph, input);
  return result;
}

function similarNeighbors(graph: DsGraph, rawValueId: string): ValueHit[] {
  const hits: ValueHit[] = [];
  const visit = (key: string, other: string) => {
    const edge = edgeOf(graph, key);
    if (edge.relation !== EdgeRelation.similarTo) return;
    const d = (edge.props?.["deltaE"] ?? edge.props?.["distance"]) as number | undefined;
    hits.push(valueHit(graph, other, d));
  };
  graph.forEachOutEdge(rawValueId, (key, _a, _s, target) => visit(key, target));
  graph.forEachInEdge(rawValueId, (key, _a, source) => visit(key, source));
  return hits.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
}

function dimensionIdsByPx(graph: DsGraph, input: string): string[] {
  const d = parseDimension(input);
  if (!d) return [];
  const ids: string[] = [];
  graph.forEachNode((id, attrs) => {
    const p = attrs.node.props;
    if (p?.["valueType"] === ValueType.dimension && p["px"] === d.px) ids.push(id);
  });
  return ids;
}

function nearestColors(graph: DsGraph, input: string): ValueHit[] {
  const target = parseColor(input);
  if (!target) return [];
  const scored: Array<{ id: string; d: number }> = [];
  graph.forEachNode((id, attrs) => {
    const p = attrs.node.props;
    if (p?.["valueType"] !== ValueType.color || attrs.node.type !== NodeType.RawValue) return;
    const lab = p["lab"];
    if (!Array.isArray(lab)) return;
    const d = deltaE2000(target, { lab: lab as [number, number, number] });
    if (d < NEAREST_EPSILON) scored.push({ id, d });
  });
  return scored
    .sort((a, b) => a.d - b.d)
    .slice(0, NEAREST_LIMIT)
    .map(({ id, d }) => valueHit(graph, id, Math.round(d * 100) / 100));
}
