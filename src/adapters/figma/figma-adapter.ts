/**
 * Figma adapter (DESIGN.md §4c) — ingests a `figma.json` capture into the graph.
 *
 * Pure ingest: no MCP here. The skill produces `figma.json` (figma-capture.ts); this
 * adapter mints the `@figma` nodes/edges and canonicalizes every token value with the
 * SAME `canonicalize()` the token adapters use — so equal values across the oklch↔Figma
 * boundary collapse onto one shared `RawValue`. That shared node is the bridge unit 2's
 * reconciliation walks (§7). Reconciliation / drift / `maps-to` are NOT done here.
 *
 * A value that won't canonicalize (notably Figma's `Font(…)` / `Effect(…)` composite DSL,
 * deferred to a later unit) is kept on the token as `unresolvedValue`, never dropped —
 * mirroring the Tailwind adapter, so missing values stay visible.
 */

import { readFile } from "node:fs/promises";
import {
  NodeType,
  EdgeRelation,
  Confidence,
  TokenCategory,
  Side,
  type GraphEdge,
  type GraphFragment,
  type GraphNode,
  type TokenNode,
  type ComponentNode,
  type InstanceNode,
} from "../../schema.js";
import { canonicalize, categoryToValueType } from "../../canonicalize/index.js";
import { isColorSyntax } from "../../canonicalize/color.js";
import { figmaPath } from "../../paths.js";
import type { Adapter, AdapterContext } from "../registry.js";
import {
  isFigmaCapture,
  figmaComponentId,
  figmaTokenId,
  figmaInstanceId,
  figmaScreenId,
  DEFAULT_MODE,
  FIGMA_ADAPTER_NAME,
  type FigmaCapture,
  type FigmaToken,
} from "./figma-capture.js";

/** Category assumed when a token omits one and its value isn't recognizable color syntax. */
const FALLBACK_CATEGORY = TokenCategory.other;

/** A token's resolved category + its `@figma` node id — the name→id index edges resolve against. */
interface TokenRef {
  id: string;
  category: TokenCategory;
}

/** Category from the capture, else inferred from a sample value (color syntax → color). */
function resolveCategory(token: FigmaToken): TokenCategory {
  if (token.category) return token.category;
  const sample = Object.values(token.modes)[0] ?? "";
  return isColorSyntax(sample) ? TokenCategory.color : FALLBACK_CATEGORY;
}

async function readCapture(root: string): Promise<FigmaCapture | null> {
  let raw: string;
  try {
    raw = await readFile(figmaPath(root), "utf8");
  } catch {
    return null; // no capture present — adapter simply doesn't fire
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isFigmaCapture(parsed)) {
    throw new Error(`figma.json is not a valid Figma capture (missing source: "${Side.figma}")`);
  }
  return parsed;
}

function extractFromCapture(capture: FigmaCapture): GraphFragment {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const source = { adapter: FIGMA_ADAPTER_NAME };

  // Pass 1 — tokens → Token@figma + canonical RawValue (the bridge) + alias index.
  const tokenByName = new Map<string, TokenRef>();
  for (const token of capture.tokens ?? []) {
    const category = resolveCategory(token);
    const id = figmaTokenId(category, token.name);
    tokenByName.set(token.name, { id, category });

    const tokenNode: TokenNode = {
      id,
      type: NodeType.Token,
      label: token.name,
      props: { category, side: Side.figma },
      sources: [{ ...source, loc: capture.fileKey }],
      confidence: Confidence.EXTRACTED,
    };

    const valueType = categoryToValueType(category);
    for (const [mode, rawValue] of Object.entries(token.modes)) {
      const rv = canonicalize(rawValue, valueType, { scope: category });
      if (!rv) {
        // Composite DSL / unparseable — keep visible, don't fabricate a RawValue.
        tokenNode.props = { ...tokenNode.props, unresolvedValue: rawValue };
        continue;
      }
      nodes.push(rv);
      edges.push({
        source: id,
        target: rv.id,
        relation: EdgeRelation.hasValue,
        ...(mode !== DEFAULT_MODE ? { props: { mode } } : {}),
        confidence: Confidence.EXTRACTED,
      });
    }
    nodes.push(tokenNode);
  }

  // Aliases need every token id resolved first (an alias may point forward).
  for (const token of capture.tokens ?? []) {
    if (!token.alias) continue;
    const from = tokenByName.get(token.name);
    const to = tokenByName.get(token.alias);
    if (!from || !to) continue; // dangling alias target — skip rather than invent a node
    edges.push({
      source: from.id,
      target: to.id,
      relation: EdgeRelation.aliases,
      confidence: Confidence.EXTRACTED,
    });
  }

  // Pass 2 — components → Component@figma (+ props_schema), uses-token, composed-of.
  const componentNames = new Set((capture.components ?? []).map((c) => c.name));
  for (const comp of capture.components ?? []) {
    const id = figmaComponentId(comp.name);
    const node: ComponentNode = {
      id,
      type: NodeType.Component,
      label: comp.name,
      props: {
        side: Side.figma,
        ...(comp.propsSchema ? { props_schema: comp.propsSchema } : {}),
      },
      sources: [{ ...source, loc: comp.nodeId }],
      confidence: Confidence.EXTRACTED,
    };
    nodes.push(node);

    for (const binding of comp.uses ?? []) {
      const ref = tokenByName.get(binding.token);
      if (!ref) continue; // bound to an unknown variable — skip
      edges.push({
        source: id,
        target: ref.id,
        relation: EdgeRelation.usesToken,
        ...(binding.slot ? { props: { slot: binding.slot } } : {}),
        confidence: Confidence.EXTRACTED,
      });
    }

    for (const child of comp.children ?? []) {
      if (child === comp.name || !componentNames.has(child)) continue;
      edges.push({
        source: id,
        target: figmaComponentId(child),
        relation: EdgeRelation.composedOf,
        confidence: Confidence.EXTRACTED,
      });
    }
  }

  // Pass 3 — instances → Instance + instance-of (only for known components).
  capture.instances?.forEach((inst, i) => {
    if (!componentNames.has(inst.of)) return;
    const key = inst.nodeId ?? `${inst.of}:${i}`;
    const id = figmaInstanceId(key);
    const node: InstanceNode = {
      id,
      type: NodeType.Instance,
      label: inst.of,
      props: {
        ...(inst.host ? { host: inst.host } : {}),
        ...(inst.bindings ? { bindings: inst.bindings } : {}),
      },
      sources: [{ ...source, loc: inst.nodeId }],
      confidence: Confidence.EXTRACTED,
    };
    nodes.push(node);
    edges.push({
      source: id,
      target: figmaComponentId(inst.of),
      relation: EdgeRelation.instanceOf,
      confidence: Confidence.EXTRACTED,
    });
  });

  // Pass 4 — screens → Screen + renders-on to the components placed on them.
  for (const screen of capture.screens ?? []) {
    const id = figmaScreenId(screen.nodeId ?? screen.name);
    nodes.push({
      id,
      type: NodeType.Screen,
      label: screen.name,
      sources: [{ ...source, loc: screen.nodeId }],
      confidence: Confidence.EXTRACTED,
    });
    for (const rendered of screen.renders ?? []) {
      if (!componentNames.has(rendered)) continue;
      edges.push({
        source: id,
        target: figmaComponentId(rendered),
        relation: EdgeRelation.rendersOn,
        confidence: Confidence.EXTRACTED,
      });
    }
  }

  return { nodes, edges };
}

export const figmaAdapter: Adapter = {
  name: FIGMA_ADAPTER_NAME,
  async detect(ctx: AdapterContext) {
    return (await readCapture(ctx.root)) !== null;
  },
  async extract(ctx: AdapterContext) {
    const capture = await readCapture(ctx.root);
    return capture ? extractFromCapture(capture) : { nodes: [], edges: [] };
  },
};

export { extractFromCapture };
