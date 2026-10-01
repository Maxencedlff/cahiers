import type { Block, InkBlock, InkColor, InkPoint, InkWord, MathBlock, Stroke } from "../types";
import { cachedBounds, roundPoint, unionBounds, type Bounds } from "./stroke";
import { PAGE_W } from "./sheet";
import { dropStrokes, joinWords } from "./words";

/**
 * Selection au lasso, transformation des traits, insertion d'espace et
 * gomme precise (encre-13, encre-14). Logique pure, sans DOM.
 *
 * Deux regles tiennent tout le module :
 *  - un trait deplace, retaille ou recolore GARDE son id : la fusion des
 *    copies de conflit OneDrive se fait par id de trait (core/sync.ts) ;
 *  - un trait colle ou un morceau de trait coupe a la gomme recoit un id
 *    NEUF : c'est un autre trait.
 */

export interface Pt { x: number; y: number }

/* ---------------- lasso ---------------- */

/** Point dans un polygone (regle pair-impair), polygone ferme implicitement. */
export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Part des points d'un trait au-dela de laquelle le lasso le prend. */
export const LASSO_RATIO = 0.5;

/**
 * Le trait est-il « majoritairement » dans le lasso ? Plus de la moitie de
 * ses points : un trait qui depasse un peu du tour reste pris, un trait
 * voisin effleure ne l'est pas.
 */
export function strokeInLasso(s: Stroke, poly: readonly Pt[], ratio = LASSO_RATIO): boolean {
  if (poly.length < 3 || s.points.length === 0) return false;
  const b = cachedBounds(s);
  const pb = polygonBounds(poly);
  if (b.x > pb.x + pb.w || b.x + b.w < pb.x || b.y > pb.y + pb.h || b.y + b.h < pb.y) return false;
  let n = 0;
  for (const p of s.points) if (pointInPolygon(p.x, p.y, poly)) n++;
  return n / s.points.length > ratio;
}

export function polygonBounds(poly: readonly Pt[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return poly.length ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Traits d'un bloc qui en porte (encre, math, annotations PDF). */
export function strokesOf(b: Block): Stroke[] {
  if (b.type === "ink" || b.type === "math") return b.strokes;
  if (b.type === "pdf") return b.annotations;
  return [];
}

/** Zone reconnue posee sur la page (math, ou encre convertie sur zone). */
function isZone(b: Block): b is MathBlock | InkBlock {
  return (b.type === "math" || b.type === "ink") && !!b.rect;
}

/**
 * Traits pris par le lasso. Une zone math/texte reconnue est indivisible :
 * un seul de ses traits pris emmene toute la zone, sinon sa formule
 * resterait a l'ancienne place avec une partie de son encre.
 */
export function selectInLasso(blocks: readonly Block[], poly: readonly Pt[]): Set<string> {
  const ids = new Set<string>();
  for (const b of blocks) {
    if (b.type !== "ink" && b.type !== "math") continue;
    const hit = b.strokes.filter((s) => strokeInLasso(s, poly));
    if (!hit.length) continue;
    for (const s of isZone(b) ? b.strokes : hit) ids.add(s.id);
  }
  return ids;
}

/** Les traits de la page qui portent ces ids, dans l'ordre de la page. */
export function strokesById(blocks: readonly Block[], ids: ReadonlySet<string>): Stroke[] {
  const out: Stroke[] = [];
  for (const b of blocks) for (const s of strokesOf(b)) if (ids.has(s.id)) out.push(s);
  return out;
}

/** Boite des traits (epaisseur comprise). */
export function selectionBounds(strokes: readonly Stroke[]): Bounds {
  return unionBounds(strokes.map((s) => cachedBounds(s)));
}

/* ---------------- transformation ---------------- */

/**
 * Translation et mise a l'echelle uniforme autour d'une origine :
 * p' = o + (p - o) * s + d.
 */
export interface Transform { dx: number; dy: number; s: number; ox: number; oy: number }

export const IDENTITY: Transform = { dx: 0, dy: 0, s: 1, ox: 0, oy: 0 };

export function translation(dx: number, dy: number): Transform {
  return { dx, dy, s: 1, ox: 0, oy: 0 };
}

export function isIdentity(t: Transform): boolean {
  return t.dx === 0 && t.dy === 0 && t.s === 1;
}

export function applyPoint(t: Transform, p: Pt): Pt {
  return { x: t.ox + (p.x - t.ox) * t.s + t.dx, y: t.oy + (p.y - t.oy) * t.s + t.dy };
}

export function applyBounds(t: Transform, b: Bounds): Bounds {
  const a = applyPoint(t, b);
  return { x: a.x, y: a.y, w: b.w * t.s, h: b.h * t.s };
}

/**
 * Trait transforme EN PLACE : meme objet, meme id. Le tableau de points est
 * neuf (le cache des bornes le voit), l'epaisseur suit l'echelle.
 */
export function transformStroke(s: Stroke, t: Transform): void {
  s.points = s.points.map((p) => {
    const q = applyPoint(t, p);
    return roundPoint({ ...p, x: q.x, y: q.y });
  });
  if (t.s !== 1) s.width = Math.max(0.3, Math.round(s.width * t.s * 100) / 100);
}

/**
 * Applique une transformation aux traits `ids` de la page, et garde les
 * blocs coherents : une zone dont tous les traits bougent emmene son cadre ;
 * un mot reconnu dont tous les traits bougent emmene sa boite ; un mot
 * dont une partie seulement bouge lache les traits partis (ils restent a
 * l'encre en rendu propre, rien n'est perdu).
 */
export function transformBlocks(blocks: Block[], ids: ReadonlySet<string>, t: Transform): void {
  if (isIdentity(t) || !ids.size) return;
  for (const b of blocks) {
    const list = strokesOf(b);
    let moved = 0;
    for (const s of list) if (ids.has(s.id)) { transformStroke(s, t); moved++; }
    if (!moved) continue;
    if (isZone(b) && moved === list.length) b.rect = applyBounds(t, b.rect!);
    if (b.type === "ink" && b.words) b.words = moveWords(b.words, ids, t);
  }
}

function moveWords(words: InkWord[], ids: ReadonlySet<string>, t: Transform): InkWord[] {
  return words.map((w) => {
    if (!w.box || !w.strokeIds.length) return w;
    const n = w.strokeIds.filter((id) => ids.has(id)).length;
    if (n === 0) return w;
    if (n === w.strokeIds.length) return { ...w, box: applyBounds(t, w.box) };
    return { ...w, strokeIds: w.strokeIds.filter((id) => !ids.has(id)) };
  });
}

/**
 * Translation ramenee pour que la boite reste sur la feuille : jamais a
 * gauche de 0, a droite de PAGE_W ni au-dessus du haut. En bas, la feuille
 * s'allonge (sheet.ts).
 */
export function clampMove(b: Bounds, dx: number, dy: number): { dx: number; dy: number } {
  let x = dx, y = dy;
  if (b.x + x < 0) x = -b.x;
  if (b.x + b.w + x > PAGE_W) x = Math.max(-b.x, PAGE_W - b.x - b.w);
  if (b.y + y < 0) y = -b.y;
  return { dx: x, dy: y };
}

/** Plus petit cote d'une selection retaillee, en unites de page. */
export const MIN_SIZE = 8;

/**
 * Redimensionnement proportionnel par la poignee bas-droite : le coin
 * haut-gauche reste en place, l'echelle suit la projection du deplacement
 * sur la diagonale. Bornee pour que la selection ne disparaisse pas et ne
 * sorte pas de la largeur de la feuille.
 */
export function resizeTransform(b: Bounds, dx: number, dy: number): Transform {
  const d2 = b.w * b.w + b.h * b.h;
  if (d2 === 0) return IDENTITY;
  let s = ((b.w + dx) * b.w + (b.h + dy) * b.h) / d2;
  const min = MIN_SIZE / Math.max(1, Math.min(b.w || Infinity, b.h || Infinity));
  s = Math.max(s, Math.min(1, min), 0.05);
  if (b.w > 0) s = Math.min(s, (PAGE_W - b.x) / b.w);
  return { dx: 0, dy: 0, s, ox: b.x, oy: b.y };
}

/* ---------------- couleur ---------------- */

/** Recolore les traits (palette semantique, meme id). Rend le nombre change. */
export function recolorStrokes(blocks: Block[], ids: ReadonlySet<string>, color: InkColor): number {
  let n = 0;
  for (const b of blocks) {
    for (const s of strokesOf(b)) {
      if (ids.has(s.id) && s.color !== color) { s.color = color; n++; }
    }
  }
  return n;
}

/* ---------------- copier / coller ---------------- */

/**
 * Presse-papiers de l'encre : traits libres, et zones reconnues prises en
 * entier (elles gardent leur formule ou leur texte).
 */
export interface InkClip {
  strokes: Stroke[];
  zones: (MathBlock | InkBlock)[];
  bounds: Bounds;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Copie profonde de la selection : le presse-papiers ne suit plus la page. */
export function copySelection(blocks: readonly Block[], ids: ReadonlySet<string>): InkClip | null {
  const strokes: Stroke[] = [];
  const zones: (MathBlock | InkBlock)[] = [];
  const all: Stroke[] = [];
  for (const b of blocks) {
    const list = strokesOf(b).filter((s) => ids.has(s.id));
    if (!list.length) continue;
    all.push(...list);
    if (isZone(b) && list.length === b.strokes.length) zones.push(clone(b));
    else if (b.type !== "pdf") strokes.push(...clone(list));
  }
  if (!all.length) return null;
  return { strokes, zones, bounds: selectionBounds(all) };
}

/**
 * Collage : de NOUVEAUX ids pour chaque trait et chaque zone (un collage
 * est un autre trait, la fusion par id ne doit jamais les confondre), et
 * le decalage (dx, dy). Les mots d'une zone suivent leurs traits.
 */
export function pasteClip(
  clip: InkClip, dx: number, dy: number, newId: () => string,
): { strokes: Stroke[]; zones: (MathBlock | InkBlock)[] } {
  const t = translation(dx, dy);
  const fresh = (s: Stroke, map?: Map<string, string>): Stroke => {
    const c = clone(s);
    c.id = newId();
    map?.set(s.id, c.id);
    transformStroke(c, t);
    return c;
  };
  const strokes = clip.strokes.map((s) => fresh(s));
  const zones = clip.zones.map((z) => {
    const map = new Map<string, string>();
    const c = clone(z);
    c.id = newId();
    c.strokes = z.strokes.map((s) => fresh(s, map));
    if (c.rect) c.rect = applyBounds(t, c.rect);
    if (c.type === "ink" && c.words) {
      c.words = c.words.map((w) => ({
        ...w,
        strokeIds: w.strokeIds.map((id) => map.get(id) ?? id),
        ...(w.box ? { box: applyBounds(t, w.box) } : {}),
      }));
    }
    return c;
  });
  return { strokes, zones };
}

/** Pas du decalage de collages successifs au meme endroit. */
export const PASTE_STEP = 24;

/* ---------------- insertion d'espace ---------------- */

/**
 * Traits « sous la ligne » y : ceux dont le centre est sous elle. Un grand
 * signe qui commence juste au-dessus (integrale, accolade) descend avec
 * sa formule. Une zone reconnue part en entier si un de ses traits part.
 */
export function strokesBelow(blocks: readonly Block[], y: number): Set<string> {
  const ids = new Set<string>();
  for (const b of blocks) {
    const list = strokesOf(b);
    const below = list.filter((s) => {
      if (!s.points.length) return false;
      const r = cachedBounds(s);
      return r.y + r.h / 2 >= y;
    });
    if (!below.length) continue;
    for (const s of isZone(b) ? list : below) ids.add(s.id);
  }
  return ids;
}

/**
 * Deplacement vertical permis pour l'insertion d'espace : vers le bas sans
 * limite (la feuille s'allonge) ; vers le haut, seulement le blanc qui
 * separe la ligne du premier trait pousse, sinon l'encre remonterait sur
 * ce qui est au-dessus.
 */
export function clampSpace(blocks: readonly Block[], ids: ReadonlySet<string>, y: number, dy: number): number {
  if (dy >= 0) return dy;
  let top = Infinity;
  for (const s of strokesById(blocks, ids)) top = Math.min(top, cachedBounds(s).y);
  if (top === Infinity) return 0;
  return Math.max(dy, Math.min(0, y - top));
}

/* ---------------- gomme precise ---------------- */

/** Morceau plus court que ca (unites de page) : poussiere, jete. */
const MIN_PIECE = 1.2;

/**
 * Coupe un trait par le disque de la gomme (rayon r + demi-epaisseur) et
 * rend les morceaux restants, ou null si le disque ne le touche pas. Les
 * segments qui traversent le bord sont coupes au point d'entree exact
 * (pression et temps interpoles). Chaque morceau a un id neuf, la meme
 * couleur, epaisseur, outil et heure de debut.
 */
export function splitStroke(s: Stroke, cx: number, cy: number, r: number, newId: () => string): Stroke[] | null {
  const rr = r + s.width / 2;
  if (!s.points.length) return null;
  const b = cachedBounds(s);
  if (cx + rr < b.x || cx - rr > b.x + b.w || cy + rr < b.y || cy - rr > b.y + b.h) return null;
  const inside = (p: InkPoint) => (p.x - cx) ** 2 + (p.y - cy) ** 2 <= rr * rr;

  const pieces: InkPoint[][] = [];
  let cur: InkPoint[] = [];
  let touched = false;
  const flush = () => { if (cur.length) pieces.push(cur); cur = []; };

  const pts = s.points;
  if (pts.length === 1) return inside(pts[0]) ? [] : null;
  if (!inside(pts[0])) cur.push(pts[0]);
  else touched = true;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], c = pts[i];
    const hits = segmentCircle(a, c, cx, cy, rr);
    const ain = inside(a), cin = inside(c);
    if (ain || cin || hits.length) touched = true;
    if (!ain && !cin) {
      if (hits.length === 2) {
        // Le segment traverse le disque : sortie, trou, reprise.
        cur.push(lerp(a, c, hits[0]));
        flush();
        cur.push(lerp(a, c, hits[1]));
      }
      cur.push(c);
    } else if (!ain && cin) {
      cur.push(lerp(a, c, hits[0] ?? 1));
      flush();
    } else if (ain && !cin) {
      cur.push(lerp(a, c, hits[hits.length - 1] ?? 0));
      cur.push(c);
    }
    // ain && cin : dans la gomme, rien a garder.
  }
  flush();
  if (!touched) return null;
  return pieces
    .filter((p) => p.length >= 2 && pathLength(p) >= MIN_PIECE)
    .map((points) => ({ ...s, id: newId(), points: points.map(roundPoint) }));
}

/** Parametres (0..1, croissants) ou le segment [a, b] coupe le cercle. */
function segmentCircle(a: Pt, b: Pt, cx: number, cy: number, r: number): number[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - cx, fy = a.y - cy;
  const A = dx * dx + dy * dy;
  if (A === 0) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const q = Math.sqrt(disc);
  return [(-B - q) / (2 * A), (-B + q) / (2 * A)].filter((t) => t >= 0 && t <= 1);
}

function lerp(a: InkPoint, b: InkPoint, t: number): InkPoint {
  const out: InkPoint = {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    p: a.p + (b.p - a.p) * t,
    t: a.t + (b.t - a.t) * t,
  };
  if (a.tiltX !== undefined || b.tiltX !== undefined) {
    out.tiltX = (a.tiltX ?? 0) + ((b.tiltX ?? 0) - (a.tiltX ?? 0)) * t;
    out.tiltY = (a.tiltY ?? 0) + ((b.tiltY ?? 0) - (a.tiltY ?? 0)) * t;
  }
  return out;
}

function pathLength(p: InkPoint[]): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) n += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return n;
}

/**
 * Remplace des traits par leurs morceaux, a leur place dans chaque bloc
 * (une liste vide = trait retire). Les mots reconnus pointent sur les
 * morceaux ; une zone math videe perd sa formule et disparait (jamais de
 * LaTeX orphelin, comme a la gomme entiere). Rend vrai si un mot du fond de
 * page a ete touche (sa lecture est a refaire).
 */
export function replaceStrokes(blocks: Block[], repl: ReadonlyMap<string, Stroke[]>): { blocks: Block[]; wordsTouched: boolean } {
  let wordsTouched = false;
  const swap = (list: Stroke[]) => list.flatMap((s) => repl.get(s.id) ?? [s]);
  for (const b of blocks) {
    if (b.type === "ink") {
      b.strokes = swap(b.strokes);
      if (b.words) {
        let changed = false;
        const words = b.words.map((w) => {
          if (!w.strokeIds.some((id) => repl.has(id))) return w;
          changed = true;
          if (!b.rect) wordsTouched = true;
          return { ...w, strokeIds: w.strokeIds.flatMap((id) => repl.get(id)?.map((p) => p.id) ?? [id]) };
        });
        if (changed) {
          // Un mot dont toute l'encre est partie disparait, comme a la gomme entiere.
          b.words = dropStrokes(words, new Set());
          b.recognized = joinWords(b.words) || null;
        }
      }
    } else if (b.type === "math") {
      const had = b.strokes.length;
      b.strokes = swap(b.strokes);
      if (had > 0 && b.strokes.length === 0) b.latex = null;
    } else if (b.type === "pdf") {
      b.annotations = swap(b.annotations);
    }
  }
  return {
    blocks: blocks.filter((b) => !(b.type === "math" && b.strokes.length === 0)),
    wordsTouched,
  };
}
