import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tailwindV4Adapter } from "./tailwind-v4.js";
import { mergeFragments } from "../graph.js";
import type { GraphDocument, GraphEdge } from "../schema.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "tw4");

const token = (doc: GraphDocument, id: string) => doc.nodes.find((n) => n.id === id);
const hasValue = (doc: GraphDocument, source: string): GraphEdge[] =>
  doc.edges.filter((e) => e.source === source && e.relation === "has-value");

describe("tailwind-v4 adapter", () => {
  let doc: GraphDocument;

  beforeAll(async () => {
    expect(await tailwindV4Adapter.detect({ root: fixtureRoot })).toBe(true);
    doc = mergeFragments([await tailwindV4Adapter.extract({ root: fixtureRoot })]);
  });

  it("creates semantic tokens from @theme with the Tailwind utility recorded", () => {
    const primary = token(doc, "token:color:primary")!;
    expect(primary.props?.tier).toBe("semantic");
    expect(primary.props?.category).toBe("color");
    expect(primary.props?.tailwind).toEqual({ namespace: "color", utility: "primary" });
  });

  it("collapses the exposed primitive var, carrying per-mode values", () => {
    const edges = hasValue(doc, "token:color:primary");
    const modes = Object.fromEntries(edges.map((e) => [e.props?.mode, e.target]));
    expect(modes.light).toBe("value:color:37,99,235,255");
    expect(modes.dark).toBe("value:color:59,130,246,255");
  });

  it("resolves calc() and var() radius tokens to px", () => {
    expect(hasValue(doc, "token:radius:md")[0]?.target).toBe("value:dimension:8px@radius");
    expect(hasValue(doc, "token:radius:lg")[0]?.target).toBe("value:dimension:10px@radius");
    // base --radius is consumed by --radius-lg: var(--radius), not a separate token.
    expect(token(doc, "token:radius:radius")).toBeUndefined();
  });

  it("resolves a literal font-size token", () => {
    expect(hasValue(doc, "token:fontSize:sm")[0]?.target).toBe("value:dimension:13.75px@fontSize");
  });

  it("collapses equal values to one RawValue (value-first)", () => {
    const sec = hasValue(doc, "token:color:secondary").find((e) => e.props?.mode === "light");
    const muted = hasValue(doc, "token:color:muted").find((e) => e.props?.mode === "light");
    expect(sec?.target).toBe(muted?.target);
  });

  it("keeps a raw var not exposed via @theme as a primitive token", () => {
    const t = token(doc, "token:color:sidebar-foreground-hover")!;
    expect(t.props?.tier).toBe("primitive");
  });

  it("captures an unknown-namespace token whose value is unambiguous, flagged inferred", () => {
    // `--brand-glow: oklch(...)` — namespace unknown, but oklch() is unambiguously a color.
    const t = token(doc, "token:color:glow")!;
    expect(t.props?.category).toBe("color");
    expect(t.props?.uncategorizedNamespace).toBe("brand");
    expect(t.props?.categoryInferred).toBe(true);
    expect(t.confidence).toBe("INFERRED");
    expect(hasValue(doc, "token:color:glow")[0]?.target).toBe("value:color:222,62,45,255");
  });

  it("does NOT guess a category for an ambiguous bare-number value", () => {
    // `--scale-tight: 100` — could be spacing/z-index/opacity/ms; we refuse to fabricate.
    const t = token(doc, "token:other:tight")!;
    expect(t.props?.category).toBe("other");
    expect(t.props?.categoryInferred).toBe(true);
    expect(hasValue(doc, "token:other:tight")).toHaveLength(0); // no fabricated value
    expect(t.props?.unresolvedValue).toBe("100");
  });

  it("emits no dangling edges", () => {
    const ids = new Set(doc.nodes.map((n) => n.id));
    expect(doc.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });
});
