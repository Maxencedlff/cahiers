import { create, all } from "mathjs";
import { normalizeInput, humanError } from "./engine";
import { numericRoots } from "./solve";
import { findSingularity } from "./integrate";

const math = create(all, { number: "number" });

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
 */
export function samplePlot(
  fn: string, from: number, to: number, count = 600, variable = "x",
): PlotOutcome {
  let compiled: { evaluate(scope: Record<string, number>): unknown };
  try {
    compiled = math.compile(normalizeInput(stripY(fn))) as typeof compiled;
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }

  const samples: Sample[] = [];
  let yMin = Infinity, yMax = -Infinity;
  const step = (to - from) / (count - 1);

  for (let i = 0; i < count; i++) {
    const x = from + i * step;
    let y: number | null;
    try {
      const raw = compiled.evaluate({ [variable]: x });
      const num = typeof raw === "number" ? raw : Number(raw);
      y = Number.isFinite(num) ? num : null;
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

/** Tableau de valeurs. */
export function valueTable(
  fn: string, from: number, to: number, step: number, variable = "x",
): TableRow[] {
  const compiled = math.compile(normalizeInput(stripY(fn))) as { evaluate(s: Record<string, number>): unknown };
  const rows: TableRow[] = [];
  const count = Math.min(Math.floor((to - from) / step) + 1, 500);
  for (let i = 0; i < count; i++) {
    const x = from + i * step;
    let y: string;
    try {
      const v = compiled.evaluate({ [variable]: x });
      y = Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 1e6) / 1e6) : "non défini";
    } catch {
      y = "non défini";
    }
    rows.push({ x: Math.round(x * 1e6) / 1e6, y });
  }
  return rows;
}

/** Racines visibles dans la fenetre courante. */
export function rootsInWindow(fn: string, from: number, to: number, variable = "x"): number[] {
  try {
    return numericRoots(stripY(fn), variable, from, to, 2000);
  } catch {
    return [];
  }
}

/**
 * Extremums locaux, reperes par changement de sens entre echantillons.
 * Un « extremum » colle a une asymptote (tan juste avant pi/2) n'en est pas
 * un : la fonction doit rester bornee de part et d'autre (findSingularity).
 */
export function extremaInWindow(
  fn: string, from: number, to: number, variable = "x", count = 800,
): { x: number; y: number; kind: "max" | "min" }[] {
  const plot = samplePlot(fn, from, to, count, variable);
  if (!plot.ok || !plot.samples) return [];
  let f: (x: number) => number;
  try {
    const compiled = math.compile(normalizeInput(stripY(fn)));
    f = (x: number) => { try { return Number(compiled.evaluate({ [variable]: x })); } catch { return NaN; } };
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

/** Etiquette courte d'une graduation : 0.5, 1000, 2e-6. */
export function tickLabel(v: number, step: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return Number(v.toPrecision(3)).toExponential().replace("e+", "e").replace(".", ",");
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(decimals).replace(".", ",");
}
