/**
 * Tableau du texte tape : deplacements du curseur entre les cases et
 * operations sur les lignes et colonnes. Logique pure, sans DOM : la vue
 * (src/ui/doctable.ts) demande ou aller, puis touche son tableau.
 */

export interface CellPos { row: number; col: number }
export interface TableSize { rows: number; cols: number }

/**
 * Touche de deplacement dans un tableau :
 *  - next / prev : Tab / Maj+Tab (case suivante, en passant a la ligne) ;
 *  - down / up : fleches verticales et Entree (meme colonne) ;
 *  - right / left : fleche au bord de la case.
 */
export type CellMove = "next" | "prev" | "down" | "up" | "right" | "left";

/**
 * Ou va le curseur : une case, `newRow` (Tab dans la derniere case : une
 * ligne de plus, comme Word), `before` / `after` (on sort du tableau).
 */
export type CellTarget = { cell: CellPos; atEnd: boolean } | { newRow: true } | { leave: "before" | "after" };

export function cellStep(at: CellPos, size: TableSize, move: CellMove): CellTarget {
  const { row, col } = at;
  const last = { row: size.rows - 1, col: size.cols - 1 };
  switch (move) {
    case "next":
      if (col < last.col) return { cell: { row, col: col + 1 }, atEnd: true };
      if (row < last.row) return { cell: { row: row + 1, col: 0 }, atEnd: true };
      return { newRow: true };
    case "prev":
      if (col > 0) return { cell: { row, col: col - 1 }, atEnd: true };
      if (row > 0) return { cell: { row: row - 1, col: last.col }, atEnd: true };
      return { leave: "before" };
    case "right":
      if (col < last.col) return { cell: { row, col: col + 1 }, atEnd: false };
      if (row < last.row) return { cell: { row: row + 1, col: 0 }, atEnd: false };
      return { leave: "after" };
    case "left":
      if (col > 0) return { cell: { row, col: col - 1 }, atEnd: true };
      if (row > 0) return { cell: { row: row - 1, col: last.col }, atEnd: true };
      return { leave: "before" };
    case "down":
      return row < last.row ? { cell: { row: row + 1, col }, atEnd: true } : { leave: "after" };
    case "up":
      return row > 0 ? { cell: { row: row - 1, col }, atEnd: true } : { leave: "before" };
  }
}

/** Taille choisie a l'insertion : « 3x4 », « 3 × 4 », « 3*4 » (lignes × colonnes, 1 a 20). */
export function parseTableSize(s: string): TableSize | null {
  const m = /^\s*(\d{1,2})\s*[x×*]\s*(\d{1,2})\s*$/i.exec(s);
  if (!m) return null;
  const rows = Number(m[1]), cols = Number(m[2]);
  return rows >= 1 && cols >= 1 && rows <= 20 && cols <= 20 ? { rows, cols } : null;
}

/** Case ou revient le curseur apres avoir retire une ligne ou une colonne. */
export function afterRemove(at: CellPos, size: TableSize, what: "row" | "col"): CellPos | null {
  if (what === "row") {
    if (size.rows <= 1) return null;
    return { row: Math.min(at.row, size.rows - 2), col: at.col };
  }
  if (size.cols <= 1) return null;
  return { row: at.row, col: Math.min(at.col, size.cols - 2) };
}
