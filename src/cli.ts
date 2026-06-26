#!/usr/bin/env node
/**
 * dsgraph CLI skeleton (DESIGN.md §15).
 *
 * Phase 0: command surface is wired and graph.json can be loaded/inspected.
 * Build (`detect → extract → … → emit`) and the read verbs are stubbed with
 * NOT_IMPLEMENTED notices that land in later phases; they parse args and load
 * the graph so the plumbing is exercised end to end.
 */

import { Command } from "commander";
import { readGraph, toGraphology } from "./graph.js";
import { build } from "./build.js";
import { graphPath } from "./paths.js";
import { EDGE_CLASS, type EdgeRelation } from "./schema.js";
import { match } from "./query/match.js";
import { explain } from "./query/explain.js";
import { query } from "./query/query.js";
import { context } from "./query/context.js";
import { localEmbedder } from "./embed/local.js";
import type { DsGraph } from "./query/util.js";

/** Load graph.json from a project root into a traversable graph. */
async function loadGraph(root: string): Promise<DsGraph> {
  const doc = await readGraph(graphPath(root));
  return toGraphology(doc).graph;
}

const program = new Command();

program
  .name("dsgraph")
  .description("A design-system knowledge graph: tokens + components + Figma, queryable.")
  .version("0.0.0");

const todo = (phase: string) => (..._args: unknown[]) => {
  console.error(`NOT_IMPLEMENTED — lands in MVP ${phase} (see DESIGN.md §16).`);
  process.exitCode = 2;
};

// ── Build side ────────────────────────────────────────────────────────────────

program
  .argument("[path]", "target app root to scan", ".")
  .option("--figma <key>", "Figma file key (figma.json must be present)")
  .option("--update", "incremental update from manifest (DESIGN.md §12)")
  .option("--watch", "watch + rebuild on save")
  .option("--no-viz", "skip graph.html emission")
  .option("--instances", "emit a node per component usage (Pass 2; large graph)")
  .option("--resolution <n>", "Louvain resolution", parseFloat)
  .action(async (path: string, opts: { viz?: boolean; instances?: boolean }) => {
    const { doc, activated, dangling, similar, mapsTo, findings, unresolvedTokens, outPath, vizPath, reportPath: report } =
      await build(path, { viz: opts.viz, emitInstances: opts.instances });
    console.log(`adapters fired: ${activated.length ? activated.join(", ") : "none"}`);
    console.log(`${doc.nodes.length} nodes, ${doc.edges.length} edges (${similar} similar-to) → ${outPath}`);
    if (mapsTo) console.log(`${mapsTo} maps-to (figma↔code bridge)`);
    if (findings.length) {
      const byKind = findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.kind] = (acc[f.kind] ?? 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(byKind)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
      console.log(`findings: ${summary}`);
    }
    if (vizPath) console.log(`viz → ${vizPath}`);
    if (report) console.log(`report → ${report}`);
    if (unresolvedTokens) console.warn(`⚠ ${unresolvedTokens} token(s) with unresolved values`);
    if (dangling) console.warn(`⚠ ${dangling} dangling edge(s)`);
  });

// ── Read side ─────────────────────────────────────────────────────────────────

program
  .command("query <q>")
  .description("best-first weighted traversal from NL seeds (§10.1)")
  .option("--root <dir>", "project root containing dsgraph-out/", ".")
  .option("--budget <n>", "max nodes to surface", (v) => parseInt(v, 10), 30)
  .action(async (q: string, opts: { root: string; budget: number }) => {
    const graph = await loadGraph(opts.root);
    const { seeds, nodes } = query(graph, q, opts.budget);
    if (!seeds.length) return console.log(`no seeds matched "${q}"`);
    console.log(`query "${q}" — seeds: ${seeds.join(", ")}`);
    for (const n of nodes) {
      console.log(`  ${"  ".repeat(n.hop)}[${n.hop}] ${n.label} (${n.type}) rel=${n.relevance}`);
    }
  });

program
  .command("path <a> <b>")
  .description("shortest / k-shortest path between two nodes (§10.2)")
  .action(todo("a later unit"));

program
  .command("explain <x>")
  .description("neighborhood digest grouped by relation (§10.3)")
  .option("--root <dir>", "project root containing dsgraph-out/", ".")
  .action(async (x: string, opts: { root: string }) => {
    const graph = await loadGraph(opts.root);
    const r = explain(graph, x);
    if (!r) return console.log(`no node matched "${x}"`);
    console.log(`${r.label} (${r.type})  [${r.id}]`);
    if (r.props) console.log(`  props: ${formatProps(r.props)}`);
    for (const g of r.groups) {
      console.log(`  ${g.relation}:`);
      for (const nb of g.neighbors) {
        const arrow = nb.direction === "out" ? "→" : "←";
        const extra = nb.props?.["mode"] ? ` (${nb.props["mode"]})` : "";
        const conf = nb.confidence ? ` [${nb.confidence}]` : "";
        console.log(`    ${arrow} ${nb.label}${extra}${conf}`);
      }
    }
    if (r.sharesValueWith.length) {
      console.log(`  shares value with: ${r.sharesValueWith.map((s) => s.label).join(", ")}`);
    }
  });

program
  .command("impact <x>")
  .description("reverse reachability — what breaks if x changes (§10.4)")
  .action(todo("Phase 2"));

program
  .command("context <desc>")
  .description("generation retrieval — build kit + reuse-vs-introduce (§10.5)")
  .option("--root <dir>", "project root containing dsgraph-out/", ".")
  .option("--slot <slot=value...>", "desired slot value(s), e.g. surface=#2563eb radius=8px")
  .option("--no-embed", "skip the local embedding model (lexical resolution only)")
  .action(async (desc: string, opts: { root: string; slot?: string[]; embed?: boolean }) => {
    const graph = await loadGraph(opts.root);
    const slots = (opts.slot ?? []).map((s) => {
      const eq = s.indexOf("=");
      return { slot: s.slice(0, eq), value: s.slice(eq + 1) };
    });
    const embedder = opts.embed === false ? undefined : localEmbedder({ root: opts.root });
    const r = await context(graph, desc, { embedder, slots });

    console.log(`context "${r.query}"`);
    if (!r.components.length) console.log("  no existing components matched.");
    for (const c of r.components) {
      console.log(`  ◆ ${c.label} (${c.score})${c.variants ? ` — variants: ${Object.keys(c.variants).join(", ")}` : ""}`);
      if (c.tokens.length) {
        const toks = c.tokens.map((t) => (t.slot ? `${t.slot}:${t.label}` : t.label)).join(", ");
        console.log(`      tokens: ${toks}`);
      }
      if (c.siblings.length) console.log(`      with: ${c.siblings.map((s) => s.label).join(", ")}`);
    }
    const e = r.expressibility;
    console.log(`\n  verdict: ${e.component}${e.base ? ` → ${e.base.label}` : ""}`);
    for (const d of e.slots) {
      const detail =
        d.verdict === "SNAP-SUGGEST" && d.snapTo
          ? ` → snap to ${d.snapTo.label} (Δ${d.snapTo.distance.toFixed(2)})`
          : d.tokens?.length
            ? ` → ${d.tokens.map((t) => t.label).join(", ")}`
            : "";
      console.log(`    ${d.slot}=${d.value}: ${d.verdict}${detail}`);
    }
  });

program
  .command("match <value>")
  .description("canonicalize a literal value → RawValue → tokens + neighbors (§10.6)")
  .option("--root <dir>", "project root containing dsgraph-out/", ".")
  .action(async (value: string, opts: { root: string }) => {
    const graph = await loadGraph(opts.root);
    const r = match(graph, value);
    const ty = r.valueType ? ` (${r.valueType})` : "";
    console.log(`match "${r.input}"${ty}`);
    if (r.inSystem && r.exact) {
      console.log(`  in system: ${r.exact.rawValueId}`);
      console.log(`  carried by: ${formatTokens(r.exact.tokens)}`);
      if (r.similar.length) {
        console.log("  similar:");
        for (const s of r.similar) {
          console.log(`    Δ${s.distance ?? "?"}  ${s.label} → ${formatTokens(s.tokens)}`);
        }
      }
    } else if (r.nearest.length) {
      console.log("  not in system. nearest:");
      for (const s of r.nearest) console.log(`    Δ${s.distance}  ${s.label} → ${formatTokens(s.tokens)}`);
    } else {
      console.log("  not in system, no near matches.");
    }
  });

function formatTokens(tokens: { label: string; mode?: string }[]): string {
  if (!tokens.length) return "(no tokens)";
  return tokens.map((t) => (t.mode ? `${t.label}:${t.mode}` : t.label)).join(", ");
}

function formatProps(props: Record<string, unknown>): string {
  return Object.entries(props)
    .filter(([, v]) => typeof v !== "object")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

// ── Plumbing (live in Phase 0) ────────────────────────────────────────────────

program
  .command("info")
  .description("load graph.json and print node/edge counts by type/class")
  .option("--root <dir>", "project root containing dsgraph-out/", ".")
  .action(async (opts: { root: string }) => {
    const doc = await readGraph(graphPath(opts.root));
    const { graph, skipped } = toGraphology(doc);

    const byType = new Map<string, number>();
    for (const n of doc.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);

    const byClass = new Map<string, number>();
    for (const e of doc.edges) {
      const cls = EDGE_CLASS[e.relation as EdgeRelation] ?? "unknown";
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    }

    console.log(`graph.json v${doc.version}`);
    console.log(`  ${graph.order} nodes, ${graph.size} edges loaded`);
    console.log("  nodes by type:");
    for (const [t, c] of [...byType].sort()) console.log(`    ${t}: ${c}`);
    console.log("  edges by class:");
    for (const [t, c] of [...byClass].sort()) console.log(`    ${t}: ${c}`);
    if (skipped.length) console.warn(`  ⚠ ${skipped.length} dangling edge(s) skipped`);
  });

program
  .command("install")
  .description("register the /dsgraph skill + CLAUDE.md nudge (§14)")
  .action(todo("Phase 5"));

program
  .command("hook <action>")
  .description("git post-commit hook management (§13)")
  .action(todo("Phase 5"));

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
