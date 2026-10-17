/**
 * Bibliotheque de symboles electriques de l'editeur de schemas (logique pure,
 * aucun DOM). Normes francaises / IEC 60617, comme en cours en France.
 *
 * Unites : tout est en unites de grille (GRID px a l'echelle 1). Chaque
 * symbole a une boite (w x h) d'origine (0,0) en haut a gauche, a rot 0.
 * Les bornes tombent sur des coordonnees entieres (sur la grille).
 *
 * Dipoles : horizontaux a rot 0, longueur 4, h = 2, bornes "a" (0,1) et
 * "b" (4,1), through = ["a","b"] (le curseur clavier repart de "b").
 *
 * Lettres (une par symbole, minuscule, les 26 lettres sont prises) :
 *   r R          c C            p Cp (polarise)  l L      d D
 *   z Dz (Zener) e LED          k K (interrupteur)        v V (source de tension)
 *   u Vdc (pile, continu)       i I (source de courant)   g G (masse)
 *   o O (borne)  a A (AOP)      q Q (NPN)        j Qp (PNP)
 *   m M (MOSFET N)              n Mp (MOSFET P)  t T (transformateur)
 *   y Vm (voltmetre)            h Am (amperemetre)        x Lamp (lampe : cercle + croix)
 *   f F (fusible)               w Pot (potentiometre, w = curseur)
 *   b B (bloc)                  s S (sommateur)
 * Schemas-blocs : Maj+G = Gain (triangle, sans lettre a lui), Maj+B = bloc
 * integrateur (un bloc B dont la valeur est « ∫dt », `PRESETS`). Le bloc et
 * le gain s'allongent selon leur texte (`SchemaPart.w`, `symbolFor`).
 * Maj+lettre : variante quand elle existe (Maj+C = Cp, Maj+Q = Qp, Maj+M = Mp,
 * Maj+V = Vm, Maj+A = Am, Maj+R = Pot, Maj+O = X circuit ouvert : deux bornes
 * non reliees, sans lettre a lui), sinon le meme symbole qu'en minuscule
 * (Maj+Z = Zener, Maj+P = Cp...).
 *
 * Choix de norme :
 * - Resistance : rectangle (pas de zigzag). Bobine : 4 demi-cercles.
 * - Source de tension V : cercle traverse par le fil (IEC). Source de courant
 *   I : cercle avec une fleche (sens du courant de a vers b). Pile Vdc : grand
 *   trait (+, cote a) / petit trait (cote b).
 * - Condensateur polarise : armature creuse (rectangle vide) + « + » cote a,
 *   armature pleine cote b.
 * - Masse : trois traits decroissants.
 * - AOP : triangle avec « ∞ », E− ("n") en haut, E+ ("p") en bas, sortie "s".
 * - Transistors : cercle dessine, base/grille a gauche, collecteur/drain en
 *   haut, emetteur/source en bas. Fleche emetteur sortante (NPN), entrante
 *   (PNP) ; fleche du substrat entrante (canal N), sortante (canal P).
 * - Miroir (portsAt) : symetrie gauche-droite de la piece a rot 0, appliquee
 *   AVANT la rotation.
 */

export type SymKey =
  | "R" | "C" | "Cp" | "L" | "D" | "Dz" | "LED" | "K" | "V" | "Vdc" | "I" | "G" | "O" | "A"
  | "Q" | "Qp" | "M" | "Mp" | "T" | "Vm" | "Am" | "Lamp" | "F" | "Pot" | "B" | "S" | "X" | "Gain";

export interface Port { name: string; x: number; y: number }

export interface SymbolDef {
  key: SymKey;
  label: string;
  letter: string;
  w: number; h: number;
  ports: Port[];
  through?: [string, string];
  body: string;
  labelAt: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

export type Rot = 0 | 90 | 180 | 270;

/** Taille d'une unite de grille en px a l'echelle 1. */
export const GRID = 10;

/** Epaisseur de trait en unites de grille. */
const SW = 0.08;

// ---------------------------------------------------------------------------
// Petits constructeurs SVG (chaines), coordonnees de grille.

/** Nombre court, sans residus flottants. */
function n(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function paint(filled: boolean): string {
  const fill = filled ? "currentColor" : "none";
  return `fill="${fill}" stroke="currentColor" stroke-width="${SW}" stroke-linecap="round" stroke-linejoin="round"`;
}

function line(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ${paint(false)}/>`;
}

function path(d: string, filled = false): string {
  return `<path d="${d}" ${paint(filled)}/>`;
}

function circle(cx: number, cy: number, r: number, filled = false): string {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" ${paint(filled)}/>`;
}

function rect(x: number, y: number, w: number, h: number, filled = false): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${paint(filled)}/>`;
}

function polyline(pts: [number, number][]): string {
  const p = pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ");
  return `<polyline points="${p}" ${paint(false)}/>`;
}

/** Pointe de fleche pleine en (tx,ty), orientee de (fx,fy) vers (tx,ty). */
function head(fx: number, fy: number, tx: number, ty: number, len = 0.3, half = 0.13): string {
  const dx = tx - fx, dy = ty - fy;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const bx = tx - ux * len, by = ty - uy * len;
  const px = -uy * half, py = ux * half;
  return path(`M${n(tx)} ${n(ty)} L${n(bx + px)} ${n(by + py)} L${n(bx - px)} ${n(by - py)} Z`, true);
}

/** Fleche : trait de (x1,y1) jusqu'a la base de la pointe, pointe en (x2,y2). */
function arrow(x1: number, y1: number, x2: number, y2: number, len = 0.3): string {
  const dx = x2 - x1, dy = y2 - y1;
  const l = Math.hypot(dx, dy) || 1;
  const bx = x2 - (dx / l) * len, by = y2 - (dy / l) * len;
  return line(x1, y1, bx, by) + head(x1, y1, x2, y2, len);
}

function plus(cx: number, cy: number, s = 0.18): string {
  return line(cx - s, cy, cx + s, cy) + line(cx, cy - s, cx, cy + s);
}

function minus(cx: number, cy: number, s = 0.18): string {
  return line(cx - s, cy, cx + s, cy);
}

/**
 * Bobine : `count` demi-cercles de diametre `d` a partir de (x0,y0), le long
 * de x (vertical = false) ou de y (vertical = true). `sweep` choisit le cote
 * des bosses (1 : au-dessus en horizontal, a droite en vertical).
 */
function coil(x0: number, y0: number, count: number, d: number, vertical: boolean, sweep: 0 | 1): string {
  const r = d / 2;
  let s = `M${n(x0)} ${n(y0)}`;
  for (let i = 1; i <= count; i++) {
    const x = vertical ? x0 : x0 + i * d;
    const y = vertical ? y0 + i * d : y0;
    s += ` A${n(r)} ${n(r)} 0 0 ${sweep} ${n(x)} ${n(y)}`;
  }
  return path(s);
}

/** Fils d'un dipole : de (0,1) a x1 et de x2 a (4,1). */
function leads(x1: number, x2: number): string {
  return line(0, 1, x1, 1) + line(x2, 1, 4, 1);
}

// ---------------------------------------------------------------------------
// Dessins.

const BODY_R = leads(1, 3) + rect(1, 0.65, 2, 0.7);

const BODY_C = leads(1.8, 2.2) + line(1.8, 0.3, 1.8, 1.7) + line(2.2, 0.3, 2.2, 1.7);

const BODY_CP =
  leads(1.65, 2.2) +
  rect(1.65, 0.3, 0.2, 1.4) +          // armature creuse (+)
  rect(2.2, 0.3, 0.15, 1.4, true) +    // armature pleine (-)
  plus(1.15, 0.45);

const BODY_L = line(0, 1, 0.8, 1) + coil(0.8, 1, 4, 0.6, false, 1) + line(3.2, 1, 4, 1);

const DIODE = leads(1.5, 2.5) + path("M1.5 0.45 L1.5 1.55 L2.5 1 Z");
const BODY_D = DIODE + line(2.5, 0.45, 2.5, 1.55);
const BODY_DZ = DIODE + polyline([[2.25, 0.35], [2.5, 0.45], [2.5, 1.55], [2.75, 1.65]]);
const BODY_LED = BODY_D + arrow(2.1, 0.45, 2.55, 0.05, 0.22) + arrow(2.5, 0.6, 2.95, 0.2, 0.22);

const BODY_K = leads(1.2, 2.8) + line(1.2, 1, 2.75, 0.3);

const BODY_F = line(0, 1, 4, 1) + rect(1, 0.7, 2, 0.6);

const BODY_LAMP = (() => {
  const r = 0.7, k = r * Math.SQRT1_2;
  return leads(2 - r, 2 + r) + circle(2, 1, r) +
    line(2 - k, 1 - k, 2 + k, 1 + k) + line(2 - k, 1 + k, 2 + k, 1 - k);
})();

const BODY_V = line(0, 1, 4, 1) + circle(2, 1, 0.8);

const BODY_I = leads(1.2, 2.8) + circle(2, 1, 0.8) + arrow(1.5, 1, 2.5, 1, 0.25);

const BODY_VDC = leads(1.8, 2.2) + line(1.8, 0.2, 1.8, 1.8) + line(2.2, 0.6, 2.2, 1.4) + plus(1.3, 0.4, 0.15);

const BODY_VM = leads(1.2, 2.8) + circle(2, 1, 0.8) + path("M1.65 0.6 L2 1.4 L2.35 0.6");

const BODY_AM = leads(1.2, 2.8) + circle(2, 1, 0.8) + path("M1.65 1.4 L2 0.6 L2.35 1.4 M1.79 1.1 L2.21 1.1");

const BODY_POT = BODY_R + arrow(2, 0, 2, 0.65, 0.25);

const BODY_G = line(1, 0, 1, 1) + line(0.2, 1, 1.8, 1) + line(0.45, 1.35, 1.55, 1.35) + line(0.75, 1.7, 1.25, 1.7);

const BODY_O = circle(1, 1, 0.2);

/** Circuit ouvert : deux bornes (petits ronds) non reliees, a la place d'une piece. */
const BODY_X = line(0, 1, 1.3, 1) + circle(1.5, 1, 0.2) + circle(2.5, 1, 0.2) + line(2.7, 1, 4, 1);

const BODY_A =
  line(0, 1, 1, 1) + line(0, 3, 1, 3) + line(5, 2, 6, 2) +
  path("M1 0 L1 4 L5 2 Z") +
  minus(1.45, 1) + plus(1.45, 3) +
  // « ∞ » au centre du triangle
  path("M2.6 2 C2.6 1.72 2.25 1.72 2.25 2 C2.25 2.28 2.6 2.28 2.6 2 C2.6 1.72 2.95 1.72 2.95 2 C2.95 2.28 2.6 2.28 2.6 2");

/** Transistor bipolaire : `pnp` retourne la fleche de l'emetteur. */
function bjt(pnp: boolean): string {
  const s =
    circle(2.3, 2, 1.3) +
    line(0, 2, 1.6, 2) + line(1.6, 1.3, 1.6, 2.7) +
    line(1.6, 1.7, 3, 1) + line(3, 1, 3, 0) +
    line(1.6, 2.3, 3, 3) + line(3, 3, 3, 4);
  // fleche sur l'emetteur : vers l'exterieur (NPN) ou vers la base (PNP)
  return s + (pnp ? head(2.6, 2.8, 2.1, 2.55) : head(2.2, 2.6, 2.75, 2.875));
}

/** MOSFET a enrichissement : `pchannel` retourne la fleche du substrat. */
function mosfet(pchannel: boolean): string {
  const s =
    circle(2.2, 2, 1.4) +
    line(0, 2, 1.25, 2) + line(1.25, 1.2, 1.25, 2.8) +
    line(1.6, 0.95, 1.6, 1.45) + line(1.6, 1.75, 1.6, 2.25) + line(1.6, 2.55, 1.6, 3.05) +
    polyline([[1.6, 1.2], [3, 1.2], [3, 0]]) +
    polyline([[1.6, 2.8], [3, 2.8], [3, 4]]) +
    line(3, 2, 3, 2.8);
  return s + (pchannel ? arrow(1.6, 2, 3, 2, 0.3) : arrow(3, 2, 1.6, 2, 0.3));
}

const BODY_T =
  polyline([[0, 0], [2, 0], [2, 0.8]]) + coil(2, 0.8, 4, 0.6, true, 1) + polyline([[2, 3.2], [2, 4], [0, 4]]) +
  line(2.85, 0.6, 2.85, 3.4) + line(3.15, 0.6, 3.15, 3.4) +
  polyline([[6, 0], [4, 0], [4, 0.8]]) + coil(4, 0.8, 4, 0.6, true, 0) + polyline([[4, 3.2], [4, 4], [6, 4]]);

const BODY_B = rect(0, 0, 6, 4);

/** Gain (schema-bloc) : triangle, entree au milieu du cote gauche, sortie a la pointe. */
function gainBody(w: number): string {
  return path(`M0 0.2 L0 3.8 L${n(w)} 2 Z`);
}

const BODY_S = (() => {
  const k = Math.SQRT1_2;
  return circle(1, 1, 1) + line(1 - k, 1 - k, 1 + k, 1 + k) + line(1 - k, 1 + k, 1 + k, 1 - k);
})();

// ---------------------------------------------------------------------------
// Table.

const DIPOLE_LABEL = { x: 2, y: -0.3, anchor: "middle" } as const;

function dipole(key: SymKey, label: string, letter: string, body: string, extra: Port[] = []): SymbolDef {
  return {
    key, label, letter, w: 4, h: 2,
    ports: [{ name: "a", x: 0, y: 1 }, { name: "b", x: 4, y: 1 }, ...extra],
    through: ["a", "b"],
    body,
    labelAt: { ...DIPOLE_LABEL },
  };
}

export const SYMBOLS: Record<SymKey, SymbolDef> = {
  R: dipole("R", "Résistance", "r", BODY_R),
  C: dipole("C", "Condensateur", "c", BODY_C),
  Cp: dipole("Cp", "Condensateur polarisé", "p", BODY_CP),
  L: dipole("L", "Bobine", "l", BODY_L),
  D: dipole("D", "Diode", "d", BODY_D),
  Dz: dipole("Dz", "Diode Zener", "z", BODY_DZ),
  LED: dipole("LED", "DEL", "e", BODY_LED),
  K: dipole("K", "Interrupteur", "k", BODY_K),
  V: dipole("V", "Source de tension", "v", BODY_V),
  Vdc: dipole("Vdc", "Source continue", "u", BODY_VDC),
  I: dipole("I", "Source de courant", "i", BODY_I),
  Vm: dipole("Vm", "Voltmètre", "y", BODY_VM),
  Am: dipole("Am", "Ampèremètre", "h", BODY_AM),
  Lamp: dipole("Lamp", "Lampe", "x", BODY_LAMP),
  F: dipole("F", "Fusible", "f", BODY_F),
  Pot: dipole("Pot", "Potentiomètre", "w", BODY_POT, [{ name: "w", x: 2, y: 0 }]),
  X: dipole("X", "Circuit ouvert", "", BODY_X),
  G: {
    key: "G", label: "Masse", letter: "g", w: 2, h: 2,
    ports: [{ name: "a", x: 1, y: 0 }],
    body: BODY_G,
    labelAt: { x: 2, y: 1.1, anchor: "start" },
  },
  O: {
    key: "O", label: "Borne", letter: "o", w: 2, h: 2,
    ports: [{ name: "a", x: 1, y: 1 }],
    body: BODY_O,
    labelAt: { x: 1.4, y: 0.7, anchor: "start" },
  },
  A: {
    key: "A", label: "AOP", letter: "a", w: 6, h: 4,
    ports: [{ name: "n", x: 0, y: 1 }, { name: "p", x: 0, y: 3 }, { name: "s", x: 6, y: 2 }],
    body: BODY_A,
    labelAt: { x: 3.2, y: 0.8, anchor: "start" },
  },
  Q: {
    key: "Q", label: "Transistor NPN", letter: "q", w: 4, h: 4,
    ports: [{ name: "b", x: 0, y: 2 }, { name: "c", x: 3, y: 0 }, { name: "e", x: 3, y: 4 }],
    body: bjt(false),
    labelAt: { x: 3.7, y: 2.2, anchor: "start" },
  },
  Qp: {
    key: "Qp", label: "Transistor PNP", letter: "j", w: 4, h: 4,
    ports: [{ name: "b", x: 0, y: 2 }, { name: "c", x: 3, y: 0 }, { name: "e", x: 3, y: 4 }],
    body: bjt(true),
    labelAt: { x: 3.7, y: 2.2, anchor: "start" },
  },
  M: {
    key: "M", label: "MOSFET canal N", letter: "m", w: 4, h: 4,
    ports: [{ name: "g", x: 0, y: 2 }, { name: "d", x: 3, y: 0 }, { name: "s", x: 3, y: 4 }],
    body: mosfet(false),
    labelAt: { x: 3.7, y: 2.2, anchor: "start" },
  },
  Mp: {
    key: "Mp", label: "MOSFET canal P", letter: "n", w: 4, h: 4,
    ports: [{ name: "g", x: 0, y: 2 }, { name: "d", x: 3, y: 0 }, { name: "s", x: 3, y: 4 }],
    body: mosfet(true),
    labelAt: { x: 3.7, y: 2.2, anchor: "start" },
  },
  T: {
    key: "T", label: "Transformateur", letter: "t", w: 6, h: 4,
    ports: [
      { name: "a1", x: 0, y: 0 }, { name: "b1", x: 0, y: 4 },
      { name: "a2", x: 6, y: 0 }, { name: "b2", x: 6, y: 4 },
    ],
    body: BODY_T,
    labelAt: { x: 3, y: -0.3, anchor: "middle" },
  },
  B: {
    key: "B", label: "Bloc", letter: "b", w: 6, h: 4,
    ports: [{ name: "in", x: 0, y: 2 }, { name: "out", x: 6, y: 2 }],
    through: ["in", "out"],
    body: BODY_B,
    labelAt: { x: 3, y: 2, anchor: "middle" },
  },
  Gain: {
    key: "Gain", label: "Gain", letter: "", w: 4, h: 4,
    ports: [{ name: "in", x: 0, y: 2 }, { name: "out", x: 4, y: 2 }],
    through: ["in", "out"],
    body: gainBody(4),
    // Texte vers la partie large du triangle (centre de gravite a w/3).
    labelAt: { x: 1.6, y: 2, anchor: "middle" },
  },
  S: {
    key: "S", label: "Sommateur", letter: "s", w: 2, h: 2,
    ports: [
      { name: "in", x: 0, y: 1 }, { name: "in2", x: 1, y: 2 },
      { name: "in3", x: 1, y: 0 }, { name: "out", x: 2, y: 1 },
    ],
    through: ["in", "out"],
    body: BODY_S,
    labelAt: { x: 1.9, y: -0.2, anchor: "start" },
  },
};

const BY_LETTER = new Map<string, SymbolDef>(Object.values(SYMBOLS).filter((d) => d.letter).map((d) => [d.letter, d]));

/** Maj+lettre : variante du symbole de la lettre minuscule. */
const SHIFT_VARIANT: Partial<Record<string, SymKey>> = {
  c: "Cp", q: "Qp", m: "Mp", v: "Vm", a: "Am", r: "Pot", o: "X", g: "Gain",
};

/** Maj+lettre qui pose un symbole deja rempli (bloc integrateur). */
export const PRESETS: Partial<Record<string, { sym: SymKey; value: string; label: string }>> = {
  B: { sym: "B", value: "∫dt", label: "Intégrateur" },
};

/** Symbole pre-rempli d'une touche (Maj+B : integrateur), sinon rien. */
export function presetByKey(key: string): { sym: SymKey; value: string; label: string } | undefined {
  return key.length === 1 ? PRESETS[key] : undefined;
}

/* ---------------- symboles a longueur variable (bloc, gain) ---------------- */

/** Symboles qui s'allongent selon leur texte (largeur `SchemaPart.w`). */
export const STRETCH = new Set<SymKey>(["B", "Gain"]);

const stretched = new Map<string, SymbolDef>();

/**
 * Definition d'un symbole a la largeur `w` (bloc, gain) : boite, borne de
 * sortie, dessin et place du texte suivent. Sans `w` (ancien bloc) ou pour
 * les autres symboles : la definition de la table.
 */
export function symbolFor(key: SymKey, w?: number): SymbolDef {
  const d = SYMBOLS[key];
  if (!w || w === d.w || !STRETCH.has(key) || !Number.isInteger(w) || w < 2) return d;
  const k = `${key}:${w}`;
  let s = stretched.get(k);
  if (!s) {
    s = {
      ...d, w,
      ports: d.ports.map((p) => (p.name === "out" ? { ...p, x: w } : { ...p })),
      body: key === "Gain" ? gainBody(w) : rect(0, 0, w, d.h),
      labelAt: { ...d.labelAt, x: key === "Gain" ? Math.round(w * 0.4 * 100) / 100 : w / 2 },
    };
    stretched.set(k, s);
  }
  return s;
}

/**
 * Largeur (cases, entiere) d'un bloc ou d'un gain pour que son texte tienne
 * dedans ; `textW` = encombrement estime du texte en cases. Bloc : au moins
 * 4, texte + une case de chaque cote. Gain : le texte, centre a 0,4 w, tient
 * dans la hauteur du triangle (au moins 4).
 */
export function fitWidth(key: SymKey, textW: number): number {
  if (key === "Gain") return Math.max(4, Math.ceil(textW * 2.1 - 1e-9));
  if (key === "B") return Math.max(4, Math.ceil(textW + 1.6 - 1e-9));
  return SYMBOLS[key].w;
}

/**
 * Symbole pose par une touche. Minuscule : le symbole de la lettre. Majuscule :
 * la variante (SHIFT_VARIANT) si elle existe, sinon le meme qu'en minuscule.
 */
export function symbolByLetter(letter: string): SymbolDef | undefined {
  if (letter.length !== 1) return undefined;
  const low = letter.toLowerCase();
  if (letter !== low) {
    const v = SHIFT_VARIANT[low];
    if (v) return SYMBOLS[v];
  }
  return BY_LETTER.get(low);
}

/** Dimensions de la boite tournee. */
export function rotatedSize(w: number, h: number, rot: Rot): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
}

/**
 * Rotation d'un point de la boite (w x h) dans le sens horaire (ecran, y vers
 * le bas). Resultat dans la boite tournee, origine en haut a gauche.
 */
export function rotatePoint(x: number, y: number, rot: Rot, w: number, h: number): { x: number; y: number } {
  switch (rot) {
    case 90: return { x: h - y, y: x };
    case 180: return { x: w - x, y: h - y };
    case 270: return { x: y, y: w - x };
    default: return { x, y };
  }
}

/**
 * Bornes en coordonnees absolues de grille d'une piece posee en (x,y), coin
 * haut-gauche de sa boite tournee. Miroir = symetrie gauche-droite a rot 0,
 * appliquee avant la rotation.
 */
export function portsAt(key: SymKey, x: number, y: number, rot: Rot, mirror = false, w?: number): Port[] {
  const d = symbolFor(key, w);
  return d.ports.map((p) => {
    const px = mirror ? d.w - p.x : p.x;
    const r = rotatePoint(px, p.y, rot, d.w, d.h);
    return { name: p.name, x: x + r.x, y: y + r.y };
  });
}
