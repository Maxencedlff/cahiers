import type { InkPoint, Stroke } from "../types";
import { uuid } from "../id";

/** Boite englobante d'un ou plusieurs traits, en unites de page. */
export interface Bounds { x: number; y: number; w: number; h: number }

export function newStroke(
  color: Stroke["color"], width: number, tool: Stroke["tool"], startedAt = Date.now(),
): Stroke {
  return { id: uuid(), points: [], color, width, tool, startedAt };
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

/**
 * Bornes d'un trait, gardees en cache. Le repaint d'une zone sale interroge
 * tous les traits de la page a chaque frame : sans cache, il reparcourait
 * tous leurs points. Le cache suit le tableau de points (un trait simplifie
 * en change) et sa longueur (le trait en cours s'allonge). Seules les
 * bornes nues sont gardees, la marge est ajoutee a la demande : le repaint
 * (marge 1), la gomme (2) et la hauteur de feuille (0) ne s'evincent plus
 * l'un l'autre.
 */
const boundsCache = new WeakMap<Stroke, { pts: InkPoint[]; n: number; b: Bounds }>();
export function cachedBounds(s: Stroke, pad = 0): Bounds {
  const c = boundsCache.get(s);
  let b: Bounds;
  if (c && c.pts === s.points && c.n === s.points.length) b = c.b;
  else {
    b = strokeBounds(s);
    boundsCache.set(s, { pts: s.points, n: s.points.length, b });
  }
  return pad && s.points.length ? padBounds(b, pad) : b;
}

/** Boite agrandie de `m` de chaque cote. */
export function padBounds(b: Bounds, m: number): Bounds {
  return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
}

/**
 * Le surligneur est une bande, pas un trait : a epaisseur egale il etait
 * aussi fin que le stylo. Fin / Moyen / Epais donnent environ 10 / 15 / 25.
 */
export const HIGHLIGHT_FACTOR = 7;

/**
 * Point arrondi pour le fichier : x et y au dixieme d'unite (bien sous le
 * pixel), pression au centieme, temps a la milliseconde. Une page de cours
 * pesait 189 octets par point en double precision.
 */
export function roundPoint(p: InkPoint): InkPoint {
  const out: InkPoint = {
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    // Une pression infime ne doit pas devenir 0, lu comme « pas de pression ».
    p: p.p > 0 ? Math.max(0.01, Math.round(p.p * 100) / 100) : 0,
    t: Math.round(p.t),
  };
  if (p.tiltX || p.tiltY) { out.tiltX = Math.round(p.tiltX ?? 0); out.tiltY = Math.round(p.tiltY ?? 0); }
  return out;
}

/* ------------------------------------------------------------------ */
/* Format disque des traits (schema v2)                                */
/* ------------------------------------------------------------------ */

/**
 * En memoire, un trait garde ses points en objets {x, y, p, t} : tout le
 * code (rendu, gomme, selection, reconnaissance, fusion) les lit ainsi.
 * Sur le disque (v2), ils deviennent des tableaux plats, lisibles a la main
 * mais 3 a 4 fois plus legers (voir CLAUDE.md section 2) :
 *   "pts":  [x0, y0, x1, y1, ...]   au dixieme d'unite de page
 *   "p":    [p0, p1, ...]           pression au centieme ; un seul nombre si
 *                                   elle est constante ; absent si nulle
 *   "t":    [t0, d1, d2, ...]       ms : t0 puis l'ecart avec le point d'avant ;
 *                                   absent si tous les temps sont nuls
 *   "tilt": [tx0, ty0, ...]         inclinaison, seulement si le stylet en donne
 * La conversion se fait seulement a l'ecriture (encodeStroke) et a la
 * lecture (decodeStroke) : ces deux fonctions sont le seul acces au format.
 */
export interface DiskStroke extends Omit<Stroke, "points"> {
  pts: number[];
  p?: number | number[];
  t?: number[];
  tilt?: number[];
}

const r1 = (v: number): number => Math.round(v * 10) / 10 || 0;
const rp = (v: number): number => (v > 0 ? Math.max(0.01, Math.round(v * 100) / 100) : 0);

/** Trait memoire -> trait disque v2. Les champs inconnus sont gardes. */
export function encodeStroke(s: Stroke): DiskStroke {
  const { points, ...rest } = s;
  const n = points.length;
  const pts = new Array<number>(2 * n);
  const press = new Array<number>(n);
  const times = new Array<number>(n);
  let tilt: number[] | null = null;
  let prevT = 0;
  for (let i = 0; i < n; i++) {
    const q = points[i];
    pts[2 * i] = r1(q.x);
    pts[2 * i + 1] = r1(q.y);
    press[i] = rp(q.p);
    // Ecarts entre temps deja arrondis : pas de derive au fil du trait.
    const t = Math.round(q.t) || 0;
    times[i] = i === 0 ? t : t - prevT;
    prevT = t;
    if ((q.tiltX || q.tiltY) && !tilt) tilt = new Array<number>(2 * n).fill(0);
    if (tilt) { tilt[2 * i] = Math.round(q.tiltX ?? 0) || 0; tilt[2 * i + 1] = Math.round(q.tiltY ?? 0) || 0; }
  }
  const out: DiskStroke = { ...rest, pts };
  if (n && press.some((v) => v !== press[0])) out.p = press;
  else if (n && press[0] !== 0) out.p = press[0];
  if (times.some((v) => v !== 0)) out.t = times;
  if (tilt) out.tilt = tilt;
  return out;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Trait lu sur le disque -> trait memoire. Accepte les deux formats : v2
 * (`pts`) et v1 (`points` en objets), pour lire une page ancienne, une copie
 * de conflit ou un fichier de la corbeille quelle que soit sa version. Ne
 * leve jamais : un tableau abime donne des valeurs nulles, pas un trait perdu.
 */
export function decodeStroke(raw: unknown): Stroke {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(s.pts)) {
    return (Array.isArray(s.points) ? s : { ...s, points: [] }) as unknown as Stroke;
  }
  const { pts, p, t, tilt, points: _old, ...rest } = s;
  void _old;
  const flat = pts as unknown[];
  const n = Math.floor(flat.length / 2);
  const press = Array.isArray(p) ? p : null;
  const constP = num(p);
  const times = Array.isArray(t) ? t : [];
  const tl = Array.isArray(tilt) ? tilt : null;
  const points: InkPoint[] = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += num(times[i]);
    const q: InkPoint = { x: num(flat[2 * i]), y: num(flat[2 * i + 1]), p: press ? num(press[i]) : constP, t: acc };
    if (tl) {
      const tx = num(tl[2 * i]), ty = num(tl[2 * i + 1]);
      if (tx || ty) { q.tiltX = tx; q.tiltY = ty; }
    }
    points[i] = q;
  }
  return { ...rest, points } as unknown as Stroke;
}

/** Vrai pour un trait en memoire (objet avec un id et des points). */
export function isMemoryStroke(v: unknown): v is Stroke {
  return !!v && typeof v === "object" && typeof (v as Stroke).id === "string"
    && Array.isArray((v as Stroke).points);
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
