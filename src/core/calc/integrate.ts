import { create, all, type MathNode } from "mathjs";
import { normalizeInput, humanError } from "./engine";
import { dependsOn } from "./derive";
import { polynomialCoefficients } from "./solve";

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
          "Intégration par parties ou par substitution non disponible.",
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
    return { ok: false, message: humanError(e) };
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
      if (!dependsOn(num, v)) {
        const d = unwrap(den);
        // 1 / (ax + b)
        const lin = affine(den, v);
        if (lin) {
          return {
            expr: `${s(num)} * log(abs(${den.toString()})) / (${lin.a})`,
            rule: "1/(ax+b)",
          };
        }
        // k / u^n et k / sqrt(u) : on se ramene a k * u^(-n).
        if (d.type === "OperatorNode" && d.op === "^" && !dependsOn(d.args[1], v)) {
          const inner = integrateNode(math.parse(`${s(num)} * (${d.args[0].toString()})^(-(${d.args[1].toString()}))`), v);
          return inner ? { expr: inner.expr, rule: "puissance" } : null;
        }
        if (d.type === "FunctionNode" && (d.fn?.name ?? "") === "sqrt") {
          const inner = integrateNode(math.parse(`${s(num)} * (${d.args[0].toString()})^(-1/2)`), v);
          return inner ? { expr: inner.expr, rule: "puissance" } : null;
        }
        // k / (a x^2 + c), a et c de meme signe : arctangente.
        try {
          const c = polynomialCoefficients(den.toString(), v, 2);
          if (c.length === 3 && c[1] === 0 && c[0] * c[2] > 0) {
            const [c0, , a2] = c;
            const sgn = a2 > 0 ? 1 : -1;
            const A = Math.abs(a2), C = Math.abs(c0);
            return {
              expr: `${s(num)} * ${sgn} * atan(${v} * sqrt(${A} / ${C})) / sqrt(${A * C})`,
              rule: "1/(1+x²) : arctangente",
            };
          }
        } catch { /* pas un polynome */ }
      }
      return null;
    }

    if (node.op === "^") {
      const [base, exp] = args;
      // cos²(u) et sin²(u), u affine : linearisation.
      const b0 = unwrap(base);
      if (b0.type === "FunctionNode" && exp.toString() === "2" && ["sin", "cos"].includes(b0.fn?.name)) {
        const lin = affine(b0.args[0], v);
        if (lin) {
          const u = b0.args[0].toString();
          const sign = b0.fn.name === "cos" ? "+" : "-";
          return {
            expr: `(${u}) / (2 * (${lin.a})) ${sign} sin(2 * (${u})) / (4 * (${lin.a}))`,
            rule: `linéarisation de ${b0.fn.name}²`,
          };
        }
      }
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
  /** A afficher avec la valeur : resultat a prendre avec precaution. */
  warning?: string;
}

/**
 * Integrale definie. On tente la primitive ; a defaut, Simpson.
 *
 * Jamais F(b) - F(a) sans verifier que f est continue sur [a, b] :
 * ∫₋₁¹ 1/x n'est pas 0, elle n'existe pas. Et la valeur « exacte » est
 * recoupee par Simpson : une primitive fausse ne passe pas en silence.
 */
export function definiteIntegral(
  expr: string, variable: string, a: number, b: number,
): DefiniteOutcome {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { ok: false, message: "Bornes invalides" };
  }
  if (a === b) return { ok: true, value: 0, method: "exacte" };
  let f: (x: number) => number;
  try {
    const compiled = math.compile(normalizeInput(expr));
    f = (x: number) => Number(compiled.evaluate({ [variable]: x }));
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }

  const lo = Math.min(a, b), hi = Math.max(a, b);
  const sing = findSingularity(f, lo, hi);
  if (sing !== null) {
    const at = fmtX(sing);
    const edge = Math.abs(sing - lo) < 1e-9 * (1 + Math.abs(lo)) || Math.abs(sing - hi) < 1e-9 * (1 + Math.abs(hi));
    return {
      ok: false,
      message: edge
        ? `Intégrale impropre : f n'est pas définie en x = ${at}. Pas de valeur fiable.`
        : `Intégrale impropre : f n'est pas définie vers x ≈ ${at}. Découpe l'intervalle en deux.`,
    };
  }

  let numeric: number;
  try {
    numeric = simpson(expr, variable, a, b, 2000);
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }

  const prim = antiderivative(expr, variable);
  if (prim.ok && prim.result) {
    try {
      const F = math.compile(prim.result);
      const value = Number(F.evaluate({ [variable]: b })) - Number(F.evaluate({ [variable]: a }));
      if (Number.isFinite(value)) {
        const agrees = (num: number) => Math.abs(value - num) <= 1e-6 * (1 + Math.abs(num));
        // Fonction tres oscillante : Simpson a besoin d'un pas plus fin.
        if (agrees(numeric) || agrees(numeric = simpson(expr, variable, a, b, 40000))) {
          return { ok: true, value, method: "exacte" };
        }
        return {
          ok: Number.isFinite(numeric), value: numeric, method: "numerique",
          warning: "La primitive ne concorde pas avec le calcul numérique : valeur numérique affichée.",
          message: Number.isFinite(numeric) ? undefined : "Intégrale non calculable",
        };
      }
    } catch { /* on bascule en numerique */ }
  }
  if (!Number.isFinite(numeric)) return { ok: false, message: "Intégrale divergente ou non définie" };
  return { ok: true, value: numeric, method: "numerique" };
}

function fmtX(x: number): string {
  const r = Math.round(x * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * Cherche un point de [lo, hi] ou f n'est pas bornee : valeur non finie,
 * changement de signe qui n'est pas une racine (tan en pi/2), ou pic de |f|
 * qui grandit sans fin quand on s'en approche (1/x² en 0, hors grille).
 * Renvoie l'abscisse, ou null si f semble continue.
 */
export function findSingularity(f: (x: number) => number, lo: number, hi: number, n = 2000): number | null {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i === n ? hi : lo + ((hi - lo) * i) / n;
    let y: number;
    try { y = f(x); } catch { y = NaN; }
    if (!Number.isFinite(y)) return x;
    xs.push(x); ys.push(y);
  }
  const at = (x: number) => { try { return f(x); } catch { return NaN; } };

  for (let i = 0; i < n; i++) {
    // Changement de signe : racine ou pole ? La bissection tranche.
    if (ys[i] * ys[i + 1] < 0) {
      let a = xs[i], b = xs[i + 1], fa = ys[i];
      for (let k = 0; k < 90; k++) {
        const m = (a + b) / 2;
        const fm = at(m);
        if (!Number.isFinite(fm)) return m;
        if (fm === 0) { a = b = m; break; }
        if (fa * fm < 0) { b = m; } else { a = m; fa = fm; }
      }
      const m = (a + b) / 2;
      // Echelle = le plus petit des deux cotes : une grille qui tombe pile
      // sur le pole (tan en pi/2 vaut 1.6e16) ne doit pas le masquer.
      const scale = 1 + Math.min(Math.abs(ys[i]), Math.abs(ys[i + 1]));
      const fm = at(m);
      if (!Number.isFinite(fm) || Math.abs(fm) > 1e3 * scale) return m;
    }
  }

  // Pics de |f| : on raffine le maximum local, il doit rester borne.
  for (let i = 0; i <= n; i++) {
    const y = Math.abs(ys[i]);
    const left = i > 0 ? Math.abs(ys[i - 1]) : -Infinity;
    const right = i < n ? Math.abs(ys[i + 1]) : -Infinity;
    if (y < left || y < right || (y === left && y === right)) continue;
    // Echantillon isole tres au-dessus de ses voisins : pole touche par la grille.
    const near = Math.max(1, Number.isFinite(left) ? left : 0, Number.isFinite(right) ? right : 0);
    if (y > 1e6 * near) return xs[i];
    let a = xs[Math.max(0, i - 1)], b = xs[Math.min(n, i + 1)];
    for (let k = 0; k < 120 && b - a > 1e-300; k++) {
      const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
      const y1 = Math.abs(at(m1)), y2 = Math.abs(at(m2));
      if (!Number.isFinite(y1)) return m1;
      if (!Number.isFinite(y2)) return m2;
      if (y1 < y2) a = m1; else b = m2;
    }
    const peak = Math.abs(at((a + b) / 2));
    if (!Number.isFinite(peak) || peak > 1e6 * Math.max(1, y)) return (a + b) / 2;
  }
  return null;
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
