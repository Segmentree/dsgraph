import { describe, it, expect } from "vitest";
import { analyzeGraph } from "./findings.js";
import type { Finding, GraphDocument, GraphEdge, GraphNode } from "../schema.js";

const comp = (id: string): GraphNode => ({ id, type: "Component", label: id.replace(/^component:|@code$/g, "") });
const token = (id: string): GraphNode => ({ id, type: "Token", label: id.replace(/^token:\w+:/, "") });
const raw = (id: string): GraphNode => ({ id, type: "RawValue", label: id });
const e = (source: string, target: string, relation: GraphEdge["relation"]): GraphEdge => ({ source, target, relation });
const doc = (nodes: GraphNode[], edges: GraphEdge[]): GraphDocument => ({ version: 1, nodes, edges });
const kinds = (f: Finding[], k: string): Finding[] => f.filter((x) => x.kind === k);

describe("analyzeGraph — unused tokens & orphan components", () => {
  it("flags a token with no uses-token in-edges", () => {
    const f = analyzeGraph(doc([token("token:color:ghost")], []));
    expect(kinds(f, "unused-token")).toHaveLength(1);
  });

  it("does not flag a token that is used", () => {
    const f = analyzeGraph(
      doc(
        [token("token:color:primary"), comp("component:Button@code")],
        [e("component:Button@code", "token:color:primary", "uses-token")],
      ),
    );
    expect(kinds(f, "unused-token")).toHaveLength(0);
  });

  it("flags a component nothing renders, but not one with a parent", () => {
    const f = analyzeGraph(
      doc(
        [comp("component:Orphan@code"), comp("component:Parent@code"), comp("component:Child@code")],
        [e("component:Parent@code", "component:Child@code", "composed-of")],
      ),
    );
    const orphans = kinds(f, "orphan-component").map((o) => o.nodes[0]);
    expect(orphans).toContain("component:Orphan@code");
    expect(orphans).toContain("component:Parent@code"); // Parent has no inbound either
    expect(orphans).not.toContain("component:Child@code"); // Child is rendered by Parent
  });

  it("ignores the figma side (code-only analysis)", () => {
    const f = analyzeGraph(doc([token("token:color:ghost@figma"), comp("component:X@figma")], []));
    expect(kinds(f, "unused-token")).toHaveLength(0);
    expect(kinds(f, "orphan-component")).toHaveLength(0);
  });
});

describe("analyzeGraph — palette bloat", () => {
  it("flags a similar-to cluster of ≥3 near-identical values on distinct tokens", () => {
    const nodes = [
      raw("value:color:a"), raw("value:color:b"), raw("value:color:c"),
      token("token:color:t1"), token("token:color:t2"), token("token:color:t3"),
    ];
    const edges = [
      e("token:color:t1", "value:color:a", "has-value"),
      e("token:color:t2", "value:color:b", "has-value"),
      e("token:color:t3", "value:color:c", "has-value"),
      e("value:color:a", "value:color:b", "similar-to"),
      e("value:color:b", "value:color:c", "similar-to"),
    ];
    const f = analyzeGraph(doc(nodes, edges));
    expect(kinds(f, "palette-bloat")).toHaveLength(1);
    expect(kinds(f, "palette-bloat")[0]!.nodes).toHaveLength(3); // the three tokens
  });

  it("does not flag a cluster below the minimum", () => {
    const nodes = [raw("value:color:a"), raw("value:color:b"), token("token:color:t1"), token("token:color:t2")];
    const edges = [
      e("token:color:t1", "value:color:a", "has-value"),
      e("token:color:t2", "value:color:b", "has-value"),
      e("value:color:a", "value:color:b", "similar-to"),
    ];
    expect(kinds(analyzeGraph(doc(nodes, edges)), "palette-bloat")).toHaveLength(0);
  });
});

describe("analyzeGraph — component bloat", () => {
  it("flags two components with near-identical token+child usage", () => {
    const nodes = [
      comp("component:CardA@code"), comp("component:CardB@code"), comp("component:Parent@code"),
      token("token:color:bg"), token("token:color:fg"), token("token:radius:md"),
    ];
    // Both cards use the same 3 tokens; wrapped by Parent so neither is an orphan.
    const usage = (c: string) => [
      e(c, "token:color:bg", "uses-token"),
      e(c, "token:color:fg", "uses-token"),
      e(c, "token:radius:md", "uses-token"),
    ];
    const edges = [
      ...usage("component:CardA@code"),
      ...usage("component:CardB@code"),
      e("component:Parent@code", "component:CardA@code", "composed-of"),
      e("component:Parent@code", "component:CardB@code", "composed-of"),
    ];
    const bloat = kinds(analyzeGraph(doc(nodes, edges)), "component-bloat");
    expect(bloat).toHaveLength(1);
    expect(bloat[0]!.nodes).toEqual(
      expect.arrayContaining(["component:CardA@code", "component:CardB@code"]),
    );
  });
});

describe("analyzeGraph — god nodes", () => {
  it("flags the highest-degree token above the threshold", () => {
    const nodes: GraphNode[] = [token("token:color:primary")];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 12; i++) {
      const c = `component:C${i}@code`;
      nodes.push(comp(c));
      edges.push(e(c, "token:color:primary", "uses-token"));
    }
    const gods = kinds(analyzeGraph(doc(nodes, edges)), "god-node");
    expect(gods.some((g) => g.nodes[0] === "token:color:primary")).toBe(true);
  });
});
