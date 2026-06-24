# dsgraph

A **design-system knowledge graph**: extract an app's design tokens, components, and
Figma file into one queryable property graph that powers drift detection, discoverability,
impact analysis, and — the headline use — **generation** ("what do we already have, and can
a new thing be built from it or must we extend the system?").

Modeled on the generic graph-RAG plumbing of [graphify](https://github.com/safishamsi/graphify)
(MIT), but the design-system core — value-first matching, ΔE perceptual color similarity,
variant envelopes, expressibility — is its own.

## Status

Early. **Phase 0 (scaffold)** is in: the graph schema, `graph.json` IO with fragment
dedup/merge, graphology loading, and a CLI skeleton. See [`DESIGN.md`](DESIGN.md) for the
full technical spec and [`CLAUDE.md`](CLAUDE.md) for project intent and the MVP roadmap.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run dev -- --help     # run the CLI from source via tsx
```

## CLI (surface)

```
dsgraph <path> [--figma <key>] [--update] [--watch] [--no-viz] [--resolution N]
dsgraph query "<q>"   dsgraph path "A" "B"   dsgraph explain "X"
dsgraph impact "X"    dsgraph context "<desc>"   dsgraph match "#450000"
dsgraph info          # load graph.json and print node/edge stats (live)
```

Most verbs are stubbed pending their MVP phase; `info` is live.

## License

[MIT](LICENSE).
