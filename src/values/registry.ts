/**
 * Value-type registry — the single source of truth for how each kind of design
 * value is canonicalized and compared (DESIGN.md §3, §6b).
 *
 * Every `ValueType` is one self-contained `ValueDescriptor`: how to canonicalize a
 * raw string into a `RawValue` node, and (optionally) a distance metric for the
 * `similar-to` layer. The canonicalize dispatch and the similarity metrics — which
 * used to live apart and drift — now derive from this one table, so adding a value
 * type (duration, blur, shadow, …) is a single registry entry.
 */

import { NodeType, ValueType, TokenCategory, type RawValueNode } from "../schema.js";
import { parseColor, deltaE2000 } from "../canonicalize/color.js";
import { parseDimension } from "../canonicalize/dimension.js";
import { parseRatio, parseDuration } from "../canonicalize/scalar.js";
import { normalizeFontFamily, normalizeFontWeight } from "../canonicalize/scalar-fonts.js";
import { parseShadow, parseGradient, parseTypography } from "../canonicalize/composite.js";

export interface CanonOptions {
  /** Key scope for scoped types (usually the token category). */
  scope?: string;
  rootPx?: number;
}

export type ValueProps = Record<string, unknown>;

export interface ValueMetric {
  /** Default threshold; pairs strictly below it get a similar-to edge. */
  epsilon: number;
  /** Distance between two RawValue prop bags, or null if either lacks the data. */
  distance(a: ValueProps, b: ValueProps): number | null;
}

export interface ValueDescriptor {
  /** Raw value string → canonical RawValue node, or null if not canonicalizable. */
  canonicalize(raw: string, opts: CanonOptions): RawValueNode | null;
  /** Similarity metric; omit for nominal/config types that have no continuous distance. */
  metric?: ValueMetric;
}

// ── id + thresholds ──────────────────────────────────────────────────────────

const RAW_VALUE_NS = "value";

/** `value:<valueType>:<key>` — the RawValue node id. */
export function rawValueId(valueType: ValueType, key: string): string {
  return `${RAW_VALUE_NS}:${valueType}:${key}`;
}

/** ΔE2000 threshold for color similarity (tunable on real data, §17). */
export const COLOR_EPSILON = 10;
/** Relative-distance threshold for dimensions (~12%). */
const DIMENSION_EPSILON = 0.12;
/** Relative-distance threshold for unitless ratios (~10%). */
const RATIO_EPSILON = 0.1;
/** Relative-distance threshold for durations (~30%). */
const DURATION_EPSILON = 0.3;
/** Absolute step threshold on the 100–900 font-weight axis. */
const FONT_WEIGHT_EPSILON = 150;
/** Normalized edit-distance threshold for family names. */
const FONT_FAMILY_EPSILON = 0.34;

/** Relative distance |a−b|/max for a numeric prop, or null if either is missing. */
function relativeNumeric(a: ValueProps, b: ValueProps, key: string): number | null {
  const x = a[key];
  const y = b[key];
  if (typeof x !== "number" || typeof y !== "number") return null;
  return Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1);
}

// ── shared metric helpers ────────────────────────────────────────────────────

function isLab(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number");
}

/** Levenshtein edit distance normalized by the longer string → 0 (equal) … 1 (disjoint). */
export function normalizedEdit(a: string, b: string): number {
  if (a === b) return 0;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length]! / max;
}

const node = (valueType: ValueType, key: string, label: string, props: ValueProps): RawValueNode => ({
  id: rawValueId(valueType, key),
  type: NodeType.RawValue,
  label,
  props: { valueType, ...props },
});

// ── descriptors ──────────────────────────────────────────────────────────────

const colorDescriptor: ValueDescriptor = {
  canonicalize(raw) {
    const c = parseColor(raw);
    if (!c) return null;
    return node(ValueType.color, c.key, raw.trim(), { rgba: c.rgba, lab: c.lab, oklch: c.oklch });
  },
  metric: {
    epsilon: COLOR_EPSILON,
    distance: (a, b) =>
      isLab(a["lab"]) && isLab(b["lab"]) ? deltaE2000({ lab: a["lab"] }, { lab: b["lab"] }) : null,
  },
};

const dimensionDescriptor: ValueDescriptor = {
  canonicalize(raw, opts) {
    const d = parseDimension(raw, { scope: opts.scope, rootPx: opts.rootPx });
    if (!d) return null;
    return node(ValueType.dimension, d.key, raw.trim(), {
      px: d.px,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(d.baseAssumed ? { baseAssumed: true } : {}),
    });
  },
  metric: { epsilon: DIMENSION_EPSILON, distance: (a, b) => relativeNumeric(a, b, "px") },
};

const ratioDescriptor: ValueDescriptor = {
  canonicalize(raw, opts) {
    const r = parseRatio(raw, opts.scope);
    if (!r) return null;
    return node(ValueType.ratio, r.key, raw.trim(), {
      ratio: r.value,
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
  },
  metric: { epsilon: RATIO_EPSILON, distance: (a, b) => relativeNumeric(a, b, "ratio") },
};

const durationDescriptor: ValueDescriptor = {
  canonicalize(raw) {
    const d = parseDuration(raw);
    return d ? node(ValueType.duration, d.key, raw.trim(), { ms: d.ms }) : null;
  },
  metric: { epsilon: DURATION_EPSILON, distance: (a, b) => relativeNumeric(a, b, "ms") },
};

const fontFamilyDescriptor: ValueDescriptor = {
  canonicalize(raw) {
    const fam = normalizeFontFamily(raw);
    return fam ? node(ValueType.fontFamily, fam, raw.trim(), { family: fam }) : null;
  },
  metric: {
    epsilon: FONT_FAMILY_EPSILON,
    distance: (a, b) =>
      typeof a["family"] === "string" && typeof b["family"] === "string"
        ? normalizedEdit(a["family"], b["family"])
        : null,
  },
};

const fontWeightDescriptor: ValueDescriptor = {
  canonicalize(raw) {
    const w = normalizeFontWeight(raw);
    return w === null ? null : node(ValueType.fontWeight, String(w), raw.trim(), { weight: w });
  },
  metric: {
    epsilon: FONT_WEIGHT_EPSILON,
    distance: (a, b) =>
      typeof a["weight"] === "number" && typeof b["weight"] === "number"
        ? Math.abs(a["weight"] - b["weight"])
        : null,
  },
};

// Composites: canonicalized to a normalized structure + `refs` to scalar sub-values
// (linked by the composition derive step, §6a). No scalar similarity metric — their
// closeness is structural (shared sub-values), and component-wise distance is a later
// tuning concern (§17).

const shadowDescriptor: ValueDescriptor = {
  canonicalize(raw) {
    const s = parseShadow(raw);
    return s ? node(ValueType.shadow, s.key, raw.trim(), { layers: s.layers, refs: s.refs }) : null;
  },
};

const gradientDescriptor: ValueDescriptor = {
  canonicalize(raw) {
    const g = parseGradient(raw);
    return g
      ? node(ValueType.gradient, g.key, raw.trim(), { kind: g.kind, stops: g.stops, refs: g.refs })
      : null;
  },
};

const typographyDescriptor: ValueDescriptor = {
  canonicalize(raw) {
    const t = parseTypography(raw);
    return t ? node(ValueType.typography, t.key, raw.trim(), { refs: t.refs }) : null;
  },
};

/** The registry. A type absent here is not canonicalizable; a type without `metric` has no similarity. */
export const VALUE_TYPES: Partial<Record<ValueType, ValueDescriptor>> = {
  [ValueType.color]: colorDescriptor,
  [ValueType.dimension]: dimensionDescriptor,
  [ValueType.ratio]: ratioDescriptor,
  [ValueType.duration]: durationDescriptor,
  [ValueType.fontFamily]: fontFamilyDescriptor,
  [ValueType.fontWeight]: fontWeightDescriptor,
  [ValueType.shadow]: shadowDescriptor,
  [ValueType.gradient]: gradientDescriptor,
  [ValueType.typography]: typographyDescriptor,
};

// ── public dispatch ──────────────────────────────────────────────────────────

/** Canonicalize a raw value into a RawValue node, or null if not canonicalizable. */
export function canonicalize(
  raw: string,
  valueType: ValueType,
  opts: CanonOptions = {},
): RawValueNode | null {
  return VALUE_TYPES[valueType]?.canonicalize(raw, opts) ?? null;
}

/** Map a token category to the value type whose descriptor handles it. */
export function categoryToValueType(category: TokenCategory): ValueType {
  switch (category) {
    case TokenCategory.color:
      return ValueType.color;
    case TokenCategory.spacing:
    case TokenCategory.radius:
    case TokenCategory.fontSize:
    case TokenCategory.borderWidth:
    case TokenCategory.blur:
    case TokenCategory.letterSpacing:
      return ValueType.dimension;
    case TokenCategory.lineHeight:
    case TokenCategory.opacity:
    case TokenCategory.aspectRatio:
      return ValueType.ratio;
    case TokenCategory.duration:
      return ValueType.duration;
    case TokenCategory.fontFamily:
      return ValueType.fontFamily;
    case TokenCategory.fontWeight:
      return ValueType.fontWeight;
    case TokenCategory.shadow:
      return ValueType.shadow;
    case TokenCategory.gradient:
      return ValueType.gradient;
    default:
      return ValueType.other;
  }
}
