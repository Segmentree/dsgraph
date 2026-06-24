import { describe, it, expect } from "vitest";
import { parseRatio, parseDuration } from "./scalar.js";

describe("parseRatio", () => {
  it("parses a plain unitless number (line-height)", () => {
    expect(parseRatio("1.5", "lineHeight")).toEqual({ key: "1.5@lineHeight", value: 1.5 });
  });

  it("parses a percentage into a 0..1 ratio (opacity)", () => {
    expect(parseRatio("50%", "opacity")).toEqual({ key: "0.5@opacity", value: 0.5 });
  });

  it("parses an a/b aspect ratio", () => {
    expect(parseRatio("16/9", "aspectRatio")!.value).toBeCloseTo(1.7778, 3);
  });

  it("scopes the key so 0.5 opacity ≠ 0.5 line-height", () => {
    expect(parseRatio("0.5", "opacity")!.key).not.toBe(parseRatio("0.5", "lineHeight")!.key);
  });

  it("rejects junk and divide-by-zero", () => {
    expect(parseRatio("auto")).toBeNull();
    expect(parseRatio("16/0")).toBeNull();
  });
});

describe("parseDuration", () => {
  it("parses ms directly", () => {
    expect(parseDuration("200ms")).toEqual({ key: "200ms", ms: 200 });
  });

  it("converts seconds to ms", () => {
    expect(parseDuration("0.2s")).toEqual({ key: "200ms", ms: 200 });
  });

  it("treats a unitless number as ms", () => {
    expect(parseDuration("150")).toEqual({ key: "150ms", ms: 150 });
  });

  it("rejects non-durations", () => {
    expect(parseDuration("fast")).toBeNull();
  });
});
