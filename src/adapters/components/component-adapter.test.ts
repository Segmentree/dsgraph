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

  it("emits no edges when no resolver is provided", async () => {
    const frag = await reactComponentAdapter.extract({ root: fixtureRoot });
    expect(frag.edges).toHaveLength(0);
    expect(frag.nodes.filter((n) => n.type === "Component").length).toBe(2);
  });
});
