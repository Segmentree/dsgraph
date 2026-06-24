import { describe, it, expect } from "vitest";
import { parseColor, deltaE2000 } from "./color.js";
import { parseDimension } from "./dimension.js";
import { canonicalize, rawValueId, categoryToValueType } from "./index.js";

describe("parseColor", () => {
  it("collapses the same color across formats to one key (value-first)", () => {
    // #2563eb == rgb(37,99,235) == its oklch — all one canonical key.
    const hex = parseColor("#2563eb")!;
    const rgb = parseColor("rgb(37, 99, 235)")!;
    expect(hex.key).toBe("37,99,235,255");
    expect(rgb.key).toBe(hex.key);
  });

  it("parses oklch (Tailwind v4) and carries lab + oklch in props", () => {
    const c = parseColor("oklch(54.616% 0.21529 262.896)")!;
    expect(c.oklch[0]).toBeCloseTo(0.546, 2);
    expect(c.rgba[3]).toBe(255);
    expect(c.lab).toHaveLength(3);
  });

  it("rounds fractional alpha to 8-bit (DESIGN §3 alpha rule)", () => {
    const c = parseColor("oklch(50.54% 0.19049 27.505 / 0.102)")!;
    expect(c.rgba[3]).toBe(Math.round(0.102 * 255)); // 26
  });

  it("returns null for unparseable input", () => {
    expect(parseColor("not-a-color")).toBeNull();
  });

  it("the target's secondary/muted/accent are the same value (exact dup)", () => {
    const a = parseColor("oklch(0.97 0 0)")!;
    const b = parseColor("oklch(0.97 0 0)")!;
    expect(a.key).toBe(b.key);
    expect(deltaE2000(a, b)).toBe(0);
  });
});

describe("deltaE2000", () => {
  it("measures perceptual distance and accepts strings or canon", () => {
    const d = deltaE2000("oklch(54.616% 0.21529 262.896)", "oklch(62.31% 0.1881 259.83)");
    expect(d).toBeGreaterThan(9);
    expect(d).toBeLessThan(13); // primary light vs dark — a near-miss around ε
  });

  it("is zero for identical colors", () => {
    expect(deltaE2000("#fff", "#ffffff")).toBe(0);
  });
});

describe("parseDimension", () => {
  it("resolves rem against the root and flags baseAssumed", () => {
    const d = parseDimension("0.625rem", { scope: "radius" })!;
    expect(d.px).toBe(10);
    expect(d.baseAssumed).toBe(true);
    expect(d.key).toBe("10px@radius");
  });

  it("keeps category-scoped keys distinct", () => {
    const sp = parseDimension("16px", { scope: "spacing" })!;
    const fs = parseDimension("16px", { scope: "fontSize" })!;
    expect(sp.key).not.toBe(fs.key);
  });

  it("treats unitless numbers as px (Figma) and parses pt", () => {
    expect(parseDimension("24", { scope: "spacing" })!.px).toBe(24);
    expect(parseDimension("12pt")!.px).toBe(16);
  });

  it("refuses unresolved calc/var (adapter's job)", () => {
    expect(parseDimension("calc(var(--radius) - 2px)")).toBeNull();
    expect(parseDimension("var(--radius)")).toBeNull();
  });
});

describe("canonicalize dispatcher", () => {
  it("builds a color RawValue node with a value-first id", () => {
    const node = canonicalize("oklch(0.97 0 0)", "color")!;
    expect(node.type).toBe("RawValue");
    expect(node.id).toBe(rawValueId("color", node.id.split(":").slice(2).join(":")));
    expect(node.id.startsWith("value:color:")).toBe(true);
    expect(node.props?.valueType).toBe("color");
  });

  it("builds a dimension RawValue scoped by category", () => {
    const node = canonicalize("13.75px", "dimension", { scope: "fontSize" })!;
    expect(node.id).toBe("value:dimension:13.75px@fontSize");
    expect(node.props?.px).toBe(13.75);
  });

  it("normalizes font family and weight", () => {
    expect(canonicalize('"Inter", sans-serif', "fontFamily")!.id).toBe("value:fontFamily:inter");
    expect(canonicalize("semibold", "fontWeight")!.id).toBe("value:fontWeight:600");
  });

  it("returns null for non-canonicalizable types/values", () => {
    expect(canonicalize("0 1px 2px rgba(0,0,0,.1)", "shadow")).toBeNull();
    expect(canonicalize("garbage", "color")).toBeNull();
  });

  it("maps categories to value types", () => {
    expect(categoryToValueType("color")).toBe("color");
    expect(categoryToValueType("radius")).toBe("dimension");
    expect(categoryToValueType("z")).toBe("other");
  });
});
