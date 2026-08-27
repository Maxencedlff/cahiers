import { create, all, type MathNode } from "mathjs";
import { normalizeInput } from "./engine";

const math = create(all, { number: "number" });

/**
 * Derivation avec explication pas a pas (section 7).
 * On parcourt l'arbre, on identifie la regle appliquee et on expose
 * u, v, u', v' avant de donner le resultat. mathjs calcule, ce module explique.
 */

export type DerivRule =
  | "constante"
  | "variable"
  | "linearite"
  | "produit"
  | "quotient"
  | "puissance"
  | "chaine"
  | "elementaire";

export const RULE_LABELS: Record<DerivRule, string> = {
  constante:   "Derivee d'une constante",
  variable:    "Derivee de la variable",
  linearite:   "Linearite",
  produit:     "Regle du produit",
  quotient:    "Regle du quotient",
  puissance:   "Regle de la puissance",
  chaine:      "Regle de la chaine",
  elementaire: "Derivee usuelle",
};

export interface DerivStep {
  rule: DerivRule;
  label: string;
  /** Expression derivee a cette etape, en LaTeX. */
  exprLatex: string;
  /** Formule generale de la regle, en LaTeX. */
  formulaLatex: string;
  /** Les morceaux nommes : u, v, u', v'. */
  parts: { name: string; latex: string }[];
  resultLatex: string;
  children: DerivStep[];
}

export interface DerivOutcome {
  ok: boolean;
  message?: string;
  /** Derivee simplifiee, en texte mathjs. */
  result?: string;
  resultLatex?: string;
  steps?: DerivStep;
}

export function derivative(expr: string, variable = "x"): DerivOutcome {
  try {
    const node = math.parse(normalizeInput(expr));
    const d = simplify(math.derivative(node, variable));
    return {
      ok: true,
      result: d.toString(),
      resultLatex: d.toTex({ parenthesis: "auto" }),
      steps: explain(node, variable),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Derivee n-ieme : la derivee seconde est la derivee de la derivee. */
export function nthDerivative(expr: string, variable = "x", n = 2): DerivOutcome {
  let current = normalizeInput(expr);
  let last: DerivOutcome = { ok: false };
  for (let i = 0; i < n; i++) {
    last = derivative(current, variable);
    if (!last.ok || !last.result) return last;
    current = last.result;
  }
  return last;
}

function simplify(n: MathNode): MathNode {
  try { return math.simplify(n); } catch { return n; }
}

function tex(n: MathNode): string {
  try { return n.toTex({ parenthesis: "auto" }); } catch { return n.toString(); }
}

function dTex(n: MathNode, v: string): string {
  return tex(simplify(math.derivative(n, v)));
}

/** L'expression depend-elle de la variable ? */
export function dependsOn(node: MathNode, variable: string): boolean {
  let found = false;
  node.traverse((n: any) => {
    if (n.type === "SymbolNode" && n.name === variable) found = true;
  });
  return found;
}

function unwrap(node: any): any {
  return node?.type === "ParenthesisNode" ? unwrap(node.content) : node;
}

export function explain(raw: MathNode, v: string): DerivStep {
  const node = unwrap(raw) as any;
  const exprLatex = tex(node);
  const resultLatex = dTex(node, v);

  const step = (
    rule: DerivRule,
    formulaLatex: string,
    parts: { name: string; latex: string }[],
    children: DerivStep[] = [],
  ): DerivStep => ({
    rule, label: RULE_LABELS[rule], exprLatex, formulaLatex, parts, resultLatex, children,
  });

  if (!dependsOn(node, v)) {
    return step("constante", "(k)' = 0", [{ name: "k", latex: exprLatex }]);
  }

  if (node.type === "SymbolNode" && node.name === v) {
    return step("variable", `(${v})' = 1`, []);
  }

  if (node.type === "OperatorNode") {
    const [a, b] = node.args as any[];

    if (node.op === "+" || node.op === "-") {
      return step(
        "linearite",
        "(u \\pm w)' = u' \\pm w'",
        [
          { name: "u", latex: tex(a) },
          { name: "w", latex: tex(b) },
        ],
        [explain(a, v), explain(b, v)].filter((c) => c.rule !== "constante" || true),
      );
    }

    if (node.op === "*" && node.args.length === 2) {
      const aConst = !dependsOn(a, v);
      const bConst = !dependsOn(b, v);
      if (aConst || bConst) {
        const k = aConst ? a : b;
        const u = aConst ? b : a;
        return step(
          "linearite",
          "(k \\cdot u)' = k \\cdot u'",
          [
            { name: "k", latex: tex(k) },
            { name: "u", latex: tex(u) },
            { name: "u'", latex: dTex(u, v) },
          ],
          [explain(u, v)],
        );
      }
      return step(
        "produit",
        "(uv)' = u'v + uv'",
        [
          { name: "u", latex: tex(a) },
          { name: "v", latex: tex(b) },
          { name: "u'", latex: dTex(a, v) },
          { name: "v'", latex: dTex(b, v) },
        ],
        [explain(a, v), explain(b, v)],
      );
    }

    if (node.op === "/") {
      if (!dependsOn(b, v)) {
        return step(
          "linearite",
          "\\left(\\dfrac{u}{k}\\right)' = \\dfrac{u'}{k}",
          [
            { name: "u", latex: tex(a) },
            { name: "k", latex: tex(b) },
            { name: "u'", latex: dTex(a, v) },
          ],
          [explain(a, v)],
        );
      }
      return step(
        "quotient",
        "\\left(\\dfrac{u}{v}\\right)' = \\dfrac{u'v - uv'}{v^2}",
        [
          { name: "u", latex: tex(a) },
          { name: "v", latex: tex(b) },
          { name: "u'", latex: dTex(a, v) },
          { name: "v'", latex: dTex(b, v) },
        ],
        [explain(a, v), explain(b, v)],
      );
    }

    if (node.op === "^") {
      const baseVar = dependsOn(a, v);
      const expVar = dependsOn(b, v);
      if (baseVar && !expVar) {
        const children = unwrap(a).type === "SymbolNode" ? [] : [explain(a, v)];
        return step(
          "puissance",
          "(u^n)' = n \\, u^{n-1} \\, u'",
          [
            { name: "u", latex: tex(a) },
            { name: "n", latex: tex(b) },
            { name: "u'", latex: dTex(a, v) },
          ],
          children,
        );
      }
      if (!baseVar && expVar) {
        return step(
          "chaine",
          "(a^u)' = a^u \\ln(a) \\, u'",
          [
            { name: "a", latex: tex(a) },
            { name: "u", latex: tex(b) },
            { name: "u'", latex: dTex(b, v) },
          ],
          [explain(b, v)],
        );
      }
      return step(
        "chaine",
        "(u^v)' = u^v \\left(v' \\ln u + \\dfrac{v u'}{u}\\right)",
        [
          { name: "u", latex: tex(a) },
          { name: "v", latex: tex(b) },
        ],
        [explain(a, v), explain(b, v)],
      );
    }

    if (node.op === "-" && node.args.length === 1) {
      return step("linearite", "(-u)' = -u'", [{ name: "u", latex: tex(a) }], [explain(a, v)]);
    }
  }

  if (node.type === "FunctionNode") {
    const arg = node.args[0];
    const fname = node.fn?.name ?? String(node.fn);
    const outer = ELEMENTARY[fname];
    const inner = unwrap(arg);
    const isSimple = inner.type === "SymbolNode" && inner.name === v;

    if (isSimple) {
      return step(
        "elementaire",
        outer ? outer.simple : `(${fname}(${v}))'`,
        [],
      );
    }
    return step(
      "chaine",
      outer ? outer.chain : "(f(u))' = f'(u) \\cdot u'",
      [
        { name: "u", latex: tex(arg) },
        { name: "u'", latex: dTex(arg, v) },
      ],
      [explain(arg, v)],
    );
  }

  // Cas non reconnu : on donne quand meme le resultat, sans detail de regle.
  return step("elementaire", "", []);
}

/** Derivees usuelles, pour nommer la regle exterieure d'une composition. */
const ELEMENTARY: Record<string, { simple: string; chain: string }> = {
  sin:  { simple: "(\\sin x)' = \\cos x",              chain: "(\\sin u)' = u' \\cos u" },
  cos:  { simple: "(\\cos x)' = -\\sin x",             chain: "(\\cos u)' = -u' \\sin u" },
  tan:  { simple: "(\\tan x)' = 1 + \\tan^2 x",        chain: "(\\tan u)' = u'(1 + \\tan^2 u)" },
  exp:  { simple: "(e^x)' = e^x",                      chain: "(e^u)' = u' e^u" },
  log:  { simple: "(\\ln x)' = \\dfrac{1}{x}",         chain: "(\\ln u)' = \\dfrac{u'}{u}" },
  log10:{ simple: "(\\log x)' = \\dfrac{1}{x \\ln 10}", chain: "(\\log u)' = \\dfrac{u'}{u \\ln 10}" },
  sqrt: { simple: "(\\sqrt{x})' = \\dfrac{1}{2\\sqrt{x}}", chain: "(\\sqrt{u})' = \\dfrac{u'}{2\\sqrt{u}}" },
  asin: { simple: "(\\arcsin x)' = \\dfrac{1}{\\sqrt{1-x^2}}", chain: "(\\arcsin u)' = \\dfrac{u'}{\\sqrt{1-u^2}}" },
  acos: { simple: "(\\arccos x)' = \\dfrac{-1}{\\sqrt{1-x^2}}", chain: "(\\arccos u)' = \\dfrac{-u'}{\\sqrt{1-u^2}}" },
  atan: { simple: "(\\arctan x)' = \\dfrac{1}{1+x^2}", chain: "(\\arctan u)' = \\dfrac{u'}{1+u^2}" },
  sinh: { simple: "(\\sinh x)' = \\cosh x",            chain: "(\\sinh u)' = u' \\cosh u" },
  cosh: { simple: "(\\cosh x)' = \\sinh x",            chain: "(\\cosh u)' = u' \\sinh u" },
  abs:  { simple: "(|x|)' = \\mathrm{sgn}(x)",         chain: "(|u|)' = u' \\, \\mathrm{sgn}(u)" },
};

/* ------------------------------------------------------------------ */
/* Calcul litteral                                                     */
/* ------------------------------------------------------------------ */

export interface SimplifyOutcome {
  ok: boolean;
  message?: string;
  result?: string;
  resultLatex?: string;
  inputLatex?: string;
}

/** 2x + x donne 3x (section 7). */
export function simplifyExpr(expr: string, substitutions?: Record<string, number | string>): SimplifyOutcome {
  try {
    const src = normalizeInput(expr);
    const input = math.parse(src);
    const out = math.simplify(src, substitutions ?? {});
    return {
      ok: true,
      result: out.toString(),
      resultLatex: out.toTex({ parenthesis: "auto" }),
      inputLatex: input.toTex({ parenthesis: "auto" }),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Substitution de variables, sans simplification agressive. */
export function substitute(expr: string, values: Record<string, number | string>): SimplifyOutcome {
  try {
    const src = normalizeInput(expr);
    let node = math.parse(src);
    node = node.transform((n: any) => {
      if (n.type === "SymbolNode" && n.name in values) {
        return math.parse(String(values[n.name]));
      }
      return n;
    });
    const out = math.simplify(node);
    return {
      ok: true,
      result: out.toString(),
      resultLatex: out.toTex({ parenthesis: "auto" }),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
