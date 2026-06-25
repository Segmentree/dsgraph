/**
 * graph.html emitter (DESIGN.md §15) — a self-contained interactive viewer.
 *
 * Renders the graph with vis-network (loaded from a CDN, physics layout built in) so
 * reviewing a build needs no server or toolchain — just open the file. `RawValue` nodes
 * are painted with their actual color; edge color encodes the edge class.
 *
 * Interaction: physics runs once to lay the graph out, then freezes (nodes only move when
 * dragged). Clicking a node opens a detail panel; "Isolate" keeps only the selected node
 * and everything reachable from it (its dependency subtree). This is a reviewer's view,
 * not the eventual sigma.js layered viz.
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
  [NodeType.Router]: "#22d3ee",
};

const CLASS_COLOR: Record<string, string> = {
  structural: "#cbd5e1",
  bridge: "#a855f7",
  similarity: "#38bdf8",
  convention: "#34d399",
};

const FALLBACK_COLOR = "#9ca3af";
const DEFAULT_EDGE_COLOR = "#cbd5e1";

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

/** Edge label: the mode (light/dark) on has-value edges (as in the original viz). */
function edgeLabel(e: GraphDocument["edges"][number]): string | undefined {
  const mode = e.props?.["mode"];
  return mode ? String(mode) : undefined;
}

interface NodeDetail {
  label: string;
  type: string;
  props: Record<string, unknown>;
}

/** Build the vis datasets + a per-node detail map (for the click panel). */
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
  }));

  const edges = doc.edges.map((e) => ({
    from: e.source,
    to: e.target,
    label: edgeLabel(e),
    color: { color: CLASS_COLOR[EDGE_CLASS[e.relation as EdgeRelation]] ?? DEFAULT_EDGE_COLOR },
    dashes: EDGE_CLASS[e.relation as EdgeRelation] === "similarity",
    arrows: "to",
    font: { size: 10, color: "#94a3b8", strokeWidth: 3, strokeColor: "#0f172a" },
  }));

  const details: Record<string, NodeDetail> = {};
  for (const n of doc.nodes) details[n.id] = { label: n.label ?? n.id, type: n.type, props: n.props ?? {} };

  // Outgoing adjacency for "reachable from" isolation — DEPENDENCY edges only
  // (structural + bridge). Convention/similarity edges are excluded, else a hub
  // component would transitively reach almost the whole graph.
  // Dependency adjacency for isolation: outgoing = descendants, reverse = ancestors.
  // Structural + bridge edges only (convention/similarity don't define dependency).
  const adjacency: Record<string, string[]> = {};
  const rAdjacency: Record<string, string[]> = {};
  // Undirected 1-hop neighbors (all edge types) — used to propagate drag force through edges.
  const neighbors: Record<string, string[]> = {};
  for (const e of doc.edges) {
    const cls = EDGE_CLASS[e.relation as EdgeRelation];
    if (cls === "structural" || cls === "bridge") {
      (adjacency[e.source] ??= []).push(e.target);
      (rAdjacency[e.target] ??= []).push(e.source);
    }
    (neighbors[e.source] ??= []).push(e.target);
    (neighbors[e.target] ??= []).push(e.source);
  }

  return { nodes, edges, details, adjacency, rAdjacency, neighbors };
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
  html, body { margin: 0; height: 100%; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
  #net { position: absolute; inset: 0; z-index: 1; background: #0f172a; }
  #hud { position: fixed; top: 10px; left: 12px; z-index: 10; color: #e2e8f0; background: rgba(15,23,42,.7);
         padding: 8px 12px; border-radius: 8px; }
  #hud b { color: #a5b4fc; }
  .legend span { display: inline-block; margin-right: 10px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 3px; }
  #panel { position: fixed; top: 10px; right: 10px; z-index: 10; width: 320px; max-height: 90vh; overflow: auto;
           color: #e2e8f0; background: #111827; border: 1px solid #334155;
           border-radius: 10px; padding: 12px 14px; display: none; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  #panel .ptype { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #a5b4fc; }
  #panel .pid { font-weight: 600; font-size: 15px; margin: 2px 0 8px; word-break: break-all; }
  #panel .prow { padding: 1px 0; }
  #panel .pk { color: #94a3b8; }
  #panel .pv { color: #e2e8f0; }
  #panel .isodepth { margin-top: 10px; color: #94a3b8; font-size: 12px; }
  #panel .isodepth select { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 5px; padding: 2px 6px; margin-left: 6px; }
  #panel .btns { margin-top: 8px; display: flex; gap: 8px; }
  #panel button { flex: 1; cursor: pointer; border: 1px solid #334155; background: #1e293b; color: #e2e8f0;
                  border-radius: 6px; padding: 6px 8px; font: inherit; }
  #panel button:hover { background: #334155; }
  #panel button:disabled { opacity: .4; cursor: default; }
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
<div id="panel">
  <div class="ptype" id="p-type"></div>
  <div class="pid" id="p-id"></div>
  <div id="p-body"></div>
  <div class="isodepth">
    depth
    <select id="p-depth">
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="3">3</option>
      <option value="0" selected>all</option>
    </select>
  </div>
  <div class="btns">
    <button id="p-desc">Isolate descendants</button>
    <button id="p-anc">Isolate ancestors</button>
  </div>
  <div class="btns">
    <button id="p-reset" disabled>Reset</button>
  </div>
</div>
<div id="net"></div>
<script>
  var DATA = ${data};
  var allNodeIds = DATA.nodes.map(function (n) { return n.id; });
  var ds = new vis.DataSet(DATA.nodes);
  var network = new vis.Network(
    document.getElementById("net"),
    { nodes: ds, edges: new vis.DataSet(DATA.edges) },
    {
      nodes: {
        font: { color: "#e2e8f0", size: 12, strokeWidth: 3, strokeColor: "#0f172a" },
        borderWidth: 2,
        scaling: { min: 6, max: 40, label: { enabled: true, min: 11, max: 22 } },
      },
      edges: { smooth: { type: "continuous" }, width: 1 },
      physics: {
        // forceAtlas2 separates densely-connected clusters far better than barnesHut;
        // a weak spring constant lets repulsion + avoidOverlap spread the core apart.
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: -260,
          centralGravity: 0.005,
          springLength: 220,
          springConstant: 0.02,
          avoidOverlap: 1,
          damping: 0.85,
        },
        minVelocity: 6,
        // Keep the layout phase short so it settles + freezes within the 5s cap.
        stabilization: { iterations: 300 },
      },
      interaction: { hover: true, tooltipDelay: 100, dragNodes: true },
    }
  );

  // Lay out, frame, and freeze so the graph is still — guaranteed within 5s of load
  // (forceAtlas2 left running drifts far longer on a dense graph).
  var frozen = false;
  function settle() {
    if (frozen) return;
    frozen = true;
    network.fit({ animation: false });
    network.setOptions({ physics: false });
  }
  network.once("stabilizationIterationsDone", settle);
  setTimeout(settle, 5000);

  // Drag transmits through edges like springs (NOT via physics, whose global repulsion
  // would shove every node). A dragged node pulls its connected neighbors directly: each
  // generation out follows by DRAG_DECAY^hop of the drag displacement — direct neighbors
  // most, each next hop half as much, disconnected nodes not at all. Physics stays off, so
  // wherever you drop a node it (and the pulled neighbors) stay exactly there.
  var MAX_DRAG_HOPS = 6;
  var DRAG_DECAY = 0.5;
  var MIN_FACTOR = 0.03; // skip nodes whose follow is imperceptible (caps the work per frame)
  var drag = null;
  network.on("dragStart", function (params) {
    var id = params.nodes[0];
    if (!(id && network.body.nodes[id])) { drag = null; return; }
    var hopOf = {}; hopOf[id] = 0;
    var frontier = [id], hop = 0;
    while (frontier.length && hop < MAX_DRAG_HOPS) {
      hop++;
      var next = [];
      frontier.forEach(function (n) {
        (DATA.neighbors[n] || []).forEach(function (m) { if (!(m in hopOf)) { hopOf[m] = hop; next.push(m); } });
      });
      frontier = next;
    }
    // Precompute, once, the affected nodes with a meaningful follow factor + their start
    // positions and a direct reference to the vis node object (no per-frame lookups).
    var node = network.body.nodes;
    var affected = [];
    Object.keys(hopOf).forEach(function (nid) {
      if (nid === id) return;
      var f = Math.pow(DRAG_DECAY, hopOf[nid]);
      if (f < MIN_FACTOR || !node[nid]) return;
      affected.push({ n: node[nid], f: f, ox: node[nid].x, oy: node[nid].y });
    });
    drag = { id: id, sx: node[id].x, sy: node[id].y, affected: affected };
  });
  network.on("dragging", function (params) {
    if (!drag || params.nodes[0] !== drag.id) return;
    var dragged = network.body.nodes[drag.id];
    var dx = dragged.x - drag.sx, dy = dragged.y - drag.sy;
    var a = drag.affected;
    for (var i = 0; i < a.length; i++) {
      a[i].n.x = a[i].ox + dx * a[i].f;
      a[i].n.y = a[i].oy + dy * a[i].f;
    }
    network.redraw(); // one redraw per frame, not one per node
  });
  network.on("dragEnd", function () { drag = null; });

  // ── click → detail panel ──────────────────────────────────────────────────
  var panel = document.getElementById("panel");
  var selected = null;

  function row(k, v, depth) {
    return '<div class="prow" style="margin-left:' + depth * 10 + 'px"><span class="pk">' +
      k + '</span>: <span class="pv">' + v + '</span></div>';
  }
  function header(k, depth) {
    return '<div class="prow" style="margin-left:' + depth * 10 + 'px"><span class="pk">' + k + '</span></div>';
  }
  function formatProps(obj, depth) {
    var out = "";
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (Array.isArray(v)) out += row(k, v.join(", "), depth);
      else if (v && typeof v === "object") out += header(k, depth) + formatProps(v, depth + 1);
      else out += row(k, String(v), depth);
    });
    return out;
  }
  function showPanel(id) {
    var d = DATA.details[id];
    if (!d) return;
    selected = id;
    document.getElementById("p-type").textContent = d.type;
    document.getElementById("p-id").textContent = d.label;
    document.getElementById("p-body").innerHTML = row("id", id, 0) + formatProps(d.props, 0);
    document.getElementById("p-desc").disabled = false;
    document.getElementById("p-anc").disabled = false;
    panel.style.display = "block";
  }
  network.on("click", function (params) {
    if (params.nodes.length) showPanel(params.nodes[0]);
    else { panel.style.display = "none"; selected = null; }
  });

  // ── isolate by descendants / ancestors, to a chosen depth ─────────────────
  // BFS over dependency edges: adjacency = descendants (what it renders/uses),
  // rAdjacency = ancestors (what renders/uses it). depth 0 = unlimited.
  function reachable(start, adj, maxDepth) {
    var seen = {}; seen[start] = true;
    var frontier = [start], depth = 0;
    while (frontier.length && (maxDepth === 0 || depth < maxDepth)) {
      depth++;
      var next = [];
      frontier.forEach(function (cur) {
        (adj[cur] || []).forEach(function (n) { if (!seen[n]) { seen[n] = true; next.push(n); } });
      });
      frontier = next;
    }
    return seen;
  }
  function isolate(adj) {
    if (!selected) return;
    var depth = parseInt(document.getElementById("p-depth").value, 10) || 0;
    var keep = reachable(selected, adj, depth);
    ds.update(allNodeIds.map(function (id) { return { id: id, hidden: !keep[id] }; }));
    network.fit({ nodes: Object.keys(keep), animation: true });
    document.getElementById("p-reset").disabled = false;
  }
  document.getElementById("p-desc").onclick = function () { isolate(DATA.adjacency); };
  document.getElementById("p-anc").onclick = function () { isolate(DATA.rAdjacency); };
  document.getElementById("p-reset").onclick = function () {
    ds.update(allNodeIds.map(function (id) { return { id: id, hidden: false }; }));
    network.fit({ animation: true });
    document.getElementById("p-reset").disabled = true;
  };
</script>
</body>
</html>
`;
}

export async function writeViz(path: string, doc: GraphDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderHtml(doc), "utf8");
}
