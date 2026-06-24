/** Conventional output locations (DESIGN.md §15). All under `dsgraph-out/`. */
import { join } from "node:path";

export const DSGRAPH_OUT = "dsgraph-out";

export const graphPath = (root = ".") => join(root, DSGRAPH_OUT, "graph.json");
export const reportPath = (root = ".") => join(root, DSGRAPH_OUT, "REPORT.md");
export const manifestPath = (root = ".") => join(root, DSGRAPH_OUT, "manifest.json");
export const figmaPath = (root = ".") => join(root, DSGRAPH_OUT, "figma.json");
export const vizPath = (root = ".") => join(root, DSGRAPH_OUT, "graph.html");
