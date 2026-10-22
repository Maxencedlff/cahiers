/**
 * Schemas electriques et schemas-blocs (bloc `schema`, voir types.ts) :
 * logique pure, sans DOM. Pieces posees sur une grille entiere, fils a
 * angles droits (polylignes), annotations. Les fils ne referencent pas les
 * pieces : une extremite de fil posee sur une borne y est reliee, et
 * deplacer la piece emmene les extremites qui la touchaient (« les fils
 * suivent toujours », pas de mode « move » qui les casse).
 *
 * Saisie au clavier « tortue » (Turtle) : les fleches tracent le fil case
 * par case, une lettre pose la piece dans le sens du trace et le curseur
 * repart de son autre borne ; « . » retient un noeud, une masse ramene au
 * dernier noeud, Tab choisit une borne libre et Entree la relie.
 */
import type { SchemaBlock, SchemaNote, SchemaPart } from "../types";
import { SYMBOLS, STRETCH, fitWidth, portsAt, symbolByLetter, symbolFor, type Port, type SymKey } from "./symbols";
import { labelWidth } from "./label";

export interface Pt { x: number; y: number }
export type Dir = "right" | "left" | "up" | "down";
export type Rot = 0 | 90 | 180 | 270;

export const DIRS: Record<Dir, Pt> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

/** Rotation qui oriente un dipole (borne d'entree vers borne de sortie) dans la direction du trace. */
export function rotForDir(d: Dir): Rot {
  return d === "right" ? 0 : d === "down" ? 90 : d === "left" ? 180 : 270;
}

/**
 * Dipoles sans sens (resistance, condensateur, bobine, interrupteur...) :
 * traces vers la gauche ou vers le haut, ils gardent l'orientation habituelle
 * (bosses de la bobine en haut, lame de l'interrupteur vers la droite) ;
 * seuls les dipoles polarises (diode, source, condensateur polarise)
 * suivent le sens du trace.
 */
const NO_SENSE = new Set<string>(["R", "C", "L", "K", "F", "Lamp", "X"]);

/** Rotation et borne posee au debut du trace, pour un dipole trace dans le sens `d`. */
export function orientFor(sym: SymKey, d: Dir): { rot: Rot; entry: string; exit: string } {
  const th = SYMBOLS[sym].through ?? ["a", "b"];
  if (NO_SENSE.has(sym) && (d === "left" || d === "up")) {
    return { rot: rotForDir(d === "left" ? "right" : "down"), entry: th[1], exit: th[0] };
  }
  return { rot: rotForDir(d), entry: th[0], exit: th[1] };
}

export function samePt(a: Pt, b: Pt): boolean { return a.x === b.x && a.y === b.y; }

export function emptySchema(id: string): SchemaBlock {
  return { id, type: "schema", parts: [], wires: [] };
}

function isSym(k: string): k is SymKey { return Object.prototype.hasOwnProperty.call(SYMBOLS, k); }

/** Bornes d'une piece posee, en coordonnees de grille. */
export function partPorts(p: SchemaPart): Port[] {
  if (!isSym(p.sym)) return [];
  return portsAt(p.sym, p.x, p.y, p.rot ?? 0, p.mirror, p.w);
}

/** Boite d'une piece posee (dimensions tournees). */
export function partBox(p: SchemaPart): { x: number; y: number; w: number; h: number } {
  const d = isSym(p.sym) ? symbolFor(p.sym, p.w) : { w: 2, h: 2 };
  const turned = (p.rot ?? 0) % 180 !== 0;
  return { x: p.x, y: p.y, w: turned ? d.h : d.w, h: turned ? d.w : d.h };
}

/** Coin haut-gauche ou poser `sym` pour que sa borne `port` tombe sur `at`. */
export function placeFor(sym: SymKey, port: string, at: Pt, rot: Rot, mirror?: boolean, w?: number): Pt {
  const p = portsAt(sym, 0, 0, rot, mirror, w).find((q) => q.name === port);
  return p ? { x: at.x - p.x, y: at.y - p.y } : { x: at.x, y: at.y };
}

/* ---------------- noms ---------------- */

const NAME_PREFIX: Partial<Record<SymKey, string>> = {
  R: "R", Pot: "R", C: "C", Cp: "C", L: "L", D: "D", Dz: "D", LED: "D", K: "K", V: "E", Vdc: "E", I: "I",
  Q: "Q", Qp: "Q", M: "M", Mp: "M", T: "T", F: "F", Lamp: "H",
};

/**
 * Nom suivant d'une piece : la lettre seule pour la premiere de son espece
 * (« L », « C », comme au tableau), puis « R2 », « R3 »... (la premiere,
 * restee « R », devient alors « R1 », voir `addPart`). Rien pour une masse,
 * un AOP, un bloc, un circuit ouvert.
 */
export function nextName(s: SchemaBlock, sym: SymKey): string | undefined {
  const pre = NAME_PREFIX[sym];
  if (!pre) return undefined;
  const used = new Set(s.parts.map((p) => p.name));
  const same = s.parts.some((p) => p.name === pre || new RegExp(`^${pre}\\d+$`).test(p.name ?? ""));
  if (!same) return pre;
  let n = used.has(pre) ? 2 : 1;
  while (used.has(`${pre}${n}`)) n++;
  return `${pre}${n}`;
}

/** Etiquette de tension par defaut d'une piece nommee. */
function defaultU(name: string): string { return `u${name}`; }

function newId(s: SchemaBlock): string {
  let n = s.parts.length + 1;
  const used = new Set(s.parts.map((p) => p.id));
  while (used.has(`p${n}`)) n++;
  return `p${n}`;
}

/* ---------------- fils ---------------- */

export function wirePts(w: { pts: number[] }): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < w.pts.length; i += 2) out.push({ x: w.pts[i], y: w.pts[i + 1] });
  return out;
}

function flat(pts: Pt[]): number[] { return pts.flatMap((p) => [p.x, p.y]); }

/** Points doublons et points au milieu d'un alignement retires. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && samePt(out[out.length - 1], p)) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/** Chemin a angles droits de a vers b (horizontal d'abord, ou vertical si `vertical`). */
export function routeOrtho(a: Pt, b: Pt, vertical = false): Pt[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  return vertical ? [a, { x: a.x, y: b.y }, b] : [a, { x: b.x, y: a.y }, b];
}

export function addWire(s: SchemaBlock, pts: Pt[]): void {
  const p = simplify(pts);
  if (p.length >= 2) s.wires.push({ pts: flat(p) });
}

/** Segments de tous les fils. */
export function segments(s: SchemaBlock): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (const w of s.wires) {
    const p = wirePts(w);
    for (let i = 0; i + 1 < p.length; i++) out.push([p[i], p[i + 1]]);
  }
  return out;
}

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  if (a.x === b.x) return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  if (a.y === b.y) return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  return false;
}

/**
 * Points de jonction a dessiner : la ou au moins trois branches se
 * rejoignent (extremites de fils, bornes, fil qui arrive en T au milieu
 * d'un autre). Un simple croisement de deux fils n'en est jamais un.
 */
export function junctions(s: SchemaBlock): Pt[] {
  const ends = new Map<string, Pt>();
  const deg = new Map<string, number>();
  const key = (p: Pt) => `${p.x},${p.y}`;
  const bump = (p: Pt, n = 1) => { const k = key(p); ends.set(k, p); deg.set(k, (deg.get(k) ?? 0) + n); };
  for (const w of s.wires) {
    const p = wirePts(w);
    if (p.length < 2) continue;
    bump(p[0]);
    bump(p[p.length - 1]);
    // Coude ou point interieur d'un fil : deux branches.
    for (let i = 1; i < p.length - 1; i++) bump(p[i], 2);
  }
  for (const part of s.parts) for (const q of partPorts(part)) if (deg.has(key(q))) bump(q);
  // Extremite arrivant au milieu d'un segment d'un autre fil : deux branches de plus.
  const segs = segments(s);
  for (const [k, p] of ends) {
    for (const [a, b] of segs) {
      if (onSegment(p, a, b) && !samePt(p, a) && !samePt(p, b)) deg.set(k, (deg.get(k) ?? 0) + 2);
    }
  }
  return [...ends].filter(([k]) => (deg.get(k) ?? 0) >= 3).map(([, p]) => p);
}

/** Le point touche-t-il un fil ou une borne (connecte) ? */
function connectedAt(s: SchemaBlock, p: Pt, except?: SchemaPart): boolean {
  if (segments(s).some(([a, b]) => onSegment(p, a, b))) return true;
  return s.parts.some((q) => q !== except && partPorts(q).some((r) => samePt(r, p)));
}

/** Bornes libres (ni fil ni autre borne dessus), dans l'ordre des pieces. */
export function freePorts(s: SchemaBlock): { part: SchemaPart; port: Port }[] {
  const out: { part: SchemaPart; port: Port }[] = [];
  for (const part of s.parts) {
    for (const port of partPorts(part)) if (!connectedAt(s, port, part)) out.push({ part, port });
  }
  return out;
}

/* ---------------- pieces ---------------- */

export function addPart(s: SchemaBlock, sym: SymKey, at: Pt, rot: Rot = 0, mirror = false): SchemaPart {
  const part: SchemaPart = { id: newId(s), sym, x: at.x, y: at.y };
  if (rot) part.rot = rot;
  if (mirror) part.mirror = true;
  const name = nextName(s, sym);
  if (name) {
    part.name = name;
    // Deuxieme de son espece : la premiere, restee « R », devient « R1 » (et sa tension uR1).
    const pre = NAME_PREFIX[sym];
    const bare = pre && name !== pre ? s.parts.find((p) => p.name === pre) : undefined;
    if (bare && pre) {
      bare.name = `${pre}1`;
      for (const n of s.notes ?? []) if (n.part === bare.id && n.label === defaultU(pre)) n.label = defaultU(bare.name);
    }
  }
  s.parts.push(part);
  return part;
}

/**
 * Deplace une piece ; les extremites de fils posees sur ses bornes la
 * suivent, avec un coude ajoute pour garder les angles droits.
 */
export function movePart(s: SchemaBlock, id: string, dx: number, dy: number): void {
  const part = s.parts.find((p) => p.id === id);
  if (!part || (!dx && !dy)) return;
  const before = partPorts(part);
  part.x += dx;
  part.y += dy;
  reattach(s, before, partPorts(part));
}

/** Tourne une piece d'un quart de tour (sens horaire) autour de son centre ; ses fils suivent. */
export function rotatePart(s: SchemaBlock, id: string): void {
  const part = s.parts.find((p) => p.id === id);
  if (!part) return;
  const before = partPorts(part);
  const b = partBox(part);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  part.rot = (((part.rot ?? 0) + 90) % 360) as Rot;
  if (!part.rot) delete part.rot;
  const nb = partBox(part);
  part.x = Math.round(cx - nb.w / 2);
  part.y = Math.round(cy - nb.h / 2);
  reattach(s, before, partPorts(part));
}

/** Miroir gauche-droite d'une piece (AOP : E+ en haut) ; ses fils suivent. */
export function mirrorPart(s: SchemaBlock, id: string): void {
  const part = s.parts.find((p) => p.id === id);
  if (!part) return;
  const before = partPorts(part);
  if (part.mirror) delete part.mirror; else part.mirror = true;
  reattach(s, before, partPorts(part));
}

/**
 * Les extremites de fils posees sur les bornes `before` passent sur les
 * bornes `after` (meme ordre), avec un coude pour garder les angles droits.
 */
function reattach(s: SchemaBlock, before: Port[], after: Port[]): void {
  for (const w of s.wires) {
    let p = wirePts(w);
    let changed = false;
    for (const end of [0, p.length - 1]) {
      const k = before.findIndex((q) => samePt(q, p[end]));
      if (k < 0 || !after[k]) continue;
      const moved = { x: after[k].x, y: after[k].y };
      if (samePt(moved, p[end])) continue;
      const nb = p[end === 0 ? 1 : p.length - 2];
      // Segment voisin : on garde l'equerre avec un coude.
      const horiz = nb.y === p[end].y;
      const straight = horiz ? moved.y === nb.y : moved.x === nb.x;
      const elbow = horiz ? { x: nb.x, y: moved.y } : { x: moved.x, y: nb.y };
      if (end === 0) p = straight ? [moved, ...p.slice(1)] : [moved, elbow, ...p.slice(1)];
      else p = straight ? [...p.slice(0, -1), moved] : [...p.slice(0, -1), elbow, moved];
      changed = true;
    }
    if (changed) w.pts = flat(simplify(p));
  }
  s.wires = s.wires.filter((w) => w.pts.length >= 4);
}

/**
 * Retire une piece. Un dipole dont les deux bornes etaient reliees laisse
 * un fil a sa place (le circuit reste ferme, comme quand on enleve un
 * composant d'un trait de crayon) ; ses annotations partent avec lui.
 */
export function deletePart(s: SchemaBlock, id: string): void {
  const part = s.parts.find((p) => p.id === id);
  if (!part) return;
  const ports = partPorts(part);
  s.parts = s.parts.filter((p) => p !== part);
  s.notes = (s.notes ?? []).filter((n) => n.part !== id);
  if (!s.notes.length) delete s.notes;
  if (ports.length === 2 && ports.every((q) => connectedAt(s, q))) addWire(s, routeOrtho(ports[0], ports[1]));
}

/** Piece sous le point (dans sa boite), la plus recente d'abord. */
export function partAt(s: SchemaBlock, p: { x: number; y: number }): SchemaPart | undefined {
  for (let i = s.parts.length - 1; i >= 0; i--) {
    const b = partBox(s.parts[i]);
    if (p.x >= b.x - 0.3 && p.x <= b.x + b.w + 0.3 && p.y >= b.y - 0.3 && p.y <= b.y + b.h + 0.3) return s.parts[i];
  }
  return undefined;
}

/** Fil (indice) et segment sous le point, a `tol` unites pres. */
export function wireAt(s: SchemaBlock, p: { x: number; y: number }, tol = 0.4): { wire: number; seg: number } | null {
  for (let wi = 0; wi < s.wires.length; wi++) {
    const q = wirePts(s.wires[wi]);
    for (let i = 0; i + 1 < q.length; i++) {
      const a = q[i], b = q[i + 1];
      const inX = p.x >= Math.min(a.x, b.x) - tol && p.x <= Math.max(a.x, b.x) + tol;
      const inY = p.y >= Math.min(a.y, b.y) - tol && p.y <= Math.max(a.y, b.y) + tol;
      if (inX && inY && (a.x === b.x ? Math.abs(p.x - a.x) <= tol : Math.abs(p.y - a.y) <= tol)) return { wire: wi, seg: i };
    }
  }
  return null;
}

/**
 * Pose un dipole sur un fil (survol + lettre) : le fil est coupe la ou la
 * piece le recouvre, ses deux bouts arrivent sur ses bornes. Rend la piece,
 * ou null si le segment est trop court ou si ce n'est pas un dipole.
 */
export function insertOnWire(s: SchemaBlock, sym: SymKey, wire: number, seg: number, near: Pt, width?: number): SchemaPart | null {
  // Bloc ou gain : `width` = sa largeur (texte deja connu), sinon celle du symbole.
  const def = symbolFor(sym, width);
  if (!def.through) return null;
  const pts = wirePts(s.wires[wire]);
  const a = pts[seg], b = pts[seg + 1];
  const horizontal = a.y === b.y;
  const len = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  if (len < def.w) return null;
  const forward = horizontal ? b.x > a.x : b.y > a.y;
  const dir: Dir = horizontal ? (forward ? "right" : "left") : (forward ? "down" : "up");
  const step = DIRS[dir];
  // Debut de la piece : centree sur le point vise, sans depasser le segment.
  const along = horizontal ? Math.round(near.x) - a.x : Math.round(near.y) - a.y;
  let off = Math.round(Math.abs(along) - def.w / 2);
  off = Math.max(0, Math.min(len - def.w, off));
  const start = { x: a.x + step.x * off, y: a.y + step.y * off };
  const end = { x: start.x + step.x * def.w, y: start.y + step.y * def.w };
  const o = orientFor(sym, dir);
  const part = addPart(s, sym, placeFor(sym, o.entry, start, o.rot, false, def.w), o.rot);
  if (def.w !== SYMBOLS[sym].w) part.w = def.w;
  s.wires.splice(wire, 1);
  addWire(s, [...pts.slice(0, seg + 1), start]);
  addWire(s, [end, ...pts.slice(seg + 1)]);
  return part;
}

/** Retire un fil (indice). */
export function deleteWire(s: SchemaBlock, wire: number): void {
  s.wires.splice(wire, 1);
}

/* ---------------- annotations ---------------- */

/** Fleche de tension le long d'une piece (convention recepteur), nommee u_<nom>. */
export function addVoltage(s: SchemaBlock, part: SchemaPart): SchemaNote {
  const n: SchemaNote = { kind: "u", part: part.id, label: part.name ? defaultU(part.name) : "u" };
  (s.notes ??= []).push(n);
  return n;
}

/** Fleche de courant sur un fil, au point vise, dans le sens du segment. */
export function addCurrent(s: SchemaBlock, at: Pt, dir: Dir): SchemaNote {
  const n: SchemaNote = { kind: "i", x: at.x, y: at.y, dir, label: "i" };
  (s.notes ??= []).push(n);
  return n;
}

/** Fleche libre (photo annotee, schema) de a vers b. */
export function addArrow(s: SchemaBlock, a: { x: number; y: number }, b: { x: number; y: number }, line = false): SchemaNote {
  const n: SchemaNote = { kind: line ? "line" : "arrow", x: a.x, y: a.y, x2: b.x, y2: b.y, label: "" };
  (s.notes ??= []).push(n);
  return n;
}

/** Annotation sous le point (fleche, trait, texte, courant), la plus recente d'abord. */
export function noteAt(s: SchemaBlock, p: { x: number; y: number }, tol = 0.5): number {
  const notes = s.notes ?? [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.x === undefined || n.y === undefined) continue;
    if (n.x2 !== undefined && n.y2 !== undefined) {
      const dx = n.x2 - n.x, dy = n.y2 - n.y;
      const L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - n.x) * dx + (p.y - n.y) * dy) / L));
      if (Math.hypot(p.x - (n.x + t * dx), p.y - (n.y + t * dy)) <= tol) return i;
    } else if (Math.hypot(p.x - n.x, p.y - n.y) <= tol * 2) return i;
  }
  return -1;
}

export function addText(s: SchemaBlock, at: Pt, label: string): SchemaNote {
  const n: SchemaNote = { kind: "text", x: at.x, y: at.y, label };
  (s.notes ??= []).push(n);
  return n;
}

/* ---------------- circuit ouvert, court-circuit ---------------- */

/**
 * Circuit ouvert a la place d'un dipole (schema equivalent d'une phase :
 * diode bloquee, interrupteur ouvert) : deux bornes non reliees, memes
 * bornes, memes fils, la fleche de tension reste. Encore une fois : la piece
 * revient (`was`). Rend false si ce n'est pas un dipole.
 */
export function toggleOpen(s: SchemaBlock, id: string): boolean {
  const part = s.parts.find((p) => p.id === id);
  if (!part) return false;
  if (part.sym === "X") {
    if (!part.was || !isSym(part.was)) return false;
    part.sym = part.was;
    delete part.was;
    return true;
  }
  if (!isSym(part.sym) || SYMBOLS[part.sym].through?.[0] !== "a" || SYMBOLS[part.sym].w !== 4) return false;
  part.was = part.sym;
  part.sym = "X";
  return true;
}

/**
 * Court-circuit : la piece (dipole) est remplacee par un fil entre ses deux
 * bornes (interrupteur ferme, diode passante ideale) ; ses annotations partent.
 */
export function shortPart(s: SchemaBlock, id: string): boolean {
  const part = s.parts.find((p) => p.id === id);
  if (!part || !isSym(part.sym) || !SYMBOLS[part.sym].through) return false;
  const d = SYMBOLS[part.sym];
  const ports = partPorts(part);
  const a = ports.find((q) => q.name === d.through![0]), b = ports.find((q) => q.name === d.through![1]);
  if (!a || !b) return false;
  s.parts = s.parts.filter((p) => p !== part);
  s.notes = (s.notes ?? []).filter((n) => n.part !== id);
  if (!s.notes.length) delete s.notes;
  addWire(s, routeOrtho(a, b));
  return true;
}

/* ---------------- annotations : deplacer, retourner ---------------- */

/** Point du fil le plus proche (au demi-carreau), avec le sens du segment ; null si aucun fil a `tol` pres. */
export function nearestOnWire(s: SchemaBlock, p: { x: number; y: number }, tol = 1.2): { at: Pt; horizontal: boolean } | null {
  let best: { at: Pt; horizontal: boolean; d: number } | null = null;
  for (const [a, b] of segments(s)) {
    const horizontal = a.y === b.y;
    if (samePt(a, b)) continue;
    const half = (v: number) => Math.round(v * 2) / 2;
    const at = horizontal
      ? { x: Math.max(Math.min(a.x, b.x), Math.min(Math.max(a.x, b.x), half(p.x))), y: a.y }
      : { x: a.x, y: Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), half(p.y))) };
    const d = Math.hypot(at.x - p.x, at.y - p.y);
    if (d <= tol && (!best || d < best.d)) best = { at, horizontal, d };
  }
  return best ? { at: best.at, horizontal: best.horizontal } : null;
}

/**
 * Fleche de courant au point du fil le plus proche, dans le sens `dir` si
 * on le donne (geste le long du fil), sinon de gauche a droite / de haut en bas.
 */
export function currentOnWire(s: SchemaBlock, p: { x: number; y: number }, dir?: Dir): SchemaNote | null {
  const w = nearestOnWire(s, p);
  if (!w) return null;
  const along: Dir = w.horizontal
    ? (dir === "left" ? "left" : "right")
    : (dir === "up" ? "up" : "down");
  return addCurrent(s, w.at, along);
}

/**
 * Deplace une annotation : un courant glisse le long des fils (il garde son
 * sens sur un fil de meme orientation), un texte, une fleche libre ou un
 * trait suivent le geste au quart de case.
 */
export function moveNote(s: SchemaBlock, i: number, to: { x: number; y: number }, from: { x: number; y: number }): void {
  const n = s.notes?.[i];
  if (!n || n.x === undefined || n.y === undefined) return;
  const q = (v: number) => Math.round(v * 4) / 4;
  if (n.kind === "i") {
    const w = nearestOnWire(s, to);
    if (!w) return;
    const was = DIRS[(n.dir ?? "right") as Dir];
    const wasH = was.y === 0;
    if (wasH !== w.horizontal) n.dir = w.horizontal ? (was.y < 0 ? "left" : "right") : (was.x < 0 ? "up" : "down");
    n.x = w.at.x; n.y = w.at.y;
    return;
  }
  const dx = q(to.x - from.x), dy = q(to.y - from.y);
  n.x = q(n.x + dx); n.y = q(n.y + dy);
  if (n.x2 !== undefined && n.y2 !== undefined) { n.x2 = q(n.x2 + dx); n.y2 = q(n.y2 + dy); }
}

/** Retourne une annotation : sens du courant, sens de la tension, fleche libre. */
export function flipNote(s: SchemaBlock, i: number): void {
  const n = s.notes?.[i];
  if (!n) return;
  if (n.kind === "i") {
    const opp: Record<Dir, Dir> = { right: "left", left: "right", up: "down", down: "up" };
    n.dir = opp[(n.dir ?? "right") as Dir];
  } else if (n.kind === "u") {
    if (n.flip) delete n.flip; else n.flip = true;
  } else if (n.x2 !== undefined && n.y2 !== undefined && n.x !== undefined && n.y !== undefined) {
    [n.x, n.y, n.x2, n.y2] = [n.x2, n.y2, n.x, n.y];
  }
}

/* ---------------- groupe : selection, copier, coller ---------------- */

export interface Rect { x: number; y: number; w: number; h: number }

function inRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Pieces (ids) dont la boite est entierement dans le rectangle. */
export function partsIn(s: SchemaBlock, r: Rect): string[] {
  return s.parts.filter((p) => { const b = partBox(p); return inRect(b, r) && inRect({ x: b.x + b.w, y: b.y + b.h }, r); }).map((p) => p.id);
}

/**
 * Deplace un groupe de pieces : les fils entierement dans le rectangle `r`
 * (ou entre deux pieces du groupe) bougent en bloc, les autres suivent par
 * leurs extremites ; les annotations libres dans `r` suivent aussi.
 */
export function moveGroup(s: SchemaBlock, ids: string[], r: Rect | null, dx: number, dy: number): void {
  if (!dx && !dy) return;
  const group = s.parts.filter((p) => ids.includes(p.id));
  const before = group.flatMap((p) => partPorts(p));
  const key = (p: Pt) => `${p.x},${p.y}`;
  const ports = new Set(before.map(key));
  // Fils qui bougent en bloc : tous leurs points dans r, ou leurs deux bouts sur le groupe.
  const whole = new Set<number>();
  s.wires.forEach((w, i) => {
    const p = wirePts(w);
    if ((r && p.every((q) => inRect(q, r))) || (ports.has(key(p[0])) && ports.has(key(p[p.length - 1])))) whole.add(i);
  });
  for (const i of whole) s.wires[i].pts = s.wires[i].pts.map((v, k) => v + (k % 2 ? dy : dx));
  for (const p of group) { p.x += dx; p.y += dy; }
  const after = group.flatMap((p) => partPorts(p));
  // Les autres fils suivent leurs extremites (le bloc deja bouge n'est pas retouche).
  const moved = s.wires.filter((_w, i) => whole.has(i));
  const rest = s.wires.filter((_w, i) => !whole.has(i));
  const tmp: SchemaBlock = { ...s, wires: rest };
  reattach(tmp, before, after);
  s.wires = [...moved, ...tmp.wires];
  for (const n of s.notes ?? []) {
    if (n.part || n.x === undefined || n.y === undefined || !r || !inRect({ x: n.x, y: n.y }, r)) continue;
    n.x += dx; n.y += dy;
    if (n.x2 !== undefined && n.y2 !== undefined) { n.x2 += dx; n.y2 += dy; }
  }
}

/** Morceau de schema copie : pieces du groupe, fils et annotations dans r. */
export function extractGroup(s: SchemaBlock, ids: string[], r: Rect | null): Pick<SchemaBlock, "parts" | "wires" | "notes"> {
  const parts = s.parts.filter((p) => ids.includes(p.id));
  const ports = new Set(parts.flatMap((p) => partPorts(p)).map((q) => `${q.x},${q.y}`));
  const wires = s.wires.filter((w) => {
    const p = wirePts(w);
    return (r && p.every((q) => inRect(q, r))) || (ports.has(`${p[0].x},${p[0].y}`) && ports.has(`${p[p.length - 1].x},${p[p.length - 1].y}`));
  });
  const notes = (s.notes ?? []).filter((n) => (n.part ? ids.includes(n.part) : !!r && n.x !== undefined && n.y !== undefined && inRect({ x: n.x, y: n.y }, r)));
  return JSON.parse(JSON.stringify({ parts, wires, notes })) as Pick<SchemaBlock, "parts" | "wires" | "notes">;
}

/**
 * Colle un morceau (copie, modele) decale de (dx, dy) : nouveaux ids, noms
 * suivants (« R » deja pris : R2...). Rend les ids des pieces collees.
 */
export function pasteGroup(s: SchemaBlock, g: Pick<SchemaBlock, "parts" | "wires" | "notes">, dx: number, dy: number, keepNames = false): string[] {
  const map = new Map<string, string>();
  const out: string[] = [];
  for (const p0 of g.parts) {
    const p: SchemaPart = { ...p0, x: p0.x + dx, y: p0.y + dy, id: newId(s) };
    map.set(p0.id, p.id);
    const taken = s.parts.some((q) => q.name === p.name);
    if (p.name && isSym(p.sym) && (!keepNames || taken)) {
      const pre = NAME_PREFIX[p.sym];
      // Un nom tape a la main (« Rf ») reste ; un nom automatique prend le suivant.
      if (pre && (p.name === pre || new RegExp(`^${pre}\\d+$`).test(p.name))) {
        const nm = nextName(s, p.sym);
        if (nm) {
          const bare = nm !== pre ? s.parts.find((q) => q.name === pre) : undefined;
          if (bare) bare.name = `${pre}1`;
          p.name = nm;
        }
      }
    }
    s.parts.push(p);
    out.push(p.id);
  }
  for (const w of g.wires) s.wires.push({ pts: w.pts.map((v, k) => v + (k % 2 ? dy : dx)) });
  for (const n0 of g.notes ?? []) {
    const n: SchemaNote = { ...n0 };
    if (n.part) { const id = map.get(n.part); if (!id) continue; n.part = id; }
    if (n.x !== undefined) n.x += dx;
    if (n.y !== undefined) n.y += dy;
    if (n.x2 !== undefined) n.x2 += dx;
    if (n.y2 !== undefined) n.y2 += dy;
    (s.notes ??= []).push(n);
  }
  return out;
}

/* ---------------- schemas-blocs : bloc a la taille du texte, signes, retours ---------------- */

/** Encombrement du texte d'un bloc ou d'un gain, en cases (comme les etiquettes : 0,95 case de haut). */
function valueTextW(v: string | undefined): number {
  return labelWidth(v ?? "") * 0.95;
}

/** Point decale de `d` cases dans le sens `v`. */
function along(p: Pt, v: Pt, d: number): Pt { return { x: p.x + v.x * d, y: p.y + v.y * d }; }

/**
 * Bloc ou gain mis a la largeur `w` (cases) : sa borne d'entree ne bouge
 * pas, la sortie avance (ou recule). Pour garder la place, tout ce qui est
 * au-dela de l'ancienne sortie (pieces, fils, annotations) glisse d'autant,
 * comme on insere des colonnes ; un retour qui enjambe le bloc s'allonge.
 * Retrecir ne se fait que si la bande liberee est vide. Rend l'ancienne et
 * la nouvelle place de la sortie (le curseur clavier la suit), ou null.
 */
export function stretchPart(s: SchemaBlock, id: string, w: number): { from: Pt; to: Pt } | null {
  const part = s.parts.find((p) => p.id === id);
  if (!part || !isSym(part.sym) || !STRETCH.has(part.sym)) return null;
  const sym = part.sym;
  const oldW = part.w ?? SYMBOLS[sym].w;
  if (w === oldW || w < 2) return null;
  const before = partPorts(part);
  const inB = before.find((q) => q.name === "in")!, outB = before.find((q) => q.name === "out")!;
  const dir = { x: Math.sign(outB.x - inB.x), y: Math.sign(outB.y - inB.y) };
  const delta = w - oldW;
  const shift = along({ x: 0, y: 0 }, dir, delta);
  // Coordonnee le long du sens de la sortie : « au-dela » = au moins l'ancienne sortie.
  const key = (p: Pt) => p.x * dir.x + p.y * dir.y;
  const edge = key(outB);
  const others = s.parts.filter((p) => p !== part);
  const beyond = (p: Pt) => key(p) >= edge - 1e-9;
  const boxLo = (q: SchemaPart) => { const b = partBox(q); return Math.min(key({ x: b.x, y: b.y }), key({ x: b.x + b.w, y: b.y + b.h })); };
  const boxHi = (q: SchemaPart) => { const b = partBox(q); return Math.max(key({ x: b.x, y: b.y }), key({ x: b.x + b.w, y: b.y + b.h })); };
  // Une piece a cheval sur l'ancienne sortie : on ne peut pas inserer de colonnes proprement.
  const room = !others.some((q) => boxLo(q) < edge - 1e-9 && partPorts(q).some((r) => beyond(r)));
  if (delta < 0) {
    // Retrecir : rien entre la nouvelle et l'ancienne sortie.
    const lo = edge + delta;
    const inBand = (v: number) => v > lo + 1e-9 && v < edge - 1e-9;
    const busy = s.wires.some((wi) => wirePts(wi).some((p) => inBand(key(p)) && !(p.y === outB.y && p.x === outB.x)))
      || others.some((q) => boxHi(q) > lo + 1e-9 && boxLo(q) < edge - 1e-9)
      || (s.notes ?? []).some((n) => (n.x !== undefined && n.y !== undefined && inBand(key({ x: n.x, y: n.y }))) || (n.x2 !== undefined && n.y2 !== undefined && inBand(key({ x: n.x2, y: n.y2 }))));
    if (busy || !room) return null;
  }
  // Nouvelle largeur, l'entree reste a sa place.
  part.w = w;
  if (w === SYMBOLS[sym].w) delete part.w;
  const inA = partPorts(part).find((q) => q.name === "in")!;
  part.x += inB.x - inA.x;
  part.y += inB.y - inA.y;
  const after = partPorts(part);
  const outA = after.find((q) => q.name === "out")!;
  if (room) {
    for (const q of others) if (boxLo(q) >= edge - 1e-9) { q.x += shift.x; q.y += shift.y; }
    for (const wi of s.wires) {
      const p = wirePts(wi).map((q) => (beyond(q) ? { x: q.x + shift.x, y: q.y + shift.y } : q));
      wi.pts = flat(simplify(p));
    }
    for (const n of s.notes ?? []) {
      if (n.x !== undefined && n.y !== undefined && beyond({ x: n.x, y: n.y })) { n.x += shift.x; n.y += shift.y; }
      if (n.x2 !== undefined && n.y2 !== undefined && beyond({ x: n.x2, y: n.y2 })) { n.x2 += shift.x; n.y2 += shift.y; }
    }
    s.wires = s.wires.filter((wi) => wi.pts.length >= 4);
  } else {
    reattach(s, before, after);
  }
  return { from: { x: outB.x, y: outB.y }, to: { x: outA.x, y: outA.y } };
}

/**
 * Valeur d'une piece (vide : retiree). Bloc et gain : leur largeur suit le
 * texte (`fitWidth`), voir `stretchPart`. Rend le deplacement de la sortie.
 */
export function setPartValue(s: SchemaBlock, id: string, value: string): { from: Pt; to: Pt } | null {
  const part = s.parts.find((p) => p.id === id);
  if (!part) return null;
  const v = value.trim();
  if (v) part.value = v; else delete part.value;
  if (!isSym(part.sym) || !STRETCH.has(part.sym)) return null;
  return stretchPart(s, id, fitWidth(part.sym, valueTextW(part.value)));
}

/** Entrees d'un sommateur, dans l'ordre de sa valeur (« +-- » : in, in2, in3). */
export const SUM_INPUTS = ["in", "in2", "in3"] as const;

/** Bornes du sommateur ou arrive un fil. */
export function sumConnected(s: SchemaBlock, part: SchemaPart): Set<string> {
  const out = new Set<string>();
  for (const q of partPorts(part)) {
    if (!(SUM_INPUTS as readonly string[]).includes(q.name)) continue;
    if (s.wires.some((w) => { const p = wirePts(w); return p.length >= 2 && (samePt(p[0], q) || samePt(p[p.length - 1], q)); })) out.add(q.name);
  }
  return out;
}

/**
 * Signe de chaque entree d'un sommateur : celui de sa valeur s'il est donne
 * (« +- », « +-- »), sinon + a gauche (in) et − sur les autres (un retour
 * arrive presque toujours par le haut ou par le bas).
 */
export function sumSigns(part: SchemaPart): Record<string, "+" | "−"> {
  const v = (part.value ?? "").replace(/\s/g, "").replace(/−/g, "-");
  const out: Record<string, "+" | "−"> = {};
  SUM_INPUTS.forEach((name, i) => {
    out[name] = v[i] === "-" ? "−" : v[i] === "+" ? "+" : name === "in" ? "+" : "−";
  });
  return out;
}

/** Un clic sur un signe du sommateur : + devient −, − devient +. */
export function toggleSign(s: SchemaBlock, id: string, port: string): boolean {
  const part = s.parts.find((p) => p.id === id);
  const i = (SUM_INPUTS as readonly string[]).indexOf(port);
  if (!part || part.sym !== "S" || i < 0) return false;
  const signs = sumSigns(part);
  signs[port] = signs[port] === "+" ? "−" : "+";
  part.value = SUM_INPUTS.map((n) => (signs[n] === "+" ? "+" : "-")).join("");
  return true;
}

/** Sens vers l'exterieur d'une borne (du centre de la piece vers elle), sur un axe. */
export function portOutward(part: SchemaPart, port: Pt): Pt {
  const b = partBox(part);
  const dx = port.x - (b.x + b.w / 2), dy = port.y - (b.y + b.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
  return { x: 0, y: Math.sign(dy) || 1 };
}

/** Piece et borne posees exactement en `p`. */
export function portAt(s: SchemaBlock, p: Pt): { part: SchemaPart; port: Port } | null {
  for (const part of s.parts) for (const port of partPorts(part)) if (samePt(port, p)) return { part, port };
  return null;
}

/** Borne libre la plus proche de `g` (a `tol` cases pres), pour aimanter la fin d'un fil. */
export function freePortNear(s: SchemaBlock, g: { x: number; y: number }, tol = 0.9): Pt | null {
  let best: Pt | null = null, bd = tol;
  for (const f of freePorts(s)) {
    const d = Math.hypot(f.port.x - g.x, f.port.y - g.y);
    if (d <= bd) { bd = d; best = { x: f.port.x, y: f.port.y }; }
  }
  return best;
}

const BLOCK_SYMS = new Set(["B", "Gain", "S"]);

/** Borne d'entree d'un schema-bloc (bloc, gain, sommateur) en `p`. */
export function blockInputAt(s: SchemaBlock, p: Pt): boolean {
  const hit = portAt(s, p);
  return !!hit && BLOCK_SYMS.has(hit.part.sym) && hit.port.name !== "out";
}

/** Le segment passe-t-il dans la boite elargie de `pad` (pad < 0 : interieur strict) ? */
function segCrossesBox(a: Pt, b: Pt, r: { x: number; y: number; w: number; h: number }, pad = -0.05): boolean {
  const x0 = r.x - pad, x1 = r.x + r.w + pad, y0 = r.y - pad, y1 = r.y + r.h + pad;
  if (a.y === b.y) return a.y > y0 && a.y < y1 && Math.max(a.x, b.x) > x0 && Math.min(a.x, b.x) < x1;
  if (a.x === b.x) return a.x > x0 && a.x < x1 && Math.max(a.y, b.y) > y0 && Math.min(a.y, b.y) < y1;
  return false;
}

/** Longueur commune d'un segment avec les fils deja poses (deux fils l'un sur l'autre : illisible). */
function overlapLen(s: SchemaBlock, a: Pt, b: Pt): number {
  let o = 0;
  for (const [c, d] of segments(s)) {
    if (a.y === b.y && c.y === d.y && c.y === a.y) {
      o += Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
    } else if (a.x === b.x && c.x === d.x && c.x === a.x) {
      o += Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
    }
  }
  return o;
}

/**
 * Fil a angles droits de `from` vers `to` qui contourne les pieces : sort
 * d'une borne dans son sens, arrive sur une borne par son cote (entree − du
 * bas d'un sommateur : par le bas), et passe par-dessous ou par-dessus ce
 * qui se trouve entre les deux (boucle de retour), a 3 cases du bord pour
 * qu'un gain tienne ensuite sur le retour. Le chemin le plus court sans
 * traverser de piece ni longer un autre fil est choisi.
 */
export function routeAround(s: SchemaBlock, from0: Pt, to0: Pt): Pt[] {
  const from = { x: from0.x, y: from0.y }, to = { x: to0.x, y: to0.y };
  const src = portAt(s, from), dst = portAt(s, to);
  const u = src ? portOutward(src.part, src.port) : null;
  const v = dst ? portOutward(dst.part, dst.port) : null;
  const a1 = u ? along(from, u, 1) : from;
  const b1 = v ? along(to, v, 1) : to;
  const boxes = s.parts.map(partBox);
  // Ni dans une piece, ni a moins d'une case de son bord (sauf la borne de depart ou d'arrivee).
  const PAD = 0.9;
  const own = s.parts.map((p) => p === src?.part || p === dst?.part);
  const hits = (p: Pt, q: Pt) => boxes.some((b, i) => {
    if (own[i] && (samePt(p, from) || samePt(q, from) || samePt(p, to) || samePt(q, to))) return segCrossesBox(p, q, b);
    return segCrossesBox(p, q, b, PAD);
  });
  const cands: Pt[][] = [];
  const mid = (pts: Pt[]) => cands.push(simplify([from, ...pts, to]));
  mid([a1, { x: b1.x, y: a1.y }, b1]);
  mid([a1, { x: a1.x, y: b1.y }, b1]);
  // Par-dessous / par-dessus tout ce qui est entre les deux (pieces et fils).
  const xa = Math.min(a1.x, b1.x), xb = Math.max(a1.x, b1.x);
  let lo = Math.min(from.y, to.y), hi = Math.max(from.y, to.y);
  for (const b of boxes) if (b.x < xb + 0.5 && b.x + b.w > xa - 0.5) { lo = Math.min(lo, b.y); hi = Math.max(hi, b.y + b.h); }
  for (const [c, d] of segments(s)) {
    if (c.y === d.y && Math.max(c.x, d.x) > xa && Math.min(c.x, d.x) < xb) { lo = Math.min(lo, c.y); hi = Math.max(hi, c.y); }
  }
  for (const y of [hi + 3, lo - 3]) mid([a1, { x: a1.x, y }, { x: b1.x, y }, b1]);
  // Idem a gauche / a droite (retour vertical).
  const ya = Math.min(a1.y, b1.y), yb = Math.max(a1.y, b1.y);
  let l = Math.min(from.x, to.x), r = Math.max(from.x, to.x);
  for (const b of boxes) if (b.y < yb + 0.5 && b.y + b.h > ya - 0.5) { l = Math.min(l, b.x); r = Math.max(r, b.x + b.w); }
  for (const x of [r + 3, l - 3]) mid([a1, { x, y: a1.y }, { x, y: b1.y }, b1]);
  let best: Pt[] = routeOrtho(from, to), bestScore = Infinity;
  for (const c of cands) {
    let len = 0, bad = false, over = 0;
    for (let i = 0; i + 1 < c.length; i++) {
      const p = c[i], q = c[i + 1];
      if (p.x !== q.x && p.y !== q.y) { bad = true; break; }
      len += Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      if (hits(p, q)) { bad = true; break; }
      over += overlapLen(s, p, q);
      // Pas de demi-tour sur soi-meme.
      if (i > 0) {
        const o = c[i - 1];
        if ((o.x - p.x) * (q.x - p.x) + (o.y - p.y) * (q.y - p.y) > 0) { bad = true; break; }
      }
    }
    if (bad) continue;
    const score = len + 4 * (c.length - 2) + 50 * over;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/* ---------------- dimensions ---------------- */

/** Boite de tout le schema, en unites de grille (marge comprise). */
export function schemaBounds(s: SchemaBlock, margin = 2): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of s.parts) { const b = partBox(p); grow(b.x, b.y); grow(b.x + b.w, b.y + b.h); }
  for (const w of s.wires) for (const p of wirePts(w)) grow(p.x, p.y);
  for (const n of s.notes ?? []) {
    if (n.x !== undefined && n.y !== undefined) grow(n.x, n.y);
    if (n.x2 !== undefined && n.y2 !== undefined) grow(n.x2, n.y2);
  }
  // Photo annotee : le cadre est celui de la photo (les annotations debordant rarement).
  if (s.under) return { x: 0, y: 0, w: s.under.w / SCHEMA_UNIT, h: s.under.h / SCHEMA_UNIT };
  if (x0 === Infinity) return { x: 0, y: 0, w: 20, h: 10 };
  return { x: x0 - margin, y: y0 - margin, w: x1 - x0 + 2 * margin, h: y1 - y0 + 2 * margin };
}

/* ---------------- saisie au clavier (tortue) ---------------- */

/**
 * Curseur de saisie au clavier. `nodes` : noeuds retenus par « . », la
 * masse y ramene. `pick` : borne libre choisie par Tab (Entree la relie).
 */
export interface Turtle {
  at: Pt;
  dir: Dir;
  nodes: Pt[];
  pick?: Pt;
}

export function newTurtle(at: Pt = { x: 2, y: 4 }): Turtle {
  return { at: { ...at }, dir: "right", nodes: [] };
}

/** Fleche : le fil s'allonge de `n` cases depuis le curseur (un coude si la direction change). */
export function turtleMove(s: SchemaBlock, t: Turtle, dir: Dir, n = 1): void {
  const d = DIRS[dir];
  const to = { x: t.at.x + d.x * n, y: t.at.y + d.y * n };
  // Prolonge le fil qui finit au curseur, sinon en commence un.
  const w = s.wires.find((x) => { const p = wirePts(x); return p.length >= 2 && samePt(p[p.length - 1], t.at); });
  if (w) w.pts = flat(simplify([...wirePts(w), to]));
  else addWire(s, [t.at, to]);
  t.at = to;
  t.dir = dir;
  t.pick = undefined;
}

/** Deplace le curseur sans tracer (Maj + fleche : on va poser plus loin). */
export function turtleJump(t: Turtle, dir: Dir, n = 1): void {
  const d = DIRS[dir];
  t.at = { x: t.at.x + d.x * n, y: t.at.y + d.y * n };
  t.dir = dir;
  t.pick = undefined;
}

/** Borne d'entree d'une piece sans « through » (AOP : E+ ; transistor : base ou grille). */
const ENTRY: Partial<Record<SymKey, { in: string; out?: string }>> = {
  A: { in: "p", out: "s" }, Q: { in: "b", out: "c" }, Qp: { in: "b", out: "c" },
  M: { in: "g", out: "d" }, Mp: { in: "g", out: "d" }, G: { in: "a" }, O: { in: "a" },
  T: { in: "a1", out: "a2" },
};

/**
 * Lettre : pose la piece au curseur, orientee dans le sens du trace ; le
 * curseur repart de sa borne de sortie. Masse : elle termine la branche,
 * le curseur revient au dernier noeud retenu. Rend la piece posee.
 */
export function turtlePlace(s: SchemaBlock, t: Turtle, sym: SymKey): SchemaPart {
  const def = SYMBOLS[sym];
  t.pick = undefined;
  if (def.through) {
    const o = orientFor(sym, t.dir);
    const part = addPart(s, sym, placeFor(sym, o.entry, t.at, o.rot), o.rot);
    const out = partPorts(part).find((q) => q.name === o.exit);
    if (out) t.at = { x: out.x, y: out.y };
    return part;
  }
  const e = ENTRY[sym] ?? { in: def.ports[0]?.name ?? "a" };
  const part = addPart(s, sym, placeFor(sym, e.in, t.at, 0), 0);
  if (sym === "G") {
    const back = t.nodes.pop();
    if (back) { t.at = back; t.dir = "right"; }
  } else if (e.out) {
    const out = partPorts(part).find((q) => q.name === e.out);
    if (out) { t.at = { x: out.x, y: out.y }; t.dir = "right"; }
  }
  return part;
}

/** Lettre tapee : symbole correspondant (Maj : la variante), ou rien. */
export function letterSymbol(key: string): SymKey | undefined {
  return symbolByLetter(key)?.key;
}

/** « . » : retient le point du curseur comme noeud. */
export function turtleNode(t: Turtle): void {
  if (!t.nodes.some((n) => samePt(n, t.at))) t.nodes.push({ ...t.at });
}

/** Tab : borne libre suivante, la plus proche du curseur d'abord ; ou rien. */
export function turtleNextFree(s: SchemaBlock, t: Turtle, back = false): Pt | undefined {
  // La plus proche du curseur d'abord : c'est presque toujours celle qu'on vise.
  const dist = (p: Pt) => Math.abs(p.x - t.at.x) + Math.abs(p.y - t.at.y);
  const free = freePorts(s).map((f) => f.port).filter((p) => !samePt(p, t.at)).sort((a, b) => dist(a) - dist(b));
  if (!free.length) { t.pick = undefined; return undefined; }
  const i = t.pick ? free.findIndex((p) => samePt(p, t.pick!)) : -1;
  const next = free[((i < 0 ? (back ? 0 : -1) : i) + (back ? -1 : 1) + free.length) % free.length];
  t.pick = { x: next.x, y: next.y };
  return t.pick;
}

/** Entree : relie le curseur a la borne choisie par un fil a angles droits. */
export function turtleConnect(s: SchemaBlock, t: Turtle): boolean {
  if (!t.pick) return false;
  const vertical = t.dir === "up" || t.dir === "down";
  addWire(s, routeOrtho(t.at, t.pick, vertical));
  t.at = t.pick;
  t.pick = undefined;
  return true;
}

/* ---------------- place dans la page ---------------- */

/** Taille d'une case de grille dans la page, en unites de page. */
export const SCHEMA_UNIT = 16;
/** Largeur maximale d'un schema dans le texte (unites de page). */
export const SCHEMA_MAX_W = 700;

/** Largeur du schema dans le texte, en unites de page (taille naturelle, bornee). */
export function schemaWidth(b: SchemaBlock): number {
  if (b.under) return Math.round(b.under.w);
  if (b.width) return Math.min(SCHEMA_MAX_W, b.width);
  return Math.max(160, Math.min(SCHEMA_MAX_W, Math.round(schemaBounds(b).w * SCHEMA_UNIT)));
}

