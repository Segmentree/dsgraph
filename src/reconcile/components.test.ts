import { describe, it, expect } from "vitest";
import { reconcileComponents } from "./components.js";
import type { GraphDocument, GraphEdge, GraphNode } from "../schema.js";

const comp = (id: string, label: string, props?: Record<string, unknown>): GraphNode => ({
  id,
  type: "Component",
  label,
  ...(props ? { props } : {}),
});
const token = (id: string): GraphNode => ({ id, type: "Token", label: id });
const raw = (id: string): GraphNode => ({ id, type: "RawValue", label: id, props: { valueType: "color" } });
const e = (source: string, target: string, relation: GraphEdge["relation"]): GraphEdge => ({
  source,
  target,
  relation,
});
const doc = (nodes: GraphNode[], edges: GraphEdge[]): GraphDocument => ({ version: 1, nodes, edges });

const mapsTo = (r: { edges: GraphEdge[] }) => r.edges.filter((x) => x.relation === "maps-to");

describe("reconcileComponents", () => {
  it("bridges a structurally identical pair as INFERRED (method=structure)", () => {
    const rv = raw("value:color:1");
    const r = reconcileComponents(
      doc(
        [
          comp("component:Button@figma", "Button", { props_schema: { variant: ["ghost"] } }),
          comp("component:Button@code", "Button", { props_schema: { variant: ["ghost"] } }),
          token("token:color:primary@figma"),
          token("token:color:primary"),
          rv,
        ],
        [
          e("component:Button@figma", "token:color:primary@figma", "uses-token"),
          e("component:Button@code", "token:color:primary", "uses-token"),
          e("token:color:primary@figma", rv.id, "has-value"),
          e("token:color:primary", rv.id, "has-value"),
        ],
      ),
    );
    expect(mapsTo(r)).toEqual([
      expect.objectContaining({
        source: "component:Button@figma",
        target: "component:Button@code",
        relation: "maps-to",
        confidence: "INFERRED",
        props: expect.objectContaining({ method: "structure" }),
      }),
    ]);
  });

  it("matches on name alone when neither side has tokens/children/variants", () => {
    const r = reconcileComponents(
      doc([comp("component:Icon@figma", "Icon"), comp("component:Icon@code", "Icon")], []),
    );
    const m = mapsTo(r);
    expect(m).toHaveLength(1);
    expect(m[0]!.confidence).toBe("INFERRED"); // empty axes drop out → score = name sim = 1
  });

  it("does not match dissimilar, structureless components", () => {
    const r = reconcileComponents(
      doc([comp("component:Avatar@figma", "Avatar"), comp("component:Spinner@code", "Spinner")], []),
    );
    expect(mapsTo(r)).toHaveLength(0);
  });

  it("flags drift when a confident match uses different tokens", () => {
    const figRv = raw("value:color:fig");
    const codeRv = raw("value:color:code");
    const r = reconcileComponents(
      doc(
        [
          comp("component:Card@figma", "Card", { props_schema: { variant: ["outline"] } }),
          comp("component:Card@code", "Card", { props_schema: { variant: ["outline"] } }),
          comp("component:Icon@figma", "Icon"),
          comp("component:Icon@code", "Icon"),
          token("token:color:a@figma"),
          token("token:color:b"),
          figRv,
          codeRv,
        ],
        [
          // both Cards render an Icon (shared child name) and share a variant axis,
          // but bind different-valued tokens → high score, low value overlap.
          e("component:Card@figma", "component:Icon@figma", "composed-of"),
          e("component:Card@code", "component:Icon@code", "composed-of"),
          e("component:Card@figma", "token:color:a@figma", "uses-token"),
          e("component:Card@code", "token:color:b", "uses-token"),
          e("token:color:a@figma", figRv.id, "has-value"),
          e("token:color:b", codeRv.id, "has-value"),
        ],
      ),
    );
    const cardMap = mapsTo(r).find((x) => x.source === "component:Card@figma");
    expect(cardMap?.confidence).toBe("INFERRED");
    const drift = r.findings.filter((f) => f.kind === "drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.nodes).toEqual(["component:Card@figma", "component:Card@code"]);
  });

  it("is a no-op when only one side has components", () => {
    const r = reconcileComponents(doc([comp("component:Button@code", "Button")], []));
    expect(r.edges).toHaveLength(0);
    expect(r.findings).toHaveLength(0);
  });
});
