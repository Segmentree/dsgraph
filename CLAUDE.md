# dsgraph — project intent & handoff

> This file is the orientation for any Claude Code session starting in this folder.
> Read `DESIGN.md` next — it is the full technical spec. This file is the summary +
> the decisions that are already locked.

## What we are building

A **design-system knowledge graph** for an app — like
[graphify](https://github.com/safishamsi/graphify) (an MIT-licensed code→graph tool,
cloned read-only into `references/graphify/`), but specialized for a design system.

Goal: turn an app's **design tokens + components + Figma file** into one queryable
graph so an agent can, before building new UI, ask *"what do we already have, what does
a Card normally use, and can this new thing be expressed with the current system or does
it need a new token/component?"* It also detects design↔code **drift**, **palette bloat**,
and **component bloat**.

The three uses, combined: **drift detection**, **discoverability/docs**, and
**impact analysis** — all feeding a **generation/retrieval** workflow.

## Locked decisions

1. **Language: TypeScript / Node.** (CLI + `/dsgraph` skill share one runtime. Token
   sources are either JS/TS configs we *evaluate* via `tailwindcss/resolveConfig`, **or**
   — as in the first real target — **Tailwind v4 CSS-first config**: tokens live in a CSS
   file (`:root`/`.dark`/`@theme inline`) as CSS variables, no `tailwind.config.js`. Both
   token adapters exist; the v4/CSS-variable adapter is the one this target exercises. See
   DESIGN.md §4a.)
2. **Embeddings: yes**, for query/`context` seed resolution. Use a **local model**
   (`transformers.js` / `fastembed`) or an embeddings API — **NOT** from graphify
   (graphify's "semantic similarity" is LLM-emitted edges, not a vector index).
3. **Figma access: Dev Mode MCP** (already connected in the user's IDE). The `/dsgraph`
   skill calls the MCP tools and writes `dsgraph-out/figma.json`; the CLI ingests it.
4. **Matching is value-first, not name-first.** Canonicalize every token value →
   `RawValue` node (type-scoped) → tokens sharing a value are linked. Name similarity is
   only a tiebreaker inside a value cluster. See DESIGN.md §3, §7.
5. **Tune thresholds (ΔE ε=10, near-miss τ=3, etc.) on real data**, not upfront.
6. **graphify = optional structural-import adapter + dev-time oracle, NOT the primary
   extractor.** Reasons in DESIGN.md §0.1. Our native tree-sitter component adapter is the
   spine. graphify is MIT — if we ever port a substantial code block, include its MIT notice.
7. **First real target: the user's web dashboard** — `~/projects/web-apps/apps/web`, a
   Next.js + React + TypeScript app in a **pnpm monorepo**. The design system is a shared
   package `@workspace/ui` (`~/projects/web-apps/packages/ui`); tokens live in
   `packages/ui/src/styles/globals.css` (Tailwind v4, oklch colors, light + `.dark` modes).
   Components are **shadcn/ui (new-york) + `class-variance-authority`** — variant axes come
   from `cva({ variants })`, not TS union props (Phase 2 adapter must read cva). See §4b.

## Do this first (orientation)

Before writing extractor code, run graphify on the target app to get a fast structural map
and a component-inventory **ground truth** to validate our own extractor against:

```bash
# from the target app's repo root
graphify .          # or: uvx graphifyy ... ; see references/graphify/README.md
```

Then read its `graphify-out/graph.json` to see the component skeleton it found.

## Architecture in one breath

`detect → extract (token adapters + tree-sitter component adapter + Figma adapter)
→ build+dedup → canonicalize→RawValue → reconcile(value-first) → derive layers
(similar-to ΔE, commonly-used-with conventions, variant envelopes) → cluster → analyze
→ emit (graph.json, graph.html, REPORT.md, manifest.json)` plus read-side verbs
`query / path / explain / impact / context / match`. Full detail in DESIGN.md.

Three edge classes: **structural** (EXTRACTED), **similarity** (ΔE-weighted),
**convention** (frequency-weighted). Confidence tags everywhere: EXTRACTED / INFERRED /
AMBIGUOUS.

## MVP phases (DESIGN.md §16)

0. scaffold (schema types, graph.json IO, CLI skeleton, graphology)
1. Tailwind adapter + value canonicalizer + RawValue + similar-to + query/explain/match
2. tree-sitter component adapter (2-pass): uses-token, composed-of, instances, variant
   envelopes, commonly-used-with
3. Figma adapter via skill + reconciliation + drift/orphan report
4. context + expressibility; palette-bloat + component-bloat
5. incremental update, watch, git hook, viz, team merge

## GitHub — use the PERSONAL account

This is a side project, so all GitHub operations must use the user's **personal**
account (`segmentree`), NOT their work account. The personal `gh` config lives at
`~/.config/gh-segmentree`. Prefix every `gh` command with `GH_CONFIG_DIR`:

```bash
GH_CONFIG_DIR=~/.config/gh-segmentree gh auth status
GH_CONFIG_DIR=~/.config/gh-segmentree gh repo create dsgraph --private --source=. ...
GH_CONFIG_DIR=~/.config/gh-segmentree gh pr create ...
```

Optionally `export GH_CONFIG_DIR=~/.config/gh-segmentree` for the session. Never run a
bare `gh` here — it would default to the work account.

## Conventions

- **No magic values.** Hardcoded numbers, strings, and regexes become named `const`s
  (e.g. `BASE_ROOT_PX = 16`, `LENGTH_RE`, `MAX_8BIT = 255`). No bare literals in logic.
- **Enum-like vocabularies = `const` object + derived same-name union type.** Define each
  closed string set once as a frozen object and derive the type from it, so values and type
  can never drift:
  ```ts
  export const ValueType = { color: "color", dimension: "dimension" /* … */ } as const;
  export type ValueType = (typeof ValueType)[keyof typeof ValueType];
  ```
  Then reference the named members everywhere — `case`/`switch` labels, `return`s, and
  constructed node/edge objects (`type: NodeType.RawValue`, not `type: "RawValue"`). The
  domain vocabularies live in `src/schema.ts` (`NodeType`, `ValueType`, `TokenCategory`,
  `EdgeRelation`, …); import and reuse them, never re-spell the literals. Tests may assert
  against literals directly (pinning the wire value is the point).
- `references/` and `dsgraph-out/` are git-ignored.
