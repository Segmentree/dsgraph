import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { figmaAdapter, extractFromCapture } from "./figma-adapter.js";
import { isFigmaCapture, type FigmaCapture } from "./figma-capture.js";
import { canonicalize } from "../../canonicalize/index.js";
import type { GraphEdge, GraphFragment } from "../../schema.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const capture = JSON.parse(readFileSync(join(fixtureDir, "figma.json"), "utf8")) as FigmaCapture;

const edge = (frag: GraphFragment, rel: string, source?: string): GraphEdge[] =>
  frag.edges.filter((e) => e.relation === rel && (source === undefined || e.source === source));

describe("figma capture validation", () => {
  it("accepts the fixture and rejects non-captures", () => {
    expect(isFigmaCapture(capture)).toBe(true);
    expect(isFigmaCapture({ source: "code" })).toBe(false);
    expect(isFigmaCapture({ source: "figma", tokens: {} })).toBe(false);
    expect(isFigmaCapture(null)).toBe(false);
  });
});

describe("figma adapter — token ingest + value bridge", () => {
  let frag: GraphFragment;
  beforeAll(() => {
    frag = extractFromCapture(capture);
  });

  it("mints a Token@figma per variable, tagged side=figma", () => {
    const primary = frag.nodes.find((n) => n.id === "token:color:base/primary@figma")!;
    expect(primary.type).toBe("Token");
    expect(primary.props?.side).toBe("figma");
    expect(primary.props?.category).toBe("color");
  });

  it("canonicalizes values onto shared RawValue ids (the bridge)", () => {
    // both names carry #2563eb → has-value edges to the SAME RawValue (synonym case).
    const blueId = canonicalize("#2563eb", "color")!.id;
    const hv = edge(frag, "has-value").filter((e) => e.target === blueId);
    const sources = hv.map((e) => e.source).sort();
    expect(sources).toContain("token:color:base/primary@figma");
    expect(sources).toContain("token:color:tailwind colors/blue/600@figma");
  });

  it("scope-keys dimensions as px so they match the code side", () => {
    const eight = canonicalize("8", "dimension", { scope: "spacing" })!;
    expect(eight.id).toBe("value:dimension:8px@spacing");
    expect(eight.props?.px).toBe(8);
    const hv = edge(frag, "has-value").find(
      (e) => e.source === "token:spacing:spacing/2@figma" && e.target === eight.id,
    );
    expect(hv).toBeTruthy();
  });

  it("emits per-mode has-value edges with a mode prop", () => {
    const bg = edge(frag, "has-value").filter((e) => e.source === "token:color:base/background@figma");
    const modes = bg.map((e) => e.props?.mode).sort();
    expect(modes).toEqual(["dark", "light"]);
  });

  it("keeps an un-canonicalizable composite value visible, not dropped", () => {
    const shadow = frag.nodes.find((n) => n.id === "token:shadow:shadow/xs@figma")!;
    expect(shadow.props?.unresolvedValue).toContain("Effect(");
    // no RawValue minted for it
    expect(edge(frag, "has-value").some((e) => e.source === "token:shadow:shadow/xs@figma")).toBe(false);
  });

  it("links variable aliases with an aliases edge", () => {
    const al = edge(frag, "aliases");
    expect(al).toContainEqual(
      expect.objectContaining({
        source: "token:color:base/primary-alias@figma",
        target: "token:color:base/primary@figma",
      }),
    );
  });
});

describe("figma adapter — components, instances, screens", () => {
  let frag: GraphFragment;
  beforeAll(() => {
    frag = extractFromCapture(capture);
  });

  it("mints Component@figma with variant axes in props_schema", () => {
    const button = frag.nodes.find((n) => n.id === "component:Button@figma")!;
    expect(button.type).toBe("Component");
    expect(button.props?.side).toBe("figma");
    expect(button.props?.props_schema).toEqual({ variant: ["ghost", "outline"], size: ["sm", "icon"] });
  });

  it("emits uses-token from bound variables, with slots", () => {
    const uses = edge(frag, "uses-token", "component:Button@figma").map((e) => ({
      target: e.target,
      slot: e.props?.slot,
    }));
    expect(uses).toContainEqual({ target: "token:color:base/primary@figma", slot: "surface" });
    expect(uses).toContainEqual({ target: "token:radius:border-radius/rounded-full@figma", slot: "radius" });
  });

  it("emits composed-of for nested components only", () => {
    expect(edge(frag, "composed-of", "component:Button@figma")).toContainEqual(
      expect.objectContaining({ target: "component:Icon@figma" }),
    );
    // Icon composes nothing
    expect(edge(frag, "composed-of", "component:Icon@figma")).toHaveLength(0);
  });

  it("emits Instance + instance-of with host and bindings", () => {
    const inst = frag.nodes.find((n) => n.type === "Instance")!;
    expect(inst.label).toBe("Button");
    expect(inst.props?.host).toBe("Contact details");
    expect(inst.props?.bindings).toEqual({ variant: "ghost", size: "icon" });
    expect(edge(frag, "instance-of", inst.id)).toContainEqual(
      expect.objectContaining({ target: "component:Button@figma" }),
    );
  });

  it("emits Screen + renders-on to placed components", () => {
    const screen = frag.nodes.find((n) => n.type === "Screen")!;
    expect(screen.label).toBe("Contact details");
    expect(edge(frag, "renders-on", screen.id)).toContainEqual(
      expect.objectContaining({ target: "component:Button@figma" }),
    );
  });
});

describe("figma adapter — disk IO (detect + extract)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dsgraph-figma-"));
    await mkdir(join(root, "dsgraph-out"));
    await writeFile(join(root, "dsgraph-out", "figma.json"), JSON.stringify(capture));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects a figma.json and ingests it", async () => {
    expect(await figmaAdapter.detect({ root })).toBe(true);
    const frag = await figmaAdapter.extract({ root });
    expect(frag.nodes.some((n) => n.id === "component:Button@figma")).toBe(true);
  });

  it("does not fire when no figma.json is present", async () => {
    const empty = await mkdtemp(join(tmpdir(), "dsgraph-empty-"));
    expect(await figmaAdapter.detect({ root: empty })).toBe(false);
    await rm(empty, { recursive: true, force: true });
  });
});
