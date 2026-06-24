import { describe, it, expect } from "vitest";
import { resolveVars, evalCalc, resolveValue, type VarTable } from "./css-resolve.js";

const table: VarTable = new Map([
  ["radius", "0.625rem"],
  ["primary", "oklch(0.5 0.2 260)"],
  ["a", "var(--b)"],
  ["b", "4px"],
]);

describe("resolveVars", () => {
  it("expands a direct reference", () => {
    expect(resolveVars("var(--primary)", table)).toBe("oklch(0.5 0.2 260)");
  });

  it("expands nested references", () => {
    expect(resolveVars("var(--a)", table)).toBe("4px");
  });

  it("uses the fallback when the var is undefined", () => {
    expect(resolveVars("var(--missing, 12px)", table)).toBe("12px");
  });

  it("returns null when a ref is unresolvable and has no fallback", () => {
    expect(resolveVars("var(--missing)", table)).toBeNull();
  });

  it("keeps it embedded inside a larger expression", () => {
    expect(resolveVars("calc(var(--radius) - 2px)", table)).toBe("calc(0.625rem - 2px)");
  });
});

describe("evalCalc", () => {
  it("folds subtraction over lengths (rem→px at 16)", () => {
    expect(evalCalc("calc(0.625rem - 2px)")).toBe("8px"); // 10 - 2
  });

  it("respects precedence and parentheses", () => {
    expect(evalCalc("calc((1rem + 2px) * 2)")).toBe("36px"); // (16+2)*2
  });

  it("passes through values with no calc", () => {
    expect(evalCalc("13.75px")).toBe("13.75px");
  });

  it("returns null for unsupported calc content", () => {
    expect(evalCalc("calc(100% - 2px)")).toBeNull();
  });
});

describe("resolveValue", () => {
  it("expands vars then folds calc end to end", () => {
    expect(resolveValue("calc(var(--radius) - 4px)", table)).toBe("6px"); // 10 - 4
    expect(resolveValue("var(--radius)", table)).toBe("0.625rem"); // no calc → canonicalizer converts
  });

  it("returns null on an unresolvable var", () => {
    expect(resolveValue("var(--nope)", table)).toBeNull();
  });
});
