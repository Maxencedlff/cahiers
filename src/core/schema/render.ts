/**
 * Dessin d'un schema (logique pure, aucun DOM) : le SVG de la geometrie
 * (pieces, fils, points de jonction, fleches) et la liste des etiquettes
 * a poser par-dessus (noms, valeurs, annotations), que l'interface rend en
 * formules (KaTeX) a leur place. Unites : grille (symbols.ts GRID).
 */
import type { SchemaBlock, SchemaNote, SchemaPart } from "../types";
import { SYMBOLS, rotatePoint, symbolFor, type SymKey } from "./symbols";
import { DIRS, junctions, partBox, partPorts, portOutward, schemaBounds, segments, sumConnected, sumSigns, wirePts, type Dir, type Pt } from "./model";
import { labelWidth } from "./label";

export interface SchemaLabel {
  x: number;
  y: number;
  /** Ou le texte s'accroche au point : a gauche, au milieu ou a droite. */
  anchor: "start" | "middle" | "end";
  /** Lignes tapees (« R1 », « 10k ») : l'interface les lit en formules. */
  lines: string[];
  /** Piece ou annotation qui porte l'etiquette (edition au double-clic). */
  part?: string;
  note?: number;
  /** Ligne du nom (0) ou de la valeur (1) d'une piece : edition au double-clic. */
  field?: "name" | "value";
  /** Place calculee librement (nom, valeur, fleche) : elle peut s'ecarter d'un chevauchement. */
  auto?: boolean;
  /** Sens ou l'ecarter d'abord (vers l'exterieur de ce qu'elle nomme). */
  away?: Pt;
  /** Signe d'une entree de sommateur (borne in, in2, in3) : un clic le change. */
  sign?: string;
}

/** Boite estimee d'une etiquette, en cases (le texte fait 0,95 case). */
export function labelBox(l: SchemaLabel): { x: number; y: number; w: number; h: number } {
  const w = Math.max(0.6, ...l.lines.map((t) => labelWidth(t) * 0.95));
  const h = l.lines.length * 1.05;
  const x = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
  return { x, y: l.y - h / 2, w, h };
}

export interface SchemaDrawing {
  /** Contenu SVG (sans la balise <svg>), en unites de grille. */
  body: string;
  labels: SchemaLabel[];
  /** viewBox : boite du schema, marge comprise. */
  box: { x: number; y: number; w: number; h: number };
  /** Traits des annotations (fleches de tension, courants, fleches libres) : pour les attraper a la souris. */
  hits: { note: number; a: Pt; b: Pt }[];
}

const STROKE = 0.09;

function isSym(k: string): k is SymKey { return Object.prototype.hasOwnProperty.call(SYMBOLS, k); }

/** Transformation SVG d'une piece : miroir (avant), rotation horaire, puis position. */
export function partTransform(p: SchemaPart): string {
  if (!isSym(p.sym)) return `translate(${p.x} ${p.y})`;
  const { w, h } = symbolFor(p.sym, p.w);
  const rot = p.rot ?? 0;
  const m = rot === 90 ? `matrix(0 1 -1 0 ${h} 0)` : rot === 180 ? `matrix(-1 0 0 -1 ${w} ${h})`
    : rot === 270 ? `matrix(0 -1 1 0 0 ${w})` : "";
  const mirror = p.mirror ? ` matrix(-1 0 0 1 ${w} 0)` : "";
  return `translate(${p.x} ${p.y})${m ? ` ${m}` : ""}${mirror}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** Fleche (trait + pointe pleine) de a vers b. */
function arrow(a: Pt, b: Pt, cls: string): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const head = 0.55, half = 0.25;
  const bx = b.x - ux * head, by = b.y - uy * head;
  const pts = `${b.x},${b.y} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`;
  return `<g class="${cls}"><line x1="${a.x}" y1="${a.y}" x2="${bx}" y2="${by}"/><polygon points="${pts}" fill="currentColor" stroke="none"/></g>`;
}

/** Unite ajoutee a une valeur tapee nue (« 10k » d'une resistance -> 10 kΩ). */
const UNIT_OF: Partial<Record<SymKey, string>> = { R: "Ω", Pot: "Ω", C: "F", Cp: "F", L: "H", V: "V", Vdc: "V", I: "A", F: "A" };

/** Valeur telle qu'on l'ecrit : nombre, prefixe (u -> µ), unite du composant si elle manque. */
export function valueText(sym: string, value: string): string {
  const v = value.trim();
  const unit = isSym(sym) ? UNIT_OF[sym] : undefined;
  // LTspice ecrit aussi « 1K », « 2.2Meg » : k et M.
  const m = /^(\d+(?:[.,]\d+)?)\s*([pnuµmkKMG]|Meg)?$/i.exec(v);
  if (!unit || !m) return v;
  const pre = !m[2] ? "" : /^meg$/i.test(m[2]) ? "M" : m[2] === "u" ? "µ" : m[2] === "K" ? "k" : m[2];
  return `${m[1].replace(".", ",")} ${pre}${unit}`;
}

/**
 * Etiquettes d'une piece : le nom du cote du point d'accroche du symbole
 * (au-dessus d'un dipole horizontal), la valeur de l'autre cote ; piece
 * verticale : les deux a cote, l'un sous l'autre. Elles tournent avec elle.
 */
function partLabels(p: SchemaPart): SchemaLabel[] {
  if (!isSym(p.sym) || p.sym === "X") return [];
  // Sommateur : sa valeur est le jeu de signes, dessine a ses entrees.
  const name = p.name?.trim(), value = p.value?.trim() && p.sym !== "S" ? valueText(p.sym, p.value) : undefined;
  if (!name && !value) return [];
  const d = symbolFor(p.sym, p.w);
  // Le texte ne tourne pas avec la piece : un dipole trace vers la gauche
  // (rot 180) garde son nom au-dessus, vers le haut (270) a droite comme vers le bas.
  // Gain : le texte reste dans la partie large du triangle, donc il le suit.
  const keep = !!d.through && p.sym !== "Gain";
  const rot = (p.rot === 180 && keep ? 0 : p.rot === 270 && keep ? 90 : p.rot ?? 0) as 0 | 90 | 180 | 270;
  const lx = p.mirror ? d.w - d.labelAt.x : d.labelAt.x;
  const r = rotatePoint(lx, d.labelAt.y, rot, d.w, d.h);
  // Bloc, gain : le texte au centre, une seule etiquette.
  const centered = d.labelAt.anchor === "middle" && d.labelAt.y > 0 && d.labelAt.y < d.h;
  // Piece verticale : l'etiquette passe a cote, alignee sur le bord.
  let anchor = d.labelAt.anchor;
  if (rot === 90 && !centered) anchor = "start";
  else if (rot === 270 && !centered) anchor = "end";
  const at = { x: p.x + r.x, y: p.y + r.y };
  const out = { x: rot === 90 ? 1 : rot === 270 ? -1 : 0, y: rot === 0 || rot === 180 ? (r.y < d.h / 2 ? -1 : 1) : 0 };
  if (rot % 180 !== 0 || centered || !name || !value) {
    return [{ ...at, anchor, lines: [name, value].filter((x): x is string => !!x), part: p.id, field: name ? "name" : "value", auto: !centered, away: out }];
  }
  // Dipole horizontal : la valeur de l'autre cote de l'axe, a la meme distance.
  const box = rot % 180 === 0 ? { h: d.h } : { h: d.w };
  const other = { x: at.x, y: p.y + box.h - (at.y - p.y) };
  return [
    { ...at, anchor, lines: [name], part: p.id, field: "name", auto: true, away: out },
    { ...other, anchor, lines: [value], part: p.id, field: "value", auto: true, away: { x: 0, y: -out.y } },
  ];
}

/** Etiquette principale d'une piece (cote du nom), pour placer la fleche de tension a l'oppose. */
function partLabel(p: SchemaPart): SchemaLabel | null {
  return partLabels(p)[0] ?? null;
}

/**
 * Fleche de tension le long d'une piece a deux bornes d'entree/sortie :
 * convention recepteur (la fleche va de la sortie vers l'entree, a
 * l'oppose du courant), decalee du cote oppose a l'etiquette.
 */
function voltage(s: SchemaBlock, n: SchemaNote, index: number): { svg: string; label: SchemaLabel; a: Pt; b: Pt } | null {
  const part = s.parts.find((p) => p.id === n.part);
  if (!part || !isSym(part.sym)) return null;
  const d = SYMBOLS[part.sym];
  const ports = partPorts(part);
  const pa = ports.find((q) => q.name === (d.through?.[0] ?? ports[0]?.name));
  const pb = ports.find((q) => q.name === (d.through?.[1] ?? ports[1]?.name));
  if (!pa || !pb) return null;
  let [from, to] = [pb, pa];
  if (n.flip) [from, to] = [to, from];
  const horizontal = pa.y === pb.y;
  // Cote de l'etiquette : la fleche va de l'autre cote de l'axe de la piece.
  const lab = partLabel(part);
  const axis = horizontal ? pa.y : pa.x;
  const labSide = lab ? (horizontal ? Math.sign(lab.y - axis) : Math.sign(lab.x - axis)) : -1;
  const side = (labSide <= 0 ? 1 : -1) * (n.other ? -1 : 1);
  // La valeur est deja de ce cote (dipole horizontal) : la fleche passe en dessous d'elle.
  const valueSide = !!(part.name && part.value) && !n.other;
  // Du meme cote que le nom (« autre cote ») : la fleche passe au-dela du nom, jamais dessus.
  const sameAsName = !!lab && labSide === side;
  const nameW = lab ? Math.max(...lab.lines.map((t) => labelWidth(t) * 0.95)) : 0;
  const off = horizontal && valueSide ? 2.9
    : sameAsName ? (horizontal ? 1.3 + lab!.lines.length * 1.05 + 0.2 : Math.abs(lab!.x - axis) + nameW + 0.7)
    : n.other && horizontal ? 1.9 : 1.6;
  const shrink = 0.6;
  const along = (q: Pt, k: number): Pt => (horizontal ? { x: q.x + k, y: axis + side * off } : { x: axis + side * off, y: q.y + k });
  const sgn = horizontal ? Math.sign(to.x - from.x) : Math.sign(to.y - from.y);
  const a = along(from, sgn * shrink), b = along(to, -sgn * shrink);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const away = horizontal ? { x: 0, y: side } : { x: side, y: 0 };
  const label: SchemaLabel = horizontal
    ? { x: mid.x, y: mid.y + side * 0.9, anchor: "middle", lines: [n.label], note: index, auto: true, away }
    : { x: mid.x + side * 0.6, y: mid.y, anchor: side > 0 ? "start" : "end", lines: [n.label], note: index, auto: true, away };
  return { svg: arrow(a, b, "sch-u"), label, a, b };
}

/** Fleche de courant : pointe sur le fil au point vise, etiquette a cote. */
function current(n: SchemaNote, index: number): { svg: string; label: SchemaLabel } | null {
  if (n.x === undefined || n.y === undefined) return null;
  const d = DIRS[(n.dir ?? "right") as Dir];
  const tip = { x: n.x + d.x * 0.45, y: n.y + d.y * 0.45 };
  const tail = { x: n.x - d.x * 0.45, y: n.y - d.y * 0.45 };
  const horizontal = d.y === 0;
  const label: SchemaLabel = horizontal
    ? { x: n.x, y: n.y - 0.9, anchor: "middle", lines: [n.label], note: index, auto: true, away: { x: 0, y: -1 } }
    : { x: n.x + 0.7, y: n.y, anchor: "start", lines: [n.label], note: index, auto: true, away: { x: 1, y: 0 } };
  const head = 0.25;
  const pts = horizontal
    ? `${tip.x},${tip.y} ${tail.x},${tail.y - head * 1.4} ${tail.x},${tail.y + head * 1.4}`
    : `${tip.x},${tip.y} ${tail.x - head * 1.4},${tail.y} ${tail.x + head * 1.4},${tail.y}`;
  return { svg: `<polygon class="sch-i" points="${pts}" fill="currentColor" stroke="none"/>`, label };
}

/** Bornes d'entree des schemas-blocs : un fil qui y arrive porte une fleche. */
const BLOCK_INPUTS = new Set(["in", "in2", "in3"]);
/** Pieces des schemas-blocs (fleches aux entrees). */
const BLOCK_PARTS = new Set(["B", "S", "Gain"]);

/** Pointe pleine posee en `tip`, le fil arrivant de `from`. */
function headAt(tip: Pt, from: Pt, cls: string): string {
  const dx = Math.sign(tip.x - from.x), dy = Math.sign(tip.y - from.y);
  const tail = { x: tip.x - dx * 0.55, y: tip.y - dy * 0.55 };
  const h = 0.25;
  const pts = dx ? `${tip.x},${tip.y} ${tail.x},${tail.y - h} ${tail.x},${tail.y + h}` : `${tip.x},${tip.y} ${tail.x - h},${tail.y} ${tail.x + h},${tail.y}`;
  return `<polygon class="${cls}" points="${pts}" fill="currentColor" stroke="none"/>`;
}

/**
 * Schemas-blocs : fleche au bout de chaque fil qui entre dans un bloc ou un
 * sommateur, et les signes du sommateur (+ a gauche, − sur les entrees du
 * bas et du haut reliees ; la valeur du sommateur, « +- » ou « ++ », les
 * choisit dans l'ordre in, in2, in3).
 */
function blockDecorations(s: SchemaBlock): { svg: string[]; labels: SchemaLabel[] } {
  const svg: string[] = [];
  const labels: SchemaLabel[] = [];
  const ends = new Map<string, Pt>();
  for (const w of s.wires) {
    const p = wirePts(w);
    if (p.length < 2) continue;
    ends.set(`${p[0].x},${p[0].y}`, p[1]);
    ends.set(`${p[p.length - 1].x},${p[p.length - 1].y}`, p[p.length - 2]);
  }
  const outs = new Set<string>();
  for (const part of s.parts) {
    if (!BLOCK_PARTS.has(part.sym)) continue;
    const ports = partPorts(part);
    for (const q of ports) {
      if (q.name === "out") { outs.add(`${q.x},${q.y}`); continue; }
      if (!BLOCK_INPUTS.has(q.name)) continue;
      const from = ends.get(`${q.x},${q.y}`);
      if (!from) continue;
      // Pointe juste avant la borne, dans le sens du fil.
      svg.push(headAt(q, from, "sch-in"));
    }
    if (part.sym === "S") {
      const connected = sumConnected(s, part);
      const signs = sumSigns(part);
      for (const q of ports) {
        if (!BLOCK_INPUTS.has(q.name) || (q.name !== "in" && !connected.has(q.name))) continue;
        // Pres de l'entree, cote amont du fil, decale sur le cote (+ en haut a gauche, − en bas a gauche...).
        const v = portOutward(part, q);
        const side = v.x ? { x: 0, y: -1 } : { x: -1, y: 0 };
        labels.push({ x: q.x + v.x * 0.55 + side.x * 0.6, y: q.y + v.y * 0.55 + side.y * 0.6, anchor: "middle", lines: [signs[q.name]], part: part.id, sign: q.name });
      }
    }
  }
  // Sortie d'un schema-bloc : le fil qui en part et finit en l'air porte une fleche au bout (« y(t) → »).
  const touched = (p: Pt) => s.parts.some((q) => partPorts(q).some((r) => r.x === p.x && r.y === p.y))
    || segments(s).some(([a, b]) => (a.x === b.x ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y) : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)) && !(a.x === p.x && a.y === p.y) && !(b.x === p.x && b.y === p.y))
    || s.wires.filter((w) => { const q = wirePts(w); return q.length >= 2 && [q[0], q[q.length - 1]].some((e) => e.x === p.x && e.y === p.y); }).length > 1;
  // Un fil qui porte deja une fleche de courant (schema fait a la main) n'en recoit pas d'autre.
  const onWire = (p: Pt[], n: SchemaNote) => n.kind === "i" && n.x !== undefined && n.y !== undefined
    && p.some((q, i) => i > 0 && (q.x === p[i - 1].x ? n.x === q.x && n.y! >= Math.min(q.y, p[i - 1].y) && n.y! <= Math.max(q.y, p[i - 1].y) : n.y === q.y && n.x! >= Math.min(q.x, p[i - 1].x) && n.x! <= Math.max(q.x, p[i - 1].x)));
  for (const w of s.wires) {
    const p = wirePts(w);
    if (p.length < 2 || (s.notes ?? []).some((n) => onWire(p, n))) continue;
    const a = p[0], b = p[p.length - 1];
    if (outs.has(`${a.x},${a.y}`) && !touched(b)) svg.push(headAt(b, p[p.length - 2], "sch-out"));
    else if (outs.has(`${b.x},${b.y}`) && !touched(a)) svg.push(headAt(a, p[1], "sch-out"));
  }
  return { svg, labels };
}

/** Etiquette d'une fleche libre : au bout de la pointe (axe : « u(t) » en haut, « t » au bout) ; d'un trait : a cote de son milieu. */
function arrowLabel(n: SchemaNote, index: number): SchemaLabel | null {
  if (!n.label || n.x === undefined || n.y === undefined || n.x2 === undefined || n.y2 === undefined) return null;
  const dx = n.x2 - n.x, dy = n.y2 - n.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  if (n.kind === "line") {
    // A cote du milieu, du cote « haut » (ou a droite d'un trait vertical).
    const nx = Math.abs(uy) > 0.9 ? 1 : -uy * Math.sign(ux || 1), ny = Math.abs(uy) > 0.9 ? 0 : -1;
    return { x: (n.x + n.x2) / 2 + nx * 0.7, y: (n.y + n.y2) / 2 + ny * 0.8, anchor: nx > 0.5 ? "start" : "middle", lines: [n.label], note: index, auto: true, away: { x: nx, y: ny } };
  }
  // Fleche surtout verticale : l'etiquette au-dessus/au-dessous de la pointe ; horizontale : apres la pointe.
  if (Math.abs(uy) >= Math.abs(ux)) {
    return { x: n.x2, y: n.y2 + Math.sign(uy) * 0.8, anchor: "middle", lines: [n.label], note: index, auto: true, away: { x: 0, y: Math.sign(uy) } };
  }
  return { x: n.x2 + Math.sign(ux) * 0.4, y: n.y2 + 0.85, anchor: ux > 0 ? "end" : "start", lines: [n.label], note: index, auto: true, away: { x: 0, y: 1 } };
}

type Box = { x: number; y: number; w: number; h: number };

function overlaps(a: Box, b: Box, pad = 0.08): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

function segHitsBox(a: Pt, b: Pt, r: Box): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2));
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n, y = a.y + ((b.y - a.y) * i) / n;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  return false;
}

/** Partie dessinee d'une piece (sans les bouts de fil d'un dipole), pour ne pas y poser de texte. */
function coreBox(p: SchemaPart): Box {
  const b = partBox(p);
  const d = isSym(p.sym) ? SYMBOLS[p.sym] : null;
  if (d?.through?.[0] === "a" && d.w === 4) {
    return b.w > b.h ? { x: b.x + 1, y: b.y + 0.3, w: 2, h: b.h - 0.6 } : { x: b.x + 0.3, y: b.y + 1, w: b.w - 0.6, h: 2 };
  }
  return { x: b.x + 0.15, y: b.y + 0.15, w: b.w - 0.3, h: b.h - 0.3 };
}

/**
 * Etiquettes sans chevauchement : chacune a sa place calculee, sauf si elle
 * tombe sur une etiquette deja posee, une piece, un fil ou une fleche ; elle
 * s'ecarte alors au plus pres (d'abord vers l'exterieur de ce qu'elle nomme).
 * Les textes poses a la main ne bougent jamais.
 */
export function resolveLabels(s: SchemaBlock, labels: SchemaLabel[], strokes: [Pt, Pt][]): void {
  const cores = s.parts.map(coreBox);
  const segs = [...segments(s), ...strokes];
  const placed: Box[] = labels.filter((l) => !l.auto).map(labelBox);
  const free = (b: Box) => !placed.some((q) => overlaps(b, q)) && !cores.some((c) => overlaps(b, c, -0.05)) && !segs.some(([a, c]) => segHitsBox(a, c, b));
  // Les noms d'abord, puis les valeurs, puis les fleches.
  const order = labels.filter((l) => l.auto).sort((a, b) => rank(a) - rank(b));
  for (const l of order) {
    const box = labelBox(l);
    if (free(box)) { placed.push(box); continue; }
    const away = l.away ?? { x: 0, y: -1 };
    const along = { x: away.y ? 1 : 0, y: away.x ? 1 : 0 };
    let best: Pt | null = null;
    for (const step of [0.4, 0.8, 1.2, 1.6, 2.0, 2.6]) {
      const cands: Pt[] = [
        { x: away.x * step, y: away.y * step },
        { x: along.x * step, y: along.y * step },
        { x: -along.x * step, y: -along.y * step },
        { x: (away.x + along.x) * step * 0.7, y: (away.y + along.y) * step * 0.7 },
        { x: (away.x - along.x) * step * 0.7, y: (away.y - along.y) * step * 0.7 },
      ];
      best = cands.find((c) => free({ ...box, x: box.x + c.x, y: box.y + c.y })) ?? null;
      if (best) break;
    }
    if (best) { l.x += best.x; l.y += best.y; }
    placed.push(labelBox(l));
  }
}

function rank(l: SchemaLabel): number {
  return l.field === "name" ? 0 : l.field === "value" ? 1 : l.note !== undefined ? 2 : 3;
}

export function drawSchema(s: SchemaBlock): SchemaDrawing {
  const out: string[] = [];
  const labels: SchemaLabel[] = [];
  const hits: { note: number; a: Pt; b: Pt }[] = [];
  out.push(`<g class="sch-wires" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">`);
  s.wires.forEach((w, i) => {
    const pts = wirePts(w).map((p) => `${p.x},${p.y}`).join(" ");
    out.push(`<polyline data-wire="${i}" points="${pts}"/>`);
  });
  out.push("</g>");
  for (const p of s.parts) {
    if (!isSym(p.sym)) continue;
    out.push(`<g class="sch-part" data-part="${esc(p.id)}" transform="${partTransform(p)}" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${symbolFor(p.sym, p.w).body}</g>`);
    labels.push(...partLabels(p));
  }
  const deco = blockDecorations(s);
  out.push(...deco.svg);
  labels.push(...deco.labels);
  for (const j of junctions(s)) out.push(`<circle class="sch-dot" cx="${j.x}" cy="${j.y}" r="0.2" fill="currentColor"/>`);
  out.push(`<g class="sch-notes" stroke="currentColor" stroke-width="${STROKE}" fill="none">`);
  (s.notes ?? []).forEach((n, i) => {
    if (n.kind === "u") { const v = voltage(s, n, i); if (v) { out.push(v.svg); labels.push(v.label); hits.push({ note: i, a: v.a, b: v.b }); } }
    else if (n.kind === "i") {
      const c = current(n, i);
      if (c && n.x !== undefined && n.y !== undefined) {
        out.push(c.svg); labels.push(c.label);
        const d = DIRS[(n.dir ?? "right") as Dir];
        hits.push({ note: i, a: { x: n.x - d.x * 0.45, y: n.y - d.y * 0.45 }, b: { x: n.x + d.x * 0.45, y: n.y + d.y * 0.45 } });
      }
    }
    else if ((n.kind === "arrow" || n.kind === "line") && n.x !== undefined && n.y !== undefined && n.x2 !== undefined && n.y2 !== undefined) {
      const dash = n.dash ? ` stroke-dasharray="0.35 0.25"` : "";
      out.push(n.kind === "arrow"
        ? arrow({ x: n.x, y: n.y }, { x: n.x2, y: n.y2 }, `sch-arrow`).replace("<line ", `<line${dash} `)
        : `<line class="sch-line" x1="${n.x}" y1="${n.y}" x2="${n.x2}" y2="${n.y2}" stroke-linecap="round"${dash}/>`);
      hits.push({ note: i, a: { x: n.x, y: n.y }, b: { x: n.x2, y: n.y2 } });
      const l = arrowLabel(n, i);
      if (l) labels.push(l);
    }
    else if (n.x !== undefined && n.y !== undefined) labels.push({ x: n.x, y: n.y, anchor: "middle", lines: [n.label], note: i });
  });
  out.push("</g>");
  // Les fleches de tension et libres sont des obstacles ; les courants (petits, sur un fil) aussi.
  resolveLabels(s, labels, hits.map((h) => [h.a, h.b] as [Pt, Pt]));
  // Cadre : le schema et ses etiquettes (une etiquette ne deborde plus du bloc).
  const box = schemaBounds(s);
  if (!s.under && (s.parts.length || s.wires.length || s.notes?.length)) {
    let x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
    for (const l of labels) {
      const b = labelBox(l);
      x0 = Math.min(x0, b.x - 0.5); y0 = Math.min(y0, b.y - 0.4);
      x1 = Math.max(x1, b.x + b.w + 0.5); y1 = Math.max(y1, b.y + b.h + 0.4);
    }
    box.x = x0; box.y = y0; box.w = x1 - x0; box.h = y1 - y0;
  }
  return { body: out.join(""), labels, box, hits };
}
