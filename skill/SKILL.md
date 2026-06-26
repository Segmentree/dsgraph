---
name: dsgraph
description: Build, update, and query the design-system knowledge graph (tokens + components + Figma) for the current app. Use when asked to capture a Figma design system, detect design↔code drift, check what UI primitives already exist before building new UI, or answer "what does X use / what uses X".
---

# /dsgraph — design-system knowledge graph

dsgraph turns an app's **design tokens + components + Figma file** into one queryable
graph: drift detection, discoverability, impact analysis, and generation/retrieval. The
CLI does extraction, reconciliation, and querying. **This skill's job is the one thing the
CLI can't do headlessly: drive the Figma Dev Mode MCP to produce `dsgraph-out/figma.json`**,
then hand off to the CLI.

## Decide what's being asked

1. **"Capture / refresh the Figma design system"** → run the **Figma capture** below, then build.
2. **"Build / update the graph"** (code only, no Figma) → just run `dsgraph <app-root>`.
3. **A question** ("what tokens does Button use?", "is there a Card already?", "what breaks if I change `--primary`?") → if `dsgraph-out/graph.json` exists, **don't rebuild** — use the read verbs (`query` / `explain` / `match` / `impact` / `context`).

## Figma capture (produces `figma.json`)

The Figma MCP is the **local Dev Mode server** in the Figma desktop app
(`http://127.0.0.1:3845/sse`). Before starting, confirm it's reachable.

> ⚠️ **If `get_design_context` hangs (>30s):** its codegen worker is wedged. **Fully quit
> (⌘Q) and reopen the Figma desktop app**, then retry. `get_metadata`/`get_variable_defs`/
> `get_screenshot` returning fine while only `get_design_context` hangs is the tell — it's
> the only tool that runs codegen. Do not keep retrying without restarting.

Ask the user for the **page URL** (with `?node-id=…`) of the components/screens to capture.
From that one page id you fan out yourself — the user does **not** select nodes one at a time.

1. **`get_metadata(nodeId = page)`** → the whole tree. Read off:
   - `COMPONENT` / `COMPONENT_SET` → `components[]` (the set's variant props → `propsSchema`)
   - `INSTANCE` → `instances[]` (`of` = component name; `host` = parent frame/screen)
   - top `FRAME` / `SECTION` → `screens[]` (`renders` = components placed directly on it)
2. **`get_variable_defs(nodeId = page)`** → all variables at once → `tokens[]`. Map the
   variable's name prefix to a `category` (see table). Values: hex (`#2563eb`), bare px
   numbers (`8`), weight numbers (`500`), or composite DSL (`Font(…)`, `Effect(…)`).
3. **`get_design_context(nodeId = componentId)`** per component → the bound variables show
   up as Tailwind `var()` refs in the generated code (e.g. `bg-[var(--base/primary,…)]`,
   `rounded-[var(--border-radius/rounded-full,…)]`). Each → a `uses[]` binding; infer the
   `slot` from the utility prefix (see table). Nested instances → `children[]`.
   *(Optional: `get_screenshot(componentId)` for a thumbnail.)*

Write the result to **`<app-root>/dsgraph-out/figma.json`** in the capture schema
(`src/adapters/figma/figma-capture.ts` is the contract). **Do not** compute RawValues, ids,
or ΔE — the CLI canonicalizes; you just report what Figma says.

### name-prefix → `category`
| Figma variable prefix | category |
|---|---|
| `base/…`, `tailwind colors/…` (hex) | `color` |
| `spacing/…`, `width/…`, `height/…`, `size/…` | `spacing` |
| `border-radius/…`, `radius/…` | `radius` |
| `border-width/…` | `borderWidth` |
| `font-weight/…` | `fontWeight` |
| `text-…` (`Font(…)`) | `fontSize` |
| `shadow/…` (`Effect(…)`) | `shadow` |

### Tailwind utility → `slot`
`bg-`→`surface` · `text-`→`text` · `border-`→`border` · `ring-`→`ring` ·
`rounded-`→`radius` · `p-`/`px-`/`py-`/`gap-`/`m-`→`spacing` · `shadow-`→`elevation`

### `figma.json` shape (minimal)
```jsonc
{
  "source": "figma",
  "fileKey": "<from the URL>",
  "tokens": [
    { "name": "base/primary", "category": "color", "modes": { "default": "#2563eb" } },
    { "name": "base/background", "category": "color", "modes": { "light": "#fff", "dark": "#0a0a0a" } }
  ],
  "components": [
    { "name": "Button", "nodeId": "37:931",
      "propsSchema": { "variant": ["ghost","outline"], "size": ["sm","icon"] },
      "uses": [{ "token": "base/primary", "slot": "surface" }],
      "children": ["Icon"] }
  ],
  "instances": [{ "of": "Button", "nodeId": "34243:31750", "host": "Contact details", "bindings": { "variant": "ghost" } }],
  "screens": [{ "name": "Contact details", "nodeId": "34131:89115", "renders": ["Button"] }]
}
```
Every list is optional — a tokens-only or components-only capture is valid.

## Build + reconcile + emit

```bash
dsgraph <app-root>          # detects code tokens + components, ingests figma.json,
                            # canonicalizes, reconciles (maps-to + findings), emits:
                            #   dsgraph-out/graph.json   graph.html   REPORT.md
```

Then **read `dsgraph-out/REPORT.md`** and summarize the drift / near-miss / orphan /
synonym findings for the user. The value bridge is exact-by-canonical-value; oklch↔hex
gaps surface as **near-miss** (tune τ on real data, don't assume the default fits).

## Answer questions without rebuilding

When `graph.json` already exists:
```bash
dsgraph match "#2563eb"        # value → RawValue → tokens + neighbors
dsgraph explain "Button"       # neighborhood digest grouped by relation
dsgraph query "card surface"   # best-first weighted traversal from NL seeds
dsgraph impact "token:color:primary"   # what breaks if it changes
```

Before building new UI, prefer `dsgraph context "<thing>"` to reuse what exists rather than
introducing a new token/component.
