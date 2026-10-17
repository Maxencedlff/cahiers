/**
 * Modeles de schemas prets a inserer (logique pure) : montages du cours
 * (pont diviseur, RC, RL, RLC, hacheurs, AOP, regulateur Zener) et
 * chronogrammes (axes, creneau, triangle, dent de scie), schemas-blocs
 * (bloc de transfert, systemes du 1er et du 2e ordre). On les insere puis
 * on les modifie (noms, valeurs, fleches) : ce sont des schemas ordinaires.
 */
import type { SchemaBlock, SchemaNote, SchemaPart } from "../types";
import { SYMBOLS, fitWidth, type SymKey } from "./symbols";
import { labelWidth } from "./label";
import { insertOnWire, routeAround, wirePts } from "./model";

type Piece = Pick<SchemaBlock, "parts" | "wires" | "notes">;
type P = [number, number];

/** Petit constructeur : dipole d'une borne a l'autre (4 cases, droit), fils, annotations. */
class Build {
  parts: SchemaPart[] = [];
  wires: { pts: number[] }[] = [];
  notes: SchemaNote[] = [];

  /** Dipole de la borne a vers la borne b (horizontal ou vertical, 4 cases). */
  dip(sym: SymKey, a: P, b: P, name?: string, value?: string): string {
    const [ax, ay] = a, [bx, by] = b;
    const id = `p${this.parts.length + 1}`;
    let p: SchemaPart;
    if (ay === by && bx === ax + 4) p = { id, sym, x: ax, y: ay - 1 };
    else if (ay === by && bx === ax - 4) p = { id, sym, x: bx, y: ay - 1, rot: 180 };
    else if (ax === bx && by === ay + 4) p = { id, sym, x: ax - 1, y: ay, rot: 90 };
    else if (ax === bx && by === ay - 4) p = { id, sym, x: ax - 1, y: by, rot: 270 };
    else throw new Error(`dipole ${sym} : ${a} -> ${b}`);
    if (name) p.name = name;
    if (value) p.value = value;
    this.parts.push(p);
    return id;
  }

  /** Piece posee par son coin (AOP, transistor, masse, borne). */
  at(sym: SymKey, x: number, y: number, name?: string): string {
    const id = `p${this.parts.length + 1}`;
    const p: SchemaPart = { id, sym, x, y };
    if (name) p.name = name;
    this.parts.push(p);
    return id;
  }

  /** Borne (petit rond) dont le point de connexion est en (x, y). */
  term(x: number, y: number): string { return this.at("O", x - 1, y - 1); }
  /** Masse dont la borne est en (x, y). */
  ground(x: number, y: number): string { return this.at("G", x - 1, y); }

  wire(...pts: P[]): void { this.wires.push({ pts: pts.flat() }); }
  u(part: string, label: string, flip = false, other = false): void {
    const n: SchemaNote = { kind: "u", part, label };
    if (flip) n.flip = true;
    if (other) n.other = true;
    this.notes.push(n);
  }
  i(x: number, y: number, dir: "right" | "left" | "up" | "down", label: string): void { this.notes.push({ kind: "i", x, y, dir, label }); }
  text(x: number, y: number, label: string): void { this.notes.push({ kind: "text", x, y, label }); }
  arrow(x: number, y: number, x2: number, y2: number, label = ""): void { this.notes.push({ kind: "arrow", x, y, x2, y2, label }); }
  line(x: number, y: number, x2: number, y2: number, dash = false, label = ""): void {
    const n: SchemaNote = { kind: "line", x, y, x2, y2, label };
    if (dash) n.dash = true;
    this.notes.push(n);
  }
  /**
   * Bloc, gain ou sommateur pose par sa borne d'entree `in` (vers la droite) ;
   * bloc et gain a la largeur de leur texte. Rend l'id et la borne de sortie.
   */
  blk(sym: "B" | "Gain" | "S", at: P, value?: string): { id: string; out: P } {
    const id = `p${this.parts.length + 1}`;
    const d = SYMBOLS[sym];
    const w = sym === "S" ? d.w : fitWidth(sym, labelWidth(value ?? "") * 0.95);
    const p: SchemaPart = sym === "S" ? { id, sym, x: at[0], y: at[1] - 1 } : { id, sym, x: at[0], y: at[1] - 2 };
    if (w !== d.w) p.w = w;
    if (value) p.value = value;
    this.parts.push(p);
    return { id, out: [at[0] + w, at[1]] };
  }
  /** Etiquette d'un signal, au-dessus du fil (a la main : un texte, il ne bouge pas tout seul). */
  signal(x: number, y: number, label: string): void { this.text(x, y - (/\//.test(label) ? 1.5 : 1.1), label); }
  /** Retour de `from` vers la borne `to`, trace comme a la souris (par-dessous ou par-dessus). */
  feedback(from: P, to: P, gain?: string): void {
    const s = this.block();
    const pts = routeAround(s, { x: from[0], y: from[1] }, { x: to[0], y: to[1] });
    this.wires.push({ pts: pts.flatMap((q) => [q.x, q.y]) });
    if (!gain) return;
    // Gain sur le plus long segment horizontal du retour, pointe vers la gauche.
    const k = this.wires.length - 1;
    const q = wirePts(this.wires[k]);
    let seg = 0, best = -1;
    for (let i = 0; i + 1 < q.length; i++) if (q[i].y === q[i + 1].y && Math.abs(q[i + 1].x - q[i].x) > best) { best = Math.abs(q[i + 1].x - q[i].x); seg = i; }
    const sb = this.block();
    const mid = { x: Math.round((q[seg].x + q[seg + 1].x) / 2), y: q[seg].y };
    const g = insertOnWire(sb, "Gain", k, seg, mid, fitWidth("Gain", labelWidth(gain) * 0.95));
    if (!g) return;
    g.value = gain;
    this.parts = sb.parts;
    this.wires = sb.wires;
  }
  private block(): SchemaBlock { return { id: "t", type: "schema", parts: this.parts, wires: this.wires, notes: this.notes }; }
  done(): Piece { return { parts: this.parts, wires: this.wires, notes: this.notes }; }
}

/** e(t) -> [H(p)] -> s(t). */
function transfert(): Piece {
  const b = new Build();
  b.wire([0, 4], [4, 4]);
  b.signal(2, 4, "e(t)");
  const H = b.blk("B", [4, 4], "H(p)");
  b.wire(H.out, [H.out[0] + 5, 4]);
  b.signal(H.out[0] + 2.5, 4, "s(t)");
  return b.done();
}

/** Systeme du 1er ordre τ dy/dt + y = K e : e(t) -> K -> ⊗ -> 1/τ -> ∫dt -> y(t), retour de y sur l'entree −. */
function ordre1(): Piece {
  const b = new Build();
  b.wire([0, 6], [4, 6]);
  b.signal(2, 6, "e(t)");
  const K = b.blk("Gain", [4, 6], "K");
  b.wire(K.out, [K.out[0] + 3, 6]);
  const S = b.blk("S", [K.out[0] + 3, 6], "+-");
  b.wire(S.out, [S.out[0] + 4, 6]);
  const T = b.blk("Gain", [S.out[0] + 4, 6], "1/τ");
  b.wire(T.out, [T.out[0] + 5, 6]);
  b.signal(T.out[0] + 2.5, 6, "dy/dt");
  const I = b.blk("B", [T.out[0] + 5, 6], "∫dt");
  const end = I.out[0] + 7;
  b.wire(I.out, [end, 6]);
  b.signal(end - 1.5, 6, "y(t)");
  b.feedback([I.out[0] + 3, 6], [S.out[0] - 1, 7]);
  return b.done();
}

/**
 * Systeme du 2e ordre d²y/dt² + 2mω₀ dy/dt + ω₀² y = K e : e(t) -> K ->
 * ⊗(+,−,−) -> ∫ -> ∫ -> y(t) ; retours 2mω₀ depuis dy/dt (dessous) et ω₀²
 * depuis y (dessus).
 */
function ordre2(): Piece {
  const b = new Build();
  b.wire([0, 6], [4, 6]);
  b.signal(2, 6, "e(t)");
  const K = b.blk("Gain", [4, 6], "K");
  b.wire(K.out, [K.out[0] + 3, 6]);
  const S = b.blk("S", [K.out[0] + 3, 6], "+--");
  b.wire(S.out, [S.out[0] + 6, 6]);
  b.signal(S.out[0] + 3, 6, "d²y/dt²");
  const I1 = b.blk("B", [S.out[0] + 6, 6], "∫dt");
  b.wire(I1.out, [I1.out[0] + 6, 6]);
  b.signal(I1.out[0] + 2, 6, "dy/dt");
  const I2 = b.blk("B", [I1.out[0] + 6, 6], "∫dt");
  const end = I2.out[0] + 8;
  b.wire(I2.out, [end, 6]);
  b.signal(end - 2, 6, "y(t)");
  const sx = S.out[0] - 1;
  b.feedback([I1.out[0] + 4, 6], [sx, 7], "2mω_0");
  b.feedback([I2.out[0] + 3, 6], [sx, 5], "ω_0^2");
  return b.done();
}

/** Source E a gauche, branche du haut sur y = 4, retour sur y = bas. */
function serie(dips: { sym: SymKey; name: string; u: string }[], current = "i(t)"): Piece {
  const b = new Build();
  const E = b.dip("V", [2, 10], [2, 6], "E");
  b.u(E, "V_e(t)", true);
  b.wire([2, 6], [2, 4], [5, 4]);
  let x = 5;
  const last = dips.length - 1;
  dips.forEach((d, k) => {
    if (k < last) {
      const id = b.dip(d.sym, [x, 4], [x + 4, 4], d.name);
      b.u(id, d.u);
      b.wire([x + 4, 4], [x + 7, 4]);
      x += 7;
    } else {
      b.wire([x, 4], [x + 2, 4], [x + 2, 6]);
      const id = b.dip(d.sym, [x + 2, 6], [x + 2, 10], d.name);
      b.u(id, d.u);
      b.wire([x + 2, 10], [x + 2, 12], [2, 12], [2, 10]);
    }
  });
  b.i(3.5, 4, "right", current);
  return b.done();
}

function buck(): Piece {
  const b = new Build();
  const E = b.dip("V", [2, 11], [2, 7], "E");
  b.wire([2, 7], [2, 6], [5, 6]);
  b.wire([2, 11], [2, 12]);
  const K = b.dip("K", [5, 6], [9, 6], "K");
  b.wire([9, 6], [12, 6]);
  b.u(K, "U_K", false, true);
  const D = b.dip("D", [12, 11], [12, 7], "D");
  b.wire([12, 11], [12, 12]);
  b.wire([12, 7], [12, 6]);
  b.u(D, "U_D(t)", true);
  b.i(12, 11.5, "up", "i_D(t)");
  b.wire([12, 6], [15, 6]);
  b.dip("L", [15, 6], [19, 6], "L");
  b.i(14, 6, "right", "i_L(t)");
  b.wire([19, 6], [24, 6]);
  b.wire([24, 6], [24, 7]);
  b.dip("C", [24, 7], [24, 11], "C");
  b.wire([24, 11], [24, 12]);
  b.wire([24, 6], [34, 6], [34, 7]);
  const R = b.dip("R", [34, 7], [34, 11], "R");
  b.wire([34, 11], [34, 12]);
  b.wire([2, 12], [34, 12]);
  b.u(R, "V_s(t)");
  void E;
  return b.done();
}

function boost(): Piece {
  const b = new Build();
  b.dip("V", [2, 11], [2, 7], "E");
  b.wire([2, 7], [2, 6], [5, 6]);
  b.dip("L", [5, 6], [9, 6], "L");
  b.i(4, 6, "right", "i_L(t)");
  b.wire([9, 6], [13, 6]);
  b.wire([12, 6], [12, 7]);
  const K = b.dip("K", [12, 7], [12, 11], "K");
  b.u(K, "U_K");
  b.wire([12, 11], [12, 12]);
  b.dip("D", [13, 6], [17, 6], "D");
  b.wire([17, 6], [28, 6]);
  b.wire([20, 6], [20, 7]);
  b.dip("C", [20, 7], [20, 11], "C");
  b.wire([20, 11], [20, 12]);
  b.wire([28, 6], [28, 7]);
  const R = b.dip("R", [28, 7], [28, 11], "R");
  b.u(R, "V_s(t)");
  b.wire([28, 11], [28, 12], [2, 12], [2, 11]);
  return b.done();
}

function diviseur(): Piece {
  const b = new Build();
  const E = b.dip("V", [2, 12], [2, 8], "E");
  b.u(E, "V_e", true);
  b.wire([2, 8], [2, 4], [10, 4], [10, 5]);
  b.dip("R", [10, 5], [10, 9], "R1");
  b.wire([10, 9], [10, 10]);
  const R2 = b.dip("R", [10, 10], [10, 14], "R2");
  b.wire([10, 14], [10, 16], [2, 16], [2, 12]);
  b.wire([10, 10], [15, 10]);
  b.wire([10, 16], [15, 16]);
  b.term(15, 10);
  b.term(15, 16);
  b.u(R2, "V_s");
  return b.done();
}

function aop(inverseur: boolean): Piece {
  const b = new Build();
  b.at("A", 10, 4);                  // n (10,5), p (10,7), s (16,6)
  // Non inverseur : l'entree monte du bas jusqu'a E+, a droite de la branche de R1 (aucun fil ne la croise).
  b.term(inverseur ? 2 : 8, inverseur ? 5 : 10);
  b.text(inverseur ? 2 : 8, inverseur ? 3.6 : 11.4, "V_e");
  if (inverseur) {
    b.wire([2, 5], [3, 5]);
    b.dip("R", [3, 5], [7, 5], "R1");
    b.wire([7, 5], [10, 5]);
    b.wire([8, 5], [8, 1], [10, 1]);
    b.wire([10, 7], [9, 7], [9, 8]);
    b.ground(9, 8);
  } else {
    b.wire([8, 10], [8, 7], [10, 7]);
    b.wire([10, 5], [4, 5]);
    b.wire([8, 5], [8, 1], [10, 1]);
    b.dip("R", [4, 5], [4, 9], "R1");
    b.ground(4, 9);
  }
  b.dip("R", [10, 1], [14, 1], "R2");
  b.wire([14, 1], [18, 1], [18, 6]);
  b.wire([16, 6], [21, 6]);
  b.term(21, 6);
  b.text(21, 4.6, "V_s");
  return b.done();
}

function zener(): Piece {
  const b = new Build();
  const E = b.dip("V", [2, 12], [2, 8], "E");
  b.u(E, "V_e", true);
  b.wire([2, 8], [2, 4], [11, 4], [11, 8]);
  b.dip("R", [6, 4], [6, 8], "R");
  b.at("Q", 8, 8, "T");              // b (8,10), c (11,8), e (11,12)
  b.wire([6, 8], [6, 10], [8, 10]);
  const Dz = b.dip("Dz", [6, 14], [6, 10], "D_Z");
  b.u(Dz, "V_Z", true);
  b.wire([6, 14], [6, 16]);
  b.wire([11, 12], [16, 12]);
  const RL = b.dip("R", [16, 12], [16, 16], "R_L");
  b.u(RL, "V_s");
  b.wire([16, 16], [2, 16], [2, 12]);
  return b.done();
}

/** Axes : vertical (grandeur) et horizontal (t), origine en (2, y0). */
function axes(b: Build, y0: number, top: number, right: number, ylabel: string): void {
  b.arrow(2, y0 + 3, 2, top, ylabel);
  b.arrow(2, y0, right, y0, "t");
}

function creneau(): Piece {
  const b = new Build();
  axes(b, 10, 1, 27, "u_L(t)");
  b.wire([2, 4], [9, 4], [9, 12], [16, 12], [16, 4], [23, 4], [23, 12], [25, 12]);
  b.text(-1.5, 4, "U_1");
  b.text(-1.5, 12, "−U_2");
  b.line(2, 12, 9, 12, true);
  b.text(10.3, 8.9, "t_ON");
  b.text(16.8, 8.9, "T");
  return b.done();
}

function triangle(): Piece {
  const b = new Build();
  axes(b, 12, 1, 27, "i_L(t)");
  b.line(2, 9, 9, 4); b.line(9, 4, 16, 9); b.line(16, 9, 23, 4);
  b.line(2, 4, 24, 4, true); b.line(2, 9, 24, 9, true);
  b.line(9, 4, 9, 12, true); b.line(16, 9, 16, 12, true);
  b.text(-1.5, 4, "i_L max");
  b.text(-1.5, 9, "i_L min");
  b.text(9, 13, "t_ON");
  b.text(16, 13, "T");
  return b.done();
}

function scie(): Piece {
  const b = new Build();
  axes(b, 12, 1, 27, "u(t)");
  b.line(2, 11, 9, 4); b.line(9, 4, 9, 11); b.line(9, 11, 16, 4); b.line(16, 4, 16, 11); b.line(16, 11, 23, 4);
  b.line(2, 4, 24, 4, true);
  b.text(-1.5, 4, "U_max");
  b.text(9, 13, "T");
  b.text(16, 13, "2T");
  return b.done();
}

export interface Template { key: string; label: string; group: "Montages" | "Schémas-blocs" | "Chronogrammes"; build: () => Piece }

export const TEMPLATES: Template[] = [
  { key: "diviseur", label: "Pont diviseur", group: "Montages", build: diviseur },
  { key: "rc", label: "Circuit RC série", group: "Montages", build: () => serie([{ sym: "R", name: "R", u: "u_R(t)" }, { sym: "C", name: "C", u: "u_C(t)" }]) },
  { key: "rl", label: "Circuit RL série", group: "Montages", build: () => serie([{ sym: "L", name: "L", u: "u_L(t)" }, { sym: "R", name: "R", u: "u_R(t)" }]) },
  { key: "rlc", label: "Circuit RLC série", group: "Montages", build: () => serie([{ sym: "R", name: "R", u: "u_R(t)" }, { sym: "L", name: "L", u: "u_L(t)" }, { sym: "C", name: "C", u: "u_C(t)" }]) },
  { key: "buck", label: "Hacheur série (buck)", group: "Montages", build: buck },
  { key: "boost", label: "Hacheur parallèle (boost)", group: "Montages", build: boost },
  { key: "inv", label: "AOP inverseur", group: "Montages", build: () => aop(true) },
  { key: "noninv", label: "AOP non inverseur", group: "Montages", build: () => aop(false) },
  { key: "zener", label: "Régulateur Zener + transistor", group: "Montages", build: zener },
  { key: "transfert", label: "Bloc de transfert", group: "Schémas-blocs", build: transfert },
  { key: "ordre1", label: "Système du 1er ordre", group: "Schémas-blocs", build: ordre1 },
  { key: "ordre2", label: "Système du 2e ordre", group: "Schémas-blocs", build: ordre2 },
  { key: "axes", label: "Axes", group: "Chronogrammes", build: () => { const b = new Build(); axes(b, 10, 1, 27, "u(t)"); return b.done(); } },
  { key: "creneau", label: "Créneau (tension de bobine)", group: "Chronogrammes", build: creneau },
  { key: "triangle", label: "Triangle (courant de bobine)", group: "Chronogrammes", build: triangle },
  { key: "scie", label: "Dent de scie", group: "Chronogrammes", build: scie },
];

export function templateByKey(key: string): Template | undefined {
  return TEMPLATES.find((t) => t.key === key);
}
