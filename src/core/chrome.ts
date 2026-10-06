/**
 * Disposition du chrome de l'ecran cahier (logique pure) : volet du ruban
 * Maths et placement des messages ephemeres (toasts).
 */

/* ---------------- ruban Maths ---------------- */

/**
 * Largeur a partir de laquelle le ruban epingle devient une colonne a cote
 * du rail : la feuille garde alors toute sa largeur de lecture.
 */
export const MATH_DOCK_MIN = 1600;

export type MathPanelMode = "closed" | "float" | "column";

/**
 * Ou montrer le ruban Maths. Ferme par defaut ; ouvert d'un appui en volet
 * flottant par-dessus la marge (ferme par Echap ou un appui a cote) ;
 * epingle, il reste ouvert, en colonne si l'ecran est assez large et qu'il
 * n'y a pas de split (la colonne prendrait la place d'un panneau).
 */
export function mathPanelMode(o: { open: boolean; pinned: boolean; width: number; split: boolean }): MathPanelMode {
  if (o.pinned) return o.width >= MATH_DOCK_MIN && !o.split ? "column" : "float";
  return o.open ? "float" : "closed";
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
