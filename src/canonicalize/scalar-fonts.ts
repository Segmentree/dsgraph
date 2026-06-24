/** Font family/weight normalization, shared by the registry and composite parsers. */

const FONT_STACK_SEP = ",";
const QUOTE_RE = /^['"]|['"]$/g;
const NUMERIC_WEIGHT_RE = /^\d+$/;

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

/** First family of a stack, lowercased and unquoted (`"Inter", sans-serif` → `inter`). */
export function normalizeFontFamily(value: string): string | null {
  const first = value.split(FONT_STACK_SEP)[0]?.trim().replace(QUOTE_RE, "");
  return first ? first.toLowerCase() : null;
}

/** Numeric weight or keyword (`semibold` → 600) → 100..900, or null. */
export function normalizeFontWeight(value: string): number | null {
  const s = value.trim().toLowerCase();
  if (NUMERIC_WEIGHT_RE.test(s)) return Number(s);
  return WEIGHT_KEYWORDS[s] ?? null;
}
