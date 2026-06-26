/**
 * Graph analysis findings (DESIGN.md §9) — code-side health checks over the merged graph.
 *
 * Unlike reconciliation (which needs the Figma side), these run on any build: they read
 * the structural + similarity layers already present and surface consolidation/cleanup
 * opportunities. Five findings, sharing one pass of indices:
 *
 *   - palette-bloat   : a `similar-to` cluster of ≥N near-identical values on distinct tokens
 *   - component-bloat : two components with near-identical token+child usage → merge to variant
 *   - god-node        : top-k tokens/components by degree (blast radius)
 *   - unused-token    : a token with zero `uses-token` in-edges
 *   - orphan-component: a component nothing renders (zero inbound composed-of, incl. router)
 *
 * Every finding is AMBIGUOUS — they're heuristics to review, not facts.
 */

import {
  NodeType,
  EdgeRelation,
  Confidence,
  FindingKind,
  type GraphDocument,
  type GraphNode,
  type Finding,
} from "../schema.js";

/** Figma-side suffix — these analyses target the code side only. */
const FIGMA_SUFFIX = "@figma";
const isFigma = (id: string): boolean => id.endsWith(FIGMA_SUFFIX);

/** ≥ this many distinct near-identical values (each on its own token) = palette bloat. */
export const PALETTE_CLUSTER_MIN = 3;
/** Jaccard(token∪child) above this between two components = component bloat. */
export const COMPONENT_BLOAT_JACCARD = 0.8;
/** Ignore trivially-small usage sets when comparing components for bloat. */
export const COMPONENT_BLOAT_MIN_SET = 3;
/** How many top-degree nodes to flag as god nodes (per kind). */
export const GOD_NODE_TOP_K = 5;
/** A god node must exceed this degree to be worth flagging. */
export const GOD_NODE_MIN_DEGREE = 10;

export interface AnalyzeOptions {
  paletteClusterMin?: number;
  componentBloatJaccard?: number;
  godNodeTopK?: number;
}

const nameOf = (n: GraphNode): string => n.label ?? n.id;

/** Shared indices built once and read by every check. */
interface Indices {
  tokens: GraphNode[];
  components: GraphNode[];
  raws: GraphNode[];
  byId: Map<string, GraphNode>;
  usesTokenIn: Map<string, number>; // token id → # of uses-token in-edges
  usesTokenOut: Map<string, Set<string>>; // component id → token ids it uses
  childrenOut: Map<string, Set<string>>; // component id → child component ids
  composedOfIn: Map<string, number>; // component id → # inbound composed-of
  tokensOfRaw: Map<string, Set<string>>; // RawValue id → tokens with has-value to it
  similarAdj: Map<string, Set<string>>; // RawValue id ↔ RawValue id (similar-to)
  degree: Map<string, number>; // structural degree (in+out)
}

const STRUCTURAL = new Set<string>([
  EdgeRelation.hasValue,
  EdgeRelation.aliases,
  EdgeRelation.usesToken,
  EdgeRelation.composedOf,
  EdgeRelation.instanceOf,
  EdgeRelation.rendersOn,
]);

function index(doc: GraphDocument): Indices {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const ix: Indices = {
    tokens: doc.nodes.filter((n) => n.type === NodeType.Token && !isFigma(n.id)),
    components: doc.nodes.filter((n) => n.type === NodeType.Component && !isFigma(n.id)),
    raws: doc.nodes.filter((n) => n.type === NodeType.RawValue),
    byId,
    usesTokenIn: new Map(),
    usesTokenOut: new Map(),
    childrenOut: new Map(),
    composedOfIn: new Map(),
    tokensOfRaw: new Map(),
    similarAdj: new Map(),
    degree: new Map(),
  };
  const inc = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  const addSet = (m: Map<string, Set<string>>, k: string, v: string): void => {
    (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
  };

  for (const e of doc.edges) {
    if (STRUCTURAL.has(e.relation)) {
      inc(ix.degree, e.source);
      inc(ix.degree, e.target);
    }
    switch (e.relation) {
      case EdgeRelation.usesToken:
        inc(ix.usesTokenIn, e.target);
        addSet(ix.usesTokenOut, e.source, e.target);
        break;
      case EdgeRelation.composedOf:
        inc(ix.composedOfIn, e.target);
        addSet(ix.childrenOut, e.source, e.target);
        break;
      case EdgeRelation.hasValue:
        addSet(ix.tokensOfRaw, e.target, e.source);
        break;
      case EdgeRelation.similarTo:
        addSet(ix.similarAdj, e.source, e.target);
        addSet(ix.similarAdj, e.target, e.source);
        break;
    }
  }
  return ix;
}

/** Connected components of the similar-to graph (BFS over the undirected adjacency). */
function similarClusters(ix: Indices): string[][] {
  const seen = new Set<string>();
  const clusters: string[][] = [];
  for (const start of ix.similarAdj.keys()) {
    if (seen.has(start)) continue;
    const cluster: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.pop()!;
      cluster.push(cur);
      for (const nb of ix.similarAdj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function paletteBloat(ix: Indices, min: number): Finding[] {
  const out: Finding[] = [];
  for (const cluster of similarClusters(ix)) {
    // distinct code tokens carried by the near-identical values in this cluster
    const tokens = new Set<string>();
    for (const rawId of cluster) {
      for (const t of ix.tokensOfRaw.get(rawId) ?? []) if (!isFigma(t)) tokens.add(t);
    }
    if (cluster.length < min || tokens.size < min) continue;
    const labels = cluster.map((r) => nameOf(ix.byId.get(r)!)).slice(0, min + 2);
    out.push({
      kind: FindingKind.paletteBloat,
      message: `${tokens.size} tokens hold ${cluster.length} near-identical values (${labels.join(", ")}${cluster.length > labels.length ? ", …" : ""})`,
      nodes: [...tokens],
      props: { values: cluster.length, tokens: tokens.size },
      confidence: Confidence.AMBIGUOUS,
    });
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function componentBloat(ix: Indices, theta: number): Finding[] {
  // usage signature = tokens used ∪ children rendered (side-agnostic by id is fine: code-only)
  const sig = new Map<string, Set<string>>();
  for (const c of ix.components) {
    const s = new Set<string>([
      ...(ix.usesTokenOut.get(c.id) ?? []),
      ...(ix.childrenOut.get(c.id) ?? []),
    ]);
    if (s.size >= COMPONENT_BLOAT_MIN_SET) sig.set(c.id, s);
  }
  const ids = [...sig.keys()];
  const out: Finding[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      const score = jaccard(sig.get(a)!, sig.get(b)!);
      if (score <= theta) continue;
      out.push({
        kind: FindingKind.componentBloat,
        message: `${nameOf(ix.byId.get(a)!)} and ${nameOf(ix.byId.get(b)!)} have near-identical usage (${score.toFixed(2)}) — consider merging to a variant`,
        nodes: [a, b],
        props: { jaccard: Number(score.toFixed(3)) },
        confidence: Confidence.AMBIGUOUS,
      });
    }
  }
  return out;
}

function godNodes(ix: Indices, topK: number): Finding[] {
  const pick = (nodes: GraphNode[], kindLabel: string): Finding[] =>
    nodes
      .map((n) => ({ n, d: ix.degree.get(n.id) ?? 0 }))
      .filter((x) => x.d >= GOD_NODE_MIN_DEGREE)
      .sort((a, b) => b.d - a.d)
      .slice(0, topK)
      .map(({ n, d }) => ({
        kind: FindingKind.godNode,
        message: `${kindLabel} ${nameOf(n)} has degree ${d} — high blast radius`,
        nodes: [n.id],
        props: { degree: d },
        confidence: Confidence.AMBIGUOUS,
      }));
  return [...pick(ix.tokens, "token"), ...pick(ix.components, "component")];
}

function unusedTokens(ix: Indices): Finding[] {
  return ix.tokens
    .filter((t) => !(ix.usesTokenIn.get(t.id) ?? 0))
    .map((t) => ({
      kind: FindingKind.unusedToken,
      message: `token ${nameOf(t)} is defined but never used (no uses-token)`,
      nodes: [t.id],
      confidence: Confidence.AMBIGUOUS,
    }));
}

function orphanComponents(ix: Indices): Finding[] {
  return ix.components
    .filter((c) => !(ix.composedOfIn.get(c.id) ?? 0))
    .map((c) => ({
      kind: FindingKind.orphanComponent,
      message: `component ${nameOf(c)} is never rendered (no inbound composed-of)`,
      nodes: [c.id],
      confidence: Confidence.AMBIGUOUS,
    }));
}

/** Run all §9 analysis checks over a merged document. */
export function analyzeGraph(doc: GraphDocument, opts: AnalyzeOptions = {}): Finding[] {
  const ix = index(doc);
  return [
    ...paletteBloat(ix, opts.paletteClusterMin ?? PALETTE_CLUSTER_MIN),
    ...componentBloat(ix, opts.componentBloatJaccard ?? COMPONENT_BLOAT_JACCARD),
    ...godNodes(ix, opts.godNodeTopK ?? GOD_NODE_TOP_K),
    ...unusedTokens(ix),
    ...orphanComponents(ix),
  ];
}
