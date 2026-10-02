import { PAGE_H } from "./ink/sheet";

/**
 * Mode defilement virtualise (donnees-12). Logique pure : quelles pages
 * monter, leur hauteur tant qu'elles ne sont pas montees, et l'ancrage du
 * defilement quand une hauteur change.
 *
 * Seules les pages a l'ecran et MOUNT_MARGIN pages de chaque cote ont un vrai
 * DOM (texte, canvas, blocs). Les autres sont des emplacements vides de
 * hauteur connue : la barre de defilement reste juste, et 100 pages coutent
 * le prix de 3 ou 4.
 */

/** Pages montees de part et d'autre de celles a l'ecran. */
export const MOUNT_MARGIN = 1;
/**
 * Une page montee n'est demontee qu'au-dela de cette distance (en pages) de
 * l'ecran : un petit aller-retour ne reconstruit rien (hysteresis).
 */
export const KEEP_MARGIN = 2;
/**
 * Defilement rapide : l'ecran a saute d'au moins tant de pages depuis
 * l'image precedente. On ne construit rien en route, on attend l'arret.
 */
export const FAST_PAGES = 2;
/** Hauteur par defaut sous la feuille (numero de page), en px. */
export const DEFAULT_EXTRA = 32;

/** Position verticale d'un emplacement, dans le repere de la vue. */
export interface Box { top: number; bottom: number }

/**
 * Emplacements qui coupent [top, bottom] : premier et dernier indice, par
 * recherche dichotomique (les emplacements sont empiles dans l'ordre).
 * null si aucun (vue vide ou hors des pages).
 */
export function visibleRange(
  count: number, box: (i: number) => Box, top: number, bottom: number,
): [number, number] | null {
  if (count <= 0 || bottom <= top) return null;
  // Premier emplacement dont le bas passe sous le haut de la vue.
  let lo = 0, hi = count;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (box(m).bottom > top) hi = m; else lo = m + 1;
  }
  if (lo >= count) return null;
  const first = lo;
  if (box(first).top >= bottom) return null;
  // Dernier emplacement dont le haut est au-dessus du bas de la vue.
  lo = first; hi = count - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (box(m).top < bottom) lo = m; else hi = m - 1;
  }
  return [first, lo];
}

export interface WindowPlan {
  /** A monter, les pages a l'ecran d'abord (de haut en bas), puis les marges, les plus proches d'abord. */
  mount: number[];
  /** A demonter : trop loin de l'ecran et rien ne les retient. */
  unmount: number[];
}

/**
 * Fenetre de pages a monter autour de l'ecran (`visible`, indices inclus).
 * Une page retenue (`pinned` : focus, ecriture en attente, selection, trait
 * en cours) n'est jamais demontee, meme loin de l'ecran.
 */
export function planWindow(
  count: number,
  visible: [number, number] | null,
  mounted: Iterable<number>,
  pinned: (i: number) => boolean = () => false,
  margin = MOUNT_MARGIN,
  keep = Math.max(KEEP_MARGIN, margin),
): WindowPlan {
  const isMounted = new Set(mounted);
  if (!visible || count <= 0) return { mount: [], unmount: [] };
  const a = Math.max(0, Math.min(visible[0], count - 1));
  const b = Math.max(a, Math.min(visible[1], count - 1));
  const mount: number[] = [];
  for (let i = a; i <= b; i++) if (!isMounted.has(i)) mount.push(i);
  for (let d = 1; d <= margin; d++) {
    if (b + d < count && !isMounted.has(b + d)) mount.push(b + d);
    if (a - d >= 0 && !isMounted.has(a - d)) mount.push(a - d);
  }
  const lo = a - keep, hi = b + keep;
  const unmount = [...isMounted].filter((i) => (i < lo || i > hi || i >= count) && !pinned(i)).sort((x, y) => x - y);
  return { mount, unmount };
}

/** L'ecran a-t-il saute de plusieurs pages depuis l'image precedente ? */
export function isFastScroll(prevFirst: number | null, first: number, pages = FAST_PAGES): boolean {
  return prevFirst !== null && Math.abs(first - prevFirst) >= pages;
}

/*
 * Hauteurs. Une page se mesure en deux parts : la feuille, qui suit le zoom
 * (unites de page), et ce qui l'entoure (numero, bandeaux), en px fixes.
 */

export interface SlotSize {
  /** Hauteur de la feuille, en unites de page (PAGE_H pour une A4). */
  sheet: number;
  /** Hauteur autour de la feuille (numero de page, bandeaux), en px. */
  extra: number;
  /** Mesuree sur la page montee (sinon estimee). */
  measured: boolean;
}

/** Hauteur de l'emplacement en px, a l'echelle `k` (largeur de feuille / PAGE_W). */
export function slotHeight(size: SlotSize, k: number): number {
  return Math.max(1, Math.round(size.sheet * k + size.extra));
}

/** Mesure d'une page montee : feuille et page entiere en px, a l'echelle `k`. */
export function measureSize(sheetPx: number, wrapPx: number, k: number): SlotSize {
  const kk = k > 0 ? k : 1;
  return { sheet: sheetPx / kk, extra: Math.max(0, wrapPx - sheetPx), measured: true };
}

/**
 * Hauteur d'une page pas encore montee. Pagination A4 : presque toutes les
 * pages ont la hauteur d'une page deja mesuree (`typical`). Une ancienne page
 * longue deja vue garde sa hauteur memorisee (`memo`, unites de page). Une
 * erreur d'estimation est corrigee au montage, sans saut (ancrage).
 */
export function estimateSize(memo: number | undefined, typical: SlotSize | null): SlotSize {
  const extra = typical?.extra ?? DEFAULT_EXTRA;
  const sheet = memo !== undefined && Number.isFinite(memo) && memo > 0 ? memo : typical?.sheet ?? PAGE_H;
  return { sheet, extra, measured: false };
}

/**
 * Point d'ancrage du defilement : le premier emplacement dont le bas passe
 * sous le haut de la vue. Quand des emplacements changent de hauteur (montage,
 * demontage, correction d'une estimation), celui-ci doit rester a la meme
 * place a l'ecran. -1 si aucun.
 */
export function anchorIndex(count: number, box: (i: number) => Box, viewTop: number): number {
  let lo = 0, hi = count;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (box(m).bottom > viewTop) hi = m; else lo = m + 1;
  }
  return lo < count ? lo : -1;
}

/**
 * Page « en vue » pour l'indicateur « p. N / M » et la position retenue :
 * la derniere dont le haut est passe au-dessus de la ligne `y` (un peu sous
 * le haut de la vue). 0 si aucune.
 */
export function pageAt(count: number, box: (i: number) => Box, y: number): number {
  let lo = 0, hi = count - 1, best = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (box(m).top <= y) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

/**
 * Defilement a appliquer pour que l'ancre, qui etait a `before` (haut de
 * l'emplacement dans le repere de la vue), y revienne alors qu'elle est
 * maintenant a `after`. Jamais negatif.
 */
export function anchoredScroll(scrollTop: number, before: number, after: number): number {
  return Math.max(0, scrollTop + (after - before));
}

/**
 * Hauteurs memorisees pendant la seance (unites de page), par cle de page :
 * une page longue revue plus tard n'est plus estimee a une A4. Bornee.
 */
export class SizeMemo {
  private map = new Map<string, number>();
  constructor(private max = 4000) {}
  get(key: string): number | undefined { return this.map.get(key); }
  set(key: string, sheet: number): void {
    if (!Number.isFinite(sheet) || sheet <= 0) return;
    this.map.delete(key);
    this.map.set(key, sheet);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number { return this.map.size; }
}
