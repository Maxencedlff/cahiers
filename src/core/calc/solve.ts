import { create, all, type MathNode } from "mathjs";
import { normalizeInput } from "./engine";
import { rank } from "./matrix";

const math = create(all, { number: "number" });

/**
 * Resolution (section 7) : equations polynomiales, systemes, numerique.
 * Pour le second degre on affiche le discriminant et la nature des racines,
 * parce que c'est ce qu'on doit ecrire sur la copie, pas seulement le resultat.
 */

export interface Root { text: string; value: number | { re: number; im: number } }

export interface SolveOutcome {
  ok: boolean;
  message?: string;
  degree?: number;
  coefficients?: number[];
  /** Second degre : discriminant et nature. */
  discriminant?: number;
  nature?: string;
  roots?: Root[];
  method?: "exacte" | "numerique";
}

/** "2x^2 - 3x = 1" devient l'expression "2x^2 - 3x - 1". */
export function toZeroForm(equation: string): string {
  const src = normalizeInput(equation);
  const parts = src.split("=");
  if (parts.length === 1) return src;
  if (parts.length !== 2) throw new Error("Une seule egalite attendue");
  return `(${parts[0]}) - (${parts[1]})`;
}

/**
 * Coefficients d'un polynome, du terme constant au degre le plus haut.
 * Obtenus par derivations successives en 0 : c_k = f^(k)(0) / k!.
 * Fiable meme quand l'expression n'est pas ecrite sous forme developpee.
 */
export function polynomialCoefficients(expr: string, v = "x", maxDegree = 8): number[] {
  let node: MathNode = math.parse(expr);
  const coeffs: number[] = [];
  let factorial = 1;
  for (let k = 0; k <= maxDegree; k++) {
    if (k > 0) factorial *= k;
    const value = Number(node.evaluate({ [v]: 0 })) / factorial;
    if (!Number.isFinite(value)) throw new Error("Expression non polynomiale");
    coeffs.push(round(value));
    node = math.simplify(math.derivative(node, v));
    if (node.toString() === "0") break;
  }
  while (coeffs.length > 1 && Math.abs(coeffs[coeffs.length - 1]) < 1e-12) coeffs.pop();
  return coeffs;
}

function round(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-10 ? r : v;
}

export function solveEquation(equation: string, v = "x"): SolveOutcome {
  let zero: string;
  try {
    zero = toZeroForm(equation);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  let coeffs: number[] | null = null;
  try {
    coeffs = polynomialCoefficients(zero, v);
  } catch { coeffs = null; }

  if (coeffs) {
    const degree = coeffs.length - 1;
    if (degree === 1) {
      const [c, b] = coeffs;
      if (b === 0) {
        return c === 0
          ? { ok: true, degree: 0, message: "Toujours vrai", roots: [] }
          : { ok: false, message: "Aucune solution" };
      }
      return {
        ok: true, degree: 1, coefficients: coeffs, method: "exacte",
        roots: [{ text: fmt(-c / b), value: -c / b }],
      };
    }
    if (degree === 2) return solveQuadratic(coeffs);
    if (degree === 3) {
      try {
        const [d, c, b, a] = coeffs;
        const raw = math.polynomialRoot(d, c, b, a) as any[];
        return {
          ok: true, degree: 3, coefficients: coeffs, method: "exacte",
          roots: raw.map(toRoot),
        };
      } catch { /* on bascule en numerique */ }
    }
  }

  const numeric = numericRoots(zero, v);
  if (numeric.length === 0) {
    return { ok: false, message: "Aucune racine reelle trouvee sur [-100, 100]" };
  }
  return {
    ok: true, method: "numerique",
    roots: numeric.map((r) => ({ text: fmt(r), value: r })),
  };
}

function solveQuadratic(coeffs: number[]): SolveOutcome {
  const [c, b, a] = coeffs;
  const delta = b * b - 4 * a * c;
  const base = { ok: true as const, degree: 2, coefficients: coeffs, discriminant: delta, method: "exacte" as const };

  if (delta > 1e-12) {
    const r = Math.sqrt(delta);
    const x1 = (-b - r) / (2 * a);
    const x2 = (-b + r) / (2 * a);
    return {
      ...base,
      nature: "Delta > 0 : deux racines reelles distinctes",
      roots: [x1, x2].sort((p, q) => p - q).map((x) => ({ text: fmt(x), value: x })),
    };
  }
  if (Math.abs(delta) <= 1e-12) {
    const x = -b / (2 * a);
    return {
      ...base,
      nature: "Delta = 0 : une racine reelle double",
      roots: [{ text: fmt(x), value: x }],
    };
  }
  const re = -b / (2 * a);
  const im = Math.sqrt(-delta) / (2 * a);
  return {
    ...base,
    nature: "Delta < 0 : deux racines complexes conjuguees",
    roots: [
      { text: `${fmt(re)} - ${fmt(Math.abs(im))}i`, value: { re, im: -Math.abs(im) } },
      { text: `${fmt(re)} + ${fmt(Math.abs(im))}i`, value: { re, im: Math.abs(im) } },
    ],
  };
}

function toRoot(r: any): Root {
  if (typeof r === "number") return { text: fmt(r), value: r };
  const re = Number(r?.re ?? 0), im = Number(r?.im ?? 0);
  if (Math.abs(im) < 1e-12) return { text: fmt(re), value: re };
  return { text: `${fmt(re)} ${im < 0 ? "-" : "+"} ${fmt(Math.abs(im))}i`, value: { re, im } };
}

export function fmt(v: number): string {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-10) return String(r);
  return String(Math.round(v * 1e10) / 1e10);
}

/**
 * Racines reelles par balayage puis bissection. Utilise des que le polynome
 * depasse le degre 3 ou que l'equation n'est pas polynomiale.
 */
export function numericRoots(expr: string, v = "x", from = -100, to = 100, steps = 4000): number[] {
  const f = math.compile(normalizeInput(expr));
  const at = (x: number) => Number(f.evaluate({ [v]: x }));
  const roots: number[] = [];
  const h = (to - from) / steps;
  let prevX = from;
  let prevY = safe(at, prevX);

  for (let i = 1; i <= steps; i++) {
    const x = from + i * h;
    const y = safe(at, x);
    if (prevY !== null && y !== null) {
      if (Math.abs(y) < 1e-12) {
        pushUnique(roots, x);
      } else if (prevY * y < 0) {
        pushUnique(roots, bisect(at, prevX, x));
      }
    }
    prevX = x;
    prevY = y;
  }
  return roots;
}

function safe(f: (x: number) => number, x: number): number | null {
  try {
    const y = f(x);
    return Number.isFinite(y) ? y : null;
  } catch { return null; }
}

function pushUnique(list: number[], x: number) {
  const r = Math.round(x * 1e8) / 1e8;
  if (!list.some((e) => Math.abs(e - r) < 1e-6)) list.push(r);
}

function bisect(f: (x: number) => number, a: number, b: number, iterations = 80): number {
  let lo = a, hi = b;
  let flo = f(lo);
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (fmid === 0) return mid;
    if (flo * fmid < 0) { hi = mid; } else { lo = mid; flo = fmid; }
  }
  return (lo + hi) / 2;
}

/* ------------------------------------------------------------------ */
/* Systemes lineaires                                                  */
/* ------------------------------------------------------------------ */

export interface SystemOutcome {
  ok: boolean;
  message?: string;
  variables?: string[];
  solution?: Record<string, string>;
}

/**
 * Systeme lineaire donne en clair, une equation par ligne.
 * Les inconnues sont deduites des symboles rencontres.
 */
export function solveSystem(lines: string[], unknowns?: string[]): SystemOutcome {
  const equations = lines.map((l) => l.trim()).filter(Boolean);
  if (equations.length === 0) return { ok: false, message: "Aucune equation" };

  let vars: string[];
  try {
    vars = unknowns?.length ? unknowns : detectSymbols(equations);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (vars.length === 0) return { ok: false, message: "Aucune inconnue detectee" };
  if (equations.length !== vars.length) {
    return {
      ok: false,
      message: `${equations.length} equation(s) pour ${vars.length} inconnue(s) : systeme non carre`,
    };
  }

  try {
    const A: number[][] = [];
    const B: number[] = [];
    for (const eq of equations) {
      const zero = math.parse(toZeroForm(eq));
      const row: number[] = [];
      for (const v of vars) {
        const d = math.simplify(math.derivative(zero, v));
        const coeff = Number(d.evaluate(zeroScope(vars)));
        if (!Number.isFinite(coeff)) throw new Error("Systeme non lineaire");
        row.push(coeff);
      }
      const constant = Number(zero.evaluate(zeroScope(vars)));
      A.push(row);
      B.push(-constant);
    }
    // lusolve ne signale pas toujours un systeme singulier : il faut le
    // detecter avant, sinon une solution arbitraire est renvoyee comme valide.
    if (rank(A) < vars.length) {
      return { ok: false, message: "Systeme singulier : aucune solution unique" };
    }
    const sol = math.lusolve(A, B) as unknown as number[][];
    const solution: Record<string, string> = {};
    vars.forEach((v, i) => { solution[v] = fmt(Number(sol[i][0])); });
    return { ok: true, variables: vars, solution };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/singular/i.test(msg)) {
      return { ok: false, message: "Systeme singulier : aucune solution unique" };
    }
    return { ok: false, message: msg };
  }
}

function zeroScope(vars: string[]): Record<string, number> {
  return Object.fromEntries(vars.map((v) => [v, 0]));
}

function detectSymbols(equations: string[]): string[] {
  const found = new Set<string>();
  const reserved = new Set(["e", "pi", "i", "true", "false", "null", "Infinity", "NaN"]);
  for (const eq of equations) {
    math.parse(toZeroForm(eq)).traverse((n: any, _path: string, parent: any) => {
      if (n.type !== "SymbolNode") return;
      if (parent?.type === "FunctionNode" && parent.fn === n) return;
      if (reserved.has(n.name)) return;
      found.add(n.name);
    });
  }
  return [...found].sort();
}
