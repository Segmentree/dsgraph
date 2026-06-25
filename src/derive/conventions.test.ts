import { describe, it, expect } from "vitest";
import { deriveCommonlyUsedWith } from "./conventions.js";
import type { GraphDocument, GraphEdge } from "../schema.js";

const composedOf = (parent: string, child: string): GraphEdge => ({
  source: `component:${parent}@code`,
  target: `component:${child}@code`,
  relation: "composed-of",
});
const doc = (edges: GraphEdge[]): GraphDocument => ({ version: 1, nodes: [], edges });

describe("deriveCommonlyUsedWith", () => {
  it("links components co-occurring across ≥ minCo parents, weighted by Jaccard", () => {
    const edges = deriveCommonlyUsedWith(
      doc([
        composedOf("P1", "A"), composedOf("P1", "B"), composedOf("P1", "C"),
        composedOf("P2", "A"), composedOf("P2", "B"),
      ]),
    );
    expect(edges).toHaveLength(1); // only A~B co-occur (twice); A~C and B~C once each
    expect(edges[0]).toMatchObject({
      source: "component:A@code",
      target: "component:B@code",
      relation: "commonly-used-with",
      props: { coCount: 2 },
      weight: 1,
    });
  });

  it("respects the min co-occurrence threshold", () => {
    const d = doc([composedOf("P1", "A"), composedOf("P1", "B")]); // co = 1
    expect(deriveCommonlyUsedWith(d)).toHaveLength(0); // default minCo = 2
    expect(deriveCommonlyUsedWith(d, { minCoOccurrence: 1 })).toHaveLength(1);
  });

  it("weight is < 1 when components also appear apart (Jaccard)", () => {
    const [e] = deriveCommonlyUsedWith(
      doc([
        composedOf("P1", "A"), composedOf("P1", "B"),
        composedOf("P2", "A"), composedOf("P2", "B"),
        composedOf("P3", "A"), // A without B
      ]),
    );
    // count(A)=3, count(B)=2, co=2 → 2/(3+2-2) = 0.667
    expect(e!.weight).toBeCloseTo(0.667, 2);
  });

  it("ignores non-composed-of edges and self-pairs", () => {
    const d = doc([{ source: "component:A@code", target: "token:x", relation: "uses-token" }]);
    expect(deriveCommonlyUsedWith(d)).toHaveLength(0);
  });
});
