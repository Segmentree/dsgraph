import { describe, it, expect } from "vitest";
import { toGraphology } from "../graph.js";
import { canonicalize } from "../canonicalize/index.js";
import { context } from "./context.js";
import { fakeEmbedder } from "../embed/fake-embedder.js";
import type { DsGraph } from "./util.js";
import type { GraphDocument, GraphEdge, GraphNode } from "../schema.js";

const comp = (id: string, label: string, props?: Record<string, unknown>): GraphNode => ({ id, type: "Component", label, ...(props ? { props } : {}) });
const token = (id: string, label: string): GraphNode => ({ id, type: "Token", label });
const e = (source: string, target: string, relation: GraphEdge["relation"], props?: Record<string, unknown>): GraphEdge => ({ source, target, relation, ...(props ? { props } : {}) });

const blue = canonicalize("#2563eb", "color")!;

function fixture(): DsGraph {
  const doc: GraphDocument = {
    version: 1,
    nodes: [
      comp("component:Button@code", "Button", { props_schema: { variant: ["ghost", "outline"] } }),
      comp("component:Card@code", "Card"),
      comp("component:Icon@code", "Icon"),
      token("token:color:primary", "primary"),
      blue,
    ],
    edges: [
      e("token:color:primary", blue.id, "has-value"),
      e("component:Button@code", "token:color:primary", "uses-token", { slot: "surface" }),
      e("component:Button@code", "component:Icon@code", "composed-of"),
    ],
  };
  return toGraphology(doc).graph;
}

const embedder = fakeEmbedder({
  "primary button": [1, 0, 0],
  Button: [1, 0, 0],
  Card: [0, 1, 0],
  Icon: [0, 0, 1],
});

describe("context", () => {
  it("resolves the described component and builds its kit", async () => {
    const r = await context(fixture(), "primary button", { embedder });
    expect(r.components[0]!.label).toBe("Button");
    expect(r.components[0]!.variants).toEqual({ variant: ["ghost", "outline"] });
    expect(r.components[0]!.tokens).toContainEqual(
      expect.objectContaining({ label: "primary", slot: "surface" }),
    );
    expect(r.components[0]!.siblings.map((s) => s.label)).toContain("Icon");
  });

  it("runs the expressibility check against requested slot values", async () => {
    const r = await context(fixture(), "primary button", {
      embedder,
      slots: [{ slot: "surface", value: "#2563eb" }],
    });
    expect(r.expressibility.component).toBe("REUSE-COMPONENT");
    expect(r.expressibility.base?.label).toBe("Button");
    expect(r.expressibility.slots[0]!.verdict).toBe("REUSE");
  });

  it("works lexically with no embedder (degrades gracefully)", async () => {
    const r = await context(fixture(), "Button", {}); // exact lexical hit
    expect(r.components[0]!.label).toBe("Button");
  });

  it("introduces a component when nothing matches", async () => {
    const r = await context(fixture(), "datepicker", { embedder }); // unknown to fake + lexical
    expect(r.components).toHaveLength(0);
    expect(r.expressibility.component).toBe("INTRODUCE-COMPONENT");
  });
});
