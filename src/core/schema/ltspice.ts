/**
 * Import d'un schema LTspice (.asc) en bloc `schema` (logique pure).
 *
 * Format : lignes `WIRE x1 y1 x2 y2`, `FLAG x y nom` (0 = masse),
 * `SYMBOL nom x y R0|R90|R180|R270|M0..M270` suivi de `SYMATTR InstName R1`,
 * `SYMATTR Value 10k`. Coordonnees entieres, y vers le bas ; 16 unites
 * LTspice = une case de notre grille.
 *
 * Les broches des symboles LTspice viennent d'une table (relevee dans les
 * .asy de lib/sym de LTspice 24 : res, cap, ind, diode, voltage, npn...) ; une broche qui ne tombe sur aucun fil est calee sur
 * l'extremite de fil la plus proche. Notre symbole (norme francaise, de
 * taille fixe) est pose au milieu de ses broches et relie a elles par de
 * courts fils : le circuit reste ferme quoi qu'il arrive aux dimensions.
 */
import type { SchemaBlock, SchemaNote } from "../types";
import { SYMBOLS, type SymKey } from "./symbols";
import { addPart, addWire, partPorts, placeFor, routeOrtho, rotForDir, wirePts, type Dir, type Pt } from "./model";

const LT = 16;

interface LtSym { key: SymKey; pins: [number, number][]; names: string[] }

/** Symboles LTspice standard : notre symbole et les broches (unites LTspice, R0). */
const TABLE: Record<string, LtSym> = {
  res: { key: "R", pins: [[16, 16], [16, 96]], names: ["a", "b"] },
  res2: { key: "R", pins: [[16, 16], [16, 96]], names: ["a", "b"] },
  cap: { key: "C", pins: [[16, 0], [16, 64]], names: ["a", "b"] },
  polcap: { key: "Cp", pins: [[16, 0], [16, 64]], names: ["a", "b"] },
  ind: { key: "L", pins: [[16, 16], [16, 96]], names: ["a", "b"] },
  ind2: { key: "L", pins: [[16, 16], [16, 96]], names: ["a", "b"] },
  diode: { key: "D", pins: [[16, 0], [16, 64]], names: ["a", "b"] },
  schottky: { key: "D", pins: [[16, 0], [16, 64]], names: ["a", "b"] },
  zener: { key: "Dz", pins: [[16, 0], [16, 64]], names: ["a", "b"] },
  led: { key: "LED", pins: [[16, 0], [16, 64]], names: ["a", "b"] },
  voltage: { key: "V", pins: [[0, 16], [0, 96]], names: ["a", "b"] },
  battery: { key: "Vdc", pins: [[0, 16], [0, 96]], names: ["a", "b"] },
  current: { key: "I", pins: [[0, 0], [0, 80]], names: ["a", "b"] },
  npn: { key: "Q", pins: [[64, 0], [0, 48], [64, 96]], names: ["c", "b", "e"] },
  pnp: { key: "Qp", pins: [[64, 0], [0, 48], [64, 96]], names: ["c", "b", "e"] },
  nmos: { key: "M", pins: [[48, 0], [0, 80], [48, 96]], names: ["d", "g", "s"] },
  pmos: { key: "Mp", pins: [[48, 0], [0, 80], [48, 96]], names: ["d", "g", "s"] },
  // AOP : opamp et opamp2 (E+ en bas, E- en haut) ; UniversalOpAmp2 et les modeles a 5 broches recents.
  opamp: { key: "A", pins: [[-32, 80], [-32, 48], [32, 64]], names: ["p", "n", "s"] },
  universalopamp: { key: "A", pins: [[-32, 16], [-32, -16], [32, 0]], names: ["p", "n", "s"] },
};

/** Nom LTspice ramene a une cle de la table (« Opamps\\UniversalOpamp2 » -> opamp, « npn2 » -> npn). */
function lookup(name: string): LtSym | undefined {
  const base = name.split(/[\\/]/).pop()!.toLowerCase();
  if (TABLE[base]) return TABLE[base];
  if (/universalopamp/.test(base)) return TABLE.universalopamp;
  if (/opamp|^lt\d|^ad\d|^tl0|^lm\d|^op\d|^mcp/.test(base)) return TABLE.opamp;
  const stem = base.replace(/\d+$/, "");
  return TABLE[stem];
}

/** Rotation / miroir LTspice d'un point (y vers le bas) : miroir sur x d'abord, puis rotation. */
function orient(x: number, y: number, o: string): [number, number] {
  let px = x, py = y;
  if (o.startsWith("M")) px = -px;
  const r = Number(o.slice(1)) || 0;
  for (let k = 0; k < r / 90; k++) [px, py] = [-py, px];
  return [px, py];
}

const g = (v: number) => Math.round(v / LT);

/**
 * Lit un fichier .asc. `skipped` : symboles inconnus (non poses ; leurs
 * fils restent). Coordonnees ramenees pres de l'origine.
 */
export function importAsc(text: string, id: string): { block: SchemaBlock; skipped: string[] } {
  const block: SchemaBlock = { id, type: "schema", parts: [], wires: [] };
  const skipped: string[] = [];
  const wires: [number, number, number, number][] = [];
  const flags: { x: number; y: number; name: string }[] = [];
  const syms: { name: string; x: number; y: number; o: string; attrs: Record<string, string> }[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const w = line.split(/\s+/);
    const kw = w[0]?.toUpperCase();
    if (kw === "WIRE" && w.length >= 5) wires.push([+w[1], +w[2], +w[3], +w[4]]);
    else if (kw === "FLAG" && w.length >= 4) flags.push({ x: +w[1], y: +w[2], name: w.slice(3).join(" ") });
    else if (kw === "SYMBOL" && w.length >= 5) syms.push({ name: w[1], x: +w[2], y: +w[3], o: w[4].toUpperCase(), attrs: {} });
    else if (kw === "SYMATTR" && syms.length && w.length >= 3) syms[syms.length - 1].attrs[w[1].toLowerCase()] = w.slice(2).join(" ");
  }
  // Extremites de fils (et drapeaux) : les broches s'y calent.
  const ends: Pt[] = [];
  for (const [x1, y1, x2, y2] of wires) ends.push({ x: x1, y: y1 }, { x: x2, y: y2 });
  for (const f of flags) ends.push({ x: f.x, y: f.y });
  const snap = (p: Pt): Pt => {
    let best: Pt | null = null, bd = Infinity;
    for (const e of ends) {
      const d = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best && bd <= 24 ? best : p;
  };
  for (const [x1, y1, x2, y2] of wires) {
    const a = { x: g(x1), y: g(y1) }, b = { x: g(x2), y: g(y2) };
    if (a.x !== b.x || a.y !== b.y) addWire(block, routeOrtho(a, b));
  }
  const notes: SchemaNote[] = [];
  for (const sy of syms) {
    const def = lookup(sy.name);
    if (!def) { skipped.push(sy.name.split(/[\\/]/).pop()!); continue; }
    const pins = def.pins.map(([px, py]) => {
      const [ox, oy] = orient(px, py, sy.o);
      const p = snap({ x: sy.x + ox, y: sy.y + oy });
      return { x: g(p.x), y: g(p.y) };
    });
    const sd = SYMBOLS[def.key];
    let part;
    if (sd.through && pins.length === 2) {
      // Dipole : pose sur l'axe de ses broches, au milieu, relie aux deux bouts.
      const [a, b] = pins;
      const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      const dir: Dir = horizontal ? (b.x >= a.x ? "right" : "left") : (b.y >= a.y ? "down" : "up");
      const len = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
      const step = { x: dir === "right" ? 1 : dir === "left" ? -1 : 0, y: dir === "down" ? 1 : dir === "up" ? -1 : 0 };
      const off = Math.max(0, Math.floor((len - sd.w) / 2));
      const start = { x: a.x + step.x * off, y: (horizontal ? a.y : a.y + step.y * off) };
      const rot = rotForDir(dir);
      part = addPart(block, def.key, placeFor(def.key, sd.through[0], start, rot), rot);
      const ports = partPorts(part);
      const pa = ports.find((q) => q.name === sd.through![0])!, pb = ports.find((q) => q.name === sd.through![1])!;
      if (pa.x !== a.x || pa.y !== a.y) addWire(block, routeOrtho(a, pa));
      if (pb.x !== b.x || pb.y !== b.y) addWire(block, routeOrtho(pb, b));
    } else {
      // Trois broches ou plus : notre symbole au centre des broches, chaque borne reliee a la sienne.
      const cx = Math.round(pins.reduce((s, p) => s + p.x, 0) / pins.length);
      const cy = Math.round(pins.reduce((s, p) => s + p.y, 0) / pins.length);
      part = addPart(block, def.key, { x: cx - Math.floor(sd.w / 2), y: cy - Math.floor(sd.h / 2) }, 0, false);
      const ports = partPorts(part);
      def.names.forEach((n, i) => {
        const q = ports.find((pp) => pp.name === n);
        if (q && (q.x !== pins[i].x || q.y !== pins[i].y)) addWire(block, routeOrtho(pins[i], q));
      });
    }
    if (sy.attrs.instname) part.name = sy.attrs.instname;
    else delete part.name;
    if (sy.attrs.value) part.value = sy.attrs.value;
  }
  for (const f of flags) {
    const at = { x: g(f.x), y: g(f.y) };
    if (f.name === "0") addPart(block, "G", placeFor("G", "a", at, 0), 0);
    else notes.push({ kind: "text", x: at.x, y: at.y - 1, label: f.name });
  }
  if (notes.length) block.notes = notes;
  // Ramene pres de l'origine.
  let x0 = Infinity, y0 = Infinity;
  for (const p of block.parts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); }
  for (const w of block.wires) for (const p of wirePts(w)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); }
  if (Number.isFinite(x0)) {
    const dx = 2 - x0, dy = 2 - y0;
    for (const p of block.parts) { p.x += dx; p.y += dy; }
    for (const w of block.wires) w.pts = w.pts.map((v, i) => v + (i % 2 ? dy : dx));
    for (const n of block.notes ?? []) { if (n.x !== undefined) n.x += dx; if (n.y !== undefined) n.y += dy; }
  }
  return { block, skipped };
}
