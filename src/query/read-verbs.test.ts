import { describe, it, expect, beforeAll } from "vitest";
import { mergeFragments, toGraphology } from "../graph.js";
import { deriveSimilarTo } from "../derive/similar-to.js";
import { canonicalize } from "../values/registry.js";
import { resolveSeeds } from "./seeds.js";
import { match } from "./match.js";
import { explain } from "./explain.js";
import { query } from "./query.js";
import type { DsGraph } from "./util.js";
import type { GraphFragment, GraphNode } from "../schema.js";

const tok = (name: string): GraphNode => ({
  id: `token:color:${name}`,
  type: "Token",
  label: name,
  props: { category: "color", tier: "semantic" },
});

const hasValue = (token: string, valueId: string, mode: string) => ({
  source: `token:color:${token}`,
  target: valueId,
  relation: "has-value" as const,
  props: { mode },
});

let graph: DsGraph;

beforeAll(() => {
  const blue = canonicalize("#2563eb", "color")!; // primary light
  const grey = canonicalize("oklch(0.97 0 0)", "color")!; // secondary + muted share this
  const greyNear = canonicalize("oklch(0.95 0 0)", "color")!; // near grey, on `subtle`

  const frag: GraphFragment = {
    nodes: [tok("primary"), tok("secondary"), tok("muted"), tok("subtle"), blue, grey, greyNear],
    edges: [
      hasValue("primary", blue.id, "light"),
      hasValue("secondary", grey.id, "light"),
      hasValue("muted", grey.id, "light"),
      hasValue("subtle", greyNear.id, "light"),
    ],
  };
  const doc = mergeFragments([frag]);
  doc.edges.push(...deriveSimilarTo(doc));
  graph = toGraphology(doc).graph;
});

describe("resolveSeeds", () => {
  it("resolves an exact label to its node", () => {
    expect(resolveSeeds(graph, "primary")[0]?.id).toBe("token:color:primary");
  });
  it("resolves a substring across multiple nodes", () => {
    const ids = resolveSeeds(graph, "mut").map((s) => s.id);
    expect(ids).toContain("token:color:muted");
  });
});

describe("match", () => {
  it("finds the tokens carrying an in-system color", () => {
    const r = match(graph, "oklch(0.97 0 0)");
    expect(r.inSystem).toBe(true);
    expect(r.exact?.tokens.map((t) => t.label).sort()).toEqual(["muted", "secondary"]);
    expect(r.similar.some((s) => s.tokens.some((t) => t.label === "subtle"))).toBe(true);
  });

  it("snaps an off-system color to nearest in-system values", () => {
    const r = match(graph, "#f5f5f6");
    expect(r.inSystem).toBe(false);
    expect(r.nearest[0]?.distance).toBeLessThan(2);
    expect(r.nearest[0]?.tokens.map((t) => t.label)).toContain("secondary");
  });

  it("reports an unparseable input as not-in-system with no matches", () => {
    expect(match(graph, "definitely-not-a-value").inSystem).toBe(false);
  });
});

describe("explain", () => {
  it("groups edges by relation and lists value-sharing siblings", () => {
    const r = explain(graph, "secondary")!;
    expect(r.type).toBe("Token");
    expect(r.groups.find((g) => g.relation === "has-value")).toBeDefined();
    expect(r.sharesValueWith.map((s) => s.label)).toContain("muted");
  });

  it("returns null for an unresolvable seed", () => {
    expect(explain(graph, "zzz-nonexistent")).toBeNull();
  });
});

describe("query", () => {
  it("resolves seeds and expands a budgeted subgraph", () => {
    const r = query(graph, "primary", 10);
    expect(r.seeds).toContain("token:color:primary");
    expect(r.nodes.find((n) => n.id === "token:color:primary")?.hop).toBe(0);
    // the seed's value is reached at hop 1
    expect(r.nodes.some((n) => n.type === "RawValue" && n.hop === 1)).toBe(true);
  });

  it("respects the node budget", () => {
    expect(query(graph, "primary", 2).nodes.length).toBeLessThanOrEqual(2);
  });
});
