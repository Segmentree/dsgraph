/** Paren-aware splitting for composite CSS values (shadow layers, gradient stops). */

const OPEN = "(";
const CLOSE = ")";

/**
 * Split on a single-char separator at paren depth 0, so separators inside
 * `rgba(0, 0, 0, .5)` are preserved. Trims and drops empty parts.
 */
export function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of input) {
    if (ch === OPEN) depth++;
    else if (ch === CLOSE) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const COMMA = ",";
const SPACE = " ";

export const splitLayers = (input: string) => splitTopLevel(input, COMMA);
export const splitWords = (input: string) => splitTopLevel(input, SPACE);
