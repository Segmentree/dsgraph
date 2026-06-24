/**
 * Minimal CSS `var()` + `calc()` resolution for the Tailwind-v4 adapter.
 *
 * The canonicalizer deliberately refuses references/expressions (DESIGN.md §3) —
 * resolving them needs the token graph (a var's value), which is the adapter's job.
 * This module does exactly that join: given a table of `--name → value`, expand
 * `var(--x)` recursively and fold simple `calc()` length arithmetic into a concrete
 * value the canonicalizer can then turn into a `RawValue`.
 *
 * Scope is intentionally small: the expressions design-token CSS actually uses —
 * `var()` with optional fallback, and `calc()` over lengths with + - * /. Anything
 * outside that returns null, and the caller records an unresolved/off-system value.
 */

/** Map of CSS custom-property name (without `--`) → its raw declared value. */
export type VarTable = Map<string, string>;

const VAR_RE = /var\(\s*--([\w-]+)\s*(?:,([^()]*))?\)/;
const ROOT_PX = 16;
/** Depth guard against cyclic `var()` references. */
const MAX_VAR_DEPTH = 32;
/** Decimal places kept when rounding computed px. */
const ROUND_PRECISION = 4;
/** `String.indexOf` miss sentinel. */
const NOT_FOUND = -1;
/** Empty string, for blank-ness checks. */
const EMPTY = "";

/** Length units we understand; rem/em resolve against ROOT_PX. */
const UNIT = { px: "px", rem: "rem", em: "em" } as const;

/** Parentheses, shared by calc unwrapping and the tokenizer. */
const PAREN = { open: "(", close: ")" } as const;

/** The calc() function name and its opening token (`calc(`). */
const CALC_FN = "calc";
const CALC_OPEN = `${CALC_FN}${PAREN.open}`;

/** Expand all `var(--x[, fallback])` references against the table. Null if a ref is unresolvable. */
export function resolveVars(value: string, vars: VarTable, depth = 0): string | null {
  if (depth > MAX_VAR_DEPTH) return null;
  let out = value;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(out))) {
    const [whole, name, fallback] = m;
    const referenced = vars.get(name!);
    const replacement = referenced ?? fallback?.trim();
    if (replacement === undefined) return null;
    const resolved = resolveVars(replacement, vars, depth + 1);
    if (resolved === null) return null;
    out = out.slice(0, m.index) + resolved + out.slice(m.index + whole!.length);
  }
  return out;
}

const LENGTH_RE = new RegExp(`^(-?\\d*\\.?\\d+)(${UNIT.px}|${UNIT.rem}|${UNIT.em})?$`);

/** A length token in px, or null if not a bare length. */
function lengthToPx(token: string): number | null {
  const m = LENGTH_RE.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === UNIT.rem || m[2] === UNIT.em ? n * ROOT_PX : n;
}

/**
 * Evaluate `calc(...)` expressions over lengths (+ - * /, parentheses) → `<n>px`.
 * Returns the input unchanged if it contains no calc, or null if a calc can't be
 * evaluated within the supported grammar.
 */
export function evalCalc(value: string): string | null {
  if (!value.includes(CALC_OPEN)) return value;
  const expr = stripCalc(value);
  if (expr === null) return null;
  const px = evalExpr(tokenize(expr));
  return px === null ? null : `${round(px)}${UNIT.px}`;
}

/** Resolve vars then fold calc — the full adapter-side resolution. */
export function resolveValue(value: string, vars: VarTable): string | null {
  const expanded = resolveVars(value, vars);
  if (expanded === null) return null;
  return evalCalc(expanded);
}

/** Unwrap a single outer `calc( … )`, returning its inner expression. */
function stripCalc(value: string): string | null {
  const start = value.indexOf(CALC_OPEN);
  if (start === NOT_FOUND) return value;
  let depth = 0;
  for (let i = start + CALC_FN.length; i < value.length; i++) {
    if (value[i] === PAREN.open) depth++;
    else if (value[i] === PAREN.close) {
      depth--;
      if (depth === 0) {
        const inner = value.slice(start + CALC_OPEN.length, i);
        // Only support a calc that spans the whole value (no surrounding text).
        return value.slice(0, start).trim() === EMPTY && value.slice(i + 1).trim() === EMPTY
          ? inner
          : null;
      }
    }
  }
  return null;
}

/** Token kinds in a calc() expression. */
const TOK = { num: "num", op: "op", paren: "paren" } as const;
/** Arithmetic operators (standard precedence: mul/div bind tighter than add/sub). */
const OP = { add: "+", sub: "-", mul: "*", div: "/" } as const;

type Tok =
  | { t: typeof TOK.num; v: number }
  | { t: typeof TOK.op; v: string }
  | { t: typeof TOK.paren; v: typeof PAREN.open | typeof PAREN.close };

function tokenize(expr: string): Tok[] | null {
  const tokens: Tok[] = [];
  for (const raw of expr.split(/\s+/).filter(Boolean).flatMap(splitParens)) {
    if (raw === PAREN.open || raw === PAREN.close) {
      tokens.push({ t: TOK.paren, v: raw });
    } else if (raw === OP.add || raw === OP.sub || raw === OP.mul || raw === OP.div) {
      tokens.push({ t: TOK.op, v: raw });
    } else {
      const px = lengthToPx(raw);
      if (px === null) return null;
      tokens.push({ t: TOK.num, v: px });
    }
  }
  return tokens;
}

/** Split a whitespace-free chunk so parens become their own tokens (`a)` → `a`, `)`). */
function splitParens(s: string): string[] {
  const out: string[] = [];
  let buf = EMPTY;
  for (const ch of s) {
    if (ch === PAREN.open || ch === PAREN.close) {
      if (buf) out.push(buf);
      out.push(ch);
      buf = EMPTY;
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Recursive-descent eval with standard precedence over the token stream. */
function evalExpr(tokens: Tok[] | null): number | null {
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;

  const peek = () => tokens[pos];
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (peek()?.t === TOK.op && (peek()!.v === OP.add || peek()!.v === OP.sub)) {
      const op = (tokens[pos++] as { v: string }).v;
      const right = parseTerm();
      if (right === null) return null;
      left = op === OP.add ? left + right : left - right;
    }
    return left;
  };
  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (peek()?.t === TOK.op && (peek()!.v === OP.mul || peek()!.v === OP.div)) {
      const op = (tokens[pos++] as { v: string }).v;
      const right = parseFactor();
      if (right === null) return null;
      left = op === OP.mul ? left * right : left / right;
    }
    return left;
  };
  const parseFactor = (): number | null => {
    const tok = peek();
    if (!tok) return null;
    if (tok.t === TOK.paren && tok.v === PAREN.open) {
      pos++;
      const inner = parseExpr();
      if (peek()?.t === TOK.paren && (peek() as { v: string }).v === PAREN.close) pos++;
      return inner;
    }
    if (tok.t === TOK.num) {
      pos++;
      return tok.v;
    }
    return null;
  };

  const result = parseExpr();
  return pos === tokens.length ? result : null;
}

const round = (x: number, p = ROUND_PRECISION) => Math.round(x * 10 ** p) / 10 ** p;
