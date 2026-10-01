import { create, all, type MathNode } from "mathjs";
import { normalizeInput, humanError } from "./engine";
import { rank } from "./matrix";

const math = create(all, { number: "number" });

/**
 * Resolution (section 7) : equations polynomiales, systemes, numerique.
 * Pour le second degre on affiche le discriminant et la nature des racines,
 * parce que c'est ce qu'on doit ecrire sur la copie, pas seulement le resultat.
 */

export interface Root {
  text: string;
  value: number | { re: number; im: number };
  /** Forme exacte (√2, 1/3), quand elle existe, en LaTeX. */
  latex?: string;
  /** Racine multiple : 2 = double, 3 = triple... */
  multiplicity?: number;
}

export interface SolveOutcome {
  ok: boolean;
  message?: string;
  /** Inconnue deduite des symboles de l'equation. */
  variable?: string;
  degree?: number;
  coefficients?: number[];
  /** Second degre : discriminant et nature. */
  discriminant?: number;
  nature?: string;
  roots?: Root[];
  /** Racines trouvees mais non affichees (on en garde 10, les plus proches de 0). */
  more?: number;
  method?: "exacte" | "numerique";
}

/** Nombre maximal de racines affichees par la resolution numerique. */
export const MAX_ROOTS = 10;

/** "2x^2 - 3x = 1" devient l'expression "2x^2 - 3x - 1". */
export function toZeroForm(equation: string): string {
  const src = normalizeInput(equation);
  // « == » et « <= » ne sont pas des egalites a resoudre.
  const parts = src.split(/(?<![=<>!])=(?!=)/);
  if (parts.length === 1) return src;
  if (parts.length !== 2) throw new Error("Une seule égalité attendue");
  if (!parts[0].trim() || !parts[1].trim()) throw new Error("Un membre de l'égalité est vide");
  return `(${parts[0]}) - (${parts[1]})`;
}

/**
 * Coefficients d'un polynome, du terme constant au degre le plus haut.
 * Obtenus par derivations successives en 0 : c_k = f^(k)(0) / k!.
 * Fiable meme quand l'expression n'est pas ecrite sous forme developpee.
 * Leve une erreur si l'expression n'est pas un polynome de degre <= maxDegree
 * (cos(x) n'est pas son developpement de Taylor tronque).
 */
export function polynomialCoefficients(expr: string, v = "x", maxDegree = 8): number[] {
  let node: MathNode = math.parse(expr);
  const coeffs: number[] = [];
  let factorial = 1;
  let ended = false;
  for (let k = 0; k <= maxDegree; k++) {
    if (k > 0) factorial *= k;
    const value = Number(node.evaluate({ [v]: 0 })) / factorial;
    if (!Number.isFinite(value)) throw new Error("Expression non polynomiale");
    coeffs.push(round(value));
    node = math.simplify(math.derivative(node, v));
    if (isZero(node)) { ended = true; break; }
  }
  if (!ended) throw new Error("Expression non polynomiale");
  while (coeffs.length > 1 && Math.abs(coeffs[coeffs.length - 1]) < 1e-12) coeffs.pop();
  return coeffs;
}

function isZero(node: MathNode): boolean {
  if (node.toString() === "0") return true;
  // Derivee qui ne depend plus de rien et vaut 0 (ex. 0 * x).
  try { return Number(node.evaluate({})) === 0; } catch { return false; }
}

function round(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-10 ? r : v;
}

const RESERVED = new Set(["e", "pi", "i", "E", "PI", "true", "false", "null", "Infinity", "NaN", "tau", "phi"]);

/** Symboles libres d'une expression : les inconnues possibles. */
export function freeSymbols(expr: string): string[] {
  const found = new Set<string>();
  math.parse(expr).traverse((n: any, _path: string, parent: any) => {
    if (n.type !== "SymbolNode") return;
    if (parent?.type === "FunctionNode" && parent.fn === n) return;
    if (RESERVED.has(n.name)) return;
    found.add(n.name);
  });
  return [...found].sort();
}

export function solveEquation(equation: string, variable?: string): SolveOutcome {
  let zero: string;
  let v: string;
  try {
    zero = toZeroForm(equation);
    const symbols = freeSymbols(zero);
    if (variable) v = variable;
    else if (symbols.length === 1) v = symbols[0];
    else if (symbols.length === 0) {
      // Plus aucune inconnue : l'egalite est vraie ou fausse.
      const val = Number(math.evaluate(zero));
      return Math.abs(val) < 1e-12
        ? { ok: true, degree: 0, message: "Égalité toujours vraie", roots: [] }
        : { ok: false, message: "Égalité fausse : aucune solution" };
    } else {
      return {
        ok: false,
        message: `Plusieurs inconnues (${symbols.join(", ")}) : donne une valeur aux paramètres ou utilise un système.`,
      };
    }
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }

  let coeffs: number[] | null = null;
  try {
    coeffs = polynomialCoefficients(zero, v);
  } catch { coeffs = null; }

  if (coeffs) {
    const degree = coeffs.length - 1;
    if (degree === 0) {
      return coeffs[0] === 0
        ? { ok: true, variable: v, degree: 0, message: `Toujours vrai : tout ${v} convient`, roots: [] }
        : { ok: false, variable: v, message: "Aucune solution" };
    }
    if (degree === 1) {
      const [c, b] = coeffs;
      const x = -c / b;
      return {
        ok: true, variable: v, degree: 1, coefficients: coeffs, method: "exacte",
        roots: [{ text: fmt(x), value: x, latex: fractionLatex(-c, b) }],
      };
    }
    if (degree === 2) return { ...solveQuadratic(coeffs), variable: v };
    const roots = polynomialRoots(coeffs);
    if (roots) {
      return {
        ok: true, variable: v, degree, coefficients: coeffs, method: "exacte",
        roots,
        message: roots.length ? undefined : "Aucune racine",
      };
    }
  }

  let found: { roots: number[]; identity: boolean };
  try {
    found = numericSolve(zero, v);
  } catch (e) {
    return { ok: false, variable: v, message: humanError(e) };
  }
  if (found.identity) {
    return { ok: true, variable: v, message: "Égalité vraie pour toutes les valeurs testées", roots: [] };
  }
  if (found.roots.length === 0) {
    return { ok: false, variable: v, message: "Aucune racine réelle trouvée sur [-100, 100]" };
  }
  const shown = [...found.roots].sort((p, q) => Math.abs(p) - Math.abs(q)).slice(0, MAX_ROOTS).sort((p, q) => p - q);
  return {
    ok: true, variable: v, method: "numerique",
    roots: shown.map((r) => ({ text: fmt(r), value: r })),
    more: found.roots.length - shown.length,
  };
}

/* ------------------------------------------------------------------ */
/* Second degre, forme exacte                                          */
/* ------------------------------------------------------------------ */

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

const isInt = (x: number) => Number.isInteger(x) && Math.abs(x) < 1e9;

/** p/q reduit, en LaTeX ; undefined si p ou q n'est pas entier. */
export function fractionLatex(p: number, q: number): string | undefined {
  if (!isInt(p) || !isInt(q) || q === 0) return undefined;
  const g = gcd(p, q) || 1;
  let n = p / g, d = q / g;
  if (d < 0) { n = -n; d = -d; }
  if (d === 1) return String(n);
  return `${n < 0 ? "-" : ""}\\frac{${Math.abs(n)}}{${d}}`;
}

/** n = k² m avec m sans facteur carre. */
function squareFree(n: number): { k: number; m: number } {
  let k = 1, m = n;
  for (let f = 2; f * f <= m; f++) {
    while (m % (f * f) === 0) { m /= f * f; k *= f; }
  }
  return { k, m };
}

/**
 * Racines exactes de a x² + b x + c (entiers). Reelles : dans l'ordre
 * croissant. Complexes : partie imaginaire negative d'abord.
 */
function quadraticExact(a: number, b: number, c: number): [string, string] | undefined {
  if (![a, b, c].every(isInt)) return undefined;
  const delta = b * b - 4 * a * c;
  const { k, m } = squareFree(Math.abs(delta));
  if (m === 1 && delta >= 0) {
    const lo = fractionLatex(-b - k, 2 * a) ?? "", hi = fractionLatex(-b + k, 2 * a) ?? "";
    return (-b - k) / (2 * a) <= (-b + k) / (2 * a) ? [lo, hi] : [hi, lo];
  }
  const g0 = gcd(gcd(b, k), 2 * a) || 1;
  let p = -b / g0, r = k / g0, d = (2 * a) / g0;
  if (d < 0) { p = -p; d = -d; }
  const rad = delta < 0
    ? `${r === 1 ? "" : r}${m === 1 ? "" : `\\sqrt{${m}}`}\\,i`.replace(/^\\,/, "")
    : `${r === 1 ? "" : r}\\sqrt{${m}}`;
  const one = (sign: "-" | "+") => {
    const num = p === 0 ? `${sign === "-" ? "-" : ""}${rad}` : `${p} ${sign} ${rad}`;
    return d === 1 ? num : `\\frac{${num}}{${d}}`;
  };
  return [one("-"), one("+")];
}

function solveQuadratic(coeffs: number[]): SolveOutcome {
  const [c, b, a] = coeffs;
  const delta = b * b - 4 * a * c;
  const base = { ok: true as const, degree: 2, coefficients: coeffs, discriminant: round(delta), method: "exacte" as const };
  const exact = quadraticExact(a, b, c);

  if (delta > 1e-12) {
    const r = Math.sqrt(delta);
    const [x1, x2] = [(-b - r) / (2 * a), (-b + r) / (2 * a)].sort((p, q) => p - q);
    const tex = exact;
    return {
      ...base,
      nature: "Δ > 0 : deux racines réelles distinctes",
      roots: [
        { text: fmt(x1), value: x1, latex: tex?.[0] },
        { text: fmt(x2), value: x2, latex: tex?.[1] },
      ],
    };
  }
  if (Math.abs(delta) <= 1e-12) {
    const x = -b / (2 * a);
    return {
      ...base,
      nature: "Δ = 0 : une racine réelle double",
      roots: [{ text: fmt(x), value: x, latex: fractionLatex(-b, 2 * a), multiplicity: 2 }],
    };
  }
  const re = -b / (2 * a);
  const im = Math.abs(Math.sqrt(-delta) / (2 * a));
  return {
    ...base,
    nature: "Δ < 0 : deux racines complexes conjuguées",
    roots: [
      { text: `${fmt(re)} - ${fmt(im)}i`, value: { re, im: -im }, latex: exact?.[0] },
      { text: `${fmt(re)} + ${fmt(im)}i`, value: { re, im }, latex: exact?.[1] },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Degre >= 3 : Durand-Kerner, racines complexes et multiples          */
/* ------------------------------------------------------------------ */

type C = { re: number; im: number };
const cmul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const csub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
const cdiv = (a: C, b: C): C => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const cabs = (a: C) => Math.hypot(a.re, a.im);

/** Valeur du polynome (coefficients du constant au dominant) en z. */
function peval(coeffs: number[], z: C): C {
  let acc: C = { re: 0, im: 0 };
  for (let k = coeffs.length - 1; k >= 0; k--) acc = { re: cmul(acc, z).re + coeffs[k], im: cmul(acc, z).im };
  return acc;
}

function pderiv(coeffs: number[]): number[] {
  return coeffs.slice(1).map((c, i) => c * (i + 1));
}

/** Toutes les racines complexes, multiplicites regroupees, ou null si echec. */
export function polynomialRoots(coeffs: number[]): Root[] | null {
  const n = coeffs.length - 1;
  if (n < 1) return [];
  // Racine nulle factorisee a part : exacte.
  let zeros = 0;
  while (zeros < n && coeffs[zeros] === 0) zeros++;
  const p = coeffs.slice(zeros);
  const deg = p.length - 1;
  const lead = p[deg];
  const monic = p.map((c) => c / lead);
  const R = 1 + Math.max(...monic.slice(0, deg).map(Math.abs), 0);
  let z: C[] = Array.from({ length: deg }, (_, k) => {
    const ang = (2 * Math.PI * k) / deg + 0.4;
    return { re: R * Math.cos(ang), im: R * Math.sin(ang) };
  });
  for (let it = 0; it < 2000; it++) {
    let moved = 0;
    z = z.map((zi, i) => {
      let den: C = { re: 1, im: 0 };
      for (let j = 0; j < deg; j++) if (j !== i) den = cmul(den, csub(zi, z[j]));
      if (cabs(den) === 0) den = { re: 1e-12, im: 0 };
      const step = cdiv(peval(monic, zi), den);
      moved = Math.max(moved, cabs(step));
      return csub(zi, step);
    });
    if (moved < 1e-15 * R) break;
  }
  if (z.some((zi) => !Number.isFinite(zi.re) || !Number.isFinite(zi.im))) return null;

  // Regroupement des racines multiples, valide par Newton sur la derivee
  // (m-1)-ieme : une racine d'ordre m en est une racine simple.
  const groups: C[][] = [];
  for (const zi of z) {
    const g = groups.find((gr) => cabs(csub(gr[0], zi)) < 2e-3 * Math.max(1, cabs(zi)));
    if (g) g.push(zi); else groups.push([zi]);
  }
  const out: { z: C; m: number }[] = [];
  for (const g of groups) {
    if (g.length === 1) { out.push({ z: g[0], m: 1 }); continue; }
    let d = monic;
    for (let k = 1; k < g.length; k++) d = pderiv(d);
    const dd = pderiv(d);
    let c: C = { re: g.reduce((s0, q) => s0 + q.re, 0) / g.length, im: g.reduce((s0, q) => s0 + q.im, 0) / g.length };
    for (let it = 0; it < 60; it++) {
      const den = peval(dd, c);
      if (cabs(den) === 0) break;
      c = csub(c, cdiv(peval(d, c), den));
    }
    const scale = monic.reduce((s0, a, k) => s0 + Math.abs(a) * Math.pow(Math.max(1, cabs(c)), k), 0);
    if (cabs(peval(monic, c)) <= 1e-9 * scale) out.push({ z: c, m: g.length });
    else for (const q of g) out.push({ z: q, m: 1 });
  }
  if (zeros) out.push({ z: { re: 0, im: 0 }, m: zeros });

  const roots = out.map(({ z: c, m }) => {
    const mag = Math.max(1, cabs(c));
    const re = Math.abs(c.re) < 1e-10 * mag ? 0 : round(c.re);
    const im = Math.abs(c.im) < 1e-9 * mag ? 0 : round(c.im);
    const root: Root = im === 0
      ? { text: fmt(re), value: re }
      : { text: `${fmt(re)} ${im < 0 ? "-" : "+"} ${fmt(Math.abs(im))}i`, value: { re, im } };
    if (m > 1) root.multiplicity = m;
    return root;
  });
  const key = (r: Root) => (typeof r.value === "number" ? [0, r.value, 0] : [1, r.value.re, r.value.im]);
  return roots.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

export function fmt(v: number): string {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-10) return String(Object.is(r, -0) ? 0 : r);
  return String(Math.round(v * 1e10) / 1e10);
}

/* ------------------------------------------------------------------ */
/* Resolution numerique                                                */
/* ------------------------------------------------------------------ */

/**
 * Racines reelles par balayage puis bissection. Utilise quand l'equation
 * n'est pas polynomiale. Un changement de signe n'est une racine que si f
 * s'y annule vraiment : sinon c'est un pole (tan en pi/2), rejete.
 */
export function numericRoots(expr: string, v = "x", from = -100, to = 100, steps = 4000): number[] {
  return numericSolve(expr, v, from, to, steps).roots;
}

export function numericSolve(
  expr: string, v = "x", from = -100, to = 100, steps = 4000,
): { roots: number[]; identity: boolean } {
  const f = math.compile(normalizeInput(expr));
  const at = (x: number) => Number(f.evaluate({ [v]: x }));
  const roots: number[] = [];
  const h = (to - from) / steps;
  let prevX = from;
  let prevY = safe(at, prevX);
  let zeros = 0, defined = 0;
  if (prevY !== null) { defined++; if (Math.abs(prevY) < 1e-12) zeros++; }

  for (let i = 1; i <= steps; i++) {
    const x = from + i * h;
    const y = safe(at, x);
    if (y !== null) { defined++; if (Math.abs(y) < 1e-12) zeros++; }
    if (prevY !== null && y !== null) {
      if (Math.abs(y) < 1e-12) {
        pushUnique(roots, x);
      } else if (prevY * y < 0 && Math.abs(prevY) >= 1e-12) {
        const r = bisect(at, prevX, x);
        const fr = safe(at, r);
        const scale = 1 + Math.max(Math.abs(prevY), Math.abs(y));
        if (fr !== null && Math.abs(fr) < 1e-6 * scale) pushUnique(roots, r);
      }
    }
    prevX = x;
    prevY = y;
  }
  // Nulle presque partout : c'est une identite, pas 4000 racines.
  const identity = defined > 10 && zeros > defined / 2;
  return { roots: identity ? [] : roots, identity };
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
  if (equations.length === 0) return { ok: false, message: "Aucune équation" };

  let vars: string[];
  try {
    vars = unknowns?.length ? unknowns : detectSymbols(equations);
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }
  if (vars.length === 0) return { ok: false, message: "Aucune inconnue détectée" };
  if (equations.length !== vars.length) {
    return {
      ok: false,
      message: `${equations.length} équation(s) pour ${vars.length} inconnue(s) : système non carré`,
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
        if (!Number.isFinite(coeff)) throw new Error("Système non linéaire");
        row.push(coeff);
      }
      const constant = Number(zero.evaluate(zeroScope(vars)));
      A.push(row);
      B.push(-constant);
    }
    // lusolve ne signale pas toujours un systeme singulier : il faut le
    // detecter avant, sinon une solution arbitraire est renvoyee comme valide.
    if (rank(A) < vars.length) {
      return { ok: false, message: "Système singulier : aucune solution unique" };
    }
    const sol = math.lusolve(A, B) as unknown as number[][];
    const solution: Record<string, string> = {};
    vars.forEach((v, i) => { solution[v] = fmt(Number(sol[i][0])); });
    return { ok: true, variables: vars, solution };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/singular/i.test(msg)) {
      return { ok: false, message: "Système singulier : aucune solution unique" };
    }
    return { ok: false, message: humanError(e) };
  }
}

function zeroScope(vars: string[]): Record<string, number> {
  return Object.fromEntries(vars.map((v) => [v, 0]));
}

function detectSymbols(equations: string[]): string[] {
  const found = new Set<string>();
  for (const eq of equations) for (const name of freeSymbols(toZeroForm(eq))) found.add(name);
  return [...found].sort();
}
