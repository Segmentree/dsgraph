import { describe, it, expect } from "vitest";
import { buildClassResolver } from "./class-resolver.js";
import type { GraphNode } from "../../schema.js";

const token = (id: string, namespace: string, utility: string): GraphNode => ({
  id,
  type: "Token",
  label: utility,
  props: { category: "color", tailwind: { namespace, utility } },
});

const tokens: GraphNode[] = [
  token("token:color:primary", "color", "primary"),
  token("token:color:primary-foreground", "color", "primary-foreground"),
  token("token:color:card-foreground", "color", "card-foreground"),
  token("token:radius:md", "radius", "md"),
  token("token:fontSize:sm", "text", "sm"),
];

const resolver = buildClassResolver(tokens);
const ids = (s: string) => resolver.resolve(s).map((r) => r.tokenId);

describe("buildClassResolver", () => {
  it("resolves color/radius/text utilities to their tokens with slots", () => {
    const r = resolver.resolve("bg-primary text-card-foreground rounded-md");
    expect(r).toEqual([
      { utility: "bg-primary", tokenId: "token:color:primary", slot: "surface" },
      { utility: "text-card-foreground", tokenId: "token:color:card-foreground", slot: "text" },
      { utility: "rounded-md", tokenId: "token:radius:md", slot: "radius" },
    ]);
  });

  it("disambiguates text- by trying color then fontSize", () => {
    expect(ids("text-sm")).toEqual(["token:fontSize:sm"]); // sm is a fontSize token, not color
    expect(ids("text-card-foreground")).toEqual(["token:color:card-foreground"]);
  });

  it("strips variant prefixes and opacity modifiers", () => {
    expect(ids("dark:bg-primary")).toEqual(["token:color:primary"]);
    expect(ids("hover:bg-primary/90")).toEqual(["token:color:primary"]);
    expect(ids("focus-visible:ring-primary/50")).toEqual(["token:color:primary"]); // ring→color/primary
  });

  it("ignores arbitrary values and unmatched utilities (off-system)", () => {
    expect(ids("bg-[#fff]")).toEqual([]); // arbitrary → no token
    expect(ids("p-4 gap-2 shadow-sm")).toEqual([]); // recognized prefixes, no such tokens
    expect(ids("flex items-center")).toEqual([]); // non-token utilities
  });

  it("handles a realistic className blob", () => {
    const r = ids("dark:bg-sidebar bg-background text-card-foreground flex gap-6 rounded-xl border py-6 shadow-sm");
    // only background-ish + card-foreground + radius would resolve IF those tokens existed;
    // here only card-foreground exists → exactly one match
    expect(r).toEqual(["token:color:card-foreground"]);
  });
});
