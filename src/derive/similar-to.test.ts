import { describe, it, expect } from "vitest";
import { deriveSimilarTo, DEFAULT_EPSILON } from "./similar-to.js";
import { canonicalize, parseColor } from "../canonicalize/index.js";
import type { GraphDocument, GraphNode } from "../schema.js";

/** A color RawValue node from a string, as the adapters would emit it. */
function colorNode(input: string): GraphNode {
  const c = parseColor(input)!;
  return {
    id: `value:color:${c.key}`,
    type: "RawValue",
    props: { valueType: "color", rgba: c.rgba, lab: c.lab, oklch: c.oklch },
  };
}

const dimNode = (value: string, scope: string) => canonicalize(value, "dimension", { scope })!;
const weightNode = (w: string) => canonicalize(w, "fontWeight")!;
const familyNode = (f: string) => canonicalize(f, "fontFamily")!;

const docOf = (...nodes: GraphNode[]): GraphDocument => ({ version: 1, nodes, edges: [] });
const colorsDoc = (...inputs: string[]) => docOf(...inputs.map(colorNode));

describe("deriveSimilarTo — colors (ΔE)", () => {
  it("connects a near pair below ε and skips a far pair", () => {
    const doc = colorsDoc("oklch(0.97 0 0)", "oklch(0.95 0 0)", "oklch(0.5 0.2 260)");
    const edges = deriveSimilarTo(doc);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("similar-to");
    expect(edges[0]!.props?.deltaE).toBeLessThan(DEFAULT_EPSILON);
    expect(edges[0]!.weight).toBeGreaterThan(0);
  });

  it("weights by closeness (1 - ΔE/ε) at the reported precision", () => {
    const [e] = deriveSimilarTo(colorsDoc("oklch(0.97 0 0)", "oklch(0.95 0 0)"));
    const dE = e!.props!.deltaE as number;
    expect(e!.weight).toBeCloseTo(1 - dE / DEFAULT_EPSILON, 2);
  });

  it("honors a per-type epsilon override", () => {
    const doc = colorsDoc("oklch(0.97 0 0)", "oklch(0.95 0 0)");
    expect(deriveSimilarTo(doc, { epsilon: { color: 0.5 } })).toHaveLength(0);
    expect(deriveSimilarTo(doc, { epsilon: { color: 50 } })).toHaveLength(1);
  });

  it("emits each pair once and never self-links", () => {
    const edges = deriveSimilarTo(colorsDoc("oklch(0.97 0 0)", "oklch(0.96 0 0)", "oklch(0.95 0 0)"), {
      epsilon: { color: 50 },
    });
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.source !== e.target)).toBe(true);
  });
});

describe("deriveSimilarTo — dimensions (relative, scoped)", () => {
  it("connects near dimensions within the same scope", () => {
    const edges = deriveSimilarTo(docOf(dimNode("15px", "fontSize"), dimNode("16px", "fontSize")));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.props?.distance).toBeCloseTo(1 / 16, 2);
  });

  it("never compares across scopes (radius vs fontSize)", () => {
    // 14px@radius and 13.75px@fontSize are numerically adjacent but different scopes.
    const edges = deriveSimilarTo(docOf(dimNode("14px", "radius"), dimNode("13.75px", "fontSize")));
    expect(edges).toHaveLength(0);
  });

  it("treats small absolute gaps as far when relatively large (2 vs 4)", () => {
    const edges = deriveSimilarTo(docOf(dimNode("2px", "spacing"), dimNode("4px", "spacing")));
    expect(edges).toHaveLength(0); // 0.5 relative ≫ ε
  });
});

describe("deriveSimilarTo — fontWeight (ordinal) & fontFamily (lexical)", () => {
  it("connects adjacent font weights", () => {
    expect(deriveSimilarTo(docOf(weightNode("400"), weightNode("500")))).toHaveLength(1);
    expect(deriveSimilarTo(docOf(weightNode("400"), weightNode("700")))).toHaveLength(0);
  });

  it("connects near-spelled family names but not unrelated ones", () => {
    expect(deriveSimilarTo(docOf(familyNode("inter"), familyNode("intern")))).toHaveLength(1);
    expect(deriveSimilarTo(docOf(familyNode("inter"), familyNode("roboto")))).toHaveLength(0);
  });
});

describe("deriveSimilarTo — scoping", () => {
  it("ignores tokens and types with no registered metric", () => {
    const doc: GraphDocument = {
      version: 1,
      nodes: [
        colorNode("oklch(0.97 0 0)"),
        { id: "value:other:z", type: "RawValue", props: { valueType: "other" } },
        { id: "token:color:x", type: "Token", props: { category: "color" } },
      ],
      edges: [],
    };
    expect(deriveSimilarTo(doc, { epsilon: { color: 50 } })).toHaveLength(0);
  });
});
