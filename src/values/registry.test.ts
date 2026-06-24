import { describe, it, expect } from "vitest";
import { canonicalize, categoryToValueType, VALUE_TYPES } from "./registry.js";
import { deriveSimilarTo } from "../derive/similar-to.js";
import type { GraphDocument, GraphNode } from "../schema.js";

const docOf = (...nodes: (GraphNode | null)[]): GraphDocument => ({
  version: 1,
  nodes: nodes.filter((n): n is GraphNode => n !== null),
  edges: [],
});

describe("categoryToValueType — expanded coverage", () => {
  it("routes length-family categories to dimension", () => {
    for (const c of ["spacing", "radius", "fontSize", "borderWidth", "blur", "letterSpacing"] as const) {
      expect(categoryToValueType(c)).toBe("dimension");
    }
  });

  it("routes unitless categories to ratio and time to duration", () => {
    for (const c of ["lineHeight", "opacity", "aspectRatio"] as const) {
      expect(categoryToValueType(c)).toBe("ratio");
    }
    expect(categoryToValueType("duration")).toBe("duration");
  });

  it("routes composites and leaves config types as other", () => {
    expect(categoryToValueType("shadow")).toBe("shadow");
    expect(categoryToValueType("gradient")).toBe("gradient");
    expect(categoryToValueType("z")).toBe("other");
    expect(categoryToValueType("easing")).toBe("other");
  });
});

describe("ratio value type", () => {
  it("canonicalizes and scopes by category", () => {
    const lh = canonicalize("1.5", "ratio", { scope: "lineHeight" })!;
    expect(lh.id).toBe("value:ratio:1.5@lineHeight");
    expect(lh.props?.ratio).toBe(1.5);
  });

  it("similarity is relative and stays within scope", () => {
    const near = deriveSimilarTo(
      docOf(canonicalize("1.4", "ratio", { scope: "lineHeight" }), canonicalize("1.5", "ratio", { scope: "lineHeight" })),
    );
    expect(near).toHaveLength(1); // ~6.7% apart < 10%

    const crossScope = deriveSimilarTo(
      docOf(canonicalize("1.5", "ratio", { scope: "lineHeight" }), canonicalize("1.5", "ratio", { scope: "opacity" })),
    );
    expect(crossScope).toHaveLength(0); // different scope groups, never compared
  });
});

describe("duration value type", () => {
  it("canonicalizes ms/s and links near durations", () => {
    expect(canonicalize("0.2s", "duration")!.id).toBe("value:duration:200ms");
    const edges = deriveSimilarTo(docOf(canonicalize("200ms", "duration"), canonicalize("250ms", "duration")));
    expect(edges).toHaveLength(1); // 0.2 relative < 0.3
    expect(deriveSimilarTo(docOf(canonicalize("100ms", "duration"), canonicalize("500ms", "duration")))).toHaveLength(0);
  });
});

describe("registry shape", () => {
  it("every registered descriptor canonicalizes and (if present) its metric is callable", () => {
    for (const [vt, desc] of Object.entries(VALUE_TYPES)) {
      expect(typeof desc!.canonicalize).toBe("function");
      if (desc!.metric) expect(typeof desc!.metric.distance).toBe("function");
      expect(vt.length).toBeGreaterThan(0);
    }
  });
});
