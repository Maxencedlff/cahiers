/**
 * Mise en page du texte tape, logique pure (le DOM est dans
 * src/ui/linesnap.ts, textdoc.ts et pageview.ts).
 *
 *  - Interligne = pas du fond Ligne / Seyes (8 mm a l'echelle de la
 *    feuille) : les lignes normales tombent sur les lignes du fond.
 *  - Une ligne haute (fraction, photo, calcul) prend un nombre ENTIER de
 *    lignes : elle ne chevauche jamais ses voisines et la suite du texte
 *    retombe sur le fond.
 *  - Un clic sous la fin du texte y pose le curseur (lignes vides ajoutees).
 *  - Une ligne vide posee sur de l'encre descend sous l'encre avant qu'on
 *    y tape (le texte ne recouvre jamais un schema).
 *
 * Toutes les longueurs sont en unites de page (PAGE_W = 900 pour 210 mm),
 * sauf mention « em » (corps du texte).
 */
import { MM } from "./paper";
import { PAGE_W } from "./ink/sheet";

/** Corps du texte, unites de page (style.css : 21px * --k). */
export const TEXT_FONT = 21;
/** Interligne : 8 mm, le pas du fond Ligne et du grand carreau Seyes. */
export const LINE = 8 * MM;
export const LINE_EM = LINE / TEXT_FONT;
/**
 * (ascent - descent) / 2 de KaTeX_Main, en em : la ligne de base tombe a
 * LINE / 2 + FONT_SHIFT_EM * corps sous le haut de la ligne (mesure dans
 * Chromium : police 100 px, interligne 200 px -> ligne de base a 131 px).
 */
export const FONT_SHIFT_EM = 0.31;
/** Ligne de base depuis le haut d'une ligne normale. */
export const BASE = LINE / 2 + FONT_SHIFT_EM * TEXT_FONT;
export const BASE_EM = BASE / TEXT_FONT;
/** La ligne de base est posee un peu au-dessus de la ligne du fond, pas dessus. */
export const BASE_LIFT = 1.5;
/** Ligne du fond qui porte la premiere ligne de texte (8 mm * 2 du haut). */
export const FIRST_RULE = 2;
/** Marge haute du texte : la premiere ligne de base tombe sur la ligne FIRST_RULE. */
export const TEXT_TOP = round2(FIRST_RULE * LINE - BASE - BASE_LIFT);
/** Marges laterales du texte (style.css). */
export const TEXT_SIDE = 64;
/** Blanc minimal garde au-dessus et au-dessous d'une formule haute (em). */
export const EQ_GAP_EM = 0.12;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Ligne de base de la ligne `i` (0 = premiere), dans une suite de lignes normales. */
export function baselineOf(i: number): number {
  return TEXT_TOP + BASE + i * LINE;
}

/** Ligne du texte (0 = premiere) qui contient l'ordonnee y. */
export function rowAt(y: number): number {
  return Math.floor((y - TEXT_TOP) / LINE);
}

/** Bas de la ligne de texte qui contient y (toutes les lignes sont sur la grille). */
export function rowBottom(y: number): number {
  return TEXT_TOP + (rowAt(y) + 1) * LINE;
}

/**
 * Marges (em) d'une formule posee dans une ligne normale. `boxAsc`/`boxDesc`
 * : sa boite au-dessus et au-dessous de la ligne de base ; `inkAsc`/
 * `inkDesc` : ce qu'elle dessine vraiment (bornes KaTeX). La boite de marge
 * couvre un nombre entier de lignes : la ligne grandit par lignes entieres,
 * jamais de chevauchement, et la suite reste calee sur le fond.
 *
 * Le moins de lignes possible, comme Word : une formule basse (V_e = 12 V)
 * garde sa ligne ; une fraction prend deux lignes. Sa ligne de base reste
 * sur la grille si le contenu y tient, sinon le contenu est centre dans ses
 * lignes (la ligne de la fraction flotte entre deux lignes du fond, les
 * suivantes retombent dessus).
 */
export function snapInline(boxAsc: number, boxDesc: number, inkAsc: number, inkDesc: number,
  line = LINE_EM, base = BASE_EM, gap = EQ_GAP_EM): { top: number; bottom: number; rows: number } {
  const up = inkAsc + gap, down = inkDesc + gap;
  const fits = (above: number, below: number) => above >= up - 1e-9 && below >= down - 1e-9;
  let rows = Math.max(1, Math.ceil((up + down) / line - 1e-6));
  let above = NaN;
  for (; rows < 1000 && Number.isNaN(above); rows++) {
    // Ligne de base sur la grille : sous la ligne j de la formule.
    for (let j = 0; j < rows; j++) {
      const a = base + j * line;
      if (fits(a, rows * line - a)) { above = a; break; }
    }
    if (Number.isNaN(above) && rows >= 2 && up + down <= rows * line) {
      above = up + (rows * line - up - down) / 2;
    }
    if (!Number.isNaN(above)) break;
  }
  return {
    top: round4(above - boxAsc),
    bottom: round4(rows * line - above - boxDesc),
    rows,
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Marges d'un bloc pose dans le texte (photo, calcul, courbe) de hauteur h :
 * un peu d'air au-dessus, et le tout arrondi a un nombre entier de lignes.
 */
export function blockMargins(h: number, line: number, air = 0.25): { top: number; bottom: number } {
  const top = air * line;
  const rows = Math.max(1, Math.ceil((h + 2 * top) / line - 1e-6));
  return { top, bottom: rows * line - h - top };
}

/**
 * Decalage vertical (em de la ligne) d'un titre de corps `scale` (en em du
 * texte) pose sur `rows` lignes : sa ligne de base retombe sur celle de la
 * derniere ligne de la grille qu'il occupe.
 */
export function headingShift(scale: number, rows: number): number {
  // Boite de rows lignes : ligne de base a rows*L/2 + shift*corps*scale.
  // Voulue : (rows-1)*L + BASE.
  const want = (rows - 1) * LINE + BASE;
  const got = (rows * LINE) / 2 + FONT_SHIFT_EM * TEXT_FONT * scale;
  return round4((want - got) / TEXT_FONT);
}

/** Boite d'encre (unites de page). */
export interface InkBox { x: number; y: number; w: number; h: number }

/**
 * Haut de la premiere ligne libre a partir de `top` (haut d'une ligne vide) :
 * une ligne dont la bande touche de l'encre dans la colonne du texte descend
 * d'autant de lignes entieres qu'il faut pour passer dessous. Un trait qui
 * ne fait qu'effleurer le bord de la bande (`graze`) ne compte pas.
 */
export function clearOfInk(boxes: readonly InkBox[], top: number, opts: {
  line?: number; left?: number; right?: number; graze?: number; max?: number;
} = {}): number {
  const line = opts.line ?? LINE;
  const left = opts.left ?? TEXT_SIDE;
  const right = opts.right ?? PAGE_W - TEXT_SIDE;
  // Ecriture a la main : les jambages debordent souvent d'un tiers de ligne.
  const graze = opts.graze ?? line * 0.3;
  const max = opts.max ?? 400;
  const col = boxes.filter((b) => b.w >= 0 && b.x + b.w > left && b.x < right);
  let t = top;
  for (let i = 0; i < max; i++) {
    let bottom = -Infinity;
    for (const b of col) {
      if (b.y < t + line - graze && b.y + b.h > t + graze) bottom = Math.max(bottom, b.y + b.h);
    }
    if (bottom === -Infinity) return t;
    t += Math.max(1, Math.ceil((bottom - graze - t) / line - 1e-6)) * line;
  }
  return t;
}

/**
 * Nombre de lignes vides a ajouter sous la derniere ligne (centre a
 * `lastCenter`) pour que la ligne du curseur contienne `y`. 0 si y est
 * deja sur la derniere ligne ou au-dessus.
 */
export function linesToReach(lastCenter: number, y: number, line: number, max = 400): number {
  if (y <= lastCenter + line / 2) return 0;
  return Math.min(max, Math.round((y - lastCenter) / line));
}
