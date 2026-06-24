/**
 * Color canonicalization (DESIGN.md §3).
 *
 * Any CSS/Figma color string → a canonical identity key (the `RawValue` id) plus
 * metric forms for distance. Parsing is delegated to `culori`, which handles hex,
 * rgb/hsl, **oklch/oklab** (Tailwind v4's default), and named colors uniformly.
 *
 * Identity key = 8-bit sRGB `r,g,b,a` so the same color written in different formats
 * (hex here, oklch there) collapses to one node — the value-first premise (decision #4).
 * Out-of-gamut oklch is clipped to sRGB for the key; the unclipped oklch + Lab are kept
 * in props, and perceptual distance uses ΔE2000 on Lab (RGB Euclidean is perceptually
 * wrong). If clipping collisions show up on real palettes, switch the key to rounded
 * oklch (DESIGN.md §3 caveat).
 */

import { parse, converter, differenceCiede2000 } from "culori";

/** culori color-space modes we convert into. */
const MODE = { rgb: "rgb", lab: "lab", oklch: "oklch" } as const;

/** Max value of an 8-bit channel; sRGB/alpha are quantized to 0..255. */
const MAX_8BIT = 255;
/** Fully-opaque alpha when a color carries none. */
const OPAQUE_ALPHA = 1;
/** Decimal places kept for the Lab metric form. */
const LAB_PRECISION = 3;
/** Decimal places kept for stored oklch L/C, and (separately) its hue. */
const OKLCH_PRECISION = 4;
const HUE_PRECISION = 3;
/** Hue for achromatic colors, where culori leaves H undefined. */
const ACHROMATIC_HUE = 0;

const toRgb = converter(MODE.rgb);
const toLab = converter(MODE.lab);
const toOklch = converter(MODE.oklch);
const ciede2000 = differenceCiede2000();

export interface ColorCanon {
  /** Canonical key — the `value:color:<key>` suffix. 8-bit sRGB, e.g. `37,99,235,255`. */
  key: string;
  /** 8-bit sRGB + alpha, each 0..255. */
  rgba: [number, number, number, number];
  /** CIE Lab metric form (L, a, b) — the ΔE2000 space. */
  lab: [number, number, number];
  /** oklch (L 0..1, C, H°); H is 0 for achromatic. Unclipped source values. */
  oklch: [number, number, number];
}

const to8bit = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * MAX_8BIT);
const round = (x: number, p: number) => Math.round(x * 10 ** p) / 10 ** p;

/** Parse + canonicalize a color string. Returns null if culori can't parse it. */
export function parseColor(input: string): ColorCanon | null {
  const parsed = parse(input.trim());
  if (!parsed) return null;

  const rgb = toRgb(parsed);
  const lab = toLab(parsed);
  const okl = toOklch(parsed);

  const a = to8bit(parsed.alpha ?? OPAQUE_ALPHA);
  const rgba: [number, number, number, number] = [to8bit(rgb.r), to8bit(rgb.g), to8bit(rgb.b), a];

  return {
    key: rgba.join(","),
    rgba,
    lab: [round(lab.l, LAB_PRECISION), round(lab.a, LAB_PRECISION), round(lab.b, LAB_PRECISION)],
    oklch: [
      round(okl.l, OKLCH_PRECISION),
      round(okl.c, OKLCH_PRECISION),
      round(okl.h ?? ACHROMATIC_HUE, HUE_PRECISION),
    ],
  };
}

type ColorLike = string | ColorCanon | { lab: [number, number, number] };

function labColor(c: ColorLike): { mode: "lab"; l: number; a: number; b: number } {
  if (typeof c === "string") {
    const canon = parseColor(c);
    if (!canon) throw new Error(`unparseable color: ${c}`);
    return { mode: MODE.lab, l: canon.lab[0], a: canon.lab[1], b: canon.lab[2] };
  }
  const [l, a, b] = c.lab;
  return { mode: MODE.lab, l, a, b };
}

/** Perceptual distance ΔE2000 between two colors (strings or canonicalized). */
export function deltaE2000(a: ColorLike, b: ColorLike): number {
  return ciede2000(labColor(a), labColor(b));
}
