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
  .option("--resolution <n>", "Louvain resolution", parseFloat)
  .action(async (path: string, opts: { viz?: boolean }) => {
    const { doc, activated, dangling, similar, unresolvedTokens, outPath, vizPath } = await build(
      path,
      { viz: opts.viz },
    );
    console.log(`adapters fired: ${activated.length ? activated.join(", ") : "none"}`);
    console.log(`${doc.nodes.length} nodes, ${doc.edges.length} edges (${similar} similar-to) → ${outPath}`);
    if (vizPath) console.log(`viz → ${vizPath}`);
    if (unresolvedTokens) console.warn(`⚠ ${unresolvedTokens} token(s) with unresolved values`);
    if (dangling) console.warn(`⚠ ${dangling} dangling edge(s)`);
  });

// ── Read side ─────────────────────────────────────────────────────────────────

program
  .command("query <q>")
  .description("best-first weighted traversal from NL seeds (§10.1)")
  .option("--dfs", "depth-first frontier")
  .option("--budget <n>", "token budget", (v) => parseInt(v, 10), 2000)
  .action(todo("Phase 1"));

program
  .command("path <a> <b>")
  .description("shortest / k-shortest path between two nodes (§10.2)")
  .action(todo("Phase 1"));

program
  .command("explain <x>")
  .description("neighborhood digest grouped by relation (§10.3)")
  .action(todo("Phase 1"));

program
  .command("impact <x>")
  .description("reverse reachability — what breaks if x changes (§10.4)")
  .action(todo("Phase 2"));

program
  .command("context <desc>")
  .description("generation retrieval — build kit + reuse-vs-introduce (§10.5)")
  .action(todo("Phase 4"));

program
  .command("match <value>")
  .description("canonicalize a literal value → RawValue → tokens + neighbors (§10.6)")
  .action(todo("Phase 1"));

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
