/**
 * `context "<desc>"` — generation retrieval (DESIGN.md §10.5).
 *
 * Before building new UI, answer "what do we already have, and can this be expressed with
 * it?" Resolve the description to existing components (lexical + embedding), assemble a
 * build kit per candidate (its variant axes, the tokens it binds by slot, and the
 * components it travels with), then run the §11 expressibility check against the requested
 * slot values. Returns the kit + a reuse-vs-introduce decision.
 */

import { NodeType, EdgeRelation } from "../schema.js";
import { resolveSeeds } from "./seeds.js";
import { labelOf, nodeOf, edgeOf, normalize, type DsGraph } from "./util.js";
import { rankByEmbedding, type Embedder } from "../embed/embedder.js";
import {
  expressibility,
  type DesiredSlot,
  type ExpressibilityResult,
  type TokenRef,
} from "./expressibility.js";

/** Lexical score at/above which a component is kept regardless of embedding. */
const LEXICAL_KEEP = 0.6;
/** Embedding cosine at/above which a component is kept (baseline ~0.5 for unrelated text). */
const EMBED_KEEP = 0.62;
const DEFAULT_LIMIT = 5;
const FIGMA_SUFFIX = "@figma";

export interface SlotToken extends TokenRef {
  slot?: string;
}
export interface KitComponent {
  id: string;
  label: string;
  score: number;
  /** Variant axes, if any (cva / Figma component-set). */
  variants?: Record<string, unknown>;
  /** Tokens this component binds, with their slot. */
  tokens: SlotToken[];
  /** Components it composes or is commonly used with. */
  siblings: TokenRef[];
}

export interface ContextResult {
  query: string;
  components: KitComponent[];
  expressibility: ExpressibilityResult;
}

export interface ContextOptions {
  embedder?: Embedder;
  /** Desired slot values to test for reuse-vs-introduce. */
  slots?: DesiredSlot[];
  limit?: number;
  embedKeep?: number;
}

const isCodeComponent = (id: string, type: string): boolean =>
  type === NodeType.Component && !id.endsWith(FIGMA_SUFFIX);

/** Resolve a description to candidate components: max(lexical, embedding cosine). */
async function resolveComponents(
  graph: DsGraph,
  desc: string,
  opts: ContextOptions,
): Promise<{ id: string; label: string; score: number }[]> {
  const components: { id: string; label: string }[] = [];
  graph.forEachNode((id, attr) => {
    if (isCodeComponent(id, attr.node.type)) components.push({ id, label: labelOf(attr.node) });
  });

  // Lexical scores (reuse the shared scorer via resolveSeeds, then keep components).
  const lexical = new Map<string, number>();
  for (const seed of resolveSeeds(graph, desc, { limit: components.length, threshold: 0.01 })) {
    lexical.set(seed.id, seed.score);
  }

  const embed = new Map<string, number>();
  if (opts.embedder) {
    for (const r of await rankByEmbedding(opts.embedder, desc, components)) embed.set(r.id, r.score);
  }

  const embedKeep = opts.embedKeep ?? EMBED_KEEP;
  const scored = components
    .map((c) => ({ ...c, lex: lexical.get(c.id) ?? 0, emb: embed.get(c.id) ?? 0 }))
    .filter((c) => c.lex >= LEXICAL_KEEP || c.emb >= embedKeep)
    .map((c) => ({ id: c.id, label: c.label, score: Math.max(c.lex, c.emb) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  return scored.slice(0, opts.limit ?? DEFAULT_LIMIT);
}

/** Build the kit entry for one component: its variants, slot tokens, and siblings. */
function kitFor(graph: DsGraph, id: string, label: string, score: number): KitComponent {
  const tokens: SlotToken[] = [];
  const siblings = new Map<string, string>();
  graph.forEachOutEdge(id, (key, _a, _s, target) => {
    const e = edgeOf(graph, key);
    if (e.relation === EdgeRelation.usesToken) {
      tokens.push({ id: target, label: labelOf(nodeOf(graph, target)), slot: e.props?.["slot"] as string | undefined });
    } else if (e.relation === EdgeRelation.composedOf || e.relation === EdgeRelation.commonlyUsedWith) {
      siblings.set(target, labelOf(nodeOf(graph, target)));
    }
  });
  graph.forEachInEdge(id, (key, _a, source) => {
    if (edgeOf(graph, key).relation === EdgeRelation.commonlyUsedWith) {
      siblings.set(source, labelOf(nodeOf(graph, source)));
    }
  });
  const variants = nodeOf(graph, id).props?.["props_schema"] as Record<string, unknown> | undefined;
  return {
    id,
    label,
    score: Number(score.toFixed(3)),
    ...(variants ? { variants } : {}),
    tokens,
    siblings: [...siblings.entries()].map(([sid, slabel]) => ({ id: sid, label: slabel })),
  };
}

export async function context(graph: DsGraph, desc: string, opts: ContextOptions = {}): Promise<ContextResult> {
  const resolved = await resolveComponents(graph, desc, opts);
  const components = resolved.map((c) => kitFor(graph, c.id, c.label, c.score));

  const base = components[0] ? { id: components[0].id, label: components[0].label } : null;
  const expr = expressibility(graph, {
    base,
    composables: components.map((c) => ({ id: c.id, label: c.label })),
    slots: opts.slots ?? [],
  });

  return { query: desc, components, expressibility: expr };
}

export { normalize };
