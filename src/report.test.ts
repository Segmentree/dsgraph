import { describe, it, expect } from "vitest";
import { renderReport } from "./report.js";
import type { GraphDocument, Finding, GraphNode, GraphEdge } from "./schema.js";

const token = (id: string): GraphNode => ({ id, type: "Token", label: id });
const mapsTo = (source: string, target: string, confidence: GraphEdge["confidence"]): GraphEdge => ({
  source,
  target,
  relation: "maps-to",
  confidence,
});

const finding = (kind: Finding["kind"], message: string, props?: Record<string, unknown>): Finding => ({
  kind,
  message,
  nodes: [],
  ...(props ? { props } : {}),
});

describe("renderReport", () => {
  it("celebrates an in-sync system when there are no findings", () => {
    const doc: GraphDocument = {
      version: 1,
      nodes: [token("token:color:primary@figma"), token("token:color:primary")],
      edges: [mapsTo("token:color:primary@figma", "token:color:primary", "EXTRACTED")],
    };
    const md = renderReport(doc);
    expect(md).toContain("# dsgraph — design↔code report");
    expect(md).toContain("**1** figma↔code bridges");
    expect(md).toContain("1 exact");
    expect(md).toContain("in sync");
    // no finding sections rendered
    expect(md).not.toContain("## Drift");
  });

  it("renders a section per finding kind, most-actionable first", () => {
    const doc: GraphDocument = {
      version: 1,
      nodes: [],
      edges: [],
      findings: [
        finding("synonyms", "3 tokens share one value (blue)"),
        finding("drift", "'primary' differs between Figma and code"),
        finding("near-miss-drift", "x ≈ y at ΔE 1.2"),
        finding("orphan-value", "design-only value emerald", { side: "figma" }),
        finding("orphan-value", "code-only value chart-3", { side: "code" }),
      ],
    };
    const md = renderReport(doc);
    // ordering: Drift before Near-miss before Orphan before Synonyms
    expect(md.indexOf("## Drift")).toBeGreaterThan(-1);
    expect(md.indexOf("## Drift")).toBeLessThan(md.indexOf("## Near-miss drift"));
    expect(md.indexOf("## Near-miss drift")).toBeLessThan(md.indexOf("## Orphan values"));
    expect(md.indexOf("## Orphan values")).toBeLessThan(md.indexOf("## Synonyms"));
  });

  it("splits orphan values into design-only and code-only sub-lists", () => {
    const doc: GraphDocument = {
      version: 1,
      nodes: [],
      edges: [],
      findings: [
        finding("orphan-value", "design-only value emerald", { side: "figma" }),
        finding("orphan-value", "code-only value chart-3", { side: "code" }),
      ],
    };
    const md = renderReport(doc);
    expect(md).toContain("**Design-only (1)**");
    expect(md).toContain("emerald");
    expect(md).toContain("**Code-only (1)**");
    expect(md).toContain("chart-3");
  });
});
