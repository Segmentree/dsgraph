/**
 * Dimension canonicalization (DESIGN.md §3) — spacing / radius / font-size.
 *
 * Parses a single resolved length (`px`, `rem`, `em`, `pt`, `%`, or a unitless
 * Figma number) → numeric px. `rem`/`em` resolve against a configurable root
 * (default 16) with a `baseAssumed` flag. The canonical key is **category-scoped**
 * (`16px@spacing` ≠ `16px@fontSize`) to guard cross-category value collisions.
 *
 * `calc()` and `var()` are NOT resolved here — they need the token graph (a var's
 * value, sibling tokens). The adapter resolves those first, then calls this with a
 * concrete length. Unresolvable input returns null.
 */

export interface DimCanon {
  /** Category-scoped key — the `value:dimension:<key>` suffix, e.g. `16px@spacing`. */
  key: string;
  /** Numeric px metric form; distance is |a−b|. */
  px: number;
  /** True when a rem/em→px conversion assumed the default root font size. */
  baseAssumed?: boolean;
}

/** CSS points per px (96 CSS px = 72 pt). */
const PT_PER_PX = 72 / 96;
/** Default root font size (px) for rem/em resolution when none is supplied. */
const BASE_ROOT_PX = 16;
/** Key scope used when no token category is given. */
const DEFAULT_SCOPE = "dim";
/** Decimal places kept when rounding px (kills float noise like 9.9999996). */
const PX_PRECISION = 4;

/** Length units we resolve, plus the relative `%`. */
const UNIT = {
  px: "px",
  rem: "rem",
  em: "em",
  pt: "pt",
  percent: "%",
} as const;

/** References/expressions we punt to the adapter (it has the var/calc context). */
const UNRESOLVED_RE = /var\(|calc\(|clamp\(|min\(|max\(/;
/** A single numeric length with an optional unit. */
const LENGTH_RE = /^(-?\d*\.?\d+)\s*(px|rem|em|pt|%)?$/;

export interface DimOptions {
  rootPx?: number;
  /** Category scope for the key (spacing/radius/fontSize/…). Defaults to `dim`. */
  scope?: string;
}

/** Parse a single resolved length into category-scoped px. Null if unresolvable. */
export function parseDimension(input: string, opts: DimOptions = {}): DimCanon | null {
  const rootPx = opts.rootPx ?? BASE_ROOT_PX;
  const scope = opts.scope ?? DEFAULT_SCOPE;
  const s = input.trim();

  // Unresolved references / expressions are the adapter's job, not ours.
  if (UNRESOLVED_RE.test(s)) return null;

  const m = LENGTH_RE.exec(s);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];

  let px: number;
  let baseAssumed: boolean | undefined;
  switch (unit) {
    case UNIT.px:
    case undefined: // unitless Figma number → treated as px
      px = n;
      break;
    case UNIT.rem:
    case UNIT.em:
      px = n * rootPx;
      baseAssumed = true;
      break;
    case UNIT.pt:
      px = n / PT_PER_PX;
      break;
    case UNIT.percent:
      // Relative; keep the ratio in its own key space rather than fabricating px.
      return { key: `${round(n)}${UNIT.percent}@${scope}`, px: n };
    default:
      return null;
  }

  px = round(px);
  return { key: `${px}${UNIT.px}@${scope}`, px, ...(baseAssumed ? { baseAssumed } : {}) };
}

const round = (x: number, p = PX_PRECISION) => Math.round(x * 10 ** p) / 10 ** p;
