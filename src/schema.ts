/**
 * dsgraph data model (DESIGN.md §2).
 *
 * A property graph serialized to `graph.json`. These types are the single source
 * of truth for node/edge shapes; adapters produce {nodes, edges} fragments that
 * conform to them, the build step dedups by id, and the read side traverses them.
 */

/** Schema version of the emitted `graph.json`. Bump on breaking shape changes. */
export const GRAPH_VERSION = 1 as const;

/** Confidence tag carried by nodes and structural/bridge edges (DESIGN.md §0, §2). */
export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/** Which side of the system a fragment came from. */
export type Side = "code" | "figma";

// ── Node types ──────────────────────────────────────────────────────────────

export type NodeType =
  | "Token"
  | "RawValue"
  | "Component"
  | "Instance"
  | "Screen"
  | "Asset";

/** Token category — drives canonicalizer dispatch and slot inference. */
export type TokenCategory =
  | "color"
  | "spacing"
  | "fontSize"
  | "fontFamily"
  | "fontWeight"
  | "lineHeight"
  | "radius"
  | "shadow"
  | "z"
  | "other";

/** Token tier within the system (DESIGN.md §2 node table). */
export type TokenTier = "primitive" | "semantic" | "alias";

/** The valueType axis for a RawValue; canonicalization is scoped by this. */
export type ValueType =
  | "color"
  | "dimension"
  | "fontFamily"
  | "fontWeight"
  | "typography"
  | "shadow"
  | "other";

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

export type GraphNode =
  | TokenNode
  | RawValueNode
  | ComponentNode
  | InstanceNode
  | ScreenNode
  | AssetNode;

// ── Edge types ──────────────────────────────────────────────────────────────

/** Edge relations grouped into the three classes from DESIGN.md §2. */
export type EdgeRelation =
  // structural (EXTRACTED)
  | "has-value"
  | "aliases"
  | "uses-token"
  | "composed-of"
  | "instance-of"
  | "renders-on"
  // bridge (INFERRED/AMBIGUOUS)
  | "maps-to"
  // similarity (ΔE-weighted)
  | "similar-to"
  // convention (frequency-weighted)
  | "commonly-used-with";

export type EdgeClass = "structural" | "bridge" | "similarity" | "convention";

export const EDGE_CLASS: Record<EdgeRelation, EdgeClass> = {
  "has-value": "structural",
  aliases: "structural",
  "uses-token": "structural",
  "composed-of": "structural",
  "instance-of": "structural",
  "renders-on": "structural",
  "maps-to": "bridge",
  "similar-to": "similarity",
  "commonly-used-with": "convention",
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
