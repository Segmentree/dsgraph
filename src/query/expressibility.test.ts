import { describe, it, expect, beforeAll } from "vitest";
import { toGraphology } from "../graph.js";
import { canonicalize } from "../canonicalize/index.js";
import { expressibility, Verdict, ComponentVerdict } from "./expressibility.js";
import type { DsGraph } from "./util.js";
import type { GraphDocument, GraphEdge, GraphNode } from "../schema.js";

const comp = (id: string, label: string): GraphNode => ({ id, type: "Component", label });
const token = (id: string, label: string): GraphNode => ({ id, type: "Token", label });
const e = (source: string, target: string, relation: GraphEdge["relation"], props?: Record<string, unknown>): GraphEdge => ({ source, target, relation, ...(props ? { props } : {}) });

// Real canonical colors so ΔE snapping behaves like production.
const blue = canonicalize("#2563eb", "color")!; // base/primary
const grey = canonicalize("#737373", "color")!; // a different in-system value
const nearBlue = "#2a68ec"; // ΔE a few from blue → snaps
const redFar = "#ff0000"; // far from everything → introduce

function graphFixture(): DsGraph {
  const doc: GraphDocument = {
    version: 1,
    nodes: [
      comp("component:Button@code", "Button"),
      token("token:color:primary", "primary"),
      token("token:color:muted", "muted"),
      blue,
      grey,
    ],
    edges: [
      e("token:color:primary", blue.id, "has-value"),
      e("token:color:muted", grey.id, "has-value"),
      // Button binds primary on its surface slot.
      e("component:Button@code", "token:color:primary", "uses-token", { slot: "surface" }),
    ],
  };
  return toGraphology(doc).graph;
}

describe("expressibility — slot verdicts", () => {
  let graph: DsGraph;
  const base = { id: "component:Button@code", label: "Button" };
  beforeAll(() => {
    graph = graphFixture();
  });

  it("REUSE when the value is already on the component's slot", () => {
    const r = expressibility(graph, { base, slots: [{ slot: "surface", value: "#2563eb" }] });
    expect(r.component).toBe(ComponentVerdict.reuse);
    expect(r.slots[0]!.verdict).toBe(Verdict.reuse);
    expect(r.slots[0]!.tokens?.map((t) => t.label)).toEqual(["primary"]);
  });

  it("REUSE-NEW-PROP-COMBO when the value is in-system but not on this slot", () => {
    // grey exists (muted) but Button doesn't bind it on surface.
    const r = expressibility(graph, { base, slots: [{ slot: "surface", value: "#737373" }] });
    expect(r.slots[0]!.verdict).toBe(Verdict.reuseNewPropCombo);
    expect(r.slots[0]!.tokens?.map((t) => t.label)).toEqual(["muted"]);
  });

  it("SNAP-SUGGEST when no exact token but one within ΔE", () => {
    const r = expressibility(graph, { base, slots: [{ slot: "surface", value: nearBlue }] });
    expect(r.slots[0]!.verdict).toBe(Verdict.snapSuggest);
    expect(r.slots[0]!.snapTo?.label).toBe("primary");
    expect(r.slots[0]!.snapTo?.distance).toBeLessThan(10);
  });

  it("INTRODUCE-TOKEN when the value is far from everything", () => {
    const r = expressibility(graph, { base, slots: [{ slot: "surface", value: redFar }] });
    expect(r.slots[0]!.verdict).toBe(Verdict.introduceToken);
  });
});

describe("expressibility — component verdict", () => {
  it("INTRODUCE-COMPONENT with composables when no base resolves", () => {
    const graph = graphFixture();
    const r = expressibility(graph, {
      base: null,
      composables: [{ id: "component:Button@code", label: "Button" }],
      slots: [],
    });
    expect(r.component).toBe(ComponentVerdict.introduce);
    expect(r.composables?.map((c) => c.label)).toEqual(["Button"]);
  });
});
