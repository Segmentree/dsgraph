/**
 * Expressibility — reuse vs. introduce (DESIGN.md §11).
 *
 * Encodes "prefer variant props over new components, prefer existing tokens over new
 * ones." Given a base component (already resolved by `context`) and the slot values a
 * designer wants, decide per value whether it's:
 *
 *   REUSE                — value already on this component's slot (an existing variant)
 *   REUSE-NEW-PROP-COMBO — value is in the system, just not on this component yet
 *   SNAP-SUGGEST         — no exact token, but one within ΔE/metric ε → nudge to it
 *   INTRODUCE-TOKEN      — genuinely new value → a deliberate system extension
 *
 * Pure over the graph + canonicalizer (no embeddings); `context` does the NL→component
 * resolution and feeds the base in.
 */

import {
  NodeType,
  EdgeRelation,
  TokenCategory,
  type ValueType,
} from "../schema.js";
import { canonicalize, categoryToValueType } from "../canonicalize/index.js";
import { VALUE_TYPES } from "../values/registry.js";
import { labelOf, nodeOf, edgeOf, type DsGraph } from "./util.js";

/** Per-slot reuse/introduce verdict. */
export const Verdict = {
  reuse: "REUSE",
  reuseNewPropCombo: "REUSE-NEW-PROP-COMBO",
  snapSuggest: "SNAP-SUGGEST",
  introduceToken: "INTRODUCE-TOKEN",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

/** Whole-concept verdict (does a component already exist?). */
export const ComponentVerdict = {
  reuse: "REUSE-COMPONENT",
  introduce: "INTRODUCE-COMPONENT",
} as const;
export type ComponentVerdict = (typeof ComponentVerdict)[keyof typeof ComponentVerdict];

/** Slot → token category, so a requested value can be canonicalized in the right space. */
const SLOT_CATEGORY: Record<string, TokenCategory> = {
  surface: TokenCategory.color,
  text: TokenCategory.color,
  border: TokenCategory.color,
  ring: TokenCategory.color,
  outline: TokenCategory.color,
  fill: TokenCategory.color,
  stroke: TokenCategory.color,
  gradient: TokenCategory.gradient,
  elevation: TokenCategory.shadow,
  radius: TokenCategory.radius,
  blur: TokenCategory.blur,
  tracking: TokenCategory.letterSpacing,
  leading: TokenCategory.lineHeight,
  spacing: TokenCategory.spacing,
};

export interface DesiredSlot {
  slot: string;
  value: string;
}

export interface TokenRef {
  id: string;
  label: string;
}

export interface SlotDecision {
  slot: string;
  value: string;
  verdict: Verdict;
  /** The RawValue id the value canonicalized to (when canonicalizable). */
  rawValue?: string;
  /** Existing tokens carrying this exact value. */
  tokens?: TokenRef[];
  /** For SNAP-SUGGEST: the nearby token and its distance. */
  snapTo?: TokenRef & { distance: number };
}

export interface ExpressibilityResult {
  component: ComponentVerdict;
  base?: TokenRef;
  /** When introducing: components available to compose the new thing from. */
  composables?: TokenRef[];
  slots: SlotDecision[];
}

export interface ExpressibilityInput {
  /** Resolved base component, or null to force INTRODUCE-COMPONENT. */
  base: TokenRef | null;
  /** Components offered as composition material when introducing. */
  composables?: TokenRef[];
  slots: DesiredSlot[];
}

/** Tokens with a `has-value` edge to `rawId`. */
function tokensOfValue(graph: DsGraph, rawId: string): TokenRef[] {
  const out: TokenRef[] = [];
  graph.forEachInEdge(rawId, (key, _a, source) => {
    if (edgeOf(graph, key).relation !== EdgeRelation.hasValue) return;
    out.push({ id: source, label: labelOf(nodeOf(graph, source)) });
  });
  return out;
}

/** Token ids the base component binds to a given slot (via uses-token props.slot). */
function baseSlotTokens(graph: DsGraph, baseId: string, slot: string): Set<string> {
  const ids = new Set<string>();
  graph.forEachOutEdge(baseId, (key, _a, _s, target) => {
    const e = edgeOf(graph, key);
    if (e.relation === EdgeRelation.usesToken && e.props?.["slot"] === slot) ids.add(target);
  });
  return ids;
}

/** Nearest token (by its RawValue) within the value type's metric ε, or null. */
function nearestToken(
  graph: DsGraph,
  valueType: ValueType,
  target: Record<string, unknown>,
): (TokenRef & { distance: number }) | null {
  const metric = VALUE_TYPES[valueType]?.metric;
  if (!metric) return null;
  let best: (TokenRef & { distance: number }) | null = null;
  graph.forEachNode((id, attr) => {
    const node = attr.node;
    if (node.type !== NodeType.RawValue || node.props?.["valueType"] !== valueType) return;
    const d = metric.distance(target, node.props ?? {});
    if (d === null || d >= metric.epsilon) return;
    if (best && d >= best.distance) return;
    const tokens = tokensOfValue(graph, id);
    if (tokens[0]) best = { ...tokens[0], distance: d };
  });
  return best;
}

function decideSlot(graph: DsGraph, base: TokenRef | null, desired: DesiredSlot): SlotDecision {
  const category = SLOT_CATEGORY[desired.slot] ?? TokenCategory.other;
  const valueType = categoryToValueType(category);
  const rv = canonicalize(desired.value, valueType, { scope: category });
  if (!rv) {
    // Not canonicalizable (composite DSL, junk) → treat as a new introduction.
    return { slot: desired.slot, value: desired.value, verdict: Verdict.introduceToken };
  }

  const inPalette = graph.hasNode(rv.id);
  if (inPalette) {
    const tokens = tokensOfValue(graph, rv.id);
    const onBase = base ? baseSlotTokens(graph, base.id, desired.slot) : new Set<string>();
    const verdict = tokens.some((t) => onBase.has(t.id))
      ? Verdict.reuse
      : Verdict.reuseNewPropCombo;
    return { slot: desired.slot, value: desired.value, verdict, rawValue: rv.id, tokens };
  }

  const snap = nearestToken(graph, valueType, rv.props ?? {});
  if (snap) {
    return { slot: desired.slot, value: desired.value, verdict: Verdict.snapSuggest, rawValue: rv.id, snapTo: snap };
  }
  return { slot: desired.slot, value: desired.value, verdict: Verdict.introduceToken, rawValue: rv.id };
}

export function expressibility(graph: DsGraph, input: ExpressibilityInput): ExpressibilityResult {
  const slots = input.slots.map((s) => decideSlot(graph, input.base, s));
  return input.base
    ? { component: ComponentVerdict.reuse, base: input.base, slots }
    : { component: ComponentVerdict.introduce, composables: input.composables ?? [], slots };
}
