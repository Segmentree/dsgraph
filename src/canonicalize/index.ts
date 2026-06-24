/**
 * Canonicalization entry point (DESIGN.md §3, §6a).
 *
 * Thin facade over the value-type registry (`../values/registry`): re-exports the
 * canonicalize dispatch and the low-level parsers. The per-type behavior — node
 * shape, metric — lives in the registry so the canonicalize and similarity sides
 * can't drift.
 */

export { parseColor, deltaE2000, isColorSyntax, type ColorCanon } from "./color.js";
export { parseDimension, type DimCanon } from "./dimension.js";
export {
  canonicalize,
  categoryToValueType,
  rawValueId,
  type CanonOptions,
} from "../values/registry.js";
