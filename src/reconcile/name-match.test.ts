import { describe, it, expect } from "vitest";
import { normalizeName, nameSimilarity, greedyNameMatch } from "./name-match.js";

describe("normalizeName", () => {
  it("strips case, separators, and collapses scale numbers", () => {
    expect(normalizeName("base/primary")).toBe("baseprimary");
    expect(normalizeName("Border-Radius/rounded-md")).toBe("borderradiusroundedmd");
    expect(normalizeName("blue-600")).toBe("blue#");
    expect(normalizeName("zinc/50")).toBe("zinc#"); // 600 and 50 both collapse to one marker
  });

  it("drops mode/qualifier words so primary-dark ~ primary", () => {
    expect(normalizeName("primary-dark")).toBe("primary");
    expect(normalizeName("primary")).toBe("primary");
  });
});

describe("nameSimilarity", () => {
  it("is 1 for names equal after normalization", () => {
    expect(nameSimilarity("Primary-Dark", "primary")).toBe(1);
    expect(nameSimilarity("base/primary", "base-primary")).toBe(1);
  });

  it("ranks a closer name higher", () => {
    const close = nameSimilarity("base/primary", "primary");
    const far = nameSimilarity("tailwind colors/blue/600", "primary");
    expect(close).toBeGreaterThan(far);
  });
});

describe("greedyNameMatch", () => {
  it("pairs by best similarity without reusing either side", () => {
    const left = ["base/primary", "tailwind colors/blue/600"];
    const right = ["primary"];
    const { pairs, leftoverA, leftoverB } = greedyNameMatch(left, right, (s) => s);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.a).toBe("base/primary"); // closer to "primary" than the blue scale name
    expect(leftoverA).toEqual(["tailwind colors/blue/600"]);
    expect(leftoverB).toEqual([]);
  });
});
