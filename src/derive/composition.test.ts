import { describe, it, expect } from "vitest";
import { deriveComposition } from "./composition.js";
import { deriveSimilarTo } from "./similar-to.js";
import { canonicalize } from "../values/registry.js";
import { mergeFragments } from "../graph.js";
import type { GraphDocument } from "../schema.js";

const docWith = (...raws: Array<[string, string]>): GraphDocument => ({
  version: 1,
  nodes: raws.map(([raw, vt]) => canonicalize(raw, vt as never)!),
  edges: [],
});

describe("deriveComposition", () => {
  it("materializes a shadow's color as a RawValue + composed-of edge", () => {
    const doc = docWith(["0 1px 2px rgba(0,0,0,0.1)", "shadow"]);
    const frag = deriveComposition(doc);

    const color = frag.nodes.find((n) => n.props?.valueType === "color");
    expect(color).toBeDefined();
    expect(frag.edges).toHaveLength(1);
    expect(frag.edges[0]).toMatchObject({
      source: doc.nodes[0]!.id,
      target: color!.id,
      relation: "composed-of",
    });
  });

  it("links a typography style to its family/size/weight/lineHeight sub-values", () => {
    const doc = docWith(["600 15px/1.5 Inter", "typography"]);
    const frag = deriveComposition(doc);
    const types = frag.nodes.map((n) => n.props?.valueType).sort();
    expect(types).toEqual(["dimension", "fontFamily", "fontWeight", "ratio"]);
    expect(frag.edges.every((e) => e.relation === "composed-of")).toBe(true);
  });

  it("a shadow's color joins palette similarity after composition", () => {
    // a near-grey token color + a shadow whose color is a near grey
    const doc = docWith(["oklch(0.97 0 0)", "color"], ["0 1px 2px oklch(0.95 0 0)", "shadow"]);
    const composed = mergeFragments([{ nodes: doc.nodes, edges: doc.edges }, deriveComposition(doc)]);
    const sim = deriveSimilarTo(composed);
    // the shadow's materialized grey is ΔE-near the token grey
    expect(sim.some((e) => e.relation === "similar-to")).toBe(true);
  });
});
