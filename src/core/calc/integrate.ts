import { create, all, type MathNode } from "mathjs";
import { normalizeInput } from "./engine";
import { dependsOn } from "./derive";

const math = create(all, { number: "number" });

/**
 * Primitives (section 7).
 *
 * Limite connue : mathjs ne sait pas integrer. On implemente donc la premiere
 * option de la specification, une table de formes usuelles ecrite a la main,
 * qui couvre les polynomes, 1/x, exp, sin, cos, les sommes, la constante
 * multiplicative, et les composees affines f(ax+b).
 *
 * L'option 2 (Nerdamer, integration par parties et par substitution) reste
 * ouverte : le point d'extension est `tryExternal` ci-dessous. Elle n'est pas
 * branchee tant que le besoin reel ne s'est pas manifeste.
 */

export interface IntegralOutcome {
  ok: boolean;
  message?: string;
  /** Primitive sans la constante. */
  result?: string;
  resultLatex?: string;
  /** Regle reconnue, affichee dans les details. */
  rule?: string;
}

export function antiderivative(expr: string, variable = "x"): IntegralOutcome {
  try {
    const node = math.parse(normalizeInput(expr));
    const found = integrateNode(node, variable);
    if (!found) {
      const ext = tryExternal(expr, variable);
      if (ext) return ext;
      return {
        ok: false,
        message:
          "Forme non couverte par la table des primitives. " +
          "Integration par parties ou par substitution non disponible.",
      };
    }
    const simplified = trySimplify(math.parse(found.expr));
    return {
      ok: true,
      result: simplified.toString(),
      resultLatex: simplified.toTex({ parenthesis: "auto" }),
      rule: found.rule,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function trySimplify(n: MathNode): MathNode {
  try { return math.simplify(n); } catch { return n; }
}

interface Found { expr: string; rule: string }

function unwrap(node: any): any {
  return node?.type === "ParenthesisNode" ? unwrap(node.content) : node;
}

function s(node: MathNode): string { return `(${node.toString()})`; }

function integrateNode(raw: MathNode, v: string): Found | null {
  const node = unwrap(raw) as any;

  // Constante : integrale de k vaut kx.
  if (!dependsOn(node, v)) {
    return { expr: `${s(node)} * ${v}`, rule: "constante" };
  }

  if (node.type === "SymbolNode" && node.name === v) {
    return { expr: `${v}^2 / 2`, rule: "puissance" };
  }

  if (node.type === "OperatorNode") {
    const args = node.args as any[];

    if ((node.op === "+" || node.op === "-") && args.length === 2) {
      const a = integrateNode(args[0], v);
      const b = integrateNode(args[1], v);
      if (!a || !b) return null;
      return { expr: `(${a.expr}) ${node.op} (${b.expr})`, rule: "linearite" };
    }

    if (node.op === "-" && args.length === 1) {
      const a = integrateNode(args[0], v);
      return a ? { expr: `-(${a.expr})`, rule: "linearite" } : null;
    }

    if (node.op === "*" && args.length === 2) {
      const aConst = !dependsOn(args[0], v);
      const bConst = !dependsOn(args[1], v);
      if (aConst || bConst) {
        const k = aConst ? args[0] : args[1];
        const u = aConst ? args[1] : args[0];
        const inner = integrateNode(u, v);
        return inner
          ? { expr: `${s(k)} * (${inner.expr})`, rule: "constante multiplicative" }
          : null;
      }
      return null; // produit de deux fonctions : parties, non couvert
    }

    if (node.op === "/") {
      const [num, den] = args;
      if (!dependsOn(den, v)) {
        const inner = integrateNode(num, v);
        return inner ? { expr: `(${inner.expr}) / ${s(den)}`, rule: "constante multiplicative" } : null;
      }
      // 1 / (ax + b)
      if (!dependsOn(num, v)) {
        const lin = affine(den, v);
        if (lin) {
          return {
            expr: `${s(num)} * log(abs(${den.toString()})) / (${lin.a})`,
            rule: "1/(ax+b)",
          };
        }
      }
      return null;
    }

    if (node.op === "^") {
      const [base, exp] = args;
      if (dependsOn(base, v) && !dependsOn(exp, v)) {
        const n = Number(exp.toString());
        const lin = affine(base, v);
        if (!lin) return null;
        if (Number.isFinite(n) && Math.abs(n + 1) < 1e-12) {
          return { expr: `log(abs(${base.toString()})) / (${lin.a})`, rule: "1/u" };
        }
        return {
          expr: `(${base.toString()})^((${exp.toString()}) + 1) / (((${exp.toString()}) + 1) * (${lin.a}))`,
          rule: "puissance",
        };
      }
      // a^(kx+b)
      if (!dependsOn(base, v) && dependsOn(exp, v)) {
        const lin = affine(exp, v);
        if (!lin) return null;
        return {
          expr: `(${base.toString()})^(${exp.toString()}) / ((${lin.a}) * log(${base.toString()}))`,
          rule: "exponentielle",
        };
      }
      return null;
    }
  }

  if (node.type === "FunctionNode") {
    const fname = node.fn?.name ?? String(node.fn);
    const arg = node.args[0];
    const lin = affine(arg, v);
    if (!lin) return null; // seules les composees affines sont couvertes
    const u = arg.toString();
    const k = lin.a;
    const table: Record<string, string> = {
      sin:  `-cos(${u}) / (${k})`,
      cos:  `sin(${u}) / (${k})`,
      tan:  `-log(abs(cos(${u}))) / (${k})`,
      exp:  `exp(${u}) / (${k})`,
      sqrt: `2 * (${u})^(3/2) / (3 * (${k}))`,
      log:  `((${u}) * log(${u}) - (${u})) / (${k})`,
      sinh: `cosh(${u}) / (${k})`,
      cosh: `sinh(${u}) / (${k})`,
    };
    const found = table[fname];
    return found ? { expr: found, rule: `primitive usuelle de ${fname}` } : null;
  }

  return null;
}

/**
 * L'expression est-elle affine en v ? Renvoie le coefficient a de ax + b.
 * C'est ce qui permet de traiter sin(2x), exp(3x+1), (2x+1)^5.
 */
export function affine(node: MathNode, v: string): { a: string } | null {
  try {
    const d = math.simplify(math.derivative(node, v));
    if (dependsOn(d, v)) return null; // derivee non constante : pas affine
    return { a: d.toString() };
  } catch {
    return null;
  }
}

/**
 * Point d'extension pour l'option 2 (Nerdamer). Tant que la question reste
 * ouverte dans CLAUDE.md, la fonction ne fait rien et le dit clairement.
 */
function tryExternal(_expr: string, _variable: string): IntegralOutcome | null {
  return null;
}

/* ------------------------------------------------------------------ */
/* Integrale definie                                                   */
/* ------------------------------------------------------------------ */

export interface DefiniteOutcome {
  ok: boolean;
  message?: string;
  value?: number;
  /** "exacte" si passee par la primitive, "numerique" si Simpson. */
  method?: "exacte" | "numerique";
}

/**
 * Integrale definie. On tente la primitive ; a defaut, Simpson.
 * Un resultat numerique vaut mieux qu'un echec devant un exercice.
 */
export function definiteIntegral(
  expr: string, variable: string, a: number, b: number,
): DefiniteOutcome {
  const prim = antiderivative(expr, variable);
  if (prim.ok && prim.result) {
    try {
      const f = math.compile(prim.result);
      const value = f.evaluate({ [variable]: b }) - f.evaluate({ [variable]: a });
      if (Number.isFinite(value)) return { ok: true, value, method: "exacte" };
    } catch { /* on bascule en numerique */ }
  }
  try {
    const value = simpson(expr, variable, a, b);
    if (!Number.isFinite(value)) return { ok: false, message: "Integrale divergente ou non definie" };
    return { ok: true, value, method: "numerique" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Simpson composite, n pair. */
export function simpson(expr: string, variable: string, a: number, b: number, n = 1000): number {
  const f = math.compile(normalizeInput(expr));
  const evalAt = (x: number) => Number(f.evaluate({ [variable]: x }));
  const steps = n % 2 === 0 ? n : n + 1;
  const h = (b - a) / steps;
  let sum = evalAt(a) + evalAt(b);
  for (let i = 1; i < steps; i++) {
    sum += evalAt(a + i * h) * (i % 2 === 0 ? 2 : 4);
  }
  return (h / 3) * sum;
}
