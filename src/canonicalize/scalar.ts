/**
 * Scalar canonicalizers beyond length (DESIGN.md §3): unitless ratios and time.
 *
 * - `ratio` — lineHeight (`1.5`), opacity (`0.5` / `50%`), aspectRatio (`16/9`).
 *   Reduced to a single number; key is category-scoped so a `0.5` opacity and a
 *   `0.5` line-height stay distinct.
 * - `duration` — motion time (`200ms`, `0.2s`) reduced to milliseconds.
 */

const ROUND_PRECISION = 4;
const MS_PER_S = 1000;
const PERCENT_DIVISOR = 100;
const KEY_SEP = "@";

const ASPECT_RE = /^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/;
const PERCENT_RE = /^(-?\d*\.?\d+)%$/;
const NUMBER_RE = /^-?\d*\.?\d+$/;
const DURATION_RE = /^(-?\d*\.?\d+)(ms|s)?$/;
const UNIT = { ms: "ms", s: "s" } as const;

const round = (x: number, p = ROUND_PRECISION) => Math.round(x * 10 ** p) / 10 ** p;

export interface RatioCanon {
  /** Category-scoped key, e.g. `1.5@lineHeight`. */
  key: string;
  value: number;
}

/** Parse a unitless ratio: plain number, percentage, or `a/b` aspect ratio. */
export function parseRatio(raw: string, scope = "ratio"): RatioCanon | null {
  const s = raw.trim();
  let value: number;

  const aspect = ASPECT_RE.exec(s);
  const percent = PERCENT_RE.exec(s);
  if (aspect) {
    const denom = Number(aspect[2]);
    if (!denom) return null;
    value = Number(aspect[1]) / denom;
  } else if (percent) {
    value = Number(percent[1]) / PERCENT_DIVISOR;
  } else if (NUMBER_RE.test(s)) {
    value = Number(s);
  } else {
    return null;
  }

  if (!Number.isFinite(value)) return null;
  value = round(value);
  return { key: `${value}${KEY_SEP}${scope}`, value };
}

export interface DurationCanon {
  /** Key in ms, e.g. `200ms`. */
  key: string;
  ms: number;
}

/** Parse a duration (`200ms`, `0.2s`, or a unitless ms number) into milliseconds. */
export function parseDuration(raw: string): DurationCanon | null {
  const m = DURATION_RE.exec(raw.trim());
  if (!m) return null;
  let ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  if (m[2] === UNIT.s) ms *= MS_PER_S;
  ms = round(ms);
  return { key: `${ms}${UNIT.ms}`, ms };
}
