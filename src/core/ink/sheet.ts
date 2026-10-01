import type { Block, Page, Stroke } from "../types";

/** Unites de page. Rapport proche d'une feuille A4 en portrait. */
export const PAGE_W = 900;
export const PAGE_H = 1240;

/**
 * Place laissee sous le trait le plus bas quand il depasse l'A4 : on doit
 * pouvoir continuer a ecrire sous un schema sans tomber au bord de la
 * feuille. Une page dont l'encre tient dans l'A4 garde sa taille.
 */
export const INK_MARGIN = 80;

/** Traits d'un bloc, quel que soit son type. */
function strokesOf(b: Block): Stroke[] {
  if (b.type === "ink" || b.type === "math") return b.strokes;
  if (b.type === "pdf") return b.annotations;
  return [];
}

/** Bas du trait le plus bas de la page (epaisseur comprise), 0 sans encre. */
export function inkBottom(blocks: Block[]): number {
  let bottom = 0;
  for (const b of blocks) {
    for (const s of strokesOf(b)) {
      const half = s.width / 2;
      for (const p of s.points) if (p.y + half > bottom) bottom = p.y + half;
    }
  }
  return bottom;
}

/**
 * Hauteur logique de la feuille, en unites de page : jamais moins qu'une A4,
 * et assez pour le texte tape (`textH`) comme pour l'encre la plus basse.
 * La feuille ET le canvas prennent cette hauteur : un trait ecrit sous l'A4
 * garde ses coordonnees au lieu d'etre ecrase sur le bord (y = PAGE_H).
 */
export function sheetHeight(page: Page, textH = 0): number {
  const ink = inkBottom(page.blocks);
  return Math.ceil(Math.max(
    PAGE_H,
    page.height ?? 0,
    textH,
    ink > PAGE_H ? ink + INK_MARGIN : 0,
  ));
}

/**
 * Trait termine sous l'A4 : la hauteur est notee dans la page, pour qu'elle
 * se rouvre a la bonne taille. Rend true si la hauteur a change.
 */
export function growForStroke(page: Page, stroke: Stroke): boolean {
  let bottom = 0;
  for (const p of stroke.points) if (p.y + stroke.width / 2 > bottom) bottom = p.y + stroke.width / 2;
  if (bottom <= PAGE_H) return false;
  const need = Math.ceil(bottom + INK_MARGIN);
  if (need <= (page.height ?? PAGE_H)) return false;
  page.height = need;
  return true;
}
