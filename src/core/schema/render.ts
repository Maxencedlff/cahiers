/**
 * Dessin d'un schema (logique pure, aucun DOM) : le SVG de la geometrie
 * (pieces, fils, points de jonction, fleches) et la liste des etiquettes
 * a poser par-dessus (noms, valeurs, annotations), que l'interface rend en
 * formules (KaTeX) a leur place. Unites : grille (symbols.ts GRID).
 */
import type { SchemaBlock, SchemaNote, SchemaPart } from "../types";
import { SYMBOLS, rotatePoint, type SymKey } from "./symbols";
import { DIRS, junctions, partPorts, schemaBounds, wirePts, type Dir, type Pt } from "./model";

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
}

export interface SchemaDrawing {
  /** Contenu SVG (sans la balise <svg>), en unites de grille. */
  body: string;
  labels: SchemaLabel[];
  /** viewBox : boite du schema, marge comprise. */
  box: { x: number; y: number; w: number; h: number };
}

const STROKE = 0.09;

function isSym(k: string): k is SymKey { return Object.prototype.hasOwnProperty.call(SYMBOLS, k); }

/** Transformation SVG d'une piece : miroir (avant), rotation horaire, puis position. */
export function partTransform(p: SchemaPart): string {
  if (!isSym(p.sym)) return `translate(${p.x} ${p.y})`;
  const { w, h } = SYMBOLS[p.sym];
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
  const m = /^(\d+(?:[.,]\d+)?)\s*([pnuµmkMG]?)$/.exec(v);
  if (!unit || !m) return v;
  return `${m[1]} ${m[2] === "u" ? "µ" : m[2]}${unit}`;
}

/**
 * Etiquettes d'une piece : le nom du cote du point d'accroche du symbole
 * (au-dessus d'un dipole horizontal), la valeur de l'autre cote ; piece
 * verticale : les deux a cote, l'un sous l'autre. Elles tournent avec elle.
 */
function partLabels(p: SchemaPart): SchemaLabel[] {
  if (!isSym(p.sym)) return [];
  // Sommateur : sa valeur est le jeu de signes, dessine a ses entrees.
  const name = p.name?.trim(), value = p.value?.trim() && p.sym !== "S" ? valueText(p.sym, p.value) : undefined;
  if (!name && !value) return [];
  const d = SYMBOLS[p.sym];
  // Le texte ne tourne pas avec la piece : un dipole trace vers la gauche
  // (rot 180) garde son nom au-dessus, vers le haut (270) a droite comme vers le bas.
  const rot = (p.rot === 180 && d.through ? 0 : p.rot === 270 && d.through ? 90 : p.rot ?? 0) as 0 | 90 | 180 | 270;
  const lx = p.mirror ? d.w - d.labelAt.x : d.labelAt.x;
  const r = rotatePoint(lx, d.labelAt.y, rot, d.w, d.h);
  // Piece verticale : l'etiquette passe a cote, alignee sur le bord.
  let anchor = d.labelAt.anchor;
  if (rot === 90) anchor = "start";
  else if (rot === 270) anchor = "end";
  const at = { x: p.x + r.x, y: p.y + r.y };
  // Bloc, sommateur : le texte au centre, une seule etiquette.
  const centered = d.labelAt.anchor === "middle" && d.labelAt.y > 0 && d.labelAt.y < d.h;
  if (rot % 180 !== 0 || centered || !name || !value) {
    return [{ ...at, anchor, lines: [name, value].filter((x): x is string => !!x), part: p.id }];
  }
  // Dipole horizontal : la valeur de l'autre cote de l'axe, a la meme distance.
  const box = rot % 180 === 0 ? { h: d.h } : { h: d.w };
  const other = { x: at.x, y: p.y + box.h - (at.y - p.y) };
  return [
    { ...at, anchor, lines: [name], part: p.id },
    { ...other, anchor, lines: [value], part: p.id },
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
function voltage(s: SchemaBlock, n: SchemaNote, index: number): { svg: string; label: SchemaLabel } | null {
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
  const off = horizontal && valueSide ? 2.9 : n.other && horizontal ? 1.9 : 1.6;
  const shrink = 0.6;
  const along = (q: Pt, k: number): Pt => (horizontal ? { x: q.x + k, y: axis + side * off } : { x: axis + side * off, y: q.y + k });
  const sgn = horizontal ? Math.sign(to.x - from.x) : Math.sign(to.y - from.y);
  const a = along(from, sgn * shrink), b = along(to, -sgn * shrink);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const label: SchemaLabel = horizontal
    ? { x: mid.x, y: mid.y + side * 0.9, anchor: "middle", lines: [n.label], note: index }
    : { x: mid.x + side * 0.6, y: mid.y, anchor: side > 0 ? "start" : "end", lines: [n.label], note: index };
  return { svg: arrow(a, b, "sch-u"), label };
}

/** Fleche de courant : pointe sur le fil au point vise, etiquette a cote. */
function current(n: SchemaNote, index: number): { svg: string; label: SchemaLabel } | null {
  if (n.x === undefined || n.y === undefined) return null;
  const d = DIRS[(n.dir ?? "right") as Dir];
  const tip = { x: n.x + d.x * 0.45, y: n.y + d.y * 0.45 };
  const tail = { x: n.x - d.x * 0.45, y: n.y - d.y * 0.45 };
  const horizontal = d.y === 0;
  const label: SchemaLabel = horizontal
    ? { x: n.x, y: n.y - 0.9, anchor: "middle", lines: [n.label], note: index }
    : { x: n.x + 0.7, y: n.y, anchor: "start", lines: [n.label], note: index };
  const head = 0.25;
  const pts = horizontal
    ? `${tip.x},${tip.y} ${tail.x},${tail.y - head * 1.4} ${tail.x},${tail.y + head * 1.4}`
    : `${tip.x},${tip.y} ${tail.x - head * 1.4},${tail.y} ${tail.x + head * 1.4},${tail.y}`;
  return { svg: `<polygon class="sch-i" points="${pts}" fill="currentColor" stroke="none"/>`, label };
}

/** Bornes d'entree des schemas-blocs : un fil qui y arrive porte une fleche. */
const BLOCK_INPUTS = new Set(["in", "in2", "in3"]);

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
  for (const part of s.parts) {
    if (part.sym !== "B" && part.sym !== "S") continue;
    const ports = partPorts(part);
    const connected = new Set<string>();
    for (const q of ports) {
      if (!BLOCK_INPUTS.has(q.name)) continue;
      const from = ends.get(`${q.x},${q.y}`);
      if (!from) continue;
      connected.add(q.name);
      // Pointe juste avant la borne, dans le sens du fil.
      const dx = Math.sign(q.x - from.x), dy = Math.sign(q.y - from.y);
      const tip = { x: q.x, y: q.y }, tail = { x: q.x - dx * 0.55, y: q.y - dy * 0.55 };
      const h = 0.25;
      const pts = dx ? `${tip.x},${tip.y} ${tail.x},${tail.y - h} ${tail.x},${tail.y + h}` : `${tip.x},${tip.y} ${tail.x - h},${tail.y} ${tail.x + h},${tail.y}`;
      svg.push(`<polygon class="sch-in" points="${pts}" fill="currentColor" stroke="none"/>`);
    }
    if (part.sym === "S") {
      const signs = (part.value ?? "").replace(/\s/g, "").replace(/−/g, "-");
      const order = ["in", "in2", "in3"];
      for (const q of ports) {
        const i = order.indexOf(q.name);
        if (i < 0 || (q.name !== "in" && !connected.has(q.name))) continue;
        const sign = signs[i] === "-" ? "−" : signs[i] === "+" ? "+" : q.name === "in" ? "+" : "−";
        const off = q.name === "in" ? { x: -0.55, y: -0.6 } : q.name === "in2" ? { x: -0.6, y: 0.55 } : { x: -0.6, y: -0.55 };
        labels.push({ x: q.x + off.x, y: q.y + off.y, anchor: "middle", lines: [sign], part: part.id });
      }
    }
  }
  return { svg, labels };
}

export function drawSchema(s: SchemaBlock): SchemaDrawing {
  const box = schemaBounds(s);
  const out: string[] = [];
  const labels: SchemaLabel[] = [];
  out.push(`<g class="sch-wires" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">`);
  s.wires.forEach((w, i) => {
    const pts = wirePts(w).map((p) => `${p.x},${p.y}`).join(" ");
    out.push(`<polyline data-wire="${i}" points="${pts}"/>`);
  });
  out.push("</g>");
  for (const p of s.parts) {
    if (!isSym(p.sym)) continue;
    out.push(`<g class="sch-part" data-part="${esc(p.id)}" transform="${partTransform(p)}" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${SYMBOLS[p.sym].body}</g>`);
    labels.push(...partLabels(p));
  }
  const deco = blockDecorations(s);
  out.push(...deco.svg);
  labels.push(...deco.labels);
  for (const j of junctions(s)) out.push(`<circle class="sch-dot" cx="${j.x}" cy="${j.y}" r="0.2" fill="currentColor"/>`);
  out.push(`<g class="sch-notes" stroke="currentColor" stroke-width="${STROKE}" fill="none">`);
  (s.notes ?? []).forEach((n, i) => {
    if (n.kind === "u") { const v = voltage(s, n, i); if (v) { out.push(v.svg); labels.push(v.label); } }
    else if (n.kind === "i") { const c = current(n, i); if (c) { out.push(c.svg); labels.push(c.label); } }
    else if (n.x !== undefined && n.y !== undefined) labels.push({ x: n.x, y: n.y, anchor: "middle", lines: [n.label], note: i });
  });
  out.push("</g>");
  return { body: out.join(""), labels, box };
}
