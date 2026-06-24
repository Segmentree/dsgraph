/** Public entry point — re-exports the schema and graph plumbing. */
export * from "./schema.js";
export * from "./graph.js";
export * from "./canonicalize/index.js";
export * from "./adapters/registry.js";
export { tailwindV4Adapter } from "./adapters/tailwind-v4.js";
export { tailwindConfigAdapter, walkTheme } from "./adapters/tailwind-config.js";
export { deriveSimilarTo, DEFAULT_EPSILON } from "./derive/similar-to.js";
export { deriveComposition } from "./derive/composition.js";
export { VALUE_TYPES, type ValueDescriptor, type ValueMetric } from "./values/registry.js";
export { build, DEFAULT_ADAPTERS, type BuildResult, type BuildOptions } from "./build.js";
export { resolveSeeds, type Seed } from "./query/seeds.js";
export { match, type MatchResult } from "./query/match.js";
export { explain, type ExplainResult } from "./query/explain.js";
export { query, type QueryResult } from "./query/query.js";
export { DSGRAPH_OUT, graphPath } from "./paths.js";
