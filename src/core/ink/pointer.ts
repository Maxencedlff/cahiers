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
