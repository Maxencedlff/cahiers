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
import { SYMBOLS, portsAt, symbolByLetter, type Port, type SymKey } from "./symbols";

export interface Pt { x: number; y: number }
export type Dir = "right" | "left" | "up" | "down";
export type Rot = 0 | 90 | 180 | 270;

export const DIRS: Record<Dir, Pt> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

/** Rotation qui oriente un dipole (borne d'entree vers borne de sortie) dans la direction du trace. */
export function rotForDir(d: Dir): Rot {
  return d === "right" ? 0 : d === "down" ? 90 : d === "left" ? 180 : 270;
}

export function samePt(a: Pt, b: Pt): boolean { return a.x === b.x && a.y === b.y; }

export function emptySchema(id: string): SchemaBlock {
  return { id, type: "schema", parts: [], wires: [] };
}

function isSym(k: string): k is SymKey { return Object.prototype.hasOwnProperty.call(SYMBOLS, k); }

/** Bornes d'une piece posee, en coordonnees de grille. */
export function partPorts(p: SchemaPart): Port[] {
  if (!isSym(p.sym)) return [];
  return portsAt(p.sym, p.x, p.y, p.rot ?? 0, p.mirror);
}

/** Boite d'une piece posee (dimensions tournees). */
export function partBox(p: SchemaPart): { x: number; y: number; w: number; h: number } {
  const d = isSym(p.sym) ? SYMBOLS[p.sym] : { w: 2, h: 2 };
  const turned = (p.rot ?? 0) % 180 !== 0;
  return { x: p.x, y: p.y, w: turned ? d.h : d.w, h: turned ? d.w : d.h };
}

/** Coin haut-gauche ou poser `sym` pour que sa borne `port` tombe sur `at`. */
export function placeFor(sym: SymKey, port: string, at: Pt, rot: Rot, mirror?: boolean): Pt {
  const p = portsAt(sym, 0, 0, rot, mirror).find((q) => q.name === port);
  return p ? { x: at.x - p.x, y: at.y - p.y } : { x: at.x, y: at.y };
}

/* ---------------- noms ---------------- */

const NAME_PREFIX: Partial<Record<SymKey, string>> = {
  R: "R", Pot: "R", C: "C", Cp: "C", L: "L", D: "D", Dz: "D", LED: "D", K: "K", V: "E", Vdc: "E", I: "I",
  Q: "Q", Qp: "Q", M: "M", Mp: "M", T: "T", F: "F", Lamp: "H",
};

/** Nom suivant d'une piece (« R3 » s'il y a deja R1 et R2), rien pour une masse, un AOP, un bloc. */
export function nextName(s: SchemaBlock, sym: SymKey): string | undefined {
  const pre = NAME_PREFIX[sym];
  if (!pre) return undefined;
  let n = 1;
  const used = new Set(s.parts.map((p) => p.name));
  while (used.has(`${pre}${n}`)) n++;
  return `${pre}${n}`;
}

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
  if (name) part.name = name;
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
export function insertOnWire(s: SchemaBlock, sym: SymKey, wire: number, seg: number, near: Pt): SchemaPart | null {
  const def = SYMBOLS[sym];
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
  const rot = rotForDir(dir);
  const part = addPart(s, sym, placeFor(sym, def.through[0], start, rot), rot);
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
  const n: SchemaNote = { kind: "u", part: part.id, label: part.name ? `u${part.name}` : "u" };
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
    const rot = rotForDir(t.dir);
    const part = addPart(s, sym, placeFor(sym, def.through[0], t.at, rot), rot);
    const out = partPorts(part).find((q) => q.name === def.through![1]);
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

