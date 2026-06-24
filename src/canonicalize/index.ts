/**
 * Canonicalization entry point (DESIGN.md §3, §6a).
 *
 * `canonicalize(value, valueType)` dispatches to the per-type canonicalizer and
 * returns a ready-to-merge `RawValue` node (or null if the value can't be
 * canonicalized — the adapter then records an off-system binding). Token category
 * maps to a value type via `categoryToValueType`; dimensions carry the category as
 * a key `scope` so `16px` spacing and `16px` font-size stay distinct nodes.
 */

import {
  NodeType,
  TokenCategory,
  ValueType,
  type RawValueNode,
} from "../schema.js";
import { parseColor } from "./color.js";
import { parseDimension } from "./dimension.js";

export { parseColor, deltaE2000, type ColorCanon } from "./color.js";
export { parseDimension, type DimCanon } from "./dimension.js";

/** Id namespace for RawValue nodes: `value:<valueType>:<key>`. */
const RAW_VALUE_NS = "value";

/** `value:<valueType>:<key>` — the RawValue node id. */
export function rawValueId(valueType: ValueType, key: string): string {
  return `${RAW_VALUE_NS}:${valueType}:${key}`;
}

/** Map a token category to the value type whose canonicalizer handles it. */
export function categoryToValueType(category: TokenCategory): ValueType {
  switch (category) {
    case TokenCategory.color:
      return ValueType.color;
    case TokenCategory.spacing:
    case TokenCategory.radius:
    case TokenCategory.fontSize:
    case TokenCategory.lineHeight:
      return ValueType.dimension;
    case TokenCategory.fontFamily:
      return ValueType.fontFamily;
    case TokenCategory.fontWeight:
      return ValueType.fontWeight;
    case TokenCategory.shadow:
      return ValueType.shadow;
    default:
      return ValueType.other;
  }
}

export interface CanonOptions {
  /** Key scope for dimensions (usually the token category). */
  scope?: string;
  rootPx?: number;
}

/** Canonicalize a raw value into a RawValue node, or null if not canonicalizable. */
export function canonicalize(
  value: string,
  valueType: ValueType,
  opts: CanonOptions = {},
): RawValueNode | null {
  switch (valueType) {
    case ValueType.color: {
      const c = parseColor(value);
      if (!c) return null;
      return {
        id: rawValueId(ValueType.color, c.key),
        type: NodeType.RawValue,
        label: value.trim(),
        props: { valueType: ValueType.color, rgba: c.rgba, lab: c.lab, oklch: c.oklch },
      };
    }
    case ValueType.dimension: {
      const d = parseDimension(value, { scope: opts.scope, rootPx: opts.rootPx });
      if (!d) return null;
      return {
        id: rawValueId(ValueType.dimension, d.key),
        type: NodeType.RawValue,
        label: value.trim(),
        props: {
          valueType: ValueType.dimension,
          px: d.px,
          // category scope keeps radius/spacing/fontSize in separate similarity groups
          ...(opts.scope ? { scope: opts.scope } : {}),
          ...(d.baseAssumed ? { baseAssumed: true } : {}),
        },
      };
    }
    case ValueType.fontFamily: {
      const fam = normalizeFontFamily(value);
      if (!fam) return null;
      return {
        id: rawValueId(ValueType.fontFamily, fam),
        type: NodeType.RawValue,
        label: value.trim(),
        props: { valueType: ValueType.fontFamily, family: fam },
      };
    }
    case ValueType.fontWeight: {
      const w = normalizeFontWeight(value);
      if (w === null) return null;
      return {
        id: rawValueId(ValueType.fontWeight, String(w)),
        type: NodeType.RawValue,
        label: value.trim(),
        props: { valueType: ValueType.fontWeight, weight: w },
      };
    }
    default:
      // typography/shadow composites and unknown types — later phases.
      return null;
  }
}

/** Separator between families in a font stack (`"Inter", sans-serif`). */
const FONT_STACK_SEP = ",";
/** Surrounding single/double quotes to strip from a family name. */
const QUOTE_RE = /^['"]|['"]$/g;
/** A purely numeric font weight (`400`). */
const NUMERIC_WEIGHT_RE = /^\d+$/;

/** Lowercase, drop quotes, collapse the first family of a stack. */
function normalizeFontFamily(value: string): string | null {
  const first = value.split(FONT_STACK_SEP)[0]?.trim().replace(QUOTE_RE, "");
  if (!first) return null;
  return first.toLowerCase();
}

const WEIGHT_KEYWORDS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

function normalizeFontWeight(value: string): number | null {
  const s = value.trim().toLowerCase();
  if (NUMERIC_WEIGHT_RE.test(s)) return Number(s);
  return WEIGHT_KEYWORDS[s] ?? null;
}
