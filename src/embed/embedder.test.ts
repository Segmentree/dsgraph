import { describe, it, expect } from "vitest";
import { cosine, rankByEmbedding, type Embedder } from "./embedder.js";
import { fakeEmbedder } from "./fake-embedder.js";

describe("cosine", () => {
  it("is 1 for identical, 0 for orthogonal, -1 for opposite, 0 for degenerate", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("rankByEmbedding", () => {
  it("ranks candidates by cosine to the query, best first", async () => {
    const e = fakeEmbedder({
      "primary button": [1, 0, 0],
      Button: [1, 0, 0],
      Card: [0, 1, 0],
      Tooltip: [0.7, 0.7, 0],
    });
    const ranked = await rankByEmbedding(e, "primary button", [
      { id: "c:Card", label: "Card" },
      { id: "c:Button", label: "Button" },
      { id: "c:Tooltip", label: "Tooltip" },
    ]);
    expect(ranked.map((r) => r.label)).toEqual(["Button", "Tooltip", "Card"]);
    expect(ranked[0]!.score).toBeCloseTo(1, 5);
  });

  it("returns empty for no candidates without calling the model", async () => {
    let called = false;
    const e: Embedder = { async embed() { called = true; return []; } };
    expect(await rankByEmbedding(e, "x", [])).toEqual([]);
    expect(called).toBe(false);
  });
});
