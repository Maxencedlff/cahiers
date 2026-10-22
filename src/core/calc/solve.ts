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
  method?: "exacte" | "numerique" | "litterale";
  /** Detail de la resolution, une ligne LaTeX par etape (« Afficher le détail »). */
  steps?: string[];
  /** Identification (plusieurs inconnues trouvees ensemble) : « α = 1 », … */
  values?: { name: string; text: string; latex: string }[];
}

/** Nombre maximal de racines affichees par la resolution numerique. */
export const MAX_ROOTS = 10;

/** "2x^2 - 3x = 1" devient l'expression "2x^2 - 3x - 1". */
export function toZeroForm(equation: string): string {
  const src = implicitProducts(normalizeInput(equation));
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

/**
 * Resolution d'une equation, avec son detail. `variable` : l'inconnue
 * choisie ; sans elle, le seul symbole libre. Plusieurs lettres et une
 * inconnue choisie : resolution litterale (« U = R I » pour I -> U/R).
 */
export function solveEquation(equation: string, variable?: string): SolveOutcome {
  // « F(p) = α/p + β/(p-1) » : identification, toutes les constantes d'un coup.
  if (!variable) {
    try {
      const id = identify(equation);
      if (id) return id;
    } catch { /* pas une identite */ }
  }
  const r = solveCore(equation, variable);
  if (!r.ok || r.steps || !r.variable) return r;
  try { return { ...r, steps: stepsOf(equation, r) }; } catch { return r; }
}

function solveCore(equation: string, variable?: string): SolveOutcome {
  let zero: string;
  let v: string;
  let def: string | undefined;
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
    } else if ((def = definedSymbol(equation, zero, symbols)) !== undefined) {
      // « Feq = (K/(p(p+3)))/(1+K/(p(p+3))) » : une definition a mettre en
      // forme, resolue pour la lettre seule du premier membre.
      v = def;
    } else if (!/(?<![=<>!])=(?!=)/.test(normalizeInput(equation))) {
      return { ok: false, message: "Pas de signe = : copie toute l'égalité (par exemple F(p) = α/p + …), pas seulement un membre." };
    } else {
      return {
        ok: false,
        message: `Plusieurs lettres (${symbols.join(", ")}) : indique l'inconnue à isoler, donne une valeur aux autres, ou utilise un système.`,
      };
    }
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }

  let coeffs: number[] | null = null;
  try {
    coeffs = polynomialCoefficients(zero, v);
  } catch { coeffs = null; }
  // D'autres lettres que l'inconnue : resolution litterale.
  if (!coeffs && freeSymbols(zero).some((x) => x !== v)) return symbolicSolve(equation, zero, v);

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
  let p = -b / g0, d = (2 * a) / g0;
  const r = k / g0;
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
/** `scope` : fonctions ajoutees (trigonometrie en degres, voir angleScope). */
export function numericRoots(
  expr: string, v = "x", from = -100, to = 100, steps = 4000, scope: Record<string, unknown> = {},
): number[] {
  return numericSolve(expr, v, from, to, steps, scope).roots;
}

export function numericSolve(
  expr: string, v = "x", from = -100, to = 100, steps = 4000, scope: Record<string, unknown> = {},
): { roots: number[]; identity: boolean } {
  const f = math.compile(normalizeInput(expr));
  const at = (x: number) => Number(f.evaluate({ ...scope, [v]: x }));
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

/* ------------------------------------------------------------------ */
/* Detail de la resolution et resolution litterale                     */
/* ------------------------------------------------------------------ */

/** Formule dans une ligne du detail (format du texte de la page : $...$). */
const $ = (tex: string): string => `$${tex.replace(/\$/g, "\\$")}$`;

function texOf(n: MathNode | string): string {
  const node = typeof n === "string" ? math.parse(n) : n;
  // mathjs ecrit m, C, V... en unites (\mathrm) : ce sont des grandeurs.
  return node.toTex({ parenthesis: "auto", implicit: "hide" }).replace(/\\mathrm\{([A-Za-z])\}/g, "$1").replace(/~/g, "\\,")
    // « p(p+2) » : pas de point de produit contre une parenthese.
    .replace(/\\cdot\s*(?=\\left\()/g, "").replace(/(\\right\))\s*\\cdot/g, "$1")
    // « μ p » : un petit espace entre deux lettres, pas de point.
    .replace(/\\cdot(?=\s*(?:[A-Za-z]|\\[a-z]+\b(?!\{)))/g, "\\,");
}

/** Membres de l'equation en LaTeX : « 2x + 3 = 13 ». */
function equationLatex(equation: string): string {
  const parts = normalizeInput(equation).split(/(?<![=<>!])=(?!=)/);
  return parts.map((p) => texOf(p)).join(" = ");
}

/** Polynome (coefficients du constant au dominant) en LaTeX. */
function polyLatex(coeffs: number[], v: string): string {
  const vt = texOf(v);
  let out = "";
  for (let k = coeffs.length - 1; k >= 0; k--) {
    const c = coeffs[k];
    if (Math.abs(c) < 1e-12) continue;
    const mono = k === 0 ? "" : k === 1 ? vt : `${vt}^{${k}}`;
    const abs = Math.abs(c);
    const num = mono && Math.abs(abs - 1) < 1e-12 ? "" : fmt(abs);
    const sign = c < 0 ? (out ? " - " : "-") : out ? " + " : "";
    out += `${sign}${num}${num && mono ? "\\," : ""}${mono}`;
  }
  return out || "0";
}

const par = (x: number) => (x < 0 ? `\\left(${fmt(x)}\\right)` : fmt(x));

/**
 * Detail redige comme au tableau, une ligne par etape, au format du texte
 * de la page (phrases + $formules$) : il se pose tel quel dans le cahier.
 */
function stepsOf(equation: string, r: SolveOutcome): string[] {
  const v = greekTex(texOf(r.variable!));
  const steps = [`On part de l'équation : ${$(greekTex(equationLatex(equation)))}`];
  const c = r.coefficients;
  const rootTex = (x: Root) => x.latex ?? x.text.replace(/i$/, "\\,i");
  if (c && r.degree === 1) {
    const [c0, c1] = c;
    steps.push(`On regroupe tout dans le membre de gauche : ${$(`${polyLatex(c, r.variable!)} = 0`)}`);
    if (Math.abs(c0) > 1e-12) steps.push(`On isole le terme en ${$(v)} : ${$(`${polyLatex([0, c1], r.variable!)} = ${fmt(-c0)}`)}`);
    const x = r.roots?.[0];
    if (x) {
      steps.push(Math.abs(c1 - 1) > 1e-12
        ? `On divise par ${$(fmt(c1))} : ${$(`${v} = \\frac{${fmt(-c0)}}{${fmt(c1)}} = ${rootTex(x)}`)}`
        : `D'où ${$(`${v} = ${rootTex(x)}`)}`);
      steps.push(`**Conclusion :** ${$(`S = \\left\\{ ${rootTex(x)} \\right\\}`)}`);
    }
    return steps;
  }
  if (c && r.degree === 2) {
    const [c0, b, a] = c;
    const d = b * b - 4 * a * c0;
    steps.push(`On regroupe tout dans le membre de gauche : ${$(`${polyLatex(c, r.variable!)} = 0`)}`);
    steps.push(`C'est une équation du second degré ${$(`a${v}^{2} + b${v} + c = 0`)} avec ${$(`a = ${fmt(a)},\\; b = ${fmt(b)},\\; c = ${fmt(c0)}`)}.`);
    steps.push(`On calcule le discriminant : ${$(`\\Delta = b^{2} - 4ac = ${par(b)}^{2} - 4 \\times ${par(a)} \\times ${par(c0)} = ${fmt(d)}`)}`);
    const roots = r.roots ?? [];
    if (d > 1e-12 && roots.length === 2) {
      steps.push(`${$("\\Delta > 0")} : deux racines réelles distinctes.`);
      steps.push($(`${v}_{1} = \\frac{-b - \\sqrt{\\Delta}}{2a} = \\frac{${fmt(-b)} - \\sqrt{${fmt(d)}}}{${fmt(2 * a)}} = ${rootTex(roots[0])}`));
      steps.push($(`${v}_{2} = \\frac{-b + \\sqrt{\\Delta}}{2a} = \\frac{${fmt(-b)} + \\sqrt{${fmt(d)}}}{${fmt(2 * a)}} = ${rootTex(roots[1])}`));
    } else if (Math.abs(d) <= 1e-12 && roots.length) {
      steps.push(`${$("\\Delta = 0")} : une racine double.`);
      steps.push($(`${v}_{0} = \\frac{-b}{2a} = \\frac{${fmt(-b)}}{${fmt(2 * a)}} = ${rootTex(roots[0])}`));
    } else if (roots.length === 2) {
      steps.push(`${$("\\Delta < 0")} : deux racines complexes conjuguées (${$(`\\sqrt{\\Delta} = i\\sqrt{${fmt(-d)}}`)}).`);
      steps.push($(`${v}_{1,2} = \\frac{-b \\pm i\\sqrt{-\\Delta}}{2a} = \\frac{${fmt(-b)} \\pm i\\sqrt{${fmt(-d)}}}{${fmt(2 * a)}}`));
      steps.push($(`${v}_{1} = ${rootTex(roots[0])},\\quad ${v}_{2} = ${rootTex(roots[1])}`));
    }
    steps.push(`**Conclusion :** ${$(`S = \\left\\{ ${roots.map(rootTex).join(" ;\\, ")} \\right\\}`)}`);
    return steps;
  }
  if (c && r.degree && r.degree > 2) {
    steps.push(`On regroupe tout dans le membre de gauche : ${$(`${polyLatex(c, r.variable!)} = 0`)}`);
    steps.push(`Polynôme de degré ${r.degree} : racines calculées numériquement (méthode de Durand-Kerner).`);
    const roots = r.roots ?? [];
    if (roots.length) steps.push(`**Conclusion :** ${$(`S = \\left\\{ ${roots.map(rootTex).join(" ;\\, ")} \\right\\}`)}`);
    return steps;
  }
  if (r.method === "numerique") {
    steps.push(`On regroupe tout dans le membre de gauche : ${$(`${greekTex(texOf(math.simplify(toZeroForm(equation))))} = 0`)}`);
    steps.push(`Pas de forme polynomiale : on cherche les racines numériquement sur ${$("[-100 ;\\, 100]")} (balayage puis dichotomie).`);
  }
  return steps;
}

function depends(n: MathNode, v: string): boolean {
  let found = false;
  n.traverse((x: any) => { if (x.type === "SymbolNode" && x.name === v) found = true; });
  return found;
}

/**
 * Fraction de fractions en plusieurs lettres mise sous la forme qu'on ecrit
 * (« K/(p(p+3))/(1+K/(p(p+3))) » -> « K/(p^2+3p+K) ») : produit de facteurs
 * en haut et en bas, denominateur commun des sommes, facteurs identiques
 * simplifies, puis numerateur et denominateur developpes (`rationalize`
 * seul ne simplifie pas les facteurs communs). Garde seulement si
 * l'ecriture est plus courte et vaut la meme chose en plusieurs points ;
 * sinon le noeud tel quel.
 */
export function tidyRational(node: MathNode): MathNode {
  try {
    const src = node.toString();
    let nested = false;
    node.traverse((n: any, _p: string, parent: any) => {
      if (n.type === "OperatorNode" && n.fn === "divide" && parent
          && !(parent.type === "OperatorNode" && parent.fn === "unaryMinus")) nested = true;
    });
    if (!nested) return node;
    const f = toFrac(node);
    const keys = new Map<string, number>();
    for (const x of f.num) keys.set(keyOf(x), (keys.get(keyOf(x)) ?? 0) + 1);
    const den: MathNode[] = [];
    for (const x of f.den) {
      const k = keyOf(x), c = keys.get(k) ?? 0;
      if (c > 0) keys.set(k, c - 1); else den.push(x);
    }
    const num: MathNode[] = [];
    for (const x of f.num) {
      const k = keyOf(x), c = keys.get(k) ?? 0;
      if (c > 0) { keys.set(k, c - 1); num.push(x); }
    }
    const expand = (xs: MathNode[]): string => {
      const prod = xs.length ? xs.map((x) => `(${x.toString()})`).join(" * ") : "1";
      let r: any;
      try { r = (math as any).rationalize(prod); } catch { r = math.simplify(prod); }
      while (r.type === "ParenthesisNode") r = r.content;
      return byDegree(r);
    };
    const N = expand(num), D = expand(den);
    const out: MathNode = D === "1" ? math.parse(N) : new math.OperatorNode("/", "divide", [math.parse(N), math.parse(D)]);
    if (out.toString({ implicit: "hide" }).length >= node.toString({ implicit: "hide" }).length) return node;
    // Meme valeur en quelques points (jamais une forme fausse).
    const syms = freeSymbols(src);
    const a = math.parse(src).compile(), b = out.compile();
    for (let t = 0; t < 4; t++) {
      const scope: Record<string, number> = {};
      syms.forEach((x, i) => { scope[x] = SAMPLES[(t * 3 + i) % SAMPLES.length] + 0.1 * i; });
      const va = Number(a.evaluate(scope)), vb = Number(b.evaluate(scope));
      if (!Number.isFinite(va) || !Number.isFinite(vb) || Math.abs(va - vb) > 1e-9 * (1 + Math.abs(va))) return node;
    }
    return out;
  } catch {
    return node;
  }
}

/**
 * Somme ecrite par degre decroissant de sa lettre principale (celle qui
 * monte le plus haut) : « p^2 + 3p + K », pas « K + p^2 + 3p ».
 */
function byDegree(n: any): string {
  const terms: { node: any; neg: boolean }[] = [];
  const flat = (x: any, neg: boolean) => {
    while (x.type === "ParenthesisNode") x = x.content;
    if (x.type === "OperatorNode" && x.fn === "add" && x.args.length === 2) { flat(x.args[0], neg); flat(x.args[1], neg); }
    else if (x.type === "OperatorNode" && x.fn === "subtract" && x.args.length === 2) { flat(x.args[0], neg); flat(x.args[1], !neg); }
    else if (x.type === "OperatorNode" && x.fn === "unaryMinus") flat(x.args[0], !neg);
    else terms.push({ node: x, neg });
  };
  flat(n, false);
  if (terms.length < 2) return n.toString();
  const degreeIn = (t: any, v: string) => {
    let d = 0;
    t.traverse((x: any, _p: string, parent: any) => {
      if (x.type !== "SymbolNode" || x.name !== v) return;
      d += parent?.type === "OperatorNode" && parent.fn === "pow" && parent.args[0] === x && parent.args[1].type === "ConstantNode"
        ? Number(parent.args[1].value) : 1;
    });
    return d;
  };
  const letters = freeSymbols(n.toString());
  let main = letters[0], best = -1;
  for (const v of letters) {
    const d = Math.max(...terms.map((t) => degreeIn(t.node, v)));
    if (d > best) { best = d; main = v; }
  }
  if (!main) return n.toString();
  const sorted = terms.map((t, i) => ({ ...t, i, d: degreeIn(t.node, main) })).sort((a, b) => b.d - a.d || a.i - b.i);
  return sorted.map((t, k) => `${k === 0 ? (t.neg ? "-" : "") : t.neg ? " - " : " + "}${t.node.toString()}`).join("");
}

/** Fraction en facteurs : produit `num` sur produit `den` (listes vides = 1). */
interface Frac { num: MathNode[]; den: MathNode[] }

function keyOf(n: MathNode): string {
  let x: any = n;
  while (x.type === "ParenthesisNode") x = x.content;
  return x.toString({ implicit: "show" }).replace(/\s+/g, "");
}

function product(xs: MathNode[]): MathNode {
  if (!xs.length) return new math.ConstantNode(1);
  return xs.slice(1).reduce((acc: MathNode, x) => new math.OperatorNode("*", "multiply", [acc, new math.ParenthesisNode(x)]), new math.ParenthesisNode(xs[0]) as MathNode);
}

function toFrac(n: any): Frac {
  if (n.type === "ParenthesisNode") return toFrac(n.content);
  if (n.type === "OperatorNode") {
    if (n.fn === "multiply") {
      const parts = n.args.map(toFrac);
      return { num: parts.flatMap((p: Frac) => p.num), den: parts.flatMap((p: Frac) => p.den) };
    }
    if (n.fn === "divide") {
      const a = toFrac(n.args[0]), b = toFrac(n.args[1]);
      return { num: [...a.num, ...b.den], den: [...a.den, ...b.num] };
    }
    if (n.fn === "unaryMinus") {
      const a = toFrac(n.args[0]);
      return { num: [new math.ConstantNode(-1), ...a.num], den: a.den };
    }
    if ((n.fn === "add" || n.fn === "subtract") && n.args.length === 2) {
      const a = toFrac(n.args[0]), b = toFrac(n.args[1]);
      if (!a.den.length && !b.den.length) return { num: [n], den: [] };
      // Denominateur commun : les facteurs de chacun, sans doublon.
      const common = [...a.den];
      const left = new Map<string, number>();
      for (const x of a.den) left.set(keyOf(x), (left.get(keyOf(x)) ?? 0) + 1);
      const bMissing: MathNode[] = []; // facteurs de b.den absents de a.den
      for (const x of b.den) {
        const k = keyOf(x), c = left.get(k) ?? 0;
        if (c > 0) left.set(k, c - 1); else { common.push(x); bMissing.push(x); }
      }
      // a multiplie par ce qui manque a son denominateur, b de meme.
      const bLeft = new Map<string, number>();
      for (const x of b.den) bLeft.set(keyOf(x), (bLeft.get(keyOf(x)) ?? 0) + 1);
      const aMissing: MathNode[] = [];
      for (const x of a.den) {
        const k = keyOf(x), c = bLeft.get(k) ?? 0;
        if (c > 0) bLeft.set(k, c - 1); else aMissing.push(x);
      }
      const ta = product([...a.num, ...bMissing]), tb = product([...b.num, ...aMissing]);
      return { num: [new math.OperatorNode(n.op, n.fn, [ta, tb])], den: common };
    }
    if (n.fn === "pow" && n.args[1].type === "ConstantNode" && Number.isInteger(n.args[1].value) && Math.abs(n.args[1].value) <= 6) {
      const a = toFrac(n.args[0]), k = n.args[1].value as number;
      const rep = (xs: MathNode[]) => Array.from({ length: Math.abs(k) }, () => xs).flat();
      return k >= 0 ? { num: rep(a.num), den: rep(a.den) } : { num: rep(a.den), den: rep(a.num) };
    }
  }
  if (n.type === "ConstantNode" && n.value === 1) return { num: [], den: [] };
  return { num: [n], den: [] };
}

/**
 * Lettre seule a gauche, absente a droite, et un second membre qui se met
 * en forme (sinon « U = R I » garde son message : quelle inconnue ?).
 */
function definedSymbol(equation: string, zero: string, symbols: string[]): string | undefined {
  try {
    const parts = implicitProducts(normalizeInput(equation)).split(/(?<![=<>!])=(?!=)/);
    if (parts.length !== 2) return undefined;
    const name = parts[0].trim();
    if (!/^[\p{L}_][\p{L}\d_]*$/u.test(name) || !symbols.includes(name)) return undefined;
    const rhs = math.parse(parts[1]);
    if (depends(rhs, name) || !freeSymbols(zero).some((x) => x !== name)) return undefined;
    const tidy = tidyRational(math.simplify(rhs));
    return tidy.toString() !== rhs.toString() ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Exposants essayes pour isoler l'inconnue : a v^n + b = 0. */
const POWERS = [1, 2, 3, 4, -1, -2, 0.5, -0.5];

/**
 * Inconnue isolee parmi d'autres lettres : l'equation s'ecrit a v^n + b = 0
 * avec a et b sans v (n dans POWERS) : v^n = -b/a, puis la racine.
 * « U = R I » pour I -> U/R ; « 1/2 m v^2 = E » pour v -> ±√(2E/m) ;
 * « ω = 1/√(LC) » pour C -> 1/(L ω²).
 */
function symbolicSolve(equation: string, zero: string, v: string): SolveOutcome {
  const vt = texOf(v);
  const fail = (message: string): SolveOutcome => ({ ok: false, variable: v, message });
  let f: MathNode;
  try { f = math.simplify(zero); } catch (e) { return fail(humanError(e)); }
  if (!depends(f, v)) return fail(`${v} n'apparaît pas dans l'équation`);
  const df = math.simplify(math.derivative(f, v));
  for (const n of POWERS) {
    let a: MathNode, b: MathNode;
    try {
      a = math.simplify(`(${df.toString()}) / (${n} * ${v}^(${n - 1}))`);
      if (depends(a, v)) continue;
      b = math.simplify(`${f.toString()} - (${a.toString()}) * ${v}^(${n})`);
      if (depends(b, v)) continue;
    } catch { continue; }
    // a v^n = -b, signe tourne pour que a ne commence pas par « - ».
    let lhsA = a, rhs = math.simplify(`-(${b.toString()})`);
    if (lhsA.toString().startsWith("-")) { lhsA = math.simplify(`-(${a.toString()})`); rhs = math.simplify(b.toString()); }
    const steps = [`On part de l'équation : ${$(greekTex(equationLatex(equation)))}`, `On isole ${$(vt)} : on passe tout d'un côté, ${$(`${greekTex(texOf(f))} = 0`)}`];
    const vn = n === 1 ? vt : n === 0.5 ? `\\sqrt{${vt}}` : `${vt}^{${n === -0.5 ? "-\\frac{1}{2}" : n}}`;
    const aOne = lhsA.toString() === "1";
    if (!aOne) steps.push(`On garde le terme en ${$(vt)} à gauche : ${$(`${texOf(lhsA)} \\cdot ${vn} = ${texOf(rhs)}`)}`);
    const inside = math.simplify(`(${rhs.toString()}) / (${lhsA.toString()})`);
    if (n !== 1) steps.push(`On divise par ${$(texOf(lhsA))} : ${$(`${vn} = ${texOf(inside)}`)}`);
    let sol: MathNode, latex: string, text: string;
    const tidy = n === 1 ? tidyRational(inside) : inside;
    if (n === 2) {
      sol = math.parse(`sqrt(${inside.toString()})`);
      latex = `\\pm\\sqrt{${texOf(inside)}}`;
      text = `±${sol.toString({ implicit: "hide" })}`;
    } else {
      sol = n === 1 ? tidy : math.simplify(`(${inside.toString()})^(${1 / n})`);
      latex = texOf(sol);
      text = sol.toString({ implicit: "hide" });
      if (n === 4) { latex = `\\pm ${latex}`; text = `±${text}`; }
    }
    steps.push(n === 1 ? (aOne ? `D'où ${$(`${vt} = ${latex}`)}` : `On divise par ${$(texOf(lhsA))} : ${$(`${vt} = ${latex}`)}`) : `On prend la racine : ${$(`${vt} = ${latex}`)}`);
    steps.push(`**Conclusion :** ${$(`${vt} = ${latex}`)}`);
    return { ok: true, variable: v, degree: Math.abs(n) >= 1 ? Math.abs(n) : 1, method: "litterale", roots: [{ text, value: NaN, latex }], steps };
  }
  return fail(`Pas de résolution littérale simple pour ${v} (donne des valeurs aux autres lettres)`);
}

/* ------------------------------------------------------------------ */
/* Identification (elements simples, coefficients)                     */
/* ------------------------------------------------------------------ */

/**
 * « p(p-1) » : p n'est pas une fonction connue, c'est un produit (texte
 * copie de la page). « f(t) » (une seule lettre en argument) reste une fonction.
 */
export function implicitProducts(src: string): string {
  return src.split(/((?<![=<>!])=(?!=))/).map((part) => {
    if (part === "=" || !part.trim()) return part;
    try {
      // Produits tous explicites : « p * (p + 2) * (p ^ 2 + 1) » se relit
      // pareil (« p (p+2) » serait un appel de fonction) et sans parentheses
      // en trop autour de « p * (p + 2) ».
      const fix = (n: any): any => {
        if (n.type === "FunctionNode" && n.fn?.type === "SymbolNode" && typeof (math as any)[n.fn.name] !== "function"
            && n.args.length === 1 && n.args[0].type !== "SymbolNode") {
          return new math.OperatorNode("*", "multiply", [new math.SymbolNode(n.fn.name), new math.ParenthesisNode(fix(n.args[0]))]);
        }
        if (n.type === "OperatorNode" && n.fn === "multiply" && n.implicit) {
          return new math.OperatorNode("*", "multiply", n.args.map(fix));
        }
        return n.map((c: any) => fix(c));
      };
      return fix(math.parse(part)).toString();
    } catch {
      return part;
    }
  }).join("");
}

const GREEK_TEX: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon", η: "\\eta", θ: "\\theta",
  κ: "\\kappa", λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", ρ: "\\rho", σ: "\\sigma", τ: "\\tau",
  φ: "\\varphi", χ: "\\chi", ψ: "\\psi", ω: "\\omega", ζ: "\\zeta",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Σ: "\\Sigma", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
};
function greekTex(t: string): string {
  return t.replace(/[α-ωΑ-Ω]/g, (c) => (GREEK_TEX[c] ? `${GREEK_TEX[c]} ` : c));
}

/** Rationnel p/q (q <= 10000) proche de x, en LaTeX, sinon le decimal. */
function niceNumber(x: number): { text: string; latex: string } {
  if (Math.abs(x - Math.round(x)) < 1e-9) { const r = fmt(Math.round(x)); return { text: r, latex: r }; }
  for (let q = 2; q <= 10000; q++) {
    const p = Math.round(x * q);
    if (Math.abs(x - p / q) < 1e-9 * Math.max(1, Math.abs(x))) {
      return { text: `${p}/${q}`, latex: fractionLatex(p, q) ?? `${p}/${q}` };
    }
  }
  return { text: fmt(x), latex: fmt(x) };
}

/** Gauss avec pivot partiel ; null si singulier. */
function gauss(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

const SAMPLES = [0.317, 1.731, -2.373, 2.917, -0.829, 4.173, -3.611, 0.571, 5.303, -1.471, 2.213, 3.709, -4.43, 6.07];

/**
 * Egalite vraie pour tout `x` (une lettre), lineaire en d'autres lettres
 * (les inconnues) : premier et dernier membre identifies sur des valeurs de
 * x, systeme lineaire, verification sur d'autres valeurs. null si ce n'en
 * est pas une. Detail : methode des poles pour un terme k/(x-a).
 */
function identify(equation: string): SolveOutcome | null {
  const parts = implicitProducts(normalizeInput(equation)).split(/(?<![=<>!])=(?!=)/);
  if (parts.length < 2) return null;
  const L = parts[0], R = parts[parts.length - 1];
  if (!L.trim() || !R.trim()) return null;
  const f = math.parse(`(${L}) - (${R})`);
  const syms = freeSymbols(f.toString());
  if (syms.length < 2) return null;
  const lSyms = freeSymbols(L);
  // La variable : la seule lettre du premier membre si possible.
  const candidates = lSyms.length === 1 ? lSyms : syms;
  for (const x of candidates) {
    const K = syms.filter((k) => k !== x);
    const dk = K.map((k) => math.simplify(math.derivative(f, k)));
    if (dk.some((d) => K.some((k) => depends(d, k)))) continue;
    const zero = Object.fromEntries(K.map((k) => [k, 0]));
    const f0 = f.compile(), dks = dk.map((d) => d.compile());
    const rows: number[][] = [], rhs: number[] = [], extra: number[] = [];
    for (const t of SAMPLES) {
      try {
        const scope = { ...zero, [x]: t };
        const r = dks.map((d) => Number(d.evaluate(scope)));
        const c = Number(f0.evaluate(scope));
        if (![...r, c].every(Number.isFinite)) continue;
        if (rows.length < K.length) { rows.push(r); rhs.push(-c); } else extra.push(t);
      } catch { /* pole */ }
    }
    if (rows.length < K.length || extra.length < 2) continue;
    const sol = gauss(rows, rhs);
    if (!sol) continue;
    const scopeK = Object.fromEntries(K.map((k, i) => [k, sol[i]]));
    const ok = extra.every((t) => {
      const v = Number(f0.evaluate({ ...scopeK, [x]: t }));
      const ref = Math.abs(Number(math.parse(L).compile().evaluate({ ...scopeK, [x]: t }))) + 1;
      return Math.abs(v) < 1e-7 * ref;
    });
    if (!ok) continue;
    const xt = greekTex(texOf(x));
    const values = K.map((k, i) => ({ name: k, ...niceNumber(sol[i]) }));
    const Ktex = K.map((k) => greekTex(texOf(k)));
    const Lt = greekTex(texOf(L)), Rt = greekTex(texOf(R));
    const steps = [`On cherche ${$(Ktex.join(",\\, "))} tels que, pour tout ${$(xt)} :`, $(`${Lt} = ${Rt}`)];
    // Denominateur du premier membre, factorise : les poles se lisent.
    const fac = factorFraction(L, x);
    if (fac && fac.changed) steps.push(`On factorise le dénominateur : ${$(`${greekTex(texOf(fac.den))} = ${fac.factoredTex}`)}`);
    const viaPole = new Set<number>();
    K.forEach((k, i) => {
      if (!fac) return;
      try {
        // Terme k/(x - a) : on multiplie par (x - a), les autres termes
        // s'annulent en x = a, reste k.
        const term = sumTerms(math.parse(R)).find((t) => depends(t.node, k));
        if (!term) return;
        const c1 = term.node.transform((n: any) => (n.type === "SymbolNode" && K.includes(n.name)
          ? new math.ConstantNode(n.name === k ? term.sign : 0) : n));
        const D = math.simplify(`1 / (${c1.toString()})`);
        const c = polynomialCoefficients(D.toString(), x, 1);
        if (c.length !== 2 || Math.abs(c[1]) < 1e-12) return;
        const a = -c[0] / c[1];
        const pole = fac.factors.findIndex((f) => f.root !== undefined && Math.abs(f.root - a) < 1e-9 && f.mult === 1);
        if (pole < 0) return;
        const an = niceNumber(a);
        const dt = fac.factors[pole].tex;
        const others = fac.factors.filter((_, j) => j !== pole);
        const scale = c[1];
        const denOthers = `${fac.lc * scale !== 1 ? fmt(fac.lc * scale) : ""}${others.map((f) => f.tex + (f.mult > 1 ? `^{${f.mult}}` : "")).join("")}` || "1";
        const numAt = Number(fac.num.compile().evaluate({ [x]: a }));
        const valsAt = others.map((f) => `\\left(${fmt(f.at(a))}\\right)${f.mult > 1 ? `^{${f.mult}}` : ""}`).join("");
        const lcs = fac.lc * scale !== 1 ? `${fmt(fac.lc * scale)} \\times ` : "";
        steps.push(`**Calcul de ${$(Ktex[i])}** (pôle simple ${$(`${xt} = ${an.latex}`)}) : on multiplie les deux membres par ${$(scale === 1 ? dt : `${fmt(scale)}${dt}`)}, puis on prend ${$(`${xt} = ${an.latex}`)}, les autres termes s'annulent :`);
        steps.push($(`${Ktex[i]} = \\left[ \\frac{${greekTex(texOf(fac.num))}}{${denOthers}} \\right]_{${xt} = ${an.latex}} = \\frac{${fmt(numAt)}}{${lcs}${valsAt || "1"}} = ${values[i].latex}`));
        viaPole.add(i);
      } catch { /* identification */ }
    });
    const rest = K.map((_, i) => i).filter((i) => !viaPole.has(i));
    if (rest.length) {
      try { steps.push(...coefficientSteps(L, R, x, K, values, viaPole)); } catch {
        for (const i of rest) steps.push(`${$(`${Ktex[i]} = ${values[i].latex}`)} (identification des coefficients)`);
      }
    }
    steps.push("**Conclusion :**");
    steps.push($(`${Lt} = ${decompositionTex(R, K, values.map((v) => Number(eval1(v.text))), x)}`));
    return { ok: true, variable: x, method: "exacte", roots: [], values: values.map((v) => ({ ...v, latex: v.latex })), steps };
  }
  return null;
}

/** Termes d'une somme avec leur signe (« a/p - b/(p-1) »). */
function sumTerms(n: MathNode, sign = 1, out: { sign: number; node: MathNode }[] = []): { sign: number; node: MathNode }[] {
  const x = n as any;
  if (x.type === "ParenthesisNode") return sumTerms(x.content, sign, out);
  if (x.type === "OperatorNode" && (x.op === "+" || x.op === "-") && x.args.length === 2) {
    sumTerms(x.args[0], sign, out);
    return sumTerms(x.args[1], x.op === "-" ? -sign : sign, out);
  }
  if (x.type === "OperatorNode" && x.op === "-" && x.args.length === 1) return sumTerms(x.args[0], -sign, out);
  out.push({ sign, node: n });
  return out;
}

/**
 * Detail par identification des coefficients : meme denominateur (celui
 * du premier membre), le numerateur ecrit comme somme des inconnues fois
 * des polynomes, puis une equation par puissance de x. Les polynomes sont
 * obtenus par valeurs (interpolation), robuste quelle que soit l'ecriture.
 */
function coefficientSteps(L: string, R: string, x: string, K: string[], values: { text: string; latex: string }[], known: Set<number>): string[] {
  const ln = strip0(math.parse(L));
  const isFrac = ln.type === "OperatorNode" && ln.op === "/";
  const num = isFrac ? ln.args[0] : ln, den = isFrac ? ln.args[1] : new math.ConstantNode(1);
  const deg = Math.max(polynomialCoefficients(den.toString(), x, 12).length - 1, 0);
  const numC = polynomialCoefficients(num.toString(), x, 12);
  const denF = den.compile(), rF = math.parse(R).compile();
  const zero = Object.fromEntries(K.map((k) => [k, 0]));
  // Degre des polynomes des inconnues : au plus celui du denominateur, ou du premier membre (identite polynomiale).
  const top = Math.max(deg, numC.length - 1, 4);
  const xs = Array.from({ length: top + 1 }, (_, i) => 0.37 + 1.13 * i);
  const fit = (f: (t: number) => number) => {
    const V = xs.map((t) => Array.from({ length: top + 1 }, (_, j) => t ** j));
    const c = gauss(V, xs.map(f));
    if (!c) throw new Error("interpolation");
    const r = c.map((v) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v));
    while (r.length > 1 && Math.abs(r[r.length - 1]) < 1e-9) r.pop();
    return r;
  };
  const polys = K.map((k) => fit((t) => Number(denF.evaluate({ [x]: t }))
    * (Number(rF.evaluate({ ...zero, [k]: 1, [x]: t })) - Number(rF.evaluate({ ...zero, [x]: t })))));
  const free = fit((t) => Number(denF.evaluate({ [x]: t })) * Number(rF.evaluate({ ...zero, [x]: t })));
  const xt = greekTex(texOf(x));
  const names = K.map((k) => greekTex(texOf(k)));
  const polyTex = (c: number[]) => {
    const t = polyLatex(c, x);
    return /[+-]/.test(t.replace(/^-/, "")) ? `\\left(${t}\\right)` : t === "1" ? "" : t;
  };
  const restNames = K.map((_, i) => i).filter((i) => !known.has(i)).map((i) => names[i]);
  const steps: string[] = [];
  steps.push(isFrac
    ? `**Calcul de ${$(restNames.join(",\\, "))}** : on réduit au même dénominateur ${$(greekTex(texOf(den)))} et on identifie les numérateurs :`
    : `**Calcul de ${$(restNames.join(",\\, "))}** : on développe et on identifie les coefficients des puissances de ${$(xt)} :`);
  const hasFree = free.some((c) => Math.abs(c) > 1e-9);
  steps.push($(`${greekTex(texOf(num))} = ${hasFree ? `${polyLatex(free, x)} + ` : ""}${K.map((_, i) => `${names[i]}${polyTex(polys[i]) ? `\\,${polyTex(polys[i])}` : ""}`).join(" + ")}`));
  steps.push(`On identifie les coefficients de chaque puissance de ${$(xt)} :`);
  const maxJ = Math.max(numC.length, ...polys.map((q) => q.length), free.length) - 1;
  for (let j = maxJ; j >= 0; j--) {
    const lhs = K.map((_, i) => ({ c: polys[i][j] ?? 0, n: names[i] })).filter((t) => Math.abs(t.c) > 1e-9);
    const rhsV = (numC[j] ?? 0) - (free[j] ?? 0);
    if (!lhs.length) continue;
    const sum = lhs.map((t, idx) => {
      const a = Math.abs(t.c), sign = t.c < 0 ? (idx ? " - " : "-") : idx ? " + " : "";
      return `${sign}${Math.abs(a - 1) < 1e-12 ? "" : niceNumber(a).latex}${t.n}`;
    }).join("");
    const pw = j === 0 ? "1" : j === 1 ? xt : `${xt}^{${j}}`;
    steps.push($(`${pw} :\\quad ${sum} = ${niceNumber(rhsV).latex}`));
  }
  const found = K.map((_, i) => i).filter((i) => !known.has(i)).map((i) => `${names[i]} = ${values[i].latex}`).join(",\\; ");
  if (known.size) {
    const given = [...known].map((i) => `${names[i]} = ${values[i].latex}`).join(",\\; ");
    steps.push(`On remplace ${$(given)} (trouvés par les pôles) et on résout : ${$(found)}`);
  } else {
    steps.push(`On résout ce système : ${$(found)}`);
  }
  return steps;
}

/** Denominateur du premier membre factorise sur R (racines reelles, trinomes sans racine). */
function factorFraction(L: string, x: string): {
  num: MathNode; den: MathNode; lc: number; changed: boolean; factoredTex: string;
  factors: { tex: string; mult: number; root?: number; at: (t: number) => number }[];
} | null {
  const ln = strip0(math.parse(L));
  if (ln.type !== "OperatorNode" || ln.op !== "/") return null;
  const num = ln.args[0], den = ln.args[1];
  let dc: number[];
  try { dc = polynomialCoefficients(den.toString(), x, 12); } catch { return null; }
  if (dc.length < 2) return null;
  const roots = polynomialRoots(dc);
  if (!roots) return null;
  const xt = greekTex(texOf(x));
  const lc = dc[dc.length - 1];
  const factors: { tex: string; mult: number; root?: number; at: (t: number) => number }[] = [];
  const seen = new Set<number>();
  roots.forEach((r, i) => {
    const m = r.multiplicity ?? 1;
    if (typeof r.value === "number") {
      const a = r.value, an = niceNumber(Math.abs(a));
      factors.push({ tex: Math.abs(a) < 1e-12 ? xt : `\\left(${xt} ${a < 0 ? "+" : "-"} ${an.latex}\\right)`, mult: m, root: a, at: (t) => t - a });
    } else if (r.value.im > 0 && !seen.has(i)) {
      const { re, im } = r.value;
      const q = [re * re + im * im, -2 * re, 1].map((v) => Math.round(v * 1e9) / 1e9);
      factors.push({ tex: `\\left(${polyLatex(q, x)}\\right)`, mult: m, at: (t) => t * t - 2 * re * t + re * re + im * im });
    }
  });
  // Ordre de la copie : x d'abord, puis les racines par valeur absolue (p(p-1)(p+1)(p-2)), trinomes a la fin.
  const key = (f: { root?: number }) => (f.root === undefined ? [2, 0, 0] : Math.abs(f.root) < 1e-12 ? [0, 0, 0] : [1, Math.abs(f.root), -f.root]);
  factors.sort((p, q) => { const a = key(p), b = key(q); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
  const factoredTex = `${lc !== 1 ? fmt(lc) : ""}${factors.map((f) => f.tex + (f.mult > 1 ? `^{${f.mult}}` : "")).join("")}`;
  const plain = greekTex(texOf(den)).replace(/\\left|\\right|\\cdot|\\,|\s|[{}]/g, "");
  return { num, den, lc, factors, factoredTex, changed: plain !== factoredTex.replace(/\\left|\\right|\\,|\s|[{}]/g, "") };
}

/** Valeur d'un nombre ecrit « -1/3 ». */
function eval1(t: string): number {
  return Number(math.evaluate(t));
}

/**
 * Second membre avec les valeurs trouvees, terme par terme, propre :
 * « \frac{1}{p} - \frac{1}{3(p+1)} », « -\frac{p+3}{4(p^2+p+2)} ».
 */
function decompositionTex(R: string, K: string[], vals: number[], x: string): string {
  const scope = Object.fromEntries(K.map((k, i) => [k, vals[i]]));
  let out = "";
  for (const t of sumTerms(math.parse(R))) {
    const n = strip0(t.node);
    let numC: number[], denTex: string;
    try {
      if (n.type === "OperatorNode" && n.op === "/") {
        const nf = n.args[0].compile();
        const xs = [0.3, 1.7, 2.9, -1.3, 4.1];
        const V = xs.map((s0) => [1, s0, s0 * s0]);
        const c = gauss(V.slice(0, 3), xs.slice(0, 3).map((s0) => t.sign * Number(nf.evaluate({ ...scope, [x]: s0 }))));
        if (!c) throw new Error("num");
        numC = c.map((v) => (Math.abs(v) < 1e-12 ? 0 : v));
        while (numC.length > 1 && Math.abs(numC[numC.length - 1]) < 1e-12) numC.pop();
        denTex = greekTex(texOf(n.args[1]));
      } else throw new Error("pas une fraction");
    } catch {
      const sub = t.node.transform((m: any) => (m.type === "SymbolNode" && m.name in scope ? math.parse(`(${niceNumber(scope[m.name]).text})`) : m));
      out += `${out ? (t.sign < 0 ? " - " : " + ") : t.sign < 0 ? "-" : ""}${greekTex(texOf(sub))}`;
      continue;
    }
    if (numC.every((c) => Math.abs(c) < 1e-12)) continue;
    // Denominateur commun des coefficients : numerateur entier.
    let q = 1;
    for (const c of numC) { const nn = niceNumber(c); const m = /\/(\d+)$/.exec(nn.text); if (m) q = lcm(q, Number(m[1])); }
    let ints = numC.map((c) => Math.round(c * q));
    const neg = ints[ints.length - 1] < 0;
    if (neg) ints = ints.map((c) => -c);
    const numTex = polyLatex(ints, x);
    const d = /[+-]/.test(denTex.replace(/^-/, "")) && q !== 1 ? `${q}\\left(${denTex}\\right)` : `${q !== 1 ? q : ""}${denTex}`;
    out += `${out ? (neg ? " - " : " + ") : neg ? "-" : ""}\\frac{${numTex}}{${d}}`;
  }
  return out || "0";
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

function strip0(n: any): any {
  return n.type === "ParenthesisNode" ? strip0(n.content) : n;
}
