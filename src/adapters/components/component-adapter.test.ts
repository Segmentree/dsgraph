import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reactComponentAdapter } from "./component-adapter.js";
import { buildClassResolver } from "./class-resolver.js";
import { mergeFragments } from "../../graph.js";
import type { GraphDocument, GraphNode } from "../../schema.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "ui");

const token = (id: string, namespace: string, utility: string): GraphNode => ({
  id,
  type: "Token",
  label: utility,
  props: { tailwind: { namespace, utility } },
});

const resolveClass = buildClassResolver([
  token("token:color:primary", "color", "primary"),
  token("token:color:primary-foreground", "color", "primary-foreground"),
  token("token:color:card-foreground", "color", "card-foreground"),
  token("token:radius:md", "radius", "md"),
]);

const usesToken = (doc: GraphDocument, comp: string) =>
  doc.edges
    .filter((e) => e.source === comp && e.relation === "uses-token")
    .map((e) => ({ target: e.target, slot: e.props?.slot }));

describe("react component adapter (pass 1)", () => {
  let doc: GraphDocument;

  beforeAll(async () => {
    expect(await reactComponentAdapter.detect({ root: fixtureRoot })).toBe(true);
    doc = mergeFragments([await reactComponentAdapter.extract({ root: fixtureRoot, resolveClass })]);
  });

  it("extracts PascalCase JSX-returning components, skips non-components", () => {
    const comps = doc.nodes.filter((n) => n.type === "Component").map((n) => n.label).sort();
    expect(comps).toEqual(["Badge", "BadgeGroup"]);
    expect(doc.nodes.find((n) => n.label === "helper")).toBeUndefined();
  });

  it("marks framework + side on the component node", () => {
    const badge = doc.nodes.find((n) => n.id === "component:Badge@code")!;
    expect(badge.props?.framework).toBe("react");
    expect(badge.props?.side).toBe("code");
  });

  it("emits uses-token edges from className, with slots, skipping off-system utilities", () => {
    const uses = usesToken(doc, "component:Badge@code");
    expect(uses).toContainEqual({ target: "token:color:primary", slot: "surface" });
    expect(uses).toContainEqual({ target: "token:color:primary-foreground", slot: "text" });
    expect(uses).toContainEqual({ target: "token:radius:md", slot: "radius" });
    // px-2 has no spacing token → not an edge
    expect(uses.find((u) => u.target.includes("spacing"))).toBeUndefined();
  });

  it("attributes each component's own className (multi-component file)", () => {
    const uses = usesToken(doc, "component:BadgeGroup@code");
    expect(uses).toEqual([{ target: "token:color:card-foreground", slot: "text" }]);
  });

  it("emits composed-of when a component renders a known component", () => {
    // BadgeGroup renders <Badge/> twice → one composed-of edge, instances: 2.
    const co = doc.edges.filter((e) => e.relation === "composed-of");
    expect(co).toContainEqual(
      expect.objectContaining({
        source: "component:BadgeGroup@code",
        target: "component:Badge@code",
        props: { instances: 2 },
      }),
    );
    // Badge renders only a <span> intrinsic → composes nothing.
    expect(co.find((e) => e.source === "component:Badge@code")).toBeUndefined();
  });

  it("still emits uses-token without a resolver, but skips token edges", async () => {
    const frag = await reactComponentAdapter.extract({ root: fixtureRoot });
    // composed-of needs no resolver; uses-token does.
    expect(frag.edges.some((e) => e.relation === "composed-of")).toBe(true);
    expect(frag.edges.some((e) => e.relation === "uses-token")).toBe(false);
    expect(frag.nodes.filter((n) => n.type === "Component").length).toBe(2);
  });
});

describe("react component adapter — cva variants", () => {
  const cvaRoot = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "cva");
  let doc: GraphDocument;

  beforeAll(async () => {
    doc = mergeFragments([await reactComponentAdapter.extract({ root: cvaRoot, resolveClass })]);
  });

  it("reads variant axes into props_schema", () => {
    const chip = doc.nodes.find((n) => n.id === "component:Chip@code")!;
    expect(chip.props?.props_schema).toEqual({
      tone: ["primary", "muted"],
      size: ["sm", "md"],
    });
  });

  it("pulls token usage out of cva classes (not just className)", () => {
    const uses = usesToken(doc, "component:Chip@code").map((u) => u.target);
    // from cva: rounded-md, bg-primary, text-primary-foreground, bg-card-foreground
    expect(uses).toContain("token:radius:md");
    expect(uses).toContain("token:color:primary");
    expect(uses).toContain("token:color:primary-foreground");
    expect(uses).toContain("token:color:card-foreground");
  });
});
