import { describe, it, expect } from "vitest";
import { parseShadow, parseGradient, parseTypography } from "./composite.js";

describe("parseShadow", () => {
  it("parses a single layer with offsets, blur, spread and color", () => {
    const s = parseShadow("0 4px 6px -1px rgba(0,0,0,0.1)")!;
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0]).toMatchObject({ offsetX: 0, offsetY: 4, blur: 6, spread: -1, inset: false });
    expect(s.refs).toEqual([{ valueType: "color", raw: "rgba(0,0,0,0.1)" }]);
  });

  it("parses multiple comma-separated layers (commas inside rgba preserved)", () => {
    const s = parseShadow("0 1px 2px rgba(0, 0, 0, .1), inset 0 0 0 1px #fff")!;
    expect(s.layers).toHaveLength(2);
    expect(s.layers[1]!.inset).toBe(true);
    expect(s.refs).toHaveLength(2);
  });

  it("rejects `none` and non-shadows", () => {
    expect(parseShadow("none")).toBeNull();
    expect(parseShadow("not a shadow")).toBeNull();
  });
});

describe("parseGradient", () => {
  it("extracts ordered color stops, ignoring the direction", () => {
    const g = parseGradient("linear-gradient(to right, #fff 0%, #000 100%)")!;
    expect(g.kind).toBe("linear");
    expect(g.stops).toHaveLength(2);
    expect(g.stops[0]).toMatchObject({ position: "0%" });
    expect(g.refs.map((r) => r.valueType)).toEqual(["color", "color"]);
  });

  it("rejects non-gradients", () => {
    expect(parseGradient("#fff")).toBeNull();
  });
});

describe("parseTypography (font shorthand)", () => {
  it("decomposes weight / size / lineHeight / family into refs", () => {
    const t = parseTypography("600 15px/1.5 Inter")!;
    const byType = Object.fromEntries(t.refs.map((r) => [r.valueType, r.raw]));
    expect(byType.fontWeight).toBe("600");
    expect(byType.dimension).toBe("15px");
    expect(byType.ratio).toBe("1.5");
    expect(byType.fontFamily).toBe("Inter");
  });

  it("requires at least a size and a family", () => {
    expect(parseTypography("Inter")).toBeNull();
    expect(parseTypography("15px")).toBeNull();
  });
});
