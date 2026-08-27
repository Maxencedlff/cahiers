import type { InkPoint, Stroke } from "../types";
import { uuid } from "../id";

/** Boite englobante d'un ou plusieurs traits, en unites de page. */
export interface Bounds { x: number; y: number; w: number; h: number }

export function newStroke(color: Stroke["color"], width: number, tool: Stroke["tool"]): Stroke {
  return { id: uuid(), points: [], color, width, tool };
}

export function strokeBounds(s: Stroke, pad = 0): Bounds {
  if (s.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const m = s.width / 2 + pad;
  return { x: minX - m, y: minY - m, w: maxX - minX + 2 * m, h: maxY - minY + 2 * m };
}

export function unionBounds(list: Bounds[]): Bounds {
  const real = list.filter((b) => b.w > 0 || b.h > 0);
  if (real.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...real.map((b) => b.x));
  const minY = Math.min(...real.map((b) => b.y));
  const maxX = Math.max(...real.map((b) => b.x + b.w));
  const maxY = Math.max(...real.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

/**
 * Largeur reelle d'un point : la pression module l'epaisseur.
 * Un stylet sans pression renvoie 0.5, ce qui donne l'epaisseur nominale.
 */
export function widthAt(base: number, pressure: number): number {
  const p = pressure > 0 ? pressure : 0.5;
  return base * (0.45 + 1.1 * p);
}

/**
 * Simplification Ramer-Douglas-Peucker. Un digitizer envoie jusqu'a
 * 200 points par seconde ; en garder la moitie allege le JSON, le rendu
 * et l'envoi reseau sans difference visible.
 */
export function simplify(points: InkPoint[], tolerance = 0.6): InkPoint[] {
  if (points.length < 3) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  rdp(points, 0, points.length - 1, tolerance, keep);
  return points.filter((_, i) => keep[i]);
}

function rdp(pts: InkPoint[], first: number, last: number, tol: number, keep: boolean[]): void {
  if (last <= first + 1) return;
  let maxDist = -1;
  let index = first;
  for (let i = first + 1; i < last; i++) {
    const d = perpDistance(pts[i], pts[first], pts[last]);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist > tol) {
    keep[index] = true;
    rdp(pts, first, index, tol, keep);
    rdp(pts, index, last, tol, keep);
  }
}

function perpDistance(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Un trait touche-t-il ce disque ? Utilise par la gomme. */
export function strokeHitsCircle(s: Stroke, cx: number, cy: number, r: number): boolean {
  const rr = r + s.width / 2;
  for (let i = 0; i < s.points.length; i++) {
    const p = s.points[i];
    if (Math.hypot(p.x - cx, p.y - cy) <= rr) return true;
    if (i > 0) {
      const q = s.points[i - 1];
      if (segmentDistance(cx, cy, q.x, q.y, p.x, p.y) <= rr) return true;
    }
  }
  return false;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
