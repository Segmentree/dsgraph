/**
 * graph.html emitter (DESIGN.md §15) — a self-contained interactive viewer.
 *
 * Renders the graph with vis-network (loaded from a CDN, physics layout built in)
 * so reviewing a build needs no server or toolchain — just open the file. Color
 * `RawValue` nodes are painted with their actual color, so the palette is visible
 * at a glance; edge color encodes the edge class (structural/similarity/convention).
 * This is a reviewer's view, not the eventual sigma.js layered viz.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EDGE_CLASS, NodeType, type EdgeRelation, type GraphDocument } from "./schema.js";

const VIS_CDN = "https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js";

/** Node fill by type (RawValue colors override with their real color). */
const TYPE_COLOR: Record<string, string> = {
  [NodeType.Token]: "#6366f1",
  [NodeType.RawValue]: "#94a3b8",
  [NodeType.Component]: "#f59e0b",
  [NodeType.Instance]: "#fbbf24",
  [NodeType.Screen]: "#10b981",
  [NodeType.Asset]: "#ec4899",
};

const CLASS_COLOR: Record<string, string> = {
  structural: "#cbd5e1",
  bridge: "#a855f7",
  similarity: "#38bdf8",
  convention: "#34d399",
};

const FALLBACK_COLOR = "#9ca3af";

/**
 * Node color as an explicit `{background, border}` object — NOT a string, and NOT via
 * vis groups. vis-network's auto-assigned group color silently overrides a per-node
 * color *string* for some nodes; an explicit object with no `group` field is honored.
 */
function nodeColor(node: GraphDocument["nodes"][number]): { background: string; border: string } {
  const rgba = node.props?.["rgba"] as [number, number, number, number] | undefined;
  if (node.type === NodeType.RawValue && rgba) {
    const c = `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`;
    return { background: c, border: c };
  }
  const c = TYPE_COLOR[node.type] ?? FALLBACK_COLOR;
  return { background: c, border: c };
}

/** Build the vis-network node/edge datasets. Nodes are sized by degree; labels are
 *  carried separately and shown on hover only (kills overlap at high node counts). */
function toVisData(doc: GraphDocument) {
  const degree = new Map<string, number>();
  for (const e of doc.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const nodes = doc.nodes.map((n) => ({
    id: n.id,
    label: n.label ?? n.id,
    value: degree.get(n.id) ?? 0,
    color: nodeColor(n),
    shape: n.type === NodeType.RawValue ? "dot" : "box",
    title: htmlTitle(n.id, n.props),
  }));

  const edges = doc.edges.map((e) => ({
    from: e.source,
    to: e.target,
    label: edgeLabel(e),
    color: { color: CLASS_COLOR[EDGE_CLASS[e.relation as EdgeRelation]] ?? "#cbd5e1" },
    dashes: EDGE_CLASS[e.relation as EdgeRelation] === "similarity",
    arrows: "to",
    font: { size: 10, color: "#94a3b8", strokeWidth: 3, strokeColor: "#0f172a" },
  }));
  return { nodes, edges };
}

/** Edge label: the mode (light/dark) on has-value edges (as in the original viz). */
function edgeLabel(e: GraphDocument["edges"][number]): string | undefined {
  const mode = e.props?.["mode"];
  return mode ? String(mode) : undefined;
}

function htmlTitle(id: string, props?: Record<string, unknown>): string {
  const lines = [id, ...(props ? Object.entries(props).map(([k, v]) => `${k}: ${JSON.stringify(v)}`) : [])];
  return lines.join("\n");
}

export function renderHtml(doc: GraphDocument): string {
  const data = JSON.stringify(toVisData(doc));
  const counts = `${doc.nodes.length} nodes · ${doc.edges.length} edges`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>dsgraph</title>
<script src="${VIS_CDN}"></script>
<style>
  html, body { margin: 0; height: 100%; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
  #net { width: 100vw; height: 100vh; background: #0f172a; }
  #hud { position: fixed; top: 10px; left: 12px; color: #e2e8f0; background: rgba(15,23,42,.7);
         padding: 8px 12px; border-radius: 8px; }
  #hud b { color: #a5b4fc; }
  .legend span { display: inline-block; margin-right: 10px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 3px; }
</style>
</head>
<body>
<div id="hud">
  <div><b>dsgraph</b> — ${counts}</div>
  <div class="legend">
    <span><i style="background:#6366f1"></i>Token</span>
    <span><i style="background:#94a3b8"></i>RawValue (real color)</span>
    <span><i style="background:#f59e0b"></i>Component</span>
  </div>
</div>
<div id="net"></div>
<script>
  const { nodes, edges } = ${data};
  new vis.Network(
    document.getElementById("net"),
    { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
    {
      nodes: {
        font: { color: "#e2e8f0", size: 12, strokeWidth: 3, strokeColor: "#0f172a" },
        borderWidth: 2,
        scaling: { min: 6, max: 40, label: { enabled: true, min: 11, max: 22 } },
      },
      edges: { smooth: { type: "continuous" }, width: 1 },
      physics: {
        barnesHut: { gravitationalConstant: -22000, springLength: 170, centralGravity: 0.12 },
        stabilization: { iterations: 300 },
      },
      interaction: { hover: true, tooltipDelay: 100 },
    }
  );
</script>
</body>
</html>
`;
}

export async function writeViz(path: string, doc: GraphDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderHtml(doc), "utf8");
}
