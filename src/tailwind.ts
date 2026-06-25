/**
 * Shared Tailwind vocabulary (global constants).
 *
 * These strings are produced in one place and consumed in another — the token
 * adapters tag each token with a `@theme` **namespace**, and the class→token
 * resolver maps a utility **prefix** back to a namespace + slot. Centralizing them
 * here guarantees producer and consumer never drift, and lets any future adapter,
 * hook, or analysis reuse the same names.
 *
 * Enum-like convention (CLAUDE.md): `const` object + derived same-name union type.
 */

/** Tailwind v4 `@theme` namespaces — the `--<namespace>-*` custom-property prefixes. */
export const TwNamespace = {
  color: "color",
  text: "text",
  fontWeight: "font-weight",
  font: "font",
  leading: "leading",
  tracking: "tracking",
  spacing: "spacing",
  radius: "radius",
  insetShadow: "inset-shadow",
  dropShadow: "drop-shadow",
  shadow: "shadow",
  blur: "blur",
  aspect: "aspect",
  ease: "ease",
  zIndex: "z-index",
} as const;
export type TwNamespace = (typeof TwNamespace)[keyof typeof TwNamespace];

/** Tailwind utility class prefixes — the `<prefix>-<name>` form in `className`. */
export const TwPrefix = {
  bg: "bg",
  text: "text",
  border: "border",
  ring: "ring",
  outline: "outline",
  fill: "fill",
  stroke: "stroke",
  divide: "divide",
  placeholder: "placeholder",
  from: "from",
  via: "via",
  to: "to",
  shadow: "shadow",
  rounded: "rounded",
  blur: "blur",
  tracking: "tracking",
  leading: "leading",
} as const;
export type TwPrefix = (typeof TwPrefix)[keyof typeof TwPrefix];

/** Spacing-family utility prefixes (padding/margin/gap) — all bind the spacing namespace. */
export const SPACING_PREFIXES = [
  "p", "px", "py", "pt", "pr", "pb", "pl",
  "m", "mx", "my", "mt", "mr", "mb", "ml",
  "gap",
] as const;

/** Separator between a utility prefix and its value (`bg-primary`). */
export const TW_PREFIX_SEP = "-";
/** Variant separator (`dark:bg-primary`). */
export const TW_VARIANT_SEP = ":";
/** Opacity modifier separator (`bg-primary/90`). */
export const TW_OPACITY_SEP = "/";
/** Opening bracket of an arbitrary value (`bg-[#fff]`). */
export const TW_ARBITRARY_OPEN = "[";
