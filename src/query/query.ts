/**
 * `query "<q>"` — best-first weighted traversal (DESIGN.md §10.1).
 *
 * Resolve seeds, then grow a subgraph by repeatedly expanding the highest-relevance
 * frontier edge until a node budget is hit. `edgeRelevance` blends edge-class priority
 * (bridge > structural > convention > similarity), the edge's numeric weight, and
 * inverse hop distance, so strong/near things surface first.
 */

import { EDGE_CLASS, EdgeClass, type EdgeRelation } from "../schema.js";
import { resolveSeeds } from "./seeds.js";
import { labelOf, nodeOf, edgeOf, type DsGraph } from "./util.js";

const DEFAULT_BUDGET = 30;

/** Base relevance by edge class. */
const CLASS_PRIORITY: Record<EdgeClass, number> = {
  [EdgeClass.bridge]: 1.0,
  [EdgeClass.structural]: 0.8,
  [EdgeClass.convention]: 0.6,
  [EdgeClass.similarity]: 0.4,
};

export interface QueryNode {
  id: string;
  label: string;
  type: string;
  hop: number;
  relevance: number;
}
export interface QueryResult {
  seeds: string[];
  nodes: QueryNode[];
}

function edgeRelevance(relation: EdgeRelation, weight: number | undefined, hop: number): number {
  const base = CLASS_PRIORITY[EDGE_CLASS[relation]];
  return (base * (weight ?? 1)) / (hop + 1);
}

interface FrontierEdge {
  key: string;
  from: string;
  to: string;
}

export function query(graph: DsGraph, text: string, budget = DEFAULT_BUDGET): QueryResult {
  const seeds = resolveSeeds(graph, text).map((s) => s.id);
  const hop = new Map<string, number>(seeds.map((id) => [id, 0]));
  const relevance = new Map<string, number>(seeds.map((id) => [id, Infinity]));
  const frontier: FrontierEdge[] = [];

  const pushIncident = (id: string) => {
    graph.forEachOutEdge(id, (key, _a, _s, to) => frontier.push({ key, from: id, to }));
    graph.forEachInEdge(id, (key, _a, from) => frontier.push({ key, from: id, to: from }));
  };
  seeds.forEach(pushIncident);

  while (frontier.length > 0 && hop.size < budget) {
    // Pop the highest-relevance frontier edge (small graphs → linear scan is fine).
    let bestIdx = 0;
    let bestRel = -Infinity;
    for (let i = 0; i < frontier.length; i++) {
      const f = frontier[i]!;
      const edge = edgeOf(graph, f.key);
      const rel = edgeRelevance(edge.relation, edge.weight, hop.get(f.from) ?? 0);
      if (rel > bestRel) {
        bestRel = rel;
        bestIdx = i;
      }
    }
    const { from, to } = frontier.splice(bestIdx, 1)[0]!;
    if (hop.has(to)) continue;

    hop.set(to, (hop.get(from) ?? 0) + 1);
    relevance.set(to, bestRel);
    pushIncident(to);
  }

  const nodes: QueryNode[] = [...hop.keys()].map((id) => {
    const node = nodeOf(graph, id);
    return {
      id,
      label: labelOf(node),
      type: node.type,
      hop: hop.get(id)!,
      relevance: relevance.get(id) === Infinity ? 1 : Math.round((relevance.get(id) ?? 0) * 1000) / 1000,
    };
  });
  nodes.sort((a, b) => a.hop - b.hop || b.relevance - a.relevance || a.id.localeCompare(b.id));
  return { seeds, nodes };
}
