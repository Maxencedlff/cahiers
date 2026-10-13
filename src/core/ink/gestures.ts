import type { InkPoint, Stroke } from "../types";
import { cachedBounds, type Bounds } from "./stroke";

/**
 * Gestes du stylet, sans DOM (lot stylet) :
 *  - gribouillage (zigzag dense, nombreux allers-retours) par-dessus de
 *    l'encre : il l'efface, comme sur GoodNotes ;
 *  - pointe maintenue immobile en fin de trait : le trait est redresse en
 *    segment, ou en rectangle s'il est ferme et quasi rectangulaire.
 * Tests : src/tests/stylet.test.ts.
 */

export interface Pt { x: number; y: number }

/** Allers-retours minimum d'un gribouillage. */
export const SCRIBBLE_REVERSALS = 5;

/**
 * Le trait est-il un gribouillage ? Sur l'axe ou il bouge le plus, il fait
 * au moins SCRIBBLE_REVERSALS demi-tours, chacun d'au moins un quart de
 * l'etendue (le tremblement ne compte pas), et revient sans cesse sur la
 * meme bande : l'autre axe ne s'etend pas plus que 1,2 fois celui-ci.
 * Une resistance dessinee en zigzag, un « m » ou un « www » avancent le
 * long de l'autre axe : ce ne sont pas des gribouillages.
 */
export function isScribble(points: readonly Pt[]): boolean {
  if (points.length < 12) return false;
  let sx = 0, sy = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (i) { sx += Math.abs(p.x - points[i - 1].x); sy += Math.abs(p.y - points[i - 1].y); }
  }
  const horizontal = sx >= sy;
  const main = horizontal ? maxX - minX : maxY - minY;
  const perp = horizontal ? maxY - minY : maxX - minX;
  const path = horizontal ? sx : sy;
  if (main < 12 || perp > 1.2 * main || path < 4.5 * main) return false;
  return reversals(points.map((p) => (horizontal ? p.x : p.y)), Math.max(2, main / 4)) >= SCRIBBLE_REVERSALS;
}

/** Demi-tours d'une suite de valeurs, avec une hysteresis `min`. */
export function reversals(values: readonly number[], min: number): number {
  let dir = 0, n = 0;
  let lo = values[0] ?? 0, hi = lo, extreme = lo;
  for (const v of values) {
    if (dir === 0) {
      lo = Math.min(lo, v); hi = Math.max(hi, v);
      if (v - lo >= min) { dir = 1; extreme = v; } else if (hi - v >= min) { dir = -1; extreme = v; }
    } else if (dir === 1) {
      if (v > extreme) extreme = v;
      else if (extreme - v >= min) { dir = -1; extreme = v; n++; }
    } else if (v < extreme) extreme = v;
    else if (v - extreme >= min) { dir = 1; extreme = v; n++; }
  }
  return n;
}

/**
 * Traits effaces par un gribouillage : au moins la moitie de leurs points
 * dans la boite du gribouillage (marge de 3 unites).
 */
export function scribbleTargets(scribble: readonly Pt[], strokes: readonly Stroke[]): string[] {
  const b = boxOf(scribble);
  const box = { x: b.x - 3, y: b.y - 3, w: b.w + 6, h: b.h + 6 };
  const out: string[] = [];
  for (const s of strokes) {
    if (!s.points.length) continue;
    const sb = cachedBounds(s);
    if (sb.x > box.x + box.w || sb.x + sb.w < box.x || sb.y > box.y + box.h || sb.y + sb.h < box.y) continue;
    let n = 0;
    for (const p of s.points) {
      if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) n++;
    }
    if (n / s.points.length >= 0.5) out.push(s.id);
  }
  return out;
}

function boxOf(points: readonly Pt[]): Bounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return points.length ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Pointe maintenue immobile en fin de trait (ms) avant le redressement. */
export const HOLD_MS = 500;

export type Shape = { kind: "line" | "rect"; points: InkPoint[] };

/**
 * Redressement d'un trait tenu en fin de geste. Ferme (bouts a moins de
 * 20 % de la diagonale) et quasi rectangulaire (85 % des points pres d'un
 * bord de la boite, les quatre bords touches) : rectangle. Sinon, assez
 * droit (ecart a la corde ≤ 12 % de sa longueur) : segment. Sinon null,
 * le trait reste tel quel (ecriture qui marque une pause).
 */
export function straighten(points: readonly InkPoint[]): Shape | null {
  if (points.length < 2) return null;
  const a = points[0], z = points[points.length - 1];
  const b = boxOf(points);
  const diag = Math.hypot(b.w, b.h);
  const p = points.reduce((s, q) => s + (q.p || 0.5), 0) / points.length;
  const t0 = a.t, t1 = z.t;
  const at = (x: number, y: number, t: number): InkPoint => ({ x: round(x), y: round(y), p: Math.round(p * 100) / 100, t });
  if (diag >= 20 && Math.hypot(z.x - a.x, z.y - a.y) < 0.2 * diag && b.w >= 10 && b.h >= 10) {
    const tol = Math.max(3, 0.12 * Math.min(b.w, b.h));
    const sides = [false, false, false, false];
    let near = 0;
    for (const q of points) {
      const d = [q.y - b.y, b.x + b.w - q.x, b.y + b.h - q.y, q.x - b.x];
      const k = d.indexOf(Math.min(...d));
      if (d[k] <= tol) { near++; sides[k] = true; }
    }
    // Les quatre coins atteints : un cercle ou une ellipse touche les quatre
    // bords sans jamais aller dans les coins.
    const cornerTol = Math.max(4, 0.15 * Math.min(b.w, b.h));
    const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    const cornered = corners.every(([cx, cy]) => points.some((q) => Math.hypot(q.x - cx, q.y - cy) <= cornerTol));
    if (near / points.length >= 0.85 && sides.every(Boolean) && cornered) {
      const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
      const step = (t1 - t0) / 4;
      return {
        kind: "rect",
        points: [at(x0, y0, t0), at(x1, y0, t0 + step), at(x1, y1, t0 + 2 * step), at(x0, y1, t0 + 3 * step), at(x0, y0, t1)],
      };
    }
    return null;
  }
  const len = Math.hypot(z.x - a.x, z.y - a.y);
  if (len < 15) return null;
  let dev = 0;
  for (const q of points) {
    const d = Math.abs((z.x - a.x) * (a.y - q.y) - (a.x - q.x) * (z.y - a.y)) / len;
    if (d > dev) dev = d;
  }
  if (dev > Math.max(3, 0.12 * len)) return null;
  return { kind: "line", points: [at(a.x, a.y, t0), at(z.x, z.y, t1)] };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
