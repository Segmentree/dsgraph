/**
 * Token reconciliation (DESIGN.md §7) — bridges the Figma side to the code side.
 *
 * Value-first: both sides have already canonicalized onto shared `RawValue` ids, so a
 * shared RawValue with tokens on both sides IS an exact match. Names only break ties
 * inside such a cluster. Beyond exact matches we run a ΔE near-miss pass (the oklch↔hex
 * gap, where values are close but not byte-identical) and surface four findings:
 *
 *   - `maps-to` (EXTRACTED)  one figma + one code token on a value   → confident bridge
 *   - `maps-to` (INFERRED)   many-to-many cluster, paired by name     → value+name bridge
 *   - `maps-to` (AMBIGUOUS)  nearest code color within ΔE τ           → near-miss bridge
 *   - findings: synonyms (≥2 names, one value), orphan-value (one-sided),
 *               near-miss-drift (soft drift), drift (same name, disjoint values).
 *
 * Produces only `maps-to` edges + findings; it never mutates existing nodes/edges.
 */

import {
  NodeType,
  EdgeRelation,
  EdgeClass,
  Confidence,
  ValueType,
  FindingKind,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type Finding,
} from "../schema.js";
import { deltaE2000 } from "../canonicalize/color.js";
import { greedyNameMatch, normalizeName } from "./name-match.js";

/** Default near-miss ΔE threshold τ (§7) — tune on real data (§17). */
export const DEFAULT_TAU = 3;
/** Figma-side id suffix (mirrors figma-capture.ts). */
const FIGMA_SUFFIX = "@figma";
const isFigma = (id: string): boolean => id.endsWith(FIGMA_SUFFIX);

/** maps-to `method` tag (provenance of how the bridge was found). */
const Method = { value: "value", valueName: "value+name", nearMiss: "near-miss" } as const;
/** Side tag on a one-sided orphan-value finding. */
const OrphanSide = { figma: "figma", code: "code" } as const;
/** ΔE decimals kept in messages/props. */
const DELTA_PRECISION = 2;
const round = (x: number): number => Math.round(x * 10 ** DELTA_PRECISION) / 10 ** DELTA_PRECISION;

export interface ReconcileOptions {
  /** Near-miss ΔE threshold; pairs strictly below it bridge as AMBIGUOUS. */
  tau?: number;
}

export interface ReconcileResult {
  edges: GraphEdge[];
  findings: Finding[];
}

/** A value cluster: the figma-side and code-side tokens attached to one RawValue. */
interface Cluster {
  figma: GraphNode[];
  code: GraphNode[];
}

function isLab(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number");
}

function colorDistance(a: GraphNode, b: GraphNode): number | null {
  const la = a.props?.["lab"];
  const lb = b.props?.["lab"];
  if (!isLab(la) || !isLab(lb)) return null;
  return deltaE2000({ lab: la }, { lab: lb });
}

const nameOf = (n: GraphNode): string => n.label ?? n.id;
const labelOf = (raw: GraphNode | undefined, id: string): string => raw?.label ?? id;

export function reconcileTokens(doc: GraphDocument, opts: ReconcileOptions = {}): ReconcileResult {
  const tau = opts.tau ?? DEFAULT_TAU;

  const tokenById = new Map<string, GraphNode>();
  const rawById = new Map<string, GraphNode>();
  for (const n of doc.nodes) {
    if (n.type === NodeType.Token) tokenById.set(n.id, n);
    else if (n.type === NodeType.RawValue) rawById.set(n.id, n);
  }

  // Group tokens by the RawValue they carry (has-value), split by side; and index every
  // token's value set (for the drift-by-name pass). Sets dedupe a token seen via two modes.
  const clusters = new Map<string, Cluster>();
  const valuesOf = new Map<string, Set<string>>();
  const seen = new Map<string, Set<string>>(); // rawId → token ids already counted (per side dedupe)
  for (const e of doc.edges) {
    if (e.relation !== EdgeRelation.hasValue) continue;
    const token = tokenById.get(e.source);
    if (!token) continue;
    const cl = clusters.get(e.target) ?? { figma: [], code: [] };
    const counted = seen.get(e.target) ?? new Set<string>();
    if (!counted.has(token.id)) {
      counted.add(token.id);
      (isFigma(token.id) ? cl.figma : cl.code).push(token);
    }
    seen.set(e.target, counted);
    clusters.set(e.target, cl);
    (valuesOf.get(token.id) ?? valuesOf.set(token.id, new Set()).get(token.id)!).add(e.target);
  }

  const edges: GraphEdge[] = [];
  const findings: Finding[] = [];
  const mapped = new Set<string>(); // figma→code keys already emitted
  const bridgedFigma = new Set<string>(); // figma tokens with any maps-to

  const addMapsTo = (
    figmaId: string,
    codeId: string,
    method: string,
    confidence: Confidence,
    extra?: Record<string, unknown>,
  ): void => {
    const key = `${figmaId}|${codeId}`;
    if (mapped.has(key)) return;
    mapped.add(key);
    bridgedFigma.add(figmaId);
    edges.push({
      source: figmaId,
      target: codeId,
      relation: EdgeRelation.mapsTo,
      props: { method, ...extra },
      confidence,
    });
  };

  // ── Pass 1: exact value clusters → maps-to + synonyms ───────────────────────
  for (const [rawId, cl] of clusters) {
    const { figma, code } = cl;
    if (figma.length && code.length) {
      if (figma.length === 1 && code.length === 1) {
        addMapsTo(figma[0]!.id, code[0]!.id, Method.value, Confidence.EXTRACTED);
      } else {
        const { pairs } = greedyNameMatch(figma, code, nameOf);
        for (const p of pairs) addMapsTo(p.a.id, p.b.id, Method.valueName, Confidence.INFERRED);
      }
      if (figma.length > 1 || code.length > 1) {
        const all = [...figma, ...code];
        findings.push({
          kind: FindingKind.synonyms,
          message: `${all.length} tokens share one value (${labelOf(rawById.get(rawId), rawId)})`,
          nodes: all.map((t) => t.id),
          props: { rawValue: rawId },
          confidence: Confidence.AMBIGUOUS,
        });
      }
    }
  }

  // ── Pass 2: near-miss colors (figma value, no exact code match, nearest within τ) ──
  const codeColorClusters = [...clusters].filter(
    ([id, cl]) => cl.code.length && rawById.get(id)?.props?.["valueType"] === ValueType.color,
  );
  for (const [rawId, cl] of clusters) {
    if (!cl.figma.length || cl.code.length) continue;
    const rv = rawById.get(rawId);
    if (rv?.props?.["valueType"] !== ValueType.color) continue;

    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const [cid] of codeColorClusters) {
      const d = colorDistance(rv, rawById.get(cid)!);
      if (d !== null && d < bestDist) {
        bestDist = d;
        bestId = cid;
      }
    }
    if (bestId === null || bestDist >= tau) continue;

    const codeToken = clusters.get(bestId)!.code[0]!;
    for (const f of cl.figma) {
      addMapsTo(f.id, codeToken.id, Method.nearMiss, Confidence.AMBIGUOUS, { deltaE: round(bestDist) });
    }
    findings.push({
      kind: FindingKind.nearMissDrift,
      message: `${labelOf(rv, rawId)} (figma) ≈ ${labelOf(rawById.get(bestId), bestId)} (code) at ΔE ${round(bestDist)} < τ ${tau}`,
      nodes: [...cl.figma.map((t) => t.id), codeToken.id],
      props: { deltaE: round(bestDist), tau },
      confidence: Confidence.AMBIGUOUS,
    });
  }

  // ── Pass 3: orphan-value (one-sided, and not bridged by a near-miss) ────────
  for (const [rawId, cl] of clusters) {
    if (cl.figma.length && !cl.code.length) {
      if (cl.figma.some((t) => bridgedFigma.has(t.id))) continue; // near-miss bridged it
      findings.push({
        kind: FindingKind.orphanValue,
        message: `design-only value ${labelOf(rawById.get(rawId), rawId)} — in Figma, not implemented in code`,
        nodes: cl.figma.map((t) => t.id),
        props: { side: OrphanSide.figma, rawValue: rawId },
        confidence: Confidence.INFERRED,
      });
    } else if (cl.code.length && !cl.figma.length) {
      const codeIds = new Set(cl.code.map((t) => t.id));
      if (edges.some((e) => codeIds.has(e.target))) continue; // a near-miss mapped onto it
      findings.push({
        kind: FindingKind.orphanValue,
        message: `code-only value ${labelOf(rawById.get(rawId), rawId)} — in code, not in the Figma system`,
        nodes: cl.code.map((t) => t.id),
        props: { side: OrphanSide.code, rawValue: rawId },
        confidence: Confidence.INFERRED,
      });
    }
  }

  // ── Pass 4: drift — same normalized name on both sides, disjoint values ─────
  const byName = new Map<string, Cluster>();
  for (const t of tokenById.values()) {
    const k = normalizeName(nameOf(t));
    const e = byName.get(k) ?? { figma: [], code: [] };
    (isFigma(t.id) ? e.figma : e.code).push(t);
    byName.set(k, e);
  }
  for (const [k, { figma, code }] of byName) {
    if (!figma.length || !code.length) continue;
    const fVals = new Set(figma.flatMap((t) => [...(valuesOf.get(t.id) ?? [])]));
    const cVals = new Set(code.flatMap((t) => [...(valuesOf.get(t.id) ?? [])]));
    if ([...fVals].some((v) => cVals.has(v))) continue; // share a value → no drift
    const cIds = new Set(code.map((t) => t.id));
    const alreadyBridged = edges.some(
      (e) => figma.some((f) => f.id === e.source) && cIds.has(e.target),
    );
    if (alreadyBridged) continue; // near-miss already explains the gap
    findings.push({
      kind: FindingKind.drift,
      message: `'${k}' differs between Figma and code (no shared value)`,
      nodes: [...figma, ...code].map((t) => t.id),
      props: { figma: [...fVals], code: [...cVals] },
      confidence: Confidence.INFERRED,
    });
  }

  return { edges, findings };
}

/** All maps-to edges are bridge-class (sanity re-export for callers/tests). */
export const MAPS_TO_CLASS = EdgeClass.bridge;
