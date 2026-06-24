import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { walkTheme, tailwindConfigAdapter } from "./tailwind-config.js";
import { mergeFragments } from "../graph.js";
import type { GraphDocument } from "../schema.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const token = (doc: GraphDocument, id: string) => doc.nodes.find((n) => n.id === id);
const valueOf = (doc: GraphDocument, source: string) =>
  doc.edges.find((e) => e.source === source && e.relation === "has-value")?.target;

// A small slice of a *resolved* Tailwind theme (post resolveConfig).
const theme = {
  colors: {
    white: "#ffffff",
    gray: { 100: "#f3f4f6", 500: "#6b7280" },
    brand: { DEFAULT: "#2563eb" },
    transparentFn: () => "rgba(0,0,0,0)", // opacity-aware color → skipped
  },
  spacing: { 0: "0px", 4: "1rem" },
  fontSize: { sm: ["0.875rem", { lineHeight: "1.25rem" }], base: "1rem" },
  fontFamily: { sans: ["Inter", "ui-sans-serif", "sans-serif"] },
  borderRadius: { DEFAULT: "0.25rem", lg: "0.5rem" },
  boxShadow: { sm: "0 1px 2px rgba(0,0,0,.05)" },
  zIndex: { 10: "10" },
  screens: { md: "768px" }, // unmapped section → ignored
};

describe("walkTheme", () => {
  const doc = mergeFragments([walkTheme(theme, "tailwind.config.js")]);

  it("flattens nested scales with dashed names; DEFAULT collapses to the parent", () => {
    expect(token(doc, "token:color:gray-100")).toBeDefined();
    expect(token(doc, "token:color:brand")).toBeDefined(); // brand.DEFAULT → brand
    expect(token(doc, "token:color:gray-500")?.props?.tailwind).toEqual({
      section: "colors",
      utility: "gray-500",
    });
  });

  it("canonicalizes colors to value-first RawValues", () => {
    expect(valueOf(doc, "token:color:white")).toBe("value:color:255,255,255,255");
    expect(valueOf(doc, "token:color:brand")).toBe("value:color:37,99,235,255");
  });

  it("takes the size from a fontSize tuple and scopes dimensions by category", () => {
    expect(valueOf(doc, "token:fontSize:sm")).toBe("value:dimension:14px@fontSize");
    expect(valueOf(doc, "token:spacing:4")).toBe("value:dimension:16px@spacing");
  });

  it("normalizes a font-family stack to its first family", () => {
    expect(valueOf(doc, "token:fontFamily:sans")).toBe("value:fontFamily:inter");
  });

  it("canonicalizes box-shadow into a composite shadow RawValue", () => {
    expect(valueOf(doc, "token:shadow:sm")).toBe("value:shadow:0,1,2,0,0,0,0,13");
  });

  it("keeps tokens whose values can't canonicalize, flagged unresolved", () => {
    // zIndex maps to `other`, which has no descriptor → kept but unresolved.
    expect(valueOf(doc, "token:z:10")).toBeUndefined();
    expect(token(doc, "token:z:10")?.props?.unresolvedValue).toBe("10");
  });

  it("skips function-valued colors and unmapped sections", () => {
    expect(token(doc, "token:color:transparentFn")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id.includes("md"))).toBeUndefined(); // screens ignored
  });

  it("emits no dangling edges", () => {
    const ids = new Set(doc.nodes.map((n) => n.id));
    expect(doc.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });
});

describe("tailwindConfigAdapter.detect", () => {
  it("fires when a tailwind.config.* exists", async () => {
    expect(await tailwindConfigAdapter.detect({ root: join(fixtures, "tw3") })).toBe(true);
  });

  it("does not fire on the v4 (CSS-first) fixture", async () => {
    expect(await tailwindConfigAdapter.detect({ root: join(fixtures, "tw4") })).toBe(false);
  });
});
