/**
 * Build pipeline (DESIGN.md §1, §5): detect → extract → merge → emit.
 *
 * Phase 1 wires the token side: run the registered adapters against the target,
 * merge their fragments (dedup nodes by id, edges by source·relation·target), and
 * write `graph.json`. Derived layers (similar-to, conventions), reconciliation, and
 * analysis attach to this same merged document in later units.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { mergeFragments, writeGraph, findDanglingEdges } from "./graph.js";
import { graphPath, vizPath, reportPath } from "./paths.js";
import { writeViz } from "./viz.js";
import { renderReport } from "./report.js";
import { runAdapters, type Adapter } from "./adapters/registry.js";
import { tailwindV4Adapter } from "./adapters/tailwind-v4.js";
import { tailwindConfigAdapter } from "./adapters/tailwind-config.js";
import { reactComponentAdapter } from "./adapters/components/component-adapter.js";
import { figmaAdapter } from "./adapters/figma/figma-adapter.js";
import { buildClassResolver } from "./adapters/components/class-resolver.js";
import { deriveSimilarTo } from "./derive/similar-to.js";
import { deriveComposition } from "./derive/composition.js";
import { deriveCommonlyUsedWith } from "./derive/conventions.js";
import { reconcileTokens } from "./reconcile/tokens.js";
import { reconcileComponents } from "./reconcile/components.js";
import { analyzeGraph } from "./analyze/findings.js";
import { ValueType, type GraphDocument, type Finding } from "./schema.js";

/** Node-id suffix marking the Figma side — reconciliation only runs when this is present. */
const FIGMA_ID_SUFFIX = "@figma";

/** Token adapters run first — they produce the class→token resolver (DESIGN.md §4a). */
export const TOKEN_ADAPTERS: Adapter[] = [tailwindV4Adapter, tailwindConfigAdapter];
/** Component adapters run second, with the resolver in context (§4b). */
export const COMPONENT_ADAPTERS: Adapter[] = [reactComponentAdapter];
/** Figma adapter runs third — ingests a `figma.json` capture if the skill wrote one (§4c). */
export const FIGMA_ADAPTERS: Adapter[] = [figmaAdapter];
/** All structural adapters (back-compat / single-list callers). */
export const DEFAULT_ADAPTERS: Adapter[] = [
  ...TOKEN_ADAPTERS,
  ...COMPONENT_ADAPTERS,
  ...FIGMA_ADAPTERS,
];

export interface BuildResult {
  doc: GraphDocument;
  /** Names of adapters that fired. */
  activated: string[];
  dangling: number;
  /** Count of derived similar-to edges. */
  similar: number;
  /** Count of reconciliation maps-to (bridge) edges between Figma and code. */
  mapsTo: number;
  /** Reconciliation findings (drift / near-miss / orphan / synonyms). */
  findings: Finding[];
  /** Tokens whose value couldn't be canonicalized (visible, not silently dropped). */
  unresolvedTokens: number;
  outPath: string;
  vizPath?: string;
  /** Path to REPORT.md when reconciliation ran (figma side present). */
  reportPath?: string;
}

export interface BuildOptions {
  /** Token adapters (run first → resolver). */
  tokenAdapters?: Adapter[];
  /** Component adapters (run second, given the resolver). */
  componentAdapters?: Adapter[];
  /** Figma adapters (run third — ingest figma.json if present). */
  figmaAdapters?: Adapter[];
  /** Skip writing graph.json (in-memory build, for tests/queries). */
  write?: boolean;
  /** Emit graph.html alongside graph.json (default true when writing). */
  viz?: boolean;
  /** ΔE threshold for the similar-to layer (default DEFAULT_EPSILON). */
  similarEpsilon?: number;
  /** Near-miss ΔE threshold τ for reconciliation (default DEFAULT_TAU). */
  tau?: number;
  /** Emit a node per component usage (Pass 2). Off by default (aggregate envelope only). */
  emitInstances?: boolean;
}

export async function build(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
  // Phase A — token adapters → token fragments → class→token resolver.
  const tokenRun = await runAdapters(opts.tokenAdapters ?? TOKEN_ADAPTERS, { root });
  const tokenFrag = mergeFragments(tokenRun.map((a) => a.fragment));
  const resolveClass = buildClassResolver(tokenFrag.nodes);

  // Phase B — component adapters, handed the resolver.
  const componentRun = await runAdapters(opts.componentAdapters ?? COMPONENT_ADAPTERS, {
    root,
    resolveClass,
    emitInstances: opts.emitInstances,
  });

  // Phase C — figma adapter ingests figma.json if the skill wrote one (§4c). It needs
  // no resolver: its values canonicalize onto the same RawValue ids the token side mints.
  const figmaRun = await runAdapters(opts.figmaAdapters ?? FIGMA_ADAPTERS, { root });

  const activated = [...tokenRun, ...componentRun, ...figmaRun];
  const merged = mergeFragments([
    { nodes: tokenFrag.nodes, edges: tokenFrag.edges },
    ...componentRun.map((a) => a.fragment),
    ...figmaRun.map((a) => a.fragment),
  ]);

  // Derived layer 1: materialize composite sub-values + composed-of (§6a). Re-merge so
  // sub-values that equal existing RawValues dedup by id.
  const doc = mergeFragments([
    { nodes: merged.nodes, edges: merged.edges },
    deriveComposition(merged),
  ]);

  // Derived layer 2: perceptual/numeric value similarity (§6b) — now also over the
  // materialized sub-values.
  const similarEdges = deriveSimilarTo(doc, {
    epsilon: opts.similarEpsilon === undefined ? undefined : { [ValueType.color]: opts.similarEpsilon },
  });
  doc.edges.push(...similarEdges);

  // Derived layer 3: convention edges (commonly-used-with) from composed-of (§6c).
  doc.edges.push(...deriveCommonlyUsedWith(doc));

  // Reconciliation (§7): value-first maps-to between Figma and code tokens, then a
  // structural pass over components. Only meaningful when BOTH sides are present — with
  // no Figma capture, every code value would be a trivial "code-only" orphan, so skip.
  const hasFigma = doc.nodes.some((n) => n.id.endsWith(FIGMA_ID_SUFFIX));
  const mapsToEdges: GraphDocument["edges"] = [];
  const reconFindings: Finding[] = [];
  if (hasFigma) {
    const tokenRecon = reconcileTokens(doc, { tau: opts.tau });
    const componentRecon = reconcileComponents(doc);
    doc.edges.push(...tokenRecon.edges, ...componentRecon.edges);
    mapsToEdges.push(...tokenRecon.edges, ...componentRecon.edges);
    reconFindings.push(...tokenRecon.findings, ...componentRecon.findings);
  }

  // Analysis (§9): code-side health checks — palette/component bloat, god nodes,
  // unused tokens, orphan components. Runs on any build (no Figma side required).
  const analysisFindings = analyzeGraph(doc);
  const findings = [...reconFindings, ...analysisFindings];
  if (findings.length) doc.findings = findings;

  const outPath = graphPath(root);
  const writing = opts.write !== false;
  if (writing) await writeGraph(outPath, doc);

  let viz: string | undefined;
  if (writing && opts.viz !== false) {
    viz = vizPath(root);
    await writeViz(viz, doc);
  }

  // REPORT.md — only when reconciliation produced something (figma side present).
  let report: string | undefined;
  if (writing && (mapsToEdges.length || findings.length)) {
    report = reportPath(root);
    await mkdir(dirname(report), { recursive: true });
    await writeFile(report, renderReport(doc), "utf8");
  }

  const unresolvedTokens = doc.nodes.filter(
    (n) => n.type === "Token" && n.props?.["unresolvedValue"] !== undefined,
  ).length;

  return {
    doc,
    activated: activated.map((a) => a.adapter.name),
    dangling: findDanglingEdges(doc).length,
    similar: similarEdges.length,
    mapsTo: mapsToEdges.length,
    findings,
    unresolvedTokens,
    outPath,
    vizPath: viz,
    reportPath: report,
  };
}
