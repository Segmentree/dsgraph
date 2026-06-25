/**
 * dsgraph data model (DESIGN.md §2).
 *
 * A property graph serialized to `graph.json`. These types are the single source
 * of truth for node/edge shapes; adapters produce {nodes, edges} fragments that
 * conform to them, the build step dedups by id, and the read side traverses them.
 */

/** Schema version of the emitted `graph.json`. Bump on breaking shape changes. */
export const GRAPH_VERSION = 1 as const;

/**
 * Enum-like vocabularies. Each is a `const` object (named values for `case`
 * labels / node construction) paired with a same-named union type derived from
 * it, so the values and the type can never drift apart.
 */

/** Confidence tag carried by nodes and structural/bridge edges (DESIGN.md §0, §2). */
export const Confidence = {
  EXTRACTED: "EXTRACTED",
  INFERRED: "INFERRED",
  AMBIGUOUS: "AMBIGUOUS",
} as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

/** Which side of the system a fragment came from. */
export const Side = { code: "code", figma: "figma" } as const;
export type Side = (typeof Side)[keyof typeof Side];

// ── Node types ──────────────────────────────────────────────────────────────

export const NodeType = {
  Token: "Token",
  RawValue: "RawValue",
  Component: "Component",
  Instance: "Instance",
  Screen: "Screen",
  Asset: "Asset",
  /** The app's routing root (Next/Vue/…) — renders the route-entry components (§4b). */
  Router: "Router",
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

/** Token category — drives canonicalizer dispatch and slot inference. */
export const TokenCategory = {
  color: "color",
  spacing: "spacing",
  fontSize: "fontSize",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  radius: "radius",
  borderWidth: "borderWidth",
  blur: "blur",
  opacity: "opacity",
  aspectRatio: "aspectRatio",
  duration: "duration",
  easing: "easing",
  shadow: "shadow",
  gradient: "gradient",
  z: "z",
  other: "other",
} as const;
export type TokenCategory = (typeof TokenCategory)[keyof typeof TokenCategory];

/** Token tier within the system (DESIGN.md §2 node table). */
export const TokenTier = {
  primitive: "primitive",
  semantic: "semantic",
  alias: "alias",
} as const;
export type TokenTier = (typeof TokenTier)[keyof typeof TokenTier];

/**
 * The valueType axis for a RawValue; canonicalization + similarity are keyed by it.
 * Grouped by canonical form: scalar (dimension/ratio/duration/ordinal), color,
 * nominal (fontFamily), and composite (shadow/gradient/typography).
 */
export const ValueType = {
  color: "color",
  /** Length in px — spacing/radius/fontSize/borderWidth/blur/letterSpacing (scope-keyed). */
  dimension: "dimension",
  /** Unitless number — lineHeight/opacity/aspectRatio (scope-keyed). */
  ratio: "ratio",
  /** Time in ms — duration/delay. */
  duration: "duration",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  /** Composite: layered box-shadow, references color sub-values. */
  shadow: "shadow",
  /** Composite: ordered color stops. */
  gradient: "gradient",
  /** Composite: family + size + weight + lineHeight + letterSpacing. */
  typography: "typography",
  other: "other",
} as const;
export type ValueType = (typeof ValueType)[keyof typeof ValueType];

/** Binding slot on a `uses-token` edge — the role a token plays in a component (§4b). */
export const Slot = {
  surface: "surface",
  text: "text",
  border: "border",
  ring: "ring",
  outline: "outline",
  fill: "fill",
  stroke: "stroke",
  gradient: "gradient",
  elevation: "elevation",
  radius: "radius",
  blur: "blur",
  tracking: "tracking",
  leading: "leading",
  spacing: "spacing",
} as const;
export type Slot = (typeof Slot)[keyof typeof Slot];

/** Provenance of a node — where an adapter found it. Merged across sources on dedup. */
export interface SourceRef {
  adapter: string;
  /** Repo-relative path (portable/committable, DESIGN.md §12). */
  file?: string;
  /** Human-readable locator: dotted theme path, `L12`, Figma node id, etc. */
  loc?: string;
}

export interface BaseNode<T extends NodeType = NodeType> {
  id: string;
  type: T;
  label?: string;
  props?: Record<string, unknown>;
  sources?: SourceRef[];
  confidence?: Confidence;
}

export interface TokenNode extends BaseNode<"Token"> {
  props?: {
    category?: TokenCategory;
    tier?: TokenTier;
    side?: Side;
    [k: string]: unknown;
  };
}

export interface RawValueNode extends BaseNode<"RawValue"> {
  props?: {
    valueType?: ValueType;
    /** Canonical components, type-specific (e.g. rgba tuple for colors). */
    rgba?: [number, number, number, number];
    /** CIE Lab metric form for colors (ΔE2000 distance). */
    lab?: [number, number, number];
    /** Numeric px for dimensions. */
    px?: number;
    [k: string]: unknown;
  };
}

export interface ComponentNode extends BaseNode<"Component"> {
  props?: {
    framework?: string;
    side?: Side;
    /** Variant axes extracted from props (string-literal unions, booleans). */
    props_schema?: Record<string, string[] | boolean>;
    [k: string]: unknown;
  };
}

export interface InstanceNode extends BaseNode<"Instance"> {
  props?: {
    host?: string;
    bindings?: Record<string, string>;
    [k: string]: unknown;
  };
}

export type ScreenNode = BaseNode<"Screen">;
export type AssetNode = BaseNode<"Asset">;
export type RouterNode = BaseNode<"Router">;

export type GraphNode =
  | TokenNode
  | RawValueNode
  | ComponentNode
  | InstanceNode
  | ScreenNode
  | AssetNode
  | RouterNode;

// ── Edge types ──────────────────────────────────────────────────────────────

/** Edge relations grouped into the three classes from DESIGN.md §2. */
export const EdgeRelation = {
  // structural (EXTRACTED)
  hasValue: "has-value",
  aliases: "aliases",
  usesToken: "uses-token",
  composedOf: "composed-of",
  instanceOf: "instance-of",
  rendersOn: "renders-on",
  // bridge (INFERRED/AMBIGUOUS)
  mapsTo: "maps-to",
  // similarity (ΔE-weighted)
  similarTo: "similar-to",
  // convention (frequency-weighted)
  commonlyUsedWith: "commonly-used-with",
} as const;
export type EdgeRelation = (typeof EdgeRelation)[keyof typeof EdgeRelation];

export const EdgeClass = {
  structural: "structural",
  bridge: "bridge",
  similarity: "similarity",
  convention: "convention",
} as const;
export type EdgeClass = (typeof EdgeClass)[keyof typeof EdgeClass];

export const EDGE_CLASS: Record<EdgeRelation, EdgeClass> = {
  [EdgeRelation.hasValue]: EdgeClass.structural,
  [EdgeRelation.aliases]: EdgeClass.structural,
  [EdgeRelation.usesToken]: EdgeClass.structural,
  [EdgeRelation.composedOf]: EdgeClass.structural,
  [EdgeRelation.instanceOf]: EdgeClass.structural,
  [EdgeRelation.rendersOn]: EdgeClass.structural,
  [EdgeRelation.mapsTo]: EdgeClass.bridge,
  [EdgeRelation.similarTo]: EdgeClass.similarity,
  [EdgeRelation.commonlyUsedWith]: EdgeClass.convention,
};

export interface GraphEdge {
  source: string;
  target: string;
  relation: EdgeRelation;
  props?: Record<string, unknown>;
  /** Numeric weight for similarity/convention edges (0..1). */
  weight?: number;
  confidence?: Confidence;
}

// ── Top-level document ────────────────────────────────────────────────────────

export interface GraphDocument {
  version: typeof GRAPH_VERSION;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A partial graph emitted by a single adapter, merged in the build step (§5). */
export interface GraphFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function emptyFragment(): GraphFragment {
  return { nodes: [], edges: [] };
}
