/**
 * Tailwind class → token resolver (DESIGN.md §4a, §4b).
 *
 * The token adapters tag each semantic token with `props.tailwind = {namespace, utility}`
 * (e.g. color/`primary`). A utility class is `<prefix>-<name>` where the prefix implies a
 * namespace + binding slot (`bg-` → color/surface, `rounded-` → radius). This resolver
 * builds a `(namespace, utility) → tokenId` index from the tokens, and resolves a class
 * string to the tokens it binds — the input to the component adapter's `uses-token` edges.
 *
 * Variant prefixes (`dark:`, `hover:`), opacity modifiers (`/90`), and arbitrary values
 * (`[#fff]`) are stripped/skipped: they don't change which token is referenced (arbitrary
 * values reference no token at all — an off-system binding for later analysis).
 */

import { Slot, type GraphNode } from "../../schema.js";
import {
  TwNamespace,
  TwPrefix,
  SPACING_PREFIXES,
  TW_PREFIX_SEP,
  TW_VARIANT_SEP,
  TW_OPACITY_SEP,
  TW_ARBITRARY_OPEN,
  type TwNamespace as TwNamespaceT,
} from "../../tailwind.js";

export interface ResolvedClass {
  /** The original utility (post variant/opacity stripping), e.g. `bg-primary`. */
  utility: string;
  tokenId: string;
  /** Binding slot inferred from the utility prefix (surface/text/radius/…). */
  slot: Slot;
}

export interface ClassResolver {
  /** Resolve a (possibly multi-class) string to the tokens it binds. */
  resolve(classString: string): ResolvedClass[];
}

interface PrefixRule {
  prefix: string;
  namespaces: TwNamespaceT[];
  slot: Slot;
}

/** Utility prefix → candidate Tailwind namespaces + the slot it binds. Longest prefix wins. */
const PREFIXES: PrefixRule[] = [
  { prefix: TwPrefix.bg, namespaces: [TwNamespace.color], slot: Slot.surface },
  { prefix: TwPrefix.text, namespaces: [TwNamespace.color, TwNamespace.text], slot: Slot.text },
  { prefix: TwPrefix.border, namespaces: [TwNamespace.color], slot: Slot.border },
  { prefix: TwPrefix.ring, namespaces: [TwNamespace.color], slot: Slot.ring },
  { prefix: TwPrefix.outline, namespaces: [TwNamespace.color], slot: Slot.outline },
  { prefix: TwPrefix.fill, namespaces: [TwNamespace.color], slot: Slot.fill },
  { prefix: TwPrefix.stroke, namespaces: [TwNamespace.color], slot: Slot.stroke },
  { prefix: TwPrefix.divide, namespaces: [TwNamespace.color], slot: Slot.border },
  { prefix: TwPrefix.placeholder, namespaces: [TwNamespace.color], slot: Slot.text },
  { prefix: TwPrefix.from, namespaces: [TwNamespace.color], slot: Slot.gradient },
  { prefix: TwPrefix.via, namespaces: [TwNamespace.color], slot: Slot.gradient },
  { prefix: TwPrefix.to, namespaces: [TwNamespace.color], slot: Slot.gradient },
  { prefix: TwPrefix.shadow, namespaces: [TwNamespace.shadow], slot: Slot.elevation },
  { prefix: TwPrefix.rounded, namespaces: [TwNamespace.radius], slot: Slot.radius },
  { prefix: TwPrefix.blur, namespaces: [TwNamespace.blur], slot: Slot.blur },
  { prefix: TwPrefix.tracking, namespaces: [TwNamespace.tracking], slot: Slot.tracking },
  { prefix: TwPrefix.leading, namespaces: [TwNamespace.leading], slot: Slot.leading },
  // spacing family (resolves only if the project defines spacing tokens; else off-system)
  ...SPACING_PREFIXES.map(
    (prefix): PrefixRule => ({ prefix, namespaces: [TwNamespace.spacing], slot: Slot.spacing }),
  ),
].sort((a, b) => b.prefix.length - a.prefix.length);

/** Key into the (namespace, utility) → tokenId index. */
const NS_KEY_SEP = ":";
const indexKey = (namespace: string, utility: string) => `${namespace}${NS_KEY_SEP}${utility}`;

const WHITESPACE_RE = /\s+/;
const NOT_FOUND = -1;

export function buildClassResolver(tokens: GraphNode[]): ClassResolver {
  const index = new Map<string, string>();
  for (const t of tokens) {
    const tw = t.props?.["tailwind"] as { namespace?: string; utility?: string } | undefined;
    if (tw?.namespace && tw.utility) index.set(indexKey(tw.namespace, tw.utility), t.id);
  }

  const resolveOne = (cls: string): ResolvedClass | null => {
    const base = baseUtility(cls);
    if (!base) return null;
    for (const { prefix, namespaces, slot } of PREFIXES) {
      if (base !== prefix && !base.startsWith(prefix + TW_PREFIX_SEP)) continue;
      const name = base === prefix ? "" : base.slice(prefix.length + 1);
      if (!name) return null; // bare `border`/`rounded` → default, not a named token
      for (const ns of namespaces) {
        const tokenId = index.get(indexKey(ns, name));
        if (tokenId) return { utility: base, tokenId, slot };
      }
      return null; // recognized prefix, but no matching token → off-system
    }
    return null;
  };

  return {
    resolve(classString: string): ResolvedClass[] {
      const out: ResolvedClass[] = [];
      for (const cls of classString.split(WHITESPACE_RE).filter(Boolean)) {
        const r = resolveOne(cls);
        if (r) out.push(r);
      }
      return out;
    },
  };
}

/** Strip variant prefixes + opacity modifier; null for arbitrary-value classes (no token). */
function baseUtility(cls: string): string | null {
  const afterVariants = lastVariantSegment(cls);
  const base = afterVariants.split(TW_OPACITY_SEP)[0] ?? afterVariants;
  if (base.includes(TW_ARBITRARY_OPEN)) return null; // bg-[#fff] / arbitrary → off-system
  return base || null;
}

/** The segment after the last top-level variant separator, ignoring `:` inside `[]`. */
function lastVariantSegment(cls: string): string {
  let depth = 0;
  let lastSep = NOT_FOUND;
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i];
    if (ch === TW_ARBITRARY_OPEN) depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === TW_VARIANT_SEP && depth === 0) lastSep = i;
  }
  return cls.slice(lastSep + 1);
}
