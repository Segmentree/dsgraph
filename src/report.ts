/**
 * REPORT.md — human-readable design↔code reconciliation report (DESIGN.md §15).
 *
 * Renders the reconciliation output (maps-to bridges + findings) as Markdown: a summary,
 * then a section per finding kind (drift, near-miss, orphans, synonyms). Findings already
 * carry human messages from the reconcile passes, so this groups and formats them — it
 * does not re-derive anything. God-nodes / palette-bloat / component-bloat sections land
 * in Phase 4 alongside those analyses.
 */

import {
  NodeType,
  EdgeRelation,
  FindingKind,
  Confidence,
  type GraphDocument,
  type Finding,
} from "./schema.js";

const TITLE = "# dsgraph — design↔code report";
/** Order findings appear in the report (most actionable first). */
const SECTION_ORDER: { kind: FindingKind; heading: string; blurb: string }[] = [
  { kind: FindingKind.drift, heading: "Drift (design ≠ code)", blurb: "Same name on both sides, but the value differs — a design decision code hasn't picked up (or vice-versa)." },
  { kind: FindingKind.nearMissDrift, heading: "Near-miss drift", blurb: "Values close but not equal (within ΔE τ) — likely the same intent, slightly out of sync." },
  { kind: FindingKind.orphanValue, heading: "Orphan values", blurb: "A value present on only one side." },
  { kind: FindingKind.synonyms, heading: "Synonyms (duplicate values)", blurb: "Multiple token names share one value — candidates for consolidation." },
  { kind: FindingKind.paletteBloat, heading: "Palette bloat", blurb: "Clusters of near-identical values spread across distinct tokens — the palette could collapse." },
  { kind: FindingKind.componentBloat, heading: "Component bloat", blurb: "Component pairs with near-identical token/child usage — candidates to merge into one variant axis." },
  { kind: FindingKind.godNode, heading: "God nodes", blurb: "Highest-degree tokens/components — the biggest blast radius if changed." },
  { kind: FindingKind.unusedToken, heading: "Unused tokens", blurb: "Defined but never applied — safe to remove (or wire up)." },
  { kind: FindingKind.orphanComponent, heading: "Orphan components", blurb: "Nothing renders them — likely dead code (a warning, not a certainty)." },
];
const OrphanSide = { figma: "figma", code: "code" } as const;

const bullet = (s: string): string => `- ${s}`;

function summarySection(doc: GraphDocument): string {
  const findings = doc.findings ?? [];
  const mapsTo = doc.edges.filter((e) => e.relation === EdgeRelation.mapsTo);
  const byConfidence = (c: Confidence): number => mapsTo.filter((e) => e.confidence === c).length;
  const tokenN = doc.nodes.filter((n) => n.type === NodeType.Token).length;
  const componentN = doc.nodes.filter((n) => n.type === NodeType.Component).length;

  const lines = [
    `_${doc.nodes.length} nodes · ${doc.edges.length} edges · ${tokenN} tokens · ${componentN} components_`,
    "",
    "## Summary",
    bullet(`**${mapsTo.length}** figma↔code bridges (maps-to): ${byConfidence(Confidence.EXTRACTED)} exact, ${byConfidence(Confidence.INFERRED)} inferred, ${byConfidence(Confidence.AMBIGUOUS)} ambiguous`),
  ];
  if (findings.length) {
    const counts = SECTION_ORDER.map((s) => ({
      kind: s.kind,
      n: findings.filter((f) => f.kind === s.kind).length,
    }))
      .filter((c) => c.n > 0)
      .map((c) => `${c.n} ${c.kind}`)
      .join(", ");
    lines.push(bullet(`findings: ${counts}`));
  } else {
    lines.push(bullet("no findings — design and code are in sync 🎉"));
  }
  return lines.join("\n");
}

/** Orphan-value findings split into design-only vs code-only sub-lists. */
function orphanSection(findings: Finding[]): string[] {
  const design = findings.filter((f) => f.props?.["side"] === OrphanSide.figma);
  const code = findings.filter((f) => f.props?.["side"] === OrphanSide.code);
  const out: string[] = [];
  if (design.length) {
    out.push(`**Design-only (${design.length})** — in Figma, not implemented in code:`);
    out.push(...design.map((f) => bullet(f.message)));
  }
  if (code.length) {
    if (out.length) out.push("");
    out.push(`**Code-only (${code.length})** — in code, not in the Figma system:`);
    out.push(...code.map((f) => bullet(f.message)));
  }
  return out;
}

/** Render the full REPORT.md for a reconciled graph document. */
export function renderReport(doc: GraphDocument): string {
  const findings = doc.findings ?? [];
  const blocks: string[] = [TITLE, "", summarySection(doc)];

  for (const section of SECTION_ORDER) {
    const ofKind = findings.filter((f) => f.kind === section.kind);
    if (!ofKind.length) continue;
    blocks.push("", `## ${section.heading}`, `_${section.blurb}_`, "");
    blocks.push(
      ...(section.kind === FindingKind.orphanValue
        ? orphanSection(ofKind)
        : ofKind.map((f) => bullet(f.message))),
    );
  }

  return blocks.join("\n") + "\n";
}
