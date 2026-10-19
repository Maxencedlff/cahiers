/**
 * Disposition du chrome (logique pure) : barre laterale, calculatrice,
 * palette d'outils, volet des formules et placement des messages
 * ephemeres (toasts).
 */

/* ---------------- barre laterale ---------------- */

/** Largeur a partir de laquelle la barre laterale pousse la page (paysage). */
export const SIDEBAR_DOCK_MIN = 1000;
/** En dessous : telephone, navigation en pile (liste plein ecran, puis la page). */
export const PHONE_MAX = 600;
export const SIDEBAR_W = 248;

export type SidebarMode = "docked" | "overlay" | "stack";

/**
 * Barre laterale facon Notes : a cote de la page sur un ecran large,
 * en surimpression sur une tablette en portrait (elle se referme apres un
 * choix), plein ecran au telephone (liste, puis la page : une pile).
 */
export function sidebarMode(width: number): SidebarMode {
  if (width >= SIDEBAR_DOCK_MIN) return "docked";
  return width >= PHONE_MAX ? "overlay" : "stack";
}

/* ---------------- calculatrice ---------------- */

/** Largeur du panneau inspecteur de la calculatrice. */
export const CALC_PANEL_W = 360;
/** Largeur de feuille gardee a cote du panneau (sinon elle flotte). */
const CALC_MIN_STAGE = 560;

export type CalcPlacement = "panel" | "float" | "sheet";

/**
 * Ou poser la calculatrice : panneau a droite qui pousse la page sans la
 * couvrir (inspecteur) ; fenetre flottante si l'utilisateur l'a detachee
 * ou si la page n'aurait plus sa largeur lisible ; au telephone, en bas
 * sur toute la largeur. Tablette en portrait (plus haute que large, pas de
 * place pour le panneau) : en bas aussi, la page reste lisible au-dessus
 * au lieu d'etre couverte en son milieu.
 */
export function calcPlacement(o: { width: number; stage: number; detached: boolean; height?: number }): CalcPlacement {
  if (o.width < PHONE_MAX) return "sheet";
  if (o.detached) return "float";
  if (o.stage - CALC_PANEL_W >= CALC_MIN_STAGE) return "panel";
  return o.height !== undefined && o.height > o.width ? "sheet" : "float";
}

/* ---------------- palette d'outils ---------------- */

/** Sous cette largeur de zone, les six pastilles se replient en un bouton. */
export const PALETTE_COMPACT_MAX = 600;

export function paletteCompact(stageWidth: number): boolean {
  return stageWidth < PALETTE_COMPACT_MAX;
}

/* ---------------- volet des formules (Σ) ---------------- */

export type FormulaPlacement = "closed" | "dock" | "sheet";

/**
 * Volet des formules : un panneau ancre dans la colonne de droite, comme
 * la calculatrice, qui retrecit la zone des pages au lieu de flotter
 * dessus (il ne couvre jamais le texte). Au telephone, en bas sur toute
 * la largeur : la page peut remonter au-dessus.
 */
export function formulaPlacement(o: { open: boolean; width: number }): FormulaPlacement {
  if (!o.open) return "closed";
  return o.width < PHONE_MAX ? "sheet" : "dock";
}

/**
 * Part de la colonne de droite laissee au volet des formules quand la
 * calculatrice y est ancree en dessous (separateur deplacable). null =
 * automatique : la calculatrice a sa hauteur naturelle (tout le pave
 * visible), le volet le reste, jamais moins que de quoi chercher et
 * voir quelques lignes (CSS). Bornee : chacun garde de quoi servir.
 */
const FORMULA_SPLIT_MIN = 0.2;
const FORMULA_SPLIT_MAX = 0.8;

export function clampFormulaSplit(ratio: unknown): number | null {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  return Math.min(FORMULA_SPLIT_MAX, Math.max(FORMULA_SPLIT_MIN, ratio));
}

/* ---------------- messages ephemeres ---------------- */

/** Messages a l'ecran en meme temps, au plus. */
export const MAX_TOASTS = 3;

export interface ToastLike {
  /** Porte un bouton (« Annuler ») : on le garde plus volontiers. */
  action: boolean;
}

/**
 * Messages a retirer avant d'en poser un nouveau (indices dans `shown`,
 * du plus ancien au plus recent). Le plus ancien part, sauf s'il porte une
 * action et qu'un message sans action peut partir a sa place : un
 * « Annuler » ne disparait pas sous trois « Stylet detecte ».
 */
export function toastsToDrop(shown: readonly ToastLike[], max = MAX_TOASTS): number[] {
  const kept = shown.map((t, i) => ({ ...t, i }));
  const drop: number[] = [];
  while (kept.length >= max) {
    const k = kept.findIndex((t) => !t.action);
    const at = k >= 0 ? k : 0;
    drop.push(kept[at].i);
    kept.splice(at, 1);
  }
  return drop.sort((a, b) => a - b);
}

export interface Rect { x: number; y: number; w: number; h: number }

export type ToastCorner = "top-right" | "bottom-right";

export interface ToastPlacement {
  corner: ToastCorner;
  /** Distance au bord haut (top-right) ou bas (bottom-right), en px. */
  offset: number;
  /** Distance au bord droit, en px. */
  right: number;
}

/** Largeur et hauteur reservees a la pile de messages (3 messages au plus). */
export const TOAST_ZONE = { w: 360, h: 3 * 56 + 2 * 8 };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Ou poser la pile : en haut a droite, sous la barre du haut, hors de la
 * zone d'ecriture centrale. Si un element flottant y est deja (calculatrice
 * detachee, volet), on passe en bas a droite au-dessus de l'indicateur de
 * page ; si les deux coins sont pris, on decale vers la gauche de
 * l'obstacle du haut plutot que de le recouvrir.
 */
export function toastPlacement(o: {
  width: number; height: number; top: number; bottom: number; avoid: readonly Rect[];
}): ToastPlacement {
  const margin = 12;
  const w = Math.min(TOAST_ZONE.w, o.width - 2 * margin);
  const topZone: Rect = { x: o.width - margin - w, y: o.top + margin, w, h: TOAST_ZONE.h };
  if (!o.avoid.some((r) => overlaps(r, topZone))) return { corner: "top-right", offset: o.top + margin, right: margin };
  const bottomZone: Rect = { x: o.width - margin - w, y: o.height - o.bottom - margin - TOAST_ZONE.h, w, h: TOAST_ZONE.h };
  if (!o.avoid.some((r) => overlaps(r, bottomZone))) return { corner: "bottom-right", offset: o.bottom + margin, right: margin };
  // Les deux coins sont pris : a gauche de l'obstacle du haut, s'il reste la place.
  const blocker = o.avoid.filter((r) => overlaps(r, topZone)).reduce((a, r) => (r.x < a.x ? r : a));
  const right = o.width - blocker.x + margin;
  if (o.width - right - w >= margin) return { corner: "top-right", offset: o.top + margin, right };
  return { corner: "top-right", offset: o.top + margin, right: margin };
}
