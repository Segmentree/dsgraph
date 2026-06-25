# dsgraph — Technical Design

A design-system knowledge graph: extract an app's **design tokens + components + Figma
file** into one queryable property graph that powers drift detection, discoverability,
impact analysis, and — the headline use — **generation** ("what do we already have, and
can a new thing be built from it or must we extend the system?").

Modeled on [graphify](https://github.com/safishamsi/graphify) (MIT, in
`references/graphify/`) for the generic graph-RAG plumbing, but the design-system core
(value bridge, ΔE similarity, variant envelopes, expressibility) is our own — graphify
has none of it.

---

## 0. Stack

TypeScript / Node.

| Need | Choice | Why |
|---|---|---|
| Parse components (TSX) | **`ts-morph`** (TS compiler API) | target is 100% TSX — native + type-aware (reads `cva`/`VariantProps`/JSX); "best parser per language" (CSS already uses postcss). `web-tree-sitter` kept for future vue/svelte breadth |
| Parse CSS | `postcss` | token CSS (`:root`/`@theme`); see §4a |
| Read Tailwind config | `tailwindcss/resolveConfig` | evaluates the *resolved* theme, not a regex guess |
| Color math | `culori` / `colorjs.io` | sRGB↔Lab, ΔE2000 |
| Graph + clustering | `graphology` + `graphology-communities-louvain` | property graph, Louvain |
| Layout + viz | `forceatlas2` + `sigma.js` | force-directed HTML |
| Embeddings | `transformers.js` / `fastembed` (local) or API | seed resolution (§10.0) |
| CLI | `clipanion` / `commander` | — |

### 0.1 graphify's role — optional, not the spine

graphify's `graph.json` contains the **structural skeleton** (components, files,
import/call edges) and is consumed cleanly as JSON (subprocess + read — no Python-in-TS
issue). But it has **none** of: `uses-token`, canonicalized values / `RawValue`, slot
bindings, variant envelopes, Figma. And because our token extraction must parse component
bodies anyway, routing component discovery through graphify means double-parsing + id
reconciliation + a Python runtime dep, and its import edges ≠ render composition.

Therefore: **native tree-sitter component adapter is the spine.** graphify is used (1) as a
**dev-time orientation map + component-inventory oracle** to validate our extractor, and
(2) later as an optional `graphify-import` adapter for multi-language breadth. MIT — port
with attribution if ever needed.

---

## 1. Pipeline

```
detect → extract(token adapters) + extract(component adapter) + extract(figma adapter)
       → buildGraph + dedup
       → canonicalize → RawValue bridge
       → reconcile (value-first matching)
       → deriveLayers (similar-to ΔE, commonly-used-with conventions, variant envelopes)
       → cluster → analyze
       → emit (graph.json, graph.html, REPORT.md, manifest.json, figma.json)
       → [read side] query / path / explain / impact / context / match
```

Pure functions passing a plain graph object; side effects only in `dsgraph-out/`.

---

## 2. Data model

Property graph. `graph.json` shape:

```jsonc
{
  "version": 1,
  "nodes": [
    { "id": "token:color:surface-100", "type": "Token", "label": "surface-100",
      "props": { "category": "color", "tier": "semantic" },
      "sources": [ {"adapter":"tailwind","file":"tailwind.config.js","loc":"theme.colors.surface.100"} ],
      "confidence": "EXTRACTED" },
    { "id": "value:color:244,244,245,255", "type": "RawValue",
      "props": { "valueType":"color", "rgba":[244,244,245,255], "lab":[96.3,0.1,-0.4] } },
    { "id": "component:Card@code", "type": "Component",
      "props": { "framework":"react",
                 "props_schema": {"padding":["sm","md","lg"], "tone":["neutral","raised"]} },
      "sources":[{"file":"components/Card.tsx","loc":"L12"}] }
  ],
  "edges": [
    { "source":"token:color:surface-100", "target":"value:color:244,244,245,255",
      "relation":"has-value", "props":{"mode":"light"}, "confidence":"EXTRACTED" },
    { "source":"component:Card@code", "target":"token:color:surface-100",
      "relation":"uses-token", "props":{"slot":"surface","instances":14}, "confidence":"EXTRACTED" },
    { "source":"value:color:244,244,245,255", "target":"value:color:234,234,235,255",
      "relation":"similar-to", "props":{"deltaE":2.1}, "weight":0.81 },
    { "source":"component:Card@figma", "target":"component:Card@code",
      "relation":"maps-to", "props":{"method":"value+name"}, "confidence":"INFERRED" }
  ]
}
```

### Node types
| Type | id scheme | key props |
|---|---|---|
| `Token` | `token:<cat>:<name>` | category (color/spacing/font/radius/shadow/z), tier (primitive/semantic/alias) |
| `RawValue` | `value:<type>:<canonkey>` | valueType, canonical components, lab (colors) |
| `Component` | `component:<name>@<code\|figma>` | framework, props_schema (variant axes) |
| `Instance` | `instance:<file>:<loc>` | host component, bindings |
| `Screen` | `screen:<route\|frameId>` | — |
| `Icon`/`Asset` | `asset:…` | — |

### Edge classes
| Class | relations | confidence/weight |
|---|---|---|
| **Structural** | `has-value`, `aliases`, `uses-token`(slot), `composed-of`, `instance-of`, `renders-on` | EXTRACTED |
| **Bridge** | `maps-to` | INFERRED/AMBIGUOUS |
| **Similarity** | `similar-to` | weighted by ΔE |
| **Convention** | `commonly-used-with` | weighted by frequency |

**Slots** are a property on `uses-token` edges (not separate nodes). A component's
**variant envelope** = its `uses-token` edges grouped by `slot`.

---

## 3. Value canonicalization

Each value → a **canonical key** (identity / `RawValue` id) + a **metric form** (distance).

### Colors
1. Parse `#rgb|#rgba|#rrggbb|#rrggbbaa`, `rgb()/rgba()` (comma/space, %/0–255),
   `hsl()/hsla()`, **`oklch()/oklab()`** (Tailwind v4's default color space — the first
   real target is entirely oklch), CSS named colors, Figma `{r,g,b,a}` floats 0–1. Use
   `culori`, which parses all of these natively.
2. Normalize → 8-bit sRGB + alpha `{r,g,b∈0..255, a∈0..255}`. Alpha rule:
   `a = round(alphaFloat*255)`, applied identically both sides.
3. Canonical key: `color:r,g,b,a`. **oklch caveat:** oklch can express colors outside the
   sRGB gamut, so the sRGB key clips a few; tune toward a rounded-oklch key
   (`oklch:L,C,H,a`) if real palettes lose distinctions on clip (decision #5).
4. Metric form: → **OKLab / CIE Lab**; distance = **ΔE2000** (or ΔEOK for oklch-native).
   (RGB Euclidean rejected — perceptually wrong.)

### Dimensions (spacing/radius/font-size)
1. Parse `px,rem,em,pt,%`, unitless (Figma numbers).
2. Resolve `rem/em` → px with configurable root (default 16); flag `baseAssumed`.
3. Canonical key is **category-scoped**: `dim:16px@spacing` ≠ `dim:16px@fontSize`
   (guard against cross-category value collisions).
4. Metric: numeric px; distance `|a−b|` (or relative).

### Typography / shadow / other
Composite canonical forms (font = `{family↓,weight,size,lineHeight}`; shadow = normalized
tuple). Compared component-wise.

---

## 4. Extractors / adapters

Registry: each implements `detect(root):bool` + `extract(root):{nodes,edges}`.
Auto-detect runs every `detect()` and activates firing adapters.

### 4a. Token adapters

**Tailwind v4 / CSS-first** (MVP — the first real target uses this):
- `detect`: `tailwindcss` v4 dep **and** a CSS entry with `@import 'tailwindcss'` / a
  `@theme` block / `:root { --… }` (no `tailwind.config.js`). Config path is empty in
  shadcn `components.json`; the token CSS path is `components.json → tailwind.css`.
- `extract`: parse the token CSS (tree-sitter-css / postcss) — three blocks:
  - `:root { --primary: oklch(…) }` → primitive `Token` + canonicalize → `RawValue` +
    `has-value{mode:light}`.
  - `.dark { --primary: oklch(…) }` → second `has-value{mode:dark}` on the same token
    (per-mode values, mirrors Figma modes in §4c).
  - `@theme inline { --color-primary: var(--primary); --radius-md: calc(…); --text-sm: 13.75px }`
    → semantic `Token` + `aliases` edge (var-ref) and the **utility name map**: a
    `--color-*`/`--radius-*`/`--text-*` theme key defines Tailwind utilities
    (`bg-primary`, `text-primary`, `rounded-md`, `text-sm`). Build the **class→token
    resolver** from these (incl. alpha modifiers `bg-primary/90`, variants `hover:`/`dark:`,
    arbitrary `ring-[3px]`) for the component adapter.

**Tailwind classic / `resolveConfig`** (generality — built but not exercised by the first
target):
- `detect`: `tailwind.config.{js,ts,cjs,mjs}` exists.
- `extract`: `resolveConfig(require(cfg)).theme` → walk `colors/spacing/fontSize/
  borderRadius/boxShadow/…`; each leaf → `Token` (category from section, name from dotted
  path `surface.100`→`surface-100`); each value → canonicalize → `RawValue` + `has-value`;
  value→value references → `aliases`; build the same **class→token resolver map**.

**CSS variables** (generic, non-Tailwind): `--x:` present → parse `.css/.scss`
(tree-sitter-css); `--name:value` → Token+RawValue; `var(--name)` → usage resolution. The
v4 adapter above is a specialization of this.

**Design-tokens JSON** (W3C / Style Dictionary): file with `$value`/`$type` → walk;
`$value`→RawValue; `{alias}`→`aliases`.

**CSS-in-JS theme**: styled-components/emotion/vanilla-extract dep → evaluate/parse the
exported `theme` object → Tokens.

### 4b. Component adapter (ts-morph / TS compiler API, two-pass) — the heavy one

> Parser note: uses `ts-morph` over the TS compiler AST (not tree-sitter) — the target is
> all TSX, and the typed AST reads `cva`, JSX, and imports directly. Same two-pass design.

**Pass 1 — definitions (all files, enables cross-file resolution):**
1. Find component defs: PascalCase fn/const returning JSX; `forwardRef`/`memo`;
   `styled.x`. → `Component@code`.
2. Variant axes — two sources (the first target uses **cva**):
   - **`class-variance-authority`**: `cva(base, { variants: { variant: {...}, size: {...} },
     defaultVariants })` → axis names = `variants` keys, values = their object keys,
     defaults from `defaultVariants`. The per-value class strings also feed `uses-token`
     (each variant value binds a known set of utilities). This is the primary path for
     shadcn/ui components.
   - **TS props `interface`/`type`**: string-literal unions (`size:'sm'|'md'|'lg'`) →
     discrete axes; booleans → binary axes. Often *derived* via
     `VariantProps<typeof xVariants>` — resolve back to the cva object when present.
   → `props_schema`.
3. Intrinsic token usage in body:
   - `className` literals → split utilities → resolve via class→token map → `uses-token`
     (+`slot` inferred from utility kind: `bg-*`→surface, `p-*/gap-*`→spacing,
     `text-*`→typography/color).
   - `style={{…}}` / css template literals → tree-sitter-css → prop:value → canonicalize
     → match Token **by value**; no match → **inline/off-system** binding (finding seed).
   - imported token symbols (`Colors.background100`) → resolve import → Token.
4. Child components: JSX tags resolving to known/imported components → `composed-of`.

**Pass 2 — usages (instances):** re-walk JSX; for tags ∈ component set:
`Instance` + `instance-of`; capture **prop bindings** (`padding="lg"`); instance-level
`className` overrides → per-instance `uses-token`; sibling/screen context for §6c.

(Mirrors graphify's call-graph second pass: know all symbols, then resolve references.)

### 4c. Figma adapter (Dev Mode MCP, agent-driven via the skill)

Skill calls MCP, writes `dsgraph-out/figma.json` in the universal schema; CLI ingests it.
1. `get_metadata` → tree: COMPONENT/COMPONENT_SET → `Component@figma`; INSTANCE →
   `Instance`; top FRAME → `Screen`; component-set variant props → `props_schema`.
2. `get_variable_defs` → variables (per-mode values + types) → `Token@figma` + `RawValue`
   (per mode `has-value` with `mode` prop); variable aliases → `aliases`.
3. `get_design_context` (per component) → bound variables → `uses-token` (+slot); nested
   instances → `composed-of`.
4. `get_screenshot` (optional) → thumbnail ref on `Component@figma` for viz.

---

## 5. Build + dedup

Concatenate all fragments. **Dedup nodes by id**, merge `sources[]` + props (a token from
both `Colors.ts` and the Tailwind theme → one node, two sources — graphify's ghost-dup
merge). Load into `graphology` for traversal/clustering.

---

## 6. Derived layers

### 6a. RawValue bridge
Built during canonicalization: every token (both sides) → `has-value` → type-scoped
`RawValue`. A RawValue with both-side attachments = a structural bridge (§7).

### 6b. `similar-to` (ΔE KNN)
Per type-scoped RawValue set:
```
for each value v:
    distances to every same-type value      # O(n²), n~hundreds → fine
    keep neighbors with ΔE < ε (default 10) OR k-nearest (k=5)
    add similar-to edge, weight = clamp(1 - ΔE/ε, 0..1)
```
Sparse; drives layout + palette-bloat clustering.

### 6c. Convention layer + variant envelope
```
for each Component:
    instances = Instance nodes with instance-of → component
    for each slot s:
        dist[s]     = frequency map over tokens bound to s across instances
        envelope[s] = { token: count/total }          # variant axis — recorded as-is
        default[s]  = argmax(dist[s])
        off_system[s] = instances binding s to a non-token (inline) value   # finding
    emit commonly-used-with:
        component → token  weight = envelope fraction (per slot)
        component → sibling component  weight = co-occurrence fraction
```
**Key semantic:** in-system *spread* in `envelope[s]` is the **variant range**, not an
error — recorded, never flagged. Only `off_system[s]` is a finding.

---

## 7. Reconciliation / matching (value-first, type-scoped, name-tiebreak)

**Tokens:**
```
for each RawValue rv (type-scoped):
    F = figma tokens(rv) ; C = code tokens(rv)
    if F and C:
        if |F|==1 and |C|==1: maps-to(EXTRACTED, method=value)
        else: pairs = bipartite_match(F, C, key=name_similarity)
              maps-to(INFERRED, method=value+name) per pair
              # leftover unmatched in cluster = "synonyms" finding
    elif F xor C: finding: orphan-value (design-only or code-only)
# near-miss (tolerance continuum):
for each figma RawValue with no exact code match:
    nearest = min ΔE code RawValue
    if ΔE(nearest) < τ (default 3): maps-to(AMBIGUOUS) + finding: near-miss-drift
```
`name_similarity` = normalize (lowercase, strip `-_/`, drop mode suffixes, collapse scale
numbers) → Levenshtein/Jaro. `bipartite_match` = greedy or Hungarian.

**Components** (no single value → structural):
```
score(fComp, cComp) = w1*name_similarity
                    + w2*Jaccard(token_sets)
                    + w3*Jaccard(child_sets)
                    + w4*variant_axis_overlap
bipartite_match → maps-to(INFERRED/AMBIGUOUS by score)
```

---

## 8. Clustering

- Structural+convention graph → Louvain/Leiden (`resolution` tunable) → feature areas /
  component families.
- Similarity graph (RawValue + `similar-to`) → separate clustering → color families;
  tight dense clusters = palette bloat (§9).
- Community ids stable (sorted by size, fixed seed).

---

## 9. Analysis / findings

| Finding | Algorithm |
|---|---|
| **God nodes** | top-k by weighted degree (most-used tokens/components) = blast radius |
| **Orphan values** | RawValue with one-sided `has-value` |
| **Unused tokens** | Token with zero `uses-token` in-edges |
| **Drift** | `maps-to` (name-matched) with differing value; OR instance with off-system binding |
| **Near-miss drift** | §7 near-miss pass (ΔE<τ, not equal) |
| **Palette bloat** | similarity-cluster of ≥N distinct RawValues within small ΔE, each on distinct tokens |
| **Component bloat** | component pair with `Jaccard(token∪child)>θ` differing only by bindings → merge to variant |
| **Inconsistent slot** | slot whose envelope has high entropy **and** contains off-system values (in-system spread alone NOT flagged) |

---

## 10. Query engine

Read-side verbs operate on the in-memory `graphology` graph from `graph.json`.

### 10.0 Seed resolution (NL → nodes)
```
resolveSeeds(text):
    mentions = candidate entities (noun phrases, quoted, CamelCase, kebab)
    score(node) = max(exact 1.0, normalized 0.9, substring 0.6,
                      embeddingCosine(text, label))     # local embedding model
    return top-k above threshold
```
Inside an agent the agent can pass exact ids; `match <value>` resolves a literal value
straight to RawValue→tokens.

### 10.1 `query "<q>"` — best-first weighted traversal (Dijkstra-style, budgeted)
```
query(seeds, budget=2000, mode=bfs|dfs):
    frontier = max-heap by edgeRelevance         # dfs: LIFO with relevance
    visited = set(seeds); sub = subgraph(seeds)
    push edges incident to seeds
    while frontier and tokens(sub) < budget:
        edge = frontier.pop()                    # highest-relevance first
        n = edge.otherEnd not in visited
        if n: add n+edge to sub; visited.add(n); push n's incident edges
    rank sub nodes by (1/hop) * Σ incidentWeights * log(degree)
    return serialize(sub)  # nodes+edges+confidence, trimmed to budget
```
`edgeRelevance` blends edge-class priority (exact `maps-to` > strong `commonly-used-with` >
weak `similar-to`), numeric weight, inverse hop distance.

### 10.2 `path A B` — shortest / k-shortest
`dijkstra(undirectedView, a, b, weight=1/edgeWeight)` (strong edges = short); optional
Yen's k-shortest. Returns `[(node, relation, node, confidence)…]`.

### 10.3 `explain X` — neighborhood digest
1–2 hop neighborhood, edges **grouped by relation** (uses-token by slot, composed-of,
commonly-used-with, has-value), readable, with confidence + the component's variant
envelope.

### 10.4 `impact X` — reverse reachability
```
reverse-BFS over dependency in-edges (uses-token, composed-of, instance-of, renders-on)
transitively → affected components → screens
rank by (hop asc, usageFrequency desc)
```
"What breaks if I change `surface-100`."

### 10.5 `context "<desc>"` — generation retrieval
```
seeds = resolveSeeds(desc) ∩ Components
for each near component: collect variant envelope + commonly-used-with tokens + siblings
assemble "build kit" subgraph (reuse candidates + conventional tokens + typical siblings)
run expressibility check (§11)
return kit + reuse-vs-introduce decision
```

### 10.6 `match <value>` — value lookup
Canonicalize input → RawValue lookup → exact tokens + `similar-to` neighbors within ΔE.
("What other variables share / are near this color.")

---

## 11. Expressibility — reuse vs. introduce

Encodes the rule *prefer variant props over new components*.
```
1. nearest = resolveSeeds(concept) ∩ Components
   if covers concept → base=nearest, REUSE ; else INTRODUCE-COMPONENT (list composables)
2. for each desired slot value dv:
     rv = canonicalize(dv)
     if rv ∈ palette:
         if rv ∈ base.envelope[slot]: REUSE (existing variant)
         else:                        REUSE-NEW-PROP-COMBO   # in-system → prefer prop
     elif ∃ token with ΔE(rv)<τ:      SNAP-SUGGEST(nearest token)
     else:                            INTRODUCE-TOKEN (deliberate extension)
3. emit decision report
```

---

## 12. Incremental update

Manifest `dsgraph-out/manifest.json`: `file → {hash, nodeIds[], edgeIds[]}`, relative
paths (portable/committable).
```
update():
    cur = hash files; diff vs manifest → {added, changed, deleted}
    # Phase 1 — structural, per-file (cheap, no LLM/MCP):
    for f in changed ∪ deleted: remove all nodes/edges with source==f   # clean deletions
    for f in added ∪ changed:   re-run adapters on f → merge
    prune RawValues that lost all has-value
    # Phase 2 — derived, region-scoped:
    recompute similar-to KNN for changed RawValues + old neighbors
    recompute envelopes + commonly-used-with for components whose instances changed
    re-run reconciliation for affected RawValue clusters
    re-cluster; update manifest
```
Clean deletions because nodes are **source-keyed**. Figma = one versioned fragment,
re-pulled on demand.

---

## 13. Watch / hook / team
- `dsgraph watch` — debounced watcher → `update()` on save (code side, instant).
- `dsgraph hook install` — git post-commit → `update`; **graph.json union-merge driver**
  so parallel commits never conflict.
- `dsgraph-out/` committed → teammates start with the map.

## 14. Agent skill (`/dsgraph`)
`SKILL.md` that: ensures install; for Figma calls MCP tools → `figma.json`; invokes CLI to
build/reconcile/emit; for questions when `graph.json` exists, skips rebuild and runs
`dsgraph query` (graphify fast-path). Always-on `CLAUDE.md` nudge: run
`dsgraph context "<thing>"` before building UI.

## 15. CLI + outputs
```
dsgraph <path> [--figma <key>] [--update] [--watch] [--no-viz] [--resolution N]
dsgraph query "<q>" [--dfs] [--budget N]
dsgraph path "A" "B"   dsgraph explain "X"   dsgraph impact "X"
dsgraph context "<desc>"   dsgraph match "#450000"
dsgraph hook install   dsgraph install
```
`dsgraph-out/`: `graph.json`, `graph.html` (sigma; toggle structural/similarity/convention
layers), `REPORT.md` (god nodes, drift, bloat, orphans, suggested questions),
`manifest.json`, `figma.json`, `cache/`.

## 16. MVP milestones
| Phase | Deliverable | Validates |
|---|---|---|
| 0 | scaffold: schema types, graph.json IO, CLI skeleton, graphology | plumbing |
| 1 | Tailwind adapter + canonicalizer + RawValue + similar-to + query/explain/match | value graph on any Tailwind project |
| 2 | component adapter (2-pass): uses-token, composed-of, instances, envelopes, commonly-used-with | structural + convention |
| 3 | Figma adapter via skill + reconciliation + drift/orphan report | design↔code bridge |
| 4 | context + expressibility; palette-bloat + component-bloat | generation + consolidation |
| 5 | incremental update, watch, git hook, viz polish, team merge | dynamic / production |

## 17. Open / to tune on real data
- ΔE thresholds: ε=10 (similarity), τ=3 (near-miss). Tune.
- Embedding model choice (local `transformers.js`/`fastembed` vs API).
- Reconciliation weights `w1..w4` for component matching.
- Whether `composed-of` needs render-vs-import disambiguation per framework.
