/**
 * `explain <X>` — neighborhood digest (DESIGN.md §10.3).
 *
 * Resolve a seed, then summarize its 1-hop neighborhood with edges grouped by
 * relation (has-value, similar-to, composed-of, …), each carrying the neighbor's
 * label, direction, and confidence. For a token, also surface the sibling tokens
 * that share its value (the value-first cluster).
 */

import { EdgeRelation, NodeType, type Confidence } from "../schema.js";
import { resolveSeeds } from "./seeds.js";
import { labelOf, nodeOf, edgeOf, type DsGraph } from "./util.js";

export interface NeighborRef {
  id: string;
  label: string;
  direction: "out" | "in";
  confidence?: Confidence;
  props?: Record<string, unknown>;
}
export interface RelationGroup {
  relation: string;
  neighbors: NeighborRef[];
}
export interface ExplainResult {
  id: string;
  label: string;
  type: string;
  props?: Record<string, unknown>;
  groups: RelationGroup[];
  /** Sibling tokens sharing this token's value(s). */
  sharesValueWith: { id: string; label: string }[];
}

/** Resolve `x` to a node id: exact id if present, else the top seed. */
export function resolveOne(graph: DsGraph, x: string): string | null {
  if (graph.hasNode(x)) return x;
  return resolveSeeds(graph, x, { limit: 1 })[0]?.id ?? null;
}

export function explain(graph: DsGraph, x: string): ExplainResult | null {
  const id = resolveOne(graph, x);
  if (!id) return null;
  const node = nodeOf(graph, id);

  const byRelation = new Map<string, NeighborRef[]>();
  const add = (relation: string, ref: NeighborRef) => {
    const group = byRelation.get(relation);
    if (group) group.push(ref);
    else byRelation.set(relation, [ref]);
  };

  graph.forEachOutEdge(id, (key, _a, _s, target) => {
    const edge = edgeOf(graph, key);
    add(edge.relation, {
      id: target,
      label: labelOf(nodeOf(graph, target)),
      direction: "out",
      confidence: edge.confidence,
      props: edge.props,
    });
  });
  graph.forEachInEdge(id, (key, _a, source) => {
    const edge = edgeOf(graph, key);
    add(edge.relation, {
      id: source,
      label: labelOf(nodeOf(graph, source)),
      direction: "in",
      confidence: edge.confidence,
      props: edge.props,
    });
  });

  return {
    id,
    label: labelOf(node),
    type: node.type,
    props: node.props,
    groups: [...byRelation.entries()].map(([relation, neighbors]) => ({ relation, neighbors })),
    sharesValueWith: node.type === NodeType.Token ? sharesValueWith(graph, id) : [],
  };
}

/** Other tokens reaching the same RawValue(s) this token has-value to. */
function sharesValueWith(graph: DsGraph, tokenId: string): { id: string; label: string }[] {
  const siblings = new Map<string, string>();
  graph.forEachOutEdge(tokenId, (key, _a, _s, valueId) => {
    if (edgeOf(graph, key).relation !== EdgeRelation.hasValue) return;
    graph.forEachInEdge(valueId, (k2, _a2, otherToken) => {
      if (edgeOf(graph, k2).relation !== EdgeRelation.hasValue) return;
      if (otherToken !== tokenId) siblings.set(otherToken, labelOf(nodeOf(graph, otherToken)));
    });
  });
  return [...siblings.entries()].map(([id, label]) => ({ id, label }));
}
