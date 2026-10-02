import type { Block, BlockAngle, CalcBlock, GraphBlock } from "./types";
import { docImageIds } from "./text/doc";

/**
 * Blocs vivants calc et graph (section 2) : logique pure, sans DOM ni
 * mathjs. Ils sont poses dans le texte tape comme les photos (jeton
 * `![](img:<id>)`), un appui rouvre la calculatrice, « Mettre à jour »
 * recalcule et redessine sur place.
 */

export type LiveBlock = CalcBlock | GraphBlock;

/** Largeur par defaut d'une courbe dans le texte, en unites de page. */
export const GRAPH_WIDTH = 560;
export const GRAPH_MIN_WIDTH = 240;
/** Rapport hauteur / largeur du trace d'une courbe dans la page. */
export const GRAPH_RATIO = 0.5;

export function isLiveBlock(b: Block): b is LiveBlock {
  return b.type === "calc" || b.type === "graph";
}

/**
 * Bloc qui vit dans le texte tape (sans rect) : le texte lui-meme, une
 * photo, un calcul ou une courbe. L'annulation de l'encre ne les touche
 * pas (le texte a son propre Ctrl+Z).
 */
export function isInTextBlock(b: Block): boolean {
  return (b.type === "text" || b.type === "image" || b.type === "calc" || b.type === "graph") && !b.rect;
}

/**
 * Calculs et courbes retires du texte lors d'une seance precedente (le
 * bouton ✕ garde le bloc le temps du « Annuler ») : ids a oublier a
 * l'ouverture de la page. Les photos restent (leur fichier est dans assets/).
 */
export function orphanLiveIds(blocks: readonly Block[], textContent: string): string[] {
  const inText = new Set(docImageIds(textContent));
  return blocks.filter((b) => isLiveBlock(b) && !b.rect && !inText.has(b.id)).map((b) => b.id);
}

/** Nom court d'un bloc vivant, pour les messages. */
export function liveLabel(b: LiveBlock): string {
  return b.type === "calc" ? "Calcul" : "Courbe";
}

/** Ce que la calculatrice renvoie a « Mettre à jour » ou « Envoyer ». */
export interface CalcSpec { expr: string; result: string; angle: BlockAngle }
export interface GraphSpec {
  fn: string; domain: [number, number]; range?: [number, number]; angle: BlockAngle;
  /** Axe x logarithmique (Bode). Absent = lineaire. */
  logX?: boolean;
}

/**
 * Applique une modification venue de la calculatrice. Le mode RAD n'est pas
 * ecrit (valeur par defaut, fichiers plus courts) ; une fenetre auto retire
 * `range`. Rend true si quelque chose a change.
 */
export function applyCalcSpec(b: CalcBlock, s: CalcSpec): boolean {
  const before = JSON.stringify([b.expr, b.result, b.angle ?? "RAD"]);
  b.expr = s.expr;
  b.result = s.result;
  if (s.angle === "DEG") b.angle = "DEG"; else delete b.angle;
  return JSON.stringify([b.expr, b.result, b.angle ?? "RAD"]) !== before;
}

export function applyGraphSpec(b: GraphBlock, s: GraphSpec): boolean {
  const before = JSON.stringify([b.fn, b.domain, b.range ?? null, b.angle ?? "RAD", !!b.logX]);
  b.fn = s.fn;
  b.domain = [s.domain[0], s.domain[1]];
  if (s.range) b.range = [s.range[0], s.range[1]]; else delete b.range;
  if (s.angle === "DEG") b.angle = "DEG"; else delete b.angle;
  if (s.logX) b.logX = true; else delete b.logX;
  return JSON.stringify([b.fn, b.domain, b.range ?? null, b.angle ?? "RAD", !!b.logX]) !== before;
}

/** Spec d'un bloc existant, pour preremplir la calculatrice. */
export function calcSpecOf(b: CalcBlock): CalcSpec {
  return { expr: b.expr, result: String(b.result ?? ""), angle: b.angle ?? "RAD" };
}

export function graphSpecOf(b: GraphBlock): GraphSpec {
  const spec: GraphSpec = { fn: b.fn, domain: [b.domain[0], b.domain[1]], angle: b.angle ?? "RAD" };
  if (b.logX) spec.logX = true;
  if (b.range && Number.isFinite(b.range[0]) && Number.isFinite(b.range[1]) && b.range[0] < b.range[1]) {
    spec.range = [b.range[0], b.range[1]];
  }
  return spec;
}

/** Largeur d'une courbe dans le texte : bornee a la page (comme une photo). */
export function graphWidth(b: GraphBlock, pageW: number): number {
  const w = b.width ?? (b.rect ? b.rect.w : GRAPH_WIDTH);
  return Math.round(Math.max(GRAPH_MIN_WIDTH, Math.min(pageW - 128, w)));
}
