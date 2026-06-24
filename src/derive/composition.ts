/**
 * Value composition layer (DESIGN.md §3, §6a).
 *
 * Composite RawValues (shadow, gradient, typography) carry a `refs` list of the
 * scalar sub-values they're built from. This step re-canonicalizes each ref into
 * its own RawValue and links it with a `composed-of` edge. The payoff: a shadow's
 * color becomes a first-class color RawValue — it joins the palette, participates
 * in ΔE similarity, and `impact` on that color reaches the shadow.
 *
 * Pure: returns a fragment to merge (dedup handles sub-values that equal existing
 * RawValues). Run before `similar-to` so materialized sub-values get compared too.
 */

import { canonicalize } from "../values/registry.js";
import {
  EdgeRelation,
  NodeType,
  Confidence,
  ValueType,
  type GraphDocument,
  type GraphEdge,
  type GraphFragment,
  type GraphNode,
  type ValueType as ValueTypeT,
} from "../schema.js";

interface ValueRef {
  valueType: ValueTypeT;
  raw: string;
  scope?: string;
}

function refsOf(node: GraphNode): ValueRef[] {
  const refs = node.props?.["refs"];
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (r): r is ValueRef => !!r && typeof r.valueType === "string" && typeof r.raw === "string",
  );
}

/** Materialize composite sub-values and the composed-of edges linking to them. */
export function deriveComposition(doc: GraphDocument): GraphFragment {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const node of doc.nodes) {
    if (node.type !== NodeType.RawValue) continue;
    const valueType = node.props?.["valueType"] as ValueType | undefined;
    if (valueType !== ValueType.shadow && valueType !== ValueType.gradient && valueType !== ValueType.typography) {
      continue;
    }
    for (const ref of refsOf(node)) {
      const sub = canonicalize(ref.raw, ref.valueType, ref.scope ? { scope: ref.scope } : {});
      if (!sub) continue;
      nodes.push(sub);
      edges.push({
        source: node.id,
        target: sub.id,
        relation: EdgeRelation.composedOf,
        confidence: Confidence.EXTRACTED,
      });
    }
  }
  return { nodes, edges };
}
