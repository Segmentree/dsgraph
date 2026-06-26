import { describe, it, expect } from "vitest";
import { reconcileTokens, type ReconcileResult } from "./tokens.js";
import type { GraphDocument, GraphEdge, GraphNode } from "../schema.js";

const fig = (id: string) => `${id}@figma`;

const token = (id: string, label: string): GraphNode => ({ id, type: "Token", label });
const colorRaw = (id: string, lab: [number, number, number]): GraphNode => ({
  id,
  type: "RawValue",
  label: id,
  props: { valueType: "color", lab },
});
const dimRaw = (id: string): GraphNode => ({ id, type: "RawValue", label: id, props: { valueType: "dimension" } });
const hasValue = (tokenId: string, rawId: string): GraphEdge => ({
  source: tokenId,
  target: rawId,
  relation: "has-value",
});
const doc = (nodes: GraphNode[], edges: GraphEdge[]): GraphDocument => ({ version: 1, nodes, edges });

const mapsTo = (r: ReconcileResult) => r.edges.filter((e) => e.relation === "maps-to");
const findingsOf = (r: ReconcileResult, kind: string) => r.findings.filter((f) => f.kind === kind);

describe("reconcileTokens — exact value bridge", () => {
  it("emits an EXTRACTED maps-to for a clean 1↔1 value match (figma → code)", () => {
    const rv = colorRaw("value:color:1", [50, 0, 0]);
    const r = reconcileTokens(
      doc(
        [rv, token(fig("token:color:primary"), "primary"), token("token:color:primary", "primary")],
        [hasValue(fig("token:color:primary"), rv.id), hasValue("token:color:primary", rv.id)],
      ),
    );
    expect(mapsTo(r)).toEqual([
      expect.objectContaining({
        source: "token:color:primary@figma",
        target: "token:color:primary",
        relation: "maps-to",
        confidence: "EXTRACTED",
        props: { method: "value" },
      }),
    ]);
  });

  it("pairs a many-to-many cluster by name (INFERRED) and flags synonyms", () => {
    const rv = colorRaw("value:color:blue", [40, 20, -60]);
    const nodes = [
      rv,
      token(fig("token:color:base/primary"), "base/primary"),
      token(fig("token:color:blue/600"), "blue/600"),
      token("token:color:primary", "primary"),
    ];
    const edges = [
      hasValue(fig("token:color:base/primary"), rv.id),
      hasValue(fig("token:color:blue/600"), rv.id),
      hasValue("token:color:primary", rv.id),
    ];
    const r = reconcileTokens(doc(nodes, edges));
    // best name pair (base/primary ↔ primary) bridges as INFERRED
    expect(mapsTo(r)).toContainEqual(
      expect.objectContaining({
        source: "token:color:base/primary@figma",
        target: "token:color:primary",
        confidence: "INFERRED",
        props: { method: "value+name" },
      }),
    );
    // three names, one value → a synonyms finding listing all of them
    const syn = findingsOf(r, "synonyms");
    expect(syn).toHaveLength(1);
    expect(syn[0]!.nodes).toHaveLength(3);
  });
});

describe("reconcileTokens — near-miss colors", () => {
  it("bridges figma→code within ΔE τ as AMBIGUOUS + near-miss-drift finding", () => {
    const figRv = colorRaw("value:color:fig", [50, 0, 0]);
    const codeRv = colorRaw("value:color:code", [52, 0, 0]); // ΔE ≈ 1.x < τ(3)
    const r = reconcileTokens(
      doc(
        [figRv, codeRv, token(fig("token:color:primary"), "primary"), token("token:color:primary", "primary")],
        [hasValue(fig("token:color:primary"), figRv.id), hasValue("token:color:primary", codeRv.id)],
      ),
    );
    const m = mapsTo(r);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      source: "token:color:primary@figma",
      target: "token:color:primary",
      confidence: "AMBIGUOUS",
      props: { method: "near-miss" },
    });
    expect(typeof m[0]!.props?.deltaE).toBe("number");
    expect(findingsOf(r, "near-miss-drift")).toHaveLength(1);
    // a bridged value is not also reported as an orphan
    expect(findingsOf(r, "orphan-value")).toHaveLength(0);
  });

  it("does NOT bridge when the nearest code color is beyond τ", () => {
    const figRv = colorRaw("value:color:fig", [20, 0, 0]);
    const codeRv = colorRaw("value:color:code", [80, 0, 0]); // ΔE large
    const r = reconcileTokens(
      doc(
        [figRv, codeRv, token(fig("token:color:a"), "a"), token("token:color:b", "b")],
        [hasValue(fig("token:color:a"), figRv.id), hasValue("token:color:b", codeRv.id)],
      ),
      { tau: 3 },
    );
    expect(mapsTo(r)).toHaveLength(0);
    // both values are one-sided → two orphan-value findings (design-only + code-only)
    expect(findingsOf(r, "orphan-value")).toHaveLength(2);
  });
});

describe("reconcileTokens — orphan-value", () => {
  it("flags a design-only value with the figma side", () => {
    const rv = colorRaw("value:color:only", [30, 5, 5]);
    const r = reconcileTokens(doc([rv, token(fig("token:color:brand"), "brand")], [hasValue(fig("token:color:brand"), rv.id)]));
    const orphans = findingsOf(r, "orphan-value");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.props?.side).toBe("figma");
  });
});

describe("reconcileTokens — drift (same name, disjoint values)", () => {
  it("flags a token whose value differs across sides", () => {
    const figRv = dimRaw("value:dimension:8px@spacing");
    const codeRv = dimRaw("value:dimension:16px@spacing");
    const r = reconcileTokens(
      doc(
        [figRv, codeRv, token(fig("token:spacing:gap"), "gap"), token("token:spacing:gap", "gap")],
        [hasValue(fig("token:spacing:gap"), figRv.id), hasValue("token:spacing:gap", codeRv.id)],
      ),
    );
    const drift = findingsOf(r, "drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.nodes).toEqual(
      expect.arrayContaining(["token:spacing:gap@figma", "token:spacing:gap"]),
    );
  });

  it("does not flag drift when the same name shares a value", () => {
    const rv = dimRaw("value:dimension:8px@spacing");
    const r = reconcileTokens(
      doc(
        [rv, token(fig("token:spacing:gap"), "gap"), token("token:spacing:gap", "gap")],
        [hasValue(fig("token:spacing:gap"), rv.id), hasValue("token:spacing:gap", rv.id)],
      ),
    );
    expect(findingsOf(r, "drift")).toHaveLength(0);
    expect(mapsTo(r)).toHaveLength(1); // shared value → exact bridge instead
  });
});
