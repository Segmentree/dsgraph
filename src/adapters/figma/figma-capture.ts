/**
 * `figma.json` capture schema (DESIGN.md §4c).
 *
 * The `/dsgraph` skill calls the Figma Dev Mode MCP and normalizes the result into
 * THIS shape — a small, domain-vocabulary capture, NOT yet a graph fragment. The CLI
 * figma adapter (figma-adapter.ts) ingests it: it mints the `@figma` nodes and, crucially,
 * runs every token value through the SAME `canonicalize()` the code side uses, so a Figma
 * `#2563eb` and a code `oklch(…)` that resolve equal land on the identical `RawValue` id.
 * That shared RawValue is the value bridge reconciliation walks in unit 2 (§7).
 *
 * Keeping canonicalization in the adapter (not the skill) means the skill never has to
 * reproduce our id/ΔE logic — it just reports what Figma says. This file is the contract
 * between the two.
 */

import { TokenCategory, Side, type Slot } from "../../schema.js";

/** Discriminator stored on the capture so a stray JSON can't be mistaken for one. */
export const FIGMA_CAPTURE_SOURCE = Side.figma;

/** Adapter id recorded in node `sources[].adapter`. */
export const FIGMA_ADAPTER_NAME = "figma";

/** Mode key used when a variable has a single, mode-agnostic value. */
export const DEFAULT_MODE = "default";

/**
 * One design variable (`get_variable_defs`). `modes` carries per-mode resolved values
 * (`{ light: "#2563eb", dark: "#60a5fa" }`); a single-mode variable uses `DEFAULT_MODE`.
 * `category` drives canonicalizer dispatch — the skill derives it from the variable's
 * Figma type / collection-name prefix (`spacing/…`, `base/…` color, `font-weight/…`).
 */
export interface FigmaToken {
  /** Variable name, slash-pathed as Figma reports it, e.g. `base/primary`. */
  name: string;
  category?: TokenCategory;
  /** ≥1 mode → resolved value string (hex, unitless px number, `Font(…)`, `Effect(…)`). */
  modes: Record<string, string>;
  /** Name of another token this variable resolves to (variable alias) → `aliases` edge. */
  alias?: string;
}

/** A bound variable on a component property → a `uses-token` edge (+ slot). */
export interface FigmaBinding {
  /** Token name this property binds (must match a `FigmaToken.name`). */
  token: string;
  slot?: Slot;
}

/** A COMPONENT / COMPONENT_SET (`get_metadata`) + its bindings (`get_design_context`). */
export interface FigmaComponent {
  /** Component name, e.g. `Button`. */
  name: string;
  /** Figma node id, for provenance (`34243:31750`). */
  nodeId?: string;
  /** Variant axes from a COMPONENT_SET, e.g. `{ variant: ["ghost","outline"], size: ["sm","icon"] }`. */
  propsSchema?: Record<string, string[]>;
  /** Bound variables → `uses-token` edges. */
  uses?: FigmaBinding[];
  /** Names of components nested inside (nested instances) → `composed-of` edges. */
  children?: string[];
}

/** An INSTANCE placed on a screen/parent → `Instance` node + `instance-of` edge. */
export interface FigmaInstance {
  /** Name of the component this instantiates (must match a `FigmaComponent.name`). */
  of: string;
  nodeId?: string;
  /** Screen or parent-component name this instance sits in. */
  host?: string;
  /** Variant prop values bound on this instance, e.g. `{ variant: "ghost" }`. */
  bindings?: Record<string, string>;
}

/** A top-level FRAME → `Screen` node; `renders` are the components placed directly on it. */
export interface FigmaScreen {
  name: string;
  nodeId?: string;
  /** Component names rendered directly on the screen → `renders-on` edges. */
  renders?: string[];
}

/** The whole `figma.json` document. Every list is optional (a partial capture is valid). */
export interface FigmaCapture {
  source: typeof FIGMA_CAPTURE_SOURCE;
  /** Figma file key, for provenance. */
  fileKey?: string;
  tokens?: FigmaToken[];
  components?: FigmaComponent[];
  instances?: FigmaInstance[];
  screens?: FigmaScreen[];
}

/** Structural validation: enough to reject a non-capture JSON without a schema lib. */
export function isFigmaCapture(value: unknown): value is FigmaCapture {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["source"] !== FIGMA_CAPTURE_SOURCE) return false;
  for (const key of ["tokens", "components", "instances", "screens"] as const) {
    if (v[key] !== undefined && !Array.isArray(v[key])) return false;
  }
  return true;
}

// ── id scheme (parallels the code side; `@figma`-suffixed so both sides coexist) ──────

const COMPONENT_NS = "component";
const TOKEN_NS = "token";
const INSTANCE_NS = "instance";
const SCREEN_NS = "screen";
/** Side suffix that keeps a Figma node distinct from its code twin (matched later via maps-to). */
export const FIGMA_SUFFIX = `@${Side.figma}`;

export const figmaComponentId = (name: string): string => `${COMPONENT_NS}:${name}${FIGMA_SUFFIX}`;
export const figmaTokenId = (category: TokenCategory, name: string): string =>
  `${TOKEN_NS}:${category}:${name}${FIGMA_SUFFIX}`;
export const figmaInstanceId = (key: string): string => `${INSTANCE_NS}:${Side.figma}:${key}`;
export const figmaScreenId = (key: string): string => `${SCREEN_NS}:${Side.figma}:${key}`;
