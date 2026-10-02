/**
 * Navigation entre cahiers, intercalaires et pages. Logique pure, sans DOM :
 * historique des sauts (retour arriere), filtre du menu au clavier, choix
 * de l'intercalaire du split, date d'une page.
 */

import { fold } from "./text/find";

/* ---------------- retour arriere ---------------- */

/** Un endroit ou l'on etait : cahier (dossier), intercalaire, page. */
export interface NavSpot {
  notebook: string;
  divider: string;
  page: number;
}

const sameSpot = (a: NavSpot, b: NavSpot) =>
  a.notebook === b.notebook && a.divider === b.divider && a.page === b.page;

/**
 * Pile des endroits quittes par un saut (resultat de recherche, repere,
 * lien, liste des pages). Alt+← et le bouton retour de la souris y
 * ramenent. Bornee : on ne remonte pas toute la journee.
 */
export class NavHistory {
  private stack: NavSpot[] = [];

  constructor(private max = 50) {}

  get size(): number { return this.stack.length; }

  /** Retient l'endroit qu'on quitte. Rien si on y est deja (deux sauts sur place). */
  push(spot: NavSpot): void {
    if (!spot.notebook || !spot.divider || spot.page < 1) return;
    const top = this.stack[this.stack.length - 1];
    if (top && sameSpot(top, spot)) return;
    this.stack.push({ ...spot });
    if (this.stack.length > this.max) this.stack.shift();
  }

  /**
   * L'endroit d'avant. `here` : on y est deja, on le saute (on revient
   * vraiment quelque part).
   */
  pop(here?: NavSpot | null): NavSpot | null {
    for (;;) {
      const s = this.stack.pop();
      if (!s) return null;
      if (!here || !sameSpot(s, here)) return s;
    }
  }

  /** Un groupe renomme ou deplace emmene les endroits de son contenu (D4). */
  renameDivider(notebook: string, from: string, to: string): void {
    for (const s of this.stack) {
      if (s.notebook !== notebook) continue;
      if (s.divider === from) s.divider = to;
      else if (s.divider.startsWith(from + "/")) s.divider = to + s.divider.slice(from.length);
    }
  }

  renameNotebook(from: string, to: string): void {
    for (const s of this.stack) if (s.notebook === from) s.notebook = to;
  }

  /** Intercalaire (ou tout le cahier, sans `divider`) parti a la corbeille. */
  drop(notebook: string, divider?: string): void {
    this.stack = this.stack.filter((s) => s.notebook !== notebook
      || (divider != null && s.divider !== divider && !s.divider.startsWith(divider + "/")));
  }
}

/* ---------------- menu au clavier ---------------- */

/**
 * Matieres dont un mot du titre (ou du dossier) commence par ce qui a ete
 * tape : « ma » trouve Maths, pas Informatique. Casse et accents ignores
 * (« elec » trouve Électronique). Celles dont le titre commence par la
 * frappe passent devant ; sinon l'ordre est garde.
 */
export function filterByTitle<T>(items: readonly T[], typed: string, titleOf: (t: T) => string[]): T[] {
  const q = fold(typed).text.trim();
  if (!q) return [...items];
  const first: T[] = [];
  const other: T[] = [];
  for (const it of items) {
    let rank = 0;
    for (const title of titleOf(it)) {
      const f = fold(title).text;
      if (f.startsWith(q)) { rank = 2; break; }
      if (f.split(/[\s\-_'’.()]+/).some((w) => w.startsWith(q))) rank = Math.max(rank, 1);
    }
    if (rank === 2) first.push(it);
    else if (rank === 1) other.push(it);
  }
  return [...first, ...other];
}

/**
 * Case visee par une fleche dans une grille de `count` cases sur `cols`
 * colonnes (remplie ligne par ligne). -1 = rien de focalise : la premiere.
 */
export function gridStep(index: number, key: string, cols: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  const c = Math.max(1, cols);
  let next = index;
  if (key === "ArrowRight") next = index + 1;
  else if (key === "ArrowLeft") next = index - 1;
  else if (key === "ArrowDown") next = index + c < count ? index + c : index;
  else if (key === "ArrowUp") next = index - c >= 0 ? index - c : index;
  return Math.max(0, Math.min(count - 1, next));
}

/* ---------------- intercalaires ---------------- */

/** Deplace un element d'un cran (-1 vers la gauche, +1 vers la droite). */
export function moveItem<T>(list: readonly T[], item: T, delta: number): T[] {
  const out = [...list];
  const i = out.indexOf(item);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * Intercalaire glisse dans la bande : sa place d'arrivee d'apres les centres
 * des onglets (dans l'ordre, celui qu'on glisse compris) et l'abscisse du
 * pointeur. L'onglet prend la place du premier dont il depasse le centre.
 */
export function dropIndex(centers: readonly number[], from: number, x: number): number {
  let to = from;
  for (let i = 0; i < centers.length; i++) {
    if (i < from && x < centers[i]) { to = i; break; }
    if (i > from && x > centers[i]) to = i;
  }
  return to;
}

/** La liste avec l'element deplace a l'index voulu (borne), le reste dans l'ordre. */
export function moveTo<T>(list: readonly T[], item: T, index: number): T[] {
  const out = list.filter((x) => x !== item);
  if (out.length === list.length) return [...list];
  out.splice(Math.max(0, Math.min(out.length, index)), 0, item);
  return out;
}

/** Noms qui appellent naturellement le panneau de droite : les exercices. */
const SPLIT_PREFERRED = ["exos", "exercices", "td", "tp"];

/**
 * Intercalaire a ouvrir a droite quand on n'a qu'un onglet : Exos, TD ou TP
 * s'il existe (Cours a gauche, Exos a droite), sinon le suivant, sinon le
 * precedent. null s'il n'y en a pas d'autre.
 */
export function pickSplitDivider(dividers: readonly string[], current: string, taken: readonly string[] = []): string | null {
  const free = dividers.filter((d) => d !== current && !taken.includes(d));
  if (!free.length) return null;
  // Intercalaires imbriques (D4) : le nom du dossier, et d'abord ceux du
  // meme groupe (S1/Cours a gauche, S1/TD a droite, pas S2/TD).
  const leaf = (d: string) => fold(d.slice(d.lastIndexOf("/") + 1)).text.trim();
  const group = current.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : "";
  const near = free.filter((d) => (group ? d.startsWith(group) : !d.includes("/")));
  for (const pool of [near, free]) {
    for (const name of SPLIT_PREFERRED) {
      const hit = pool.find((d) => leaf(d) === name);
      if (hit) return hit;
    }
  }
  const i = dividers.indexOf(current);
  return free.find((d) => dividers.indexOf(d) > i) ?? free[free.length - 1];
}

/* ---------------- dates ---------------- */

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/**
 * Jour d'une page, en clair : « 3 oct. » cette annee, « 3 oct. 2025 »
 * sinon. "" si la date est illisible.
 */
export function dayLabel(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}
