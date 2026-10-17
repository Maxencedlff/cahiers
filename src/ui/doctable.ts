/**
 * Tableau dans le texte tape (DOM). Le format et les deplacements sont
 * dans src/core/text/doc.ts (jeton `table`) et src/core/text/table.ts.
 *
 * Le tableau est un bloc non editable du texte de la page
 * (`div.doc-table`, contenteditable=false) ; chaque case est un petit texte
 * a elle (`.cell-doc`, un TextDoc d'une ligne) : formules tapees, fractions
 * au « / », suggestions et bulle d'aide marchent comme dans la page. Le
 * texte de la page ignore ce qui se passe dans les cases (TextDoc.owns) et
 * relit le tableau case par case a chaque modification.
 */
import type { DocToken } from "../core/text/doc";
import { afterRemove, cellStep, type CellMove, type CellPos } from "../core/text/table";
import { el } from "./dom";

/** Ce que la vue attend d'une case (un TextDoc en mode case). */
export interface CellDoc {
  readonly root: HTMLElement;
  dispose(): void;
  /** Formules de la ligne mises en forme (comme Entree), avant de quitter la case. */
  finishLine(): void;
  /** Formule ouverte dans l'editeur : les touches sont a elle. */
  readonly editingFormula: boolean;
}

/** Ce que la page fournit au tableau. */
export interface TableHost {
  /** Nouvelle case (markdown d'une ligne). */
  cell(content: string): CellDoc;
  /** Le tableau a change (case tapee, ligne ajoutee) : la page s'enregistre. */
  changed(): void;
  /** Curseur rendu au texte de la page, juste avant ou juste apres le tableau. */
  leave(table: HTMLElement, after: boolean): void;
  /** Tableau retire (vide, ou bouton « Supprimer ») : la page le retire et pose le curseur. */
  remove(table: HTMLElement): void;
}

const cellDocs = new WeakMap<HTMLElement, CellDoc>();
const hosts = new WeakMap<HTMLElement, TableHost>();
/** Derniere case visee de chaque tableau (barre d'outils). */
const lastCell = new WeakMap<HTMLElement, HTMLElement>();

export const TABLE_HELP = "Tab : case suivante (dans la dernière : une ligne de plus) · Maj+Tab : précédente · "
  + "Entrée : case du dessous (à la dernière ligne : nouvelle ligne ; ligne vide : sortir) · Échap : sortir · "
  + "Alt+Maj+flèche : ajouter une ligne/colonne · Alt+Maj+Retour arrière : retirer la ligne, Alt+Maj+Suppr : la colonne";

/** Bloc tableau a poser dans le texte ; `rows` = markdown de chaque case. */
export function buildTable(rows: string[][], host: TableHost): HTMLElement {
  const table = el("table", {});
  const body = el("tbody", {});
  table.append(body);
  for (const r of rows) body.append(makeRow(r, host));
  const wrap = el("div", { class: "doc-table doc-island", contenteditable: "false" }, table, makeBar());
  hosts.set(wrap, host);
  wrap.addEventListener("focusin", (e) => {
    const cell = (e.target as Element).closest?.(".cell-doc");
    if (cell instanceof HTMLElement) lastCell.set(wrap, cell);
    // Barre a droite du tableau, au-dessus s'il n'y a pas la place (style.css).
    const room = (wrap.parentElement?.getBoundingClientRect().right ?? 0) - wrap.getBoundingClientRect().right;
    wrap.classList.toggle("bar-above", room < 440 * (wrap.getBoundingClientRect().width / Math.max(1, wrap.offsetWidth)));
  });
  return wrap;
}

function makeRow(cells: string[], host: TableHost): HTMLElement {
  const tr = el("tr", {});
  for (const c of cells) tr.append(makeCell(c, host));
  return tr;
}

function makeCell(content: string, host: TableHost): HTMLElement {
  const doc = host.cell(content);
  cellDocs.set(doc.root, doc);
  return el("td", {}, doc.root);
}

function makeBar(): HTMLElement {
  const bar = el("div", { class: "doc-table-bar", "aria-label": "Tableau" });
  const button = (label: string, title: string, run: (wrap: HTMLElement, cell: HTMLElement) => void) => {
    const b = el("button", { type: "button", title }, label);
    // Le clavier reste dans la case : pas de focus sur le bouton.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const wrap = b.closest<HTMLElement>(".doc-table");
      if (!wrap) return;
      const cell = lastCell.get(wrap) ?? wrap.querySelector<HTMLElement>(".cell-doc");
      if (cell && wrap.contains(cell)) run(wrap, cell);
    });
    return b;
  };
  bar.append(
    button("+ Ligne", "Ajouter une ligne dessous (Alt+Maj+↓)", (w, c) => addRow(w, c, 1)),
    button("+ Colonne", "Ajouter une colonne à droite (Alt+Maj+→)", (w, c) => addCol(w, c, 1)),
    button("− Ligne", "Retirer la ligne (Alt+Maj+Retour arrière)", (w, c) => removeRow(w, c)),
    button("− Colonne", "Retirer la colonne (Alt+Maj+Suppr)", (w, c) => removeCol(w, c)),
    button("Supprimer", "Supprimer le tableau (Ctrl+Z dans la page le rend)", (w) => hosts.get(w)?.remove(w)),
    el("span", { class: "doc-table-help", title: TABLE_HELP }, "?"),
  );
  return bar;
}

/** Lignes du tableau (td de chaque tr), vivant ou copie. */
function gridOf(wrap: HTMLElement): HTMLElement[][] {
  const body = wrap.querySelector(":scope > table > tbody");
  if (!body) return [];
  return Array.from(body.children).map((tr) => Array.from(tr.children) as HTMLElement[]);
}

function posOf(wrap: HTMLElement, cell: HTMLElement): CellPos | null {
  const grid = gridOf(wrap);
  for (let row = 0; row < grid.length; row++) {
    const col = grid[row].findIndex((td) => td.contains(cell));
    if (col >= 0) return { row, col };
  }
  return null;
}

function cellAt(wrap: HTMLElement, p: CellPos): HTMLElement | null {
  return gridOf(wrap)[p.row]?.[p.col]?.querySelector<HTMLElement>(":scope > .cell-doc") ?? null;
}

/** Jetons du tableau, case par case (`read` : jetons d'un texte de case). */
export function readTable(wrap: HTMLElement, read: (cellRoot: HTMLElement) => DocToken[]): DocToken[][][] {
  return gridOf(wrap).map((tds) => tds.map((td) => {
    const root = td.querySelector<HTMLElement>(":scope > .cell-doc");
    return root ? read(root) : [];
  }));
}

/** Toutes les cases d'un morceau de texte : liberees quand le texte est quitte ou reconstruit. */
export function disposeCells(root: ParentNode): void {
  for (const c of Array.from(root.querySelectorAll<HTMLElement>(".doc-table .cell-doc"))) {
    cellDocs.get(c)?.dispose();
    cellDocs.delete(c);
  }
}

/** Curseur au debut ou a la fin d'une case. */
export function focusCell(cell: HTMLElement, atEnd = true): void {
  cell.focus({ preventScroll: true });
  const sel = document.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(!atEnd);
  sel.removeAllRanges();
  sel.addRange(r);
  cell.closest(".doc-table")?.scrollIntoView({ block: "nearest" });
}

/** Rien d'ecrit avant (ou apres) le curseur dans la case. */
function atEdge(cell: HTMLElement, end: boolean): boolean {
  const sel = document.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  if (!cell.contains(r.startContainer)) return false;
  const span = document.createRange();
  span.selectNodeContents(cell);
  if (end) span.setStart(r.startContainer, r.startOffset);
  else span.setEnd(r.startContainer, r.startOffset);
  return !span.toString().replace(/[​\n]/g, "") && !span.cloneContents().querySelector(".eq, math-field, .doc-link");
}

function cellEmpty(cell: HTMLElement): boolean {
  return !(cell.textContent ?? "").replace(/[​\s]/g, "") && !cell.querySelector(".eq, math-field, .doc-link");
}

function go(wrap: HTMLElement, from: HTMLElement, move: CellMove): void {
  const at = posOf(wrap, from);
  const grid = gridOf(wrap);
  if (!at || !grid.length) return;
  cellDocs.get(from)?.finishLine();
  const t = cellStep(at, { rows: grid.length, cols: grid[0].length }, move);
  if ("cell" in t) {
    const c = cellAt(wrap, t.cell);
    if (c) focusCell(c, t.atEnd);
  } else if ("newRow" in t) {
    addRow(wrap, from, 1, 0);
  } else {
    hosts.get(wrap)?.leave(wrap, t.leave === "after");
  }
}

/** Ligne ajoutee dessous (dir 1) ou dessus (-1) ; curseur dans sa case `col` (celle d'origine par defaut). */
function addRow(wrap: HTMLElement, from: HTMLElement, dir: 1 | -1, col?: number): void {
  const host = hosts.get(wrap);
  const at = posOf(wrap, from);
  const grid = gridOf(wrap);
  if (!host || !at) return;
  const tr = makeRow(grid[at.row].map(() => ""), host);
  const ref = grid[at.row][0].parentElement!;
  if (dir > 0) ref.after(tr); else ref.before(tr);
  host.changed();
  const c = tr.children[col ?? at.col]?.querySelector<HTMLElement>(".cell-doc");
  if (c) focusCell(c);
}

function addCol(wrap: HTMLElement, from: HTMLElement, dir: 1 | -1): void {
  const host = hosts.get(wrap);
  const at = posOf(wrap, from);
  if (!host || !at) return;
  let target: HTMLElement | null = null;
  gridOf(wrap).forEach((tds, row) => {
    const td = makeCell("", host);
    if (dir > 0) tds[at.col].after(td); else tds[at.col].before(td);
    if (row === at.row) target = td.querySelector<HTMLElement>(".cell-doc");
  });
  host.changed();
  if (target) focusCell(target);
}

function removeRow(wrap: HTMLElement, from: HTMLElement): void {
  const host = hosts.get(wrap);
  const at = posOf(wrap, from);
  const grid = gridOf(wrap);
  if (!host || !at) return;
  const next = afterRemove(at, { rows: grid.length, cols: grid[0].length }, "row");
  if (!next) { host.remove(wrap); return; }
  disposeCells(grid[at.row][0].parentElement!);
  grid[at.row][0].parentElement!.remove();
  host.changed();
  const c = cellAt(wrap, next);
  if (c) focusCell(c);
}

function removeCol(wrap: HTMLElement, from: HTMLElement): void {
  const host = hosts.get(wrap);
  const at = posOf(wrap, from);
  const grid = gridOf(wrap);
  if (!host || !at) return;
  const next = afterRemove(at, { rows: grid.length, cols: grid[0].length }, "col");
  if (!next) { host.remove(wrap); return; }
  for (const tds of grid) {
    const root = tds[at.col].querySelector<HTMLElement>(".cell-doc");
    if (root) { cellDocs.get(root)?.dispose(); cellDocs.delete(root); }
    tds[at.col].remove();
  }
  host.changed();
  const c = cellAt(wrap, next);
  if (c) focusCell(c);
}

/**
 * Touche tapee dans une case (TextDoc.onKey, apres la formule en cours, la
 * suggestion et la bulle d'aide). Vrai si le tableau l'a prise.
 */
export function tableKey(e: KeyboardEvent, cell: HTMLElement): boolean {
  const wrap = cell.closest<HTMLElement>(".doc-table");
  if (!wrap || cellDocs.get(cell)?.editingFormula) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey && e.shiftKey && !ctrl) {
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") { addRow(wrap, cell, k === "ArrowDown" ? 1 : -1); return true; }
    if (k === "ArrowRight" || k === "ArrowLeft") { addCol(wrap, cell, k === "ArrowRight" ? 1 : -1); return true; }
    if (k === "Backspace") { removeRow(wrap, cell); return true; }
    if (k === "Delete") { removeCol(wrap, cell); return true; }
    return false;
  }
  if (ctrl || e.altKey) return false;
  switch (e.key) {
    case "Tab":
      go(wrap, cell, e.shiftKey ? "prev" : "next");
      return true;
    case "Enter": {
      if (e.shiftKey) return true; // une case = une ligne
      const at = posOf(wrap, cell);
      const grid = gridOf(wrap);
      if (!at) return true;
      const lastRow = at.row === grid.length - 1;
      // Ligne vide en fin de tableau (Entree deux fois) : on en sort, comme d'une liste.
      if (lastRow && grid.length > 1 && grid[at.row].every((td) => cellEmpty(td.querySelector(".cell-doc") ?? td))) {
        disposeCells(grid[at.row][0].parentElement!);
        grid[at.row][0].parentElement!.remove();
        hosts.get(wrap)?.changed();
        hosts.get(wrap)?.leave(wrap, true);
        return true;
      }
      cellDocs.get(cell)?.finishLine();
      if (lastRow) addRow(wrap, cell, 1, 0);
      else go(wrap, cell, "down");
      return true;
    }
    case "ArrowDown":
    case "ArrowUp":
      if (e.shiftKey) return false;
      go(wrap, cell, e.key === "ArrowDown" ? "down" : "up");
      return true;
    case "ArrowRight":
    case "ArrowLeft": {
      if (e.shiftKey || !atEdge(cell, e.key === "ArrowRight")) return false;
      go(wrap, cell, e.key === "ArrowRight" ? "right" : "left");
      return true;
    }
    case "Escape":
      cellDocs.get(cell)?.finishLine();
      hosts.get(wrap)?.leave(wrap, true);
      return true;
    case "Backspace": {
      // Tableau entierement vide, Retour arriere au debut de la 1re case : il disparait.
      const first = wrap.querySelector<HTMLElement>(".cell-doc");
      if (first !== cell || !atEdge(cell, false)) return false;
      if (Array.from(wrap.querySelectorAll<HTMLElement>(".cell-doc")).every(cellEmpty)) hosts.get(wrap)?.remove(wrap);
      return true;
    }
    default:
      return false;
  }
}

/** Premiere ou derniere case d'un tableau (on y entre depuis le texte de la page). */
export function edgeCell(wrap: HTMLElement, last: boolean): HTMLElement | null {
  const all = wrap.querySelectorAll<HTMLElement>(".cell-doc");
  return all[last ? all.length - 1 : 0] ?? null;
}
