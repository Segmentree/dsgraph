/** Shared helpers for the read-side verbs (DESIGN.md §10): graph accessors + normalization. */

import type { MultiDirectedGraph } from "graphology";
import type { NodeAttributes, EdgeAttributes } from "../graph.js";
import type { GraphNode, GraphEdge } from "../schema.js";

export type DsGraph = MultiDirectedGraph<NodeAttributes, EdgeAttributes>;

export const nodeOf = (graph: DsGraph, id: string): GraphNode => graph.getNodeAttribute(id, "node");
export const edgeOf = (graph: DsGraph, key: string): GraphEdge => graph.getEdgeAttribute(key, "edge");

/** Display label for a node: its `label`, else the last id segment. */
export function labelOf(node: GraphNode): string {
  return node.label ?? node.id.split(":").slice(-1)[0] ?? node.id;
}

/** Lowercase and strip separators so `surface-100` ≈ `surface 100` ≈ `surface_100`. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\-_/]+/g, "");
}
