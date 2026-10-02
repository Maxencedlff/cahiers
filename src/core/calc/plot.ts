import { create, all } from "mathjs";
import {
  normalizeInput, humanError, angleScope, siPrefixes, installCalcFunctions, frNumber, type AngleMode,
} from "./engine";
import { numericRoots } from "./solve";
import { findSingularity } from "./integrate";

const math = create(all, { number: "number" });
installCalcFunctions(math);

/**
 * Saisie d'une courbe prete pour mathjs : j, //, virgule, et prefixes
 * d'ingenieur colles a un nombre (2,2k, 10n), sauf la variable tracee.
 */
export function prepareFn(fn: string, variable = "x"): string {
  return siPrefixes(normalizeInput(stripY(fn)), (n) => n === variable).src;
}

/**
 * Variable effective : « x » par defaut devient la variable deduite (f d'un
 * Bode en frequence). Un bloc courbe de la page, trace en « x », suit.
 */
function varFor(fn: string, variable: string): string {
  return variable === "x" ? plotVariable(fn) : variable;
}

/** Valeur reelle d'une evaluation : un complexe a partie imaginaire negligeable compte. */
function realOf(raw: unknown): { y: number | null; complex: boolean } {
  if (typeof raw === "number") return { y: Number.isFinite(raw) ? raw : null, complex: false };
  if (raw && typeof raw === "object" && (raw as any).isComplex) {
    const { re, im } = raw as { re: number; im: number };
    if (Math.abs(im) <= 1e-12 * Math.max(1, Math.abs(re))) return { y: Number.isFinite(re) ? re : null, complex: false };
    return { y: null, complex: true };
  }
  const n = Number(raw);
  return { y: Number.isFinite(n) ? n : null, complex: false };
}

/** Abscisses : pas constant, ou geometrique sur un axe log (Bode). */
function abscissa(from: number, to: number, count: number, logX: boolean): (i: number) => number {
  if (!logX) {
    const step = (to - from) / (count - 1);
    return (i) => from + i * step;
  }
  const a = Math.log10(from), b = Math.log10(to);
  return (i) => 10 ** (a + ((b - a) * i) / (count - 1));
}

/** Enveloppe dB : 20 log10 |H|. */
export function dbWrap(fn: string): string {
  return `20*log10(abs(${stripY(fn).trim()}))`;
}

/** Fonction tracee en dB : rend H, null si ce n'est pas une enveloppe dB. */
export function dbUnwrap(fn: string): string | null {
  const m = /^\s*20\s*\*\s*log10\(\s*abs\(([\s\S]*)\)\s*\)\s*$/.exec(stripY(fn));
  if (!m) return null;
  // Les parentheses doivent se fermer a la fin, pas avant : 20*log10(abs(a))*b non.
  let depth = 0;
  for (const c of m[1]) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return null;
  }
  return depth === 0 ? m[1].trim() : null;
}

const CONSTANTS = new Set(["pi", "e", "i", "E", "PI", "tau", "phi", "Infinity", "NaN", "true", "false", "null", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"]);

/**
 * Variable d'une courbe : x s'il apparait, sinon le seul nom libre (f pour
 * un Bode en frequence, t, ω...), sinon x.
 */
export function plotVariable(fn: string): string {
  try {
    const names = new Set<string>();
    math.parse(prepareFn(fn, "x")).traverse((node: any, _path: string, parent: any) => {
      if (node.type !== "SymbolNode" || CONSTANTS.has(node.name)) return;
      if (parent && parent.type === "FunctionNode" && parent.fn === node) return;
      names.add(node.name);
    });
    if (names.has("x") || names.size !== 1) return "x";
    return [...names][0];
  } catch {
    return "x";
  }
}

/**
 * Courbes (section 7) : trace qui se redessine pendant la frappe, zoom,
 * recherche de racines, tableau de valeurs.
 */

export interface Sample { x: number; y: number | null }

export interface PlotOutcome {
  ok: boolean;
  message?: string;
  samples?: Sample[];
  yMin?: number;
  yMax?: number;
}

/**
 * Echantillonnage. Les points non definis valent null pour que le rendu
 * coupe le trait au lieu de relier les deux cotes d'une asymptote.
 * `angle` : en DEG, sin(x) prend x en degres, comme dans l'onglet Calcul.
 */
export function samplePlot(
  fn: string, from: number, to: number, count = 600, variable = "x", angle?: AngleMode, logX = false,
): PlotOutcome {
  const scope = angleScope(angle);
  variable = varFor(fn, variable);
  if (logX && !(from > 0)) return { ok: false, message: "Axe log : x minimum doit être positif" };
  let compiled: { evaluate(scope: Record<string, unknown>): unknown };
  try {
    compiled = math.compile(prepareFn(fn, variable)) as typeof compiled;
  } catch (e) {
    return { ok: false, message: humanError(e, stripY(fn)) };
  }

  const samples: Sample[] = [];
  let yMin = Infinity, yMax = -Infinity;
  const at = abscissa(from, to, count, logX);
  let complex = 0;

  for (let i = 0; i < count; i++) {
    const x = at(i);
    let y: number | null;
    try {
      const r = realOf(compiled.evaluate({ ...scope, [variable]: x }));
      y = r.y;
      if (r.complex) complex++;
    } catch {
      y = null;
    }
    if (y !== null) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    samples.push({ x, y });
  }

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    if (complex) {
      return { ok: false, message: "Valeurs complexes : coche « dB » (module en décibels) ou trace abs(), arg(), re() ou im()" };
    }
    return { ok: false, message: "Fonction non définie sur cet intervalle" };
  }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  return { ok: true, samples, yMin, yMax };
}

/** "y = sin(x)" et "sin(x)" donnent la meme chose. */
export function stripY(fn: string): string {
  return fn.replace(/^\s*y\s*=\s*/i, "");
}

export interface TableRow { x: number; y: string }

/**
 * Tableau de valeurs : pas constant, ou pas 1-2-5 par decade sur un axe
 * log (10, 20, 50, 100...). y a la francaise (6 chiffres significatifs).
 */
export function valueTable(
  fn: string, from: number, to: number, step: number, variable = "x", angle?: AngleMode, logX = false,
): TableRow[] {
  const scope = angleScope(angle);
  variable = varFor(fn, variable);
  const compiled = math.compile(prepareFn(fn, variable)) as { evaluate(s: Record<string, unknown>): unknown };
  const xs: number[] = [];
  if (logX && from > 0 && to > from) xs.push(...logSteps(from, to));
  else {
    const count = Math.min(Math.floor((to - from) / step + 1e-9) + 1, 500);
    for (let i = 0; i < count; i++) xs.push(Math.round((from + i * step) * 1e6) / 1e6);
  }
  return xs.map((x) => {
    let y: string;
    try {
      const r = realOf(compiled.evaluate({ ...scope, [variable]: x }));
      y = r.y !== null ? frNumber(r.y) : r.complex ? "complexe" : "non défini";
    } catch {
      y = "non défini";
    }
    return { x, y };
  });
}

/** 1, 2, 5 × 10^k entre from et to, bornes comprises. */
function logSteps(from: number, to: number): number[] {
  const out: number[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(a, b);
  for (let k = Math.floor(Math.log10(from)); k <= Math.ceil(Math.log10(to)); k++) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** k).toPrecision(12));
      if ((v > from || near(v, from)) && (v < to || near(v, to))) out.push(v);
    }
  }
  if (!out.length || !near(out[0], from)) out.unshift(from);
  if (!near(out[out.length - 1], to)) out.push(to);
  return out.slice(0, 500);
}

/**
 * Abscisses ou la courbe passe par `level` (coupure a -3 dB d'un Bode).
 * Changement de signe entre echantillons, puis dichotomie.
 */
export function levelCrossings(
  fn: string, level: number, from: number, to: number, variable = "x", angle?: AngleMode, logX = false,
): number[] {
  let f: (x: number) => number;
  variable = varFor(fn, variable);
  try {
    const compiled = math.compile(prepareFn(fn, variable));
    const scope = angleScope(angle);
    f = (x) => { try { return realOf(compiled.evaluate({ ...scope, [variable]: x })).y ?? NaN; } catch { return NaN; } };
  } catch {
    return [];
  }
  if (logX && !(from > 0)) return [];
  const n = 800;
  const at = abscissa(from, to, n, logX);
  const out: number[] = [];
  let px = at(0), py = f(px) - level;
  for (let i = 1; i < n; i++) {
    const x = at(i), y = f(x) - level;
    if (Number.isFinite(py) && Number.isFinite(y) && py * y <= 0 && !(py === 0 && out.length)) {
      let a = px, b = x, fa = py;
      for (let k = 0; k < 60; k++) {
        const m = logX ? Math.sqrt(a * b) : (a + b) / 2;
        const fm = f(m) - level;
        if (!Number.isFinite(fm)) break;
        if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
      }
      // Une asymptote change aussi de signe : la valeur doit etre proche.
      const r = (a + b) / 2;
      if (Math.abs(f(r) - level) < 1e-6 * Math.max(1, Math.abs(level))) out.push(r);
    }
    px = x; py = y;
  }
  return out;
}

/** Racines visibles dans la fenetre courante. */
export function rootsInWindow(
  fn: string, from: number, to: number, variable = "x", angle?: AngleMode, logX = false,
): number[] {
  if (logX) return levelCrossings(fn, 0, from, to, variable, angle, true);
  variable = varFor(fn, variable);
  try {
    return numericRoots(prepareFn(fn, variable), variable, from, to, 2000, { ...angleScope(angle), ...PLOT_FUNCS });
  } catch {
    return [];
  }
}

/** Fonctions de la calculatrice (par) pour les modules qui ont leur propre mathjs. */
const PLOT_FUNCS: Record<string, unknown> = { par: (math as any).par };

/**
 * Extremums locaux, reperes par changement de sens entre echantillons.
 * Un « extremum » colle a une asymptote (tan juste avant pi/2) n'en est pas
 * un : la fonction doit rester bornee de part et d'autre (findSingularity).
 */
export function extremaInWindow(
  fn: string, from: number, to: number, variable = "x", count = 800, angle?: AngleMode, logX = false,
): { x: number; y: number; kind: "max" | "min" }[] {
  variable = varFor(fn, variable);
  const plot = samplePlot(fn, from, to, count, variable, angle, logX);
  const scope = angleScope(angle);
  if (!plot.ok || !plot.samples) return [];
  let f: (x: number) => number;
  try {
    const compiled = math.compile(prepareFn(fn, variable));
    f = (x: number) => { try { return Number(compiled.evaluate({ ...scope, [variable]: x })); } catch { return NaN; } };
  } catch {
    return [];
  }
  const out: { x: number; y: number; kind: "max" | "min" }[] = [];
  const s = plot.samples;
  for (let i = 1; i < s.length - 1; i++) {
    const a = s[i - 1].y, b = s[i].y, c = s[i + 1].y;
    if (a === null || b === null || c === null) continue;
    const kind = b > a && b > c ? "max" : b < a && b < c ? "min" : null;
    if (!kind) continue;
    if (findSingularity(f, s[i - 1].x, s[i + 1].x, 8) !== null) continue;
    out.push({ x: s[i].x, y: b, kind });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fenetre et graduations                                              */
/* ------------------------------------------------------------------ */

/**
 * Fenetre verticale automatique. Calee sur les quantiles 2 % et 98 % des
 * valeurs finies : une asymptote (tan, 1/x) n'ecrase plus la courbe, et une
 * courbe decalee (x + 100, 230 sin(wt)) reste entiere a l'ecran. Si les
 * extremes ne sont pas des pics isoles, on les garde.
 */
export function autoWindow(samples: Sample[]): { yMin: number; yMax: number } {
  const ys = samples.map((s) => s.y).filter((y): y is number => y !== null && Number.isFinite(y)).sort((a, b) => a - b);
  if (!ys.length) return { yMin: -1, yMax: 1 };
  const q = (p: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(p * (ys.length - 1))))];
  let lo = q(0.02), hi = q(0.98);
  const full = ys[ys.length - 1] - ys[0];
  if (full <= 1.5 * (hi - lo) || hi - lo === 0) { lo = ys[0]; hi = ys[ys.length - 1]; }
  if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) {
    const d = Math.max(1, Math.abs(hi) * 0.1);
    return { yMin: lo - d, yMax: hi + d };
  }
  const pad = (hi - lo) * 0.08;
  return { yMin: lo - pad, yMax: hi + pad };
}

/**
 * Fenetre verticale fixee a la main (GraphBlock.range, champs ymin / ymax
 * de l'onglet Courbes) : utilisee si elle est valable, sinon fenetre auto.
 */
export function plotWindow(samples: Sample[], range?: readonly [number, number] | null): { yMin: number; yMax: number } {
  if (isRange(range)) return { yMin: range[0], yMax: range[1] };
  return autoWindow(samples);
}

/** Bornes finies et dans l'ordre. */
export function isRange(r: readonly number[] | null | undefined): r is readonly [number, number] {
  return !!r && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] < r[1];
}

/**
 * Saisie des champs ymin / ymax : deux nombres lus (null = champ vide ou
 * illisible). Les deux vides = fenetre auto (undefined) ; un seul rempli ou
 * bornes inversees = erreur, la fenetre auto reste affichee.
 */
export function readRange(lo: number | null, hi: number | null, loEmpty: boolean, hiEmpty: boolean):
  { range?: [number, number]; error?: string } {
  if (loEmpty && hiEmpty) return {};
  if (lo === null || hi === null) return { error: "ymin et ymax : deux nombres, ou les deux vides (auto)" };
  if (!(lo < hi)) return { error: "ymin doit être plus petit que ymax" };
  return { range: [lo, hi] };
}

/** Graduations rondes (1, 2 ou 5 × 10^n) entre min et max. */
export function niceTicks(min: number, max: number, maxCount = 8): { step: number; ticks: number[] } {
  if (!(max > min)) return { step: 1, ticks: [min] };
  const raw = (max - min) / maxCount;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    // Arrondi au pas : pas de 0.30000000000000004 sur l'axe.
    const r = Math.round(t / step) * step;
    ticks.push(Math.abs(r) < step * 1e-9 ? 0 : Number(r.toPrecision(12)));
  }
  return { step, ticks };
}

/**
 * Graduations d'un axe log : decades (10, 100, 1k...) etiquetees, 2 a 9 ×
 * 10^k en grille fine. Sur moins d'une decade, 1-2-5 en majeures.
 */
export function logTicks(from: number, to: number): { major: number[]; minor: number[] } {
  const major: number[] = [], minor: number[] = [];
  if (!(from > 0) || !(to > from)) return { major, minor };
  const inside = (v: number) => v >= from * (1 - 1e-9) && v <= to * (1 + 1e-9);
  for (let k = Math.floor(Math.log10(from)); k <= Math.ceil(Math.log10(to)); k++) {
    for (let m = 1; m <= 9; m++) {
      const v = Number((m * 10 ** k).toPrecision(12));
      if (!inside(v)) continue;
      (m === 1 ? major : minor).push(v);
    }
  }
  if (major.length < 2) {
    const few = logSteps(from, to).filter((v) => /^[125]/.test(v.toExponential()));
    return { major: few, minor: minor.filter((v) => !few.includes(v)) };
  }
  return { major, minor };
}

/** Etiquette ingenieur d'une graduation : 10, 100, 1k, 10k, 1M, 100m. */
export function engTick(v: number): string {
  if (v === 0) return "0";
  const syms: Record<number, string> = { [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m", 0: "", 3: "k", 6: "M", 9: "G", 12: "T" };
  let exp = Math.floor(Math.log10(Math.abs(v)) / 3 + 1e-9) * 3;
  exp = Math.max(-12, Math.min(12, exp));
  const m = Number((v / 10 ** exp).toPrecision(3));
  return `${String(m).replace(".", ",")}${syms[exp]}`;
}

/** Etiquette courte d'une graduation : 0.5, 1000, 2e-6. */
export function tickLabel(v: number, step: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return Number(v.toPrecision(3)).toExponential().replace("e+", "e").replace(".", ",");
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(decimals).replace(".", ",");
}
