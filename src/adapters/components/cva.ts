/**
 * `class-variance-authority` extraction (DESIGN.md §4b).
 *
 * shadcn components put their classes inside `cva(base, { variants })`, not directly on
 * `className` — so the variant axes (the `props_schema`) AND the actual token-bearing
 * classes live here. This module parses a file's `cva(...)` definitions into:
 *   - `classes`: base + every variant value's class string (→ the component's uses-token)
 *   - `propsSchema`: each variant axis → its value names (→ Component.props.props_schema)
 *
 * The component that references the cva variable (`buttonVariants` ← `Button`) inherits
 * both; mapping happens in the component adapter.
 */

import { Node, type SourceFile, type CallExpression } from "ts-morph";

const CVA = "cva";
const VARIANTS_KEY = "variants";

export interface CvaInfo {
  /** Base classes + every variant value's classes. */
  classes: string[];
  /** Variant axis → its value names (e.g. `variant: ['default','destructive']`). */
  propsSchema: Record<string, string[]>;
}

/** All `cva(...)` definitions in a file, keyed by the variable they're assigned to. */
export function cvaDefs(sf: SourceFile): Map<string, CvaInfo> {
  const out = new Map<string, CvaInfo>();
  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (init && Node.isCallExpression(init) && init.getExpression().getText() === CVA) {
        const info = parseCva(init);
        if (info) out.set(decl.getName(), info);
      }
    }
  }
  return out;
}

function literalValue(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  return null;
}

function propName(prop: Node): string | null {
  if (!Node.isPropertyAssignment(prop)) return null;
  const name = prop.getNameNode();
  if (Node.isIdentifier(name)) return name.getText();
  if (Node.isStringLiteral(name)) return name.getLiteralValue();
  return null;
}

function parseCva(call: CallExpression): CvaInfo | null {
  const [base, config] = call.getArguments();
  const classes: string[] = [];
  const propsSchema: Record<string, string[]> = {};

  const baseClasses = literalValue(base);
  if (baseClasses) classes.push(baseClasses);

  if (config && Node.isObjectLiteralExpression(config)) {
    const variantsProp = config.getProperty(VARIANTS_KEY);
    const variantsObj = Node.isPropertyAssignment(variantsProp ?? undefined)
      ? (variantsProp as import("ts-morph").PropertyAssignment).getInitializer()
      : undefined;
    if (variantsObj && Node.isObjectLiteralExpression(variantsObj)) {
      for (const axisProp of variantsObj.getProperties()) {
        const axisName = propName(axisProp);
        const axisObj = Node.isPropertyAssignment(axisProp) ? axisProp.getInitializer() : undefined;
        if (!axisName || !axisObj || !Node.isObjectLiteralExpression(axisObj)) continue;

        const values: string[] = [];
        for (const valProp of axisObj.getProperties()) {
          const valName = propName(valProp);
          if (valName) values.push(valName);
          if (Node.isPropertyAssignment(valProp)) {
            const cls = literalValue(valProp.getInitializer());
            if (cls) classes.push(cls);
          }
        }
        if (values.length) propsSchema[axisName] = values;
      }
    }
  }

  return classes.length || Object.keys(propsSchema).length ? { classes, propsSchema } : null;
}
