/**
 * Component reconciliation (DESIGN.md §7) — bridges Figma components to code components.
 *
 * A component has no single value, so unlike tokens it can't match by the RawValue bridge.
 * Instead we score each (figma, code) pair on four structural axes already in the graph,
 * then greedily bipartite-match the high scorers:
 *
 *   score = w1·name_similarity            (labels, normalized)
 *         + w2·Jaccard(value sets)        (uses-token → token → has-value → RawValue)
 *         + w3·Jaccard(child names)       (composed-of children)
 *         + w4·Jaccard(variant axes)      (props_schema "axis:value" pairs)
 *
 * Axes with no evidence on either side drop out of the weighted average (they neither
 * help nor penalize), so an icon matched on name alone isn't dragged down by having no
 * tokens. A confident match whose value sets still diverge is surfaced as drift.
 */

import {
  NodeType,
  EdgeRelation,
  Confidence,
  FindingKind,
  type GraphDocument,
  type GraphNode,
  type GraphEdge,
  type Finding,
} from "../schema.js";
import { nameSimilarity } from "./name-match.js";

const FIGMA_SUFFIX = "@figma";
const CODE_SUFFIX = "@code";
const isFigma = (id: string): boolean => id.endsWith(FIGMA_SUFFIX);
const isCode = (id: string): boolean => id.endsWith(CODE_SUFFIX);

/** Scoring weights (sum normalized per-pair over the applicable axes). Tune on real data (§17). */
export const WEIGHTS = { name: 0.4, values: 0.25, children: 0.2, variants: 0.15 } as const;

/** Score ≥ this with a confident structure → INFERRED; between accept and this → AMBIGUOUS. */
export const STRONG_SCORE = 0.6;
/** Minimum score to emit any maps-to at all. */
export const ACCEPT_SCORE = 0.35;
/** A matched pair whose value-set Jaccard is below this is flagged as component drift. */
export const DRIFT_VALUE_JACCARD = 0.5;
/** Decimals kept on score/Jaccard in props/messages. */
const SCORE_PRECISION = 3;
const round = (x: number): number => Math.round(x * 10 ** SCORE_PRECISION) / 10 ** SCORE_PRECISION;

export interface ComponentReconcileOptions {
  weights?: typeof WEIGHTS;
  acceptScore?: number;
  strongScore?: number;
}

export interface ReconcileResult {
  edges: GraphEdge[];
  findings: Finding[];
}

/** Jaccard overlap of two sets; null when both are empty (axis has no evidence). */
function jaccard<T>(a: Set<T>, b: Set<T>): number | null {
  if (a.size === 0 && b.size === 0) return null;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const nameOf = (n: GraphNode): string => n.label ?? n.id;

/** Per-component structural profile compared across sides. */
interface Profile {
  node: GraphNode;
  values: Set<string>; // RawValue ids used (via uses-token → has-value)
  children: Set<string>; // child component labels (side-agnostic)
  variants: Set<string>; // "axis:value" pairs from props_schema
}

function buildProfiles(doc: GraphDocument): { figma: Profile[]; code: Profile[] } {
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const valuesOfToken = new Map<string, string[]>(); // token id → RawValue ids
  const usesByComp = new Map<string, string[]>(); // component id → token ids
  const childrenByComp = new Map<string, string[]>(); // component id → child component ids

  for (const e of doc.edges) {
    if (e.relation === EdgeRelation.hasValue) {
      (valuesOfToken.get(e.source) ?? valuesOfToken.set(e.source, []).get(e.source)!).push(e.target);
    } else if (e.relation === EdgeRelation.usesToken) {
      (usesByComp.get(e.source) ?? usesByComp.set(e.source, []).get(e.source)!).push(e.target);
    } else if (e.relation === EdgeRelation.composedOf) {
      (childrenByComp.get(e.source) ?? childrenByComp.set(e.source, []).get(e.source)!).push(e.target);
    }
  }

  const profileOf = (node: GraphNode): Profile => {
    const values = new Set<string>();
    for (const tokenId of usesByComp.get(node.id) ?? []) {
      for (const rawId of valuesOfToken.get(tokenId) ?? []) values.add(rawId);
    }
    const children = new Set<string>();
    for (const childId of childrenByComp.get(node.id) ?? []) {
      children.add(nameOf(nodeById.get(childId) ?? { id: childId, type: NodeType.Component }));
    }
    const variants = new Set<string>();
    const schema = node.props?.["props_schema"] as Record<string, unknown> | undefined;
    if (schema) {
      for (const [axis, vals] of Object.entries(schema)) {
        if (Array.isArray(vals)) for (const v of vals) variants.add(`${axis}:${v}`);
        else variants.add(axis); // boolean axis
      }
    }
    return { node, values, children, variants };
  };

  const components = doc.nodes.filter((n) => n.type === NodeType.Component);
  return {
    figma: components.filter((n) => isFigma(n.id)).map(profileOf),
    code: components.filter((n) => isCode(n.id)).map(profileOf),
  };
}

interface ScoredPair {
  figma: Profile;
  code: Profile;
  score: number;
  valueJaccard: number | null;
}

function scorePair(figma: Profile, code: Profile, weights: typeof WEIGHTS): ScoredPair {
  const valueJaccard = jaccard(figma.values, code.values);
  let num = weights.name * nameSimilarity(nameOf(figma.node), nameOf(code.node));
  let den = weights.name;
  const add = (weight: number, score: number | null): void => {
    if (score === null) return;
    num += weight * score;
    den += weight;
  };
  add(weights.values, valueJaccard);
  add(weights.children, jaccard(figma.children, code.children));
  add(weights.variants, jaccard(figma.variants, code.variants));
  return { figma, code, score: den ? num / den : 0, valueJaccard };
}

export function reconcileComponents(
  doc: GraphDocument,
  opts: ComponentReconcileOptions = {},
): ReconcileResult {
  const weights = opts.weights ?? WEIGHTS;
  const accept = opts.acceptScore ?? ACCEPT_SCORE;
  const strong = opts.strongScore ?? STRONG_SCORE;

  const { figma, code } = buildProfiles(doc);
  if (!figma.length || !code.length) return { edges: [], findings: [] };

  // Score every cross-side pair, then greedily match best-first without reuse.
  const candidates: ScoredPair[] = [];
  for (const f of figma) {
    for (const c of code) {
      const pair = scorePair(f, c, weights);
      if (pair.score >= accept) candidates.push(pair);
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedFigma = new Set<Profile>();
  const usedCode = new Set<Profile>();
  const edges: GraphEdge[] = [];
  const findings: Finding[] = [];

  for (const pair of candidates) {
    if (usedFigma.has(pair.figma) || usedCode.has(pair.code)) continue;
    usedFigma.add(pair.figma);
    usedCode.add(pair.code);

    const confidence = pair.score >= strong ? Confidence.INFERRED : Confidence.AMBIGUOUS;
    edges.push({
      source: pair.figma.node.id,
      target: pair.code.node.id,
      relation: EdgeRelation.mapsTo,
      props: { method: "structure", score: round(pair.score) },
      confidence,
    });

    // A confident match that nonetheless uses different tokens = component drift.
    if (
      confidence === Confidence.INFERRED &&
      pair.valueJaccard !== null &&
      pair.valueJaccard < DRIFT_VALUE_JACCARD
    ) {
      findings.push({
        kind: FindingKind.drift,
        message: `${nameOf(pair.figma.node)} matches code but token usage differs (value overlap ${round(pair.valueJaccard)})`,
        nodes: [pair.figma.node.id, pair.code.node.id],
        props: { valueJaccard: round(pair.valueJaccard), score: round(pair.score) },
        confidence: Confidence.AMBIGUOUS,
      });
    }
  }

  return { edges, findings };
}
