/**
 * Composite value canonicalizers (DESIGN.md §3): shadow, gradient, typography.
 *
 * A composite reduces to a normalized structure PLUS a list of `refs` — the
 * scalar sub-values it's built from (a shadow's colors, a gradient's stops, a
 * type style's family/size/weight/lineHeight). The composition derive step (§6a)
 * materializes those sub-values as their own RawValues and links them with
 * `composed-of`, so e.g. a shadow's color joins the palette graph and ΔE similarity.
 */

import { ValueType, type TokenCategory } from "../schema.js";
import { parseColor } from "./color.js";
import { parseDimension } from "./dimension.js";
import { normalizeFontWeight } from "./scalar-fonts.js";
import { splitLayers, splitWords } from "./css-tokens.js";

/** A scalar sub-value of a composite, re-canonicalized by the composition step. */
export interface ValueRef {
  valueType: ValueType;
  raw: string;
  scope?: string;
}

const INSET = "inset";
const NONE = "none";
const LAYER_SEP = "|";
const SHADOW_SCOPE = "shadow";
const MIN_SHADOW_LENGTHS = 2;

export interface ShadowLayer {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string | null;
}
export interface ShadowCanon {
  key: string;
  layers: ShadowLayer[];
  refs: ValueRef[];
}

/** Parse a (possibly multi-layer) `box-shadow` value. */
export function parseShadow(raw: string): ShadowCanon | null {
  const s = raw.trim();
  if (s === NONE || s === "") return null;

  const layers: ShadowLayer[] = [];
  const refs: ValueRef[] = [];
  for (const layerStr of splitLayers(s)) {
    let inset = false;
    let color: string | null = null;
    const lengths: number[] = [];
    for (const word of splitWords(layerStr)) {
      if (word === INSET) {
        inset = true;
        continue;
      }
      const c = parseColor(word);
      if (c) {
        color = c.key;
        refs.push({ valueType: ValueType.color, raw: word });
        continue;
      }
      const d = parseDimension(word, { scope: SHADOW_SCOPE });
      if (d) {
        lengths.push(d.px);
        continue;
      }
      return null; // unrecognized token
    }
    if (lengths.length < MIN_SHADOW_LENGTHS) return null;
    const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = lengths;
    layers.push({ inset, offsetX, offsetY, blur, spread, color });
  }
  if (layers.length === 0) return null;

  const key = layers.map(shadowLayerKey).join(LAYER_SEP);
  return { key, layers, refs };
}

function shadowLayerKey(l: ShadowLayer): string {
  return `${l.inset ? INSET + ":" : ""}${l.offsetX},${l.offsetY},${l.blur},${l.spread},${l.color ?? ""}`;
}

// ── gradient ──────────────────────────────────────────────────────────────────

const GRADIENT_RE = /^(linear|radial|conic)-gradient\((.*)\)$/s;
const POSITION_RE = /%|deg|\d/;

export interface GradientStop {
  color: string;
  position?: string;
}
export interface GradientCanon {
  key: string;
  kind: string;
  stops: GradientStop[];
  refs: ValueRef[];
}

/** Parse a `linear/radial/conic-gradient(...)` into ordered color stops. */
export function parseGradient(raw: string): GradientCanon | null {
  const m = GRADIENT_RE.exec(raw.trim());
  if (!m) return null;
  const kind = m[1]!;

  const stops: GradientStop[] = [];
  const refs: ValueRef[] = [];
  for (const arg of splitLayers(m[2]!)) {
    let color: string | null = null;
    let position: string | undefined;
    for (const word of splitWords(arg)) {
      const c = parseColor(word);
      if (c && !color) {
        color = c.key;
        refs.push({ valueType: ValueType.color, raw: word });
      } else if (POSITION_RE.test(word)) {
        position = word;
      }
    }
    if (color) stops.push(position ? { color, position } : { color });
  }
  if (stops.length === 0) return null; // a direction-only arg list isn't a gradient we model

  const key = `${kind}:${stops.map((s) => s.color + (s.position ? "@" + s.position : "")).join(",")}`;
  return { key, kind, stops, refs };
}

// ── typography ────────────────────────────────────────────────────────────────

const FONT_SIZE_RE = /^([\d.]+(?:px|rem|em))(?:\/([\d.]+%?|[\d.]+(?:px|rem|em)))?$/;
const FONT_SIZE_SCOPE = "fontSize";
const LINE_HEIGHT_SCOPE = "lineHeight";

export interface TypographyCanon {
  key: string;
  refs: ValueRef[];
}

/**
 * Parse a CSS `font` shorthand: `[weight] <size>[/<lineHeight>] <family…>`.
 * Best-effort — the richer source is Figma text styles (Phase 3). Requires at
 * least a size and a family to be a meaningful type style.
 */
export function parseTypography(raw: string): TypographyCanon | null {
  const words = splitWords(raw.trim());
  let sizeIdx = -1;
  let size: string | undefined;
  let lineHeight: string | undefined;

  for (let i = 0; i < words.length; i++) {
    const sm = FONT_SIZE_RE.exec(words[i]!);
    if (sm) {
      sizeIdx = i;
      size = sm[1];
      lineHeight = sm[2];
      break;
    }
  }
  if (sizeIdx === -1 || !size) return null;

  const family = words.slice(sizeIdx + 1).join(" ");
  if (!family) return null;

  const weight = words.slice(0, sizeIdx).find((w) => normalizeFontWeight(w) !== null);

  const refs: ValueRef[] = [
    { valueType: ValueType.fontFamily, raw: family },
    { valueType: ValueType.dimension, raw: size, scope: FONT_SIZE_SCOPE satisfies TokenCategory },
  ];
  if (weight) refs.push({ valueType: ValueType.fontWeight, raw: weight });
  if (lineHeight) {
    refs.push({ valueType: ValueType.ratio, raw: lineHeight, scope: LINE_HEIGHT_SCOPE satisfies TokenCategory });
  }

  const key = `${weight ?? "_"} ${size}${lineHeight ? "/" + lineHeight : ""} ${family.toLowerCase()}`;
  return { key, refs };
}
