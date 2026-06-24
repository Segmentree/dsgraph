import { describe, it, expect } from "vitest";
import {
  mergeFragments,
  toGraphology,
  findDanglingEdges,
  edgeKey,
} from "./graph.js";
import type { GraphFragment } from "./schema.js";

const frag = (f: Partial<GraphFragment>): GraphFragment => ({
  nodes: [],
  edges: [],
  ...f,
});

describe("mergeFragments", () => {
  it("dedups nodes by id and merges sources + props", () => {
    const a = frag({
      nodes: [
        {
          id: "token:color:surface-100",
          type: "Token",
          label: "surface-100",
          props: { category: "color" },
          sources: [{ adapter: "tailwind", file: "tailwind.config.js" }],
        },
      ],
    });
    const b = frag({
      nodes: [
        {
          id: "token:color:surface-100",
          type: "Token",
          props: { tier: "semantic" },
          sources: [{ adapter: "css-vars", file: "Colors.ts" }],
        },
      ],
    });

    const doc = mergeFragments([a, b]);
    expect(doc.nodes).toHaveLength(1);
    const node = doc.nodes[0]!;
    expect(node.label).toBe("surface-100");
    expect(node.props).toEqual({ category: "color", tier: "semantic" });
    expect(node.sources).toHaveLength(2);
  });

  it("dedups identical sources", () => {
    const s = { adapter: "tailwind", file: "tailwind.config.js" };
    const doc = mergeFragments([
      frag({ nodes: [{ id: "n", type: "Token", sources: [s] }] }),
      frag({ nodes: [{ id: "n", type: "Token", sources: [s] }] }),
    ]);
    expect(doc.nodes[0]!.sources).toHaveLength(1);
  });

  it("dedups edges by (source, relation, target)", () => {
    const edge = {
      source: "a",
      target: "b",
      relation: "uses-token" as const,
      props: { instances: 1 },
    };
    const doc = mergeFragments([
      frag({ edges: [edge] }),
      frag({ edges: [{ ...edge, props: { slot: "surface" } }] }),
    ]);
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0]!.props).toEqual({ instances: 1, slot: "surface" });
  });

  it("throws on conflicting node types for the same id", () => {
    expect(() =>
      mergeFragments([
        frag({ nodes: [{ id: "x", type: "Token" }] }),
        frag({ nodes: [{ id: "x", type: "Component" }] }),
      ]),
    ).toThrow(/conflicting types/);
  });
});

describe("toGraphology", () => {
  it("loads nodes and edges, skipping danglers", () => {
    const doc = mergeFragments([
      frag({
        nodes: [
          { id: "a", type: "Token" },
          { id: "b", type: "RawValue" },
        ],
        edges: [
          { source: "a", target: "b", relation: "has-value" },
          { source: "a", target: "ghost", relation: "uses-token" },
        ],
      }),
    ]);

    expect(findDanglingEdges(doc)).toHaveLength(1);
    const { graph, skipped } = toGraphology(doc);
    expect(graph.order).toBe(2);
    expect(graph.size).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(graph.hasEdge(edgeKey({ source: "a", target: "b", relation: "has-value" }))).toBe(
      true,
    );
  });
});
