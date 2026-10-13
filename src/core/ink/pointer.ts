/**
 * Regles du pointeur, sans DOM : quel outil prend un geste, et quand un
 * appui du doigt est une paume a ignorer. Testees dans ink.test.ts.
 */

/** Champs d'un PointerEvent utiles ici (un objet simple suffit aux tests). */
export interface PointerLike {
  pointerType: string;
  button: number;
  buttons: number;
}

/**
 * Outil du geste. Le bout gomme d'un stylet MPP (button 5, buttons & 32) et
 * le bouton lateral (button 2, buttons & 2) gomment, quel que soit l'outil
 * choisi : retourner le stylet pour effacer est le geste de correction le
 * plus frequent en cours. Le resultat est fige pour tout le geste.
 */
export function gestureTool<T extends string>(e: PointerLike, chosen: T): T | "eraser" {
  if (e.pointerType !== "pen") return chosen;
  const eraserEnd = (e.buttons & 32) !== 0 || e.button === 5;
  const barrel = (e.buttons & 2) !== 0 || e.button === 2;
  return eraserEnd || barrel ? "eraser" : chosen;
}

/** Delai apres la derniere activite du stylet pendant lequel le doigt est ignore. */
export const PALM_DELAY_MS = 400;

/**
 * Un appui du doigt qui voudrait faire defiler la page est-il une paume ?
 * Oui tant que le stylet ecrit, et juste apres son lever ou son survol : la
 * main se pose avant le trait et reste posee apres.
 */
export function isPalm(now: number, penWriting: boolean, lastPenAt: number): boolean {
  return penWriting || now - lastPenAt < PALM_DELAY_MS;
}

/* ---------------- appui court, appui long ---------------- */

/** Deplacement maximal (pixels d'ecran) d'un appui qui n'est pas un trait. */
export const TAP_MOVE_PX = 3;
/** Duree maximale d'un appui court (ms). */
export const TAP_MS = 200;
/** Appui long : immobile (a TAP_MOVE_PX pres) pendant ce delai (ms). */
export const LONG_PRESS_MS = 500;
/** Doigt : deplacement (pixels) avant de decider que c'est un defilement. */
export const PAN_SLOP_PX = 6;
/** Doigt : duree maximale d'un appui court (ms). */
export const TOUCH_TAP_MS = 350;

/**
 * Appui court : moins de TAP_MOVE_PX de deplacement et moins de TAP_MS.
 * Ce n'est jamais de l'encre (audit : les seuls « traits » de 116 pages
 * reelles etaient des appuis involontaires de 2 points, lus « . »), sauf
 * point voulu (isWantedDot).
 */
export function isTap(movedPx: number, durationMs: number, kind: "pen" | "touch" = "pen"): boolean {
  // Le doigt est plus large et plus lent qu'une pointe : marge de
  // defilement (PAN_SLOP_PX) et appui jusqu'a TOUCH_TAP_MS.
  if (kind === "touch") return movedPx < PAN_SLOP_PX && durationMs < TOUCH_TAP_MS;
  return movedPx < TAP_MOVE_PX && durationMs < TAP_MS;
}

/** Trait recent, pour reconnaitre un point voulu (bornes en unites de page). */
export interface RecentStroke {
  bounds: { x: number; y: number; w: number; h: number };
  endedAt: number;
}

/** Un point voulu touche un trait pose a moins de cette distance (unites de page, ~7 mm). */
export const DOT_NEAR = 30;
/** ... et pose depuis moins de ce delai (ms). */
export const DOT_WINDOW_MS = 1500;

/**
 * Point voulu : un autre trait a ete pose tout pres dans les 1,5 s (point
 * du i, accent, virgule decimale). Un appui isole n'en est pas un.
 */
export function isWantedDot(
  p: { x: number; y: number }, now: number, recent: readonly RecentStroke[],
): boolean {
  return recent.some((r) => {
    if (now - r.endedAt > DOT_WINDOW_MS || now < r.endedAt - 50) return false;
    const b = r.bounds;
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
    return Math.hypot(dx, dy) <= DOT_NEAR;
  });
}
