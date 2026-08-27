import { create, all } from "mathjs";
import { normalizeInput } from "./engine";
import { numericRoots } from "./solve";

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
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
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
    return { ok: false, message: "Fonction non definie sur cet intervalle" };
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
      y = Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 1e6) / 1e6) : "non defini";
    } catch {
      y = "non defini";
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

/** Extremums locaux, reperes par changement de signe de la derivee numerique. */
export function extremaInWindow(
  fn: string, from: number, to: number, variable = "x", count = 800,
): { x: number; y: number; kind: "max" | "min" }[] {
  const plot = samplePlot(fn, from, to, count, variable);
  if (!plot.ok || !plot.samples) return [];
  const out: { x: number; y: number; kind: "max" | "min" }[] = [];
  const s = plot.samples;
  for (let i = 1; i < s.length - 1; i++) {
    const a = s[i - 1].y, b = s[i].y, c = s[i + 1].y;
    if (a === null || b === null || c === null) continue;
    if (b > a && b > c) out.push({ x: s[i].x, y: b, kind: "max" });
    if (b < a && b < c) out.push({ x: s[i].x, y: b, kind: "min" });
  }
  return out;
}
