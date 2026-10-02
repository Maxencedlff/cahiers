/**
 * Pagination automatique, cote DOM : mesure des rangees du texte tape et
 * position de la coupe dans le texte. Les decisions (ou couper, quoi
 * deplacer) sont dans src/core/paginate.ts.
 *
 * Une rangee = une ligne visuelle : morceaux de texte (une ligne d'un
 * paragraphe qui passe a la ligne en est une), formules, photos et blocs,
 * sauts de ligne (une ligne vide est une rangee), titres (leur boite de
 * deux lignes). Le texte DANS une formule KaTeX ou un bloc vivant n'est pas
 * mesure : la formule compte en entier.
 */
import { groupRows, type Row, type Span } from "../core/paginate";

/** Element mesure en entier : formule, photo, bloc vivant, champ MathLive. */
const ATOM = ".eq, .doc-img, math-field";
/** Titres : leur boite fait leur hauteur de lignes (texte plus petit que la boite). */
const HEADING = ".dl-h1, .dl-h2, .dl-h3";

interface Item extends Span {
  /** Debut de la rangee de cet element, dans le texte. */
  start: () => [Node, number];
}

export interface MeasuredRows {
  rows: Row[];
  items: Item[];
}

/**
 * Rangees du texte, en unites de page depuis le haut de la feuille
 * (`sheetTop` en px client, `k` = px par unite de page).
 */
export function measureRows(root: HTMLElement, sheetTop: number, k: number): MeasuredRows {
  const items: Item[] = [];
  const toPage = (r: DOMRect | { top: number; bottom: number }): Span =>
    ({ top: (r.top - sheetTop) / k, bottom: (r.bottom - sheetTop) / k });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n instanceof Element) {
        if (n.matches(ATOM)) return NodeFilter.FILTER_ACCEPT;
        if (n.closest(ATOM)) return NodeFilter.FILTER_REJECT;
        return n.nodeName === "BR" || n.matches(HEADING) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return n.parentElement?.closest(ATOM) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n instanceof Element) {
      const el = n;
      if (n.nodeName === "BR") {
        const r = brRect(n as HTMLElement);
        if (r) items.push({ ...toPage(r), start: () => before(el) });
        continue;
      }
      const r = n.getBoundingClientRect();
      if (r.height <= 0) continue;
      // Titre : jamais seul en bas d'une page (core/paginate.ts, keep).
      items.push({ ...toPage(r), ...(n.matches(HEADING) ? { keep: true } : {}), start: () => before(el) });
      continue;
    }
    const t = n as Text;
    const len = t.data.length;
    if (!len) continue;
    range.selectNodeContents(t);
    const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
    for (const r of rects) {
      const top = r.top;
      items.push({ ...toPage(r), start: () => [t, lineStartIn(t, top)] });
    }
  }
  return { rows: groupRows(items), items };
}

/** Boite d'un saut de ligne (une ligne vide n'a pas d'autre boite). */
function brRect(br: HTMLElement): DOMRect | null {
  const b = br.getBoundingClientRect();
  if (b.height > 0) return b;
  const r = document.createRange();
  r.selectNode(br);
  const rects = Array.from(r.getClientRects()).filter((x) => x.height > 0);
  return rects[0] ?? null;
}

function before(n: Node): [Node, number] {
  const p = n.parentNode!;
  return [p, Array.prototype.indexOf.call(p.childNodes, n) as number];
}

/** Premier caractere du texte `t` pose a la hauteur `top` ou plus bas (debut d'une ligne repliee). */
function lineStartIn(t: Text, top: number): number {
  const r = document.createRange();
  const topOf = (i: number): number => {
    r.setStart(t, i);
    r.setEnd(t, i + 1);
    const rects = Array.from(r.getClientRects()).filter((x) => x.height > 0);
    return rects.length ? rects[rects.length - 1].top : -Infinity;
  };
  let lo = 0, hi = t.data.length - 1;
  if (topOf(hi) < top - 2) return t.data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(mid) >= top - 2) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Debut, dans le texte, de la rangee `row` : la position la plus tot parmi
 * ses elements, remontee hors des blocs de ligne (titre, puce) et des mises
 * en forme dont elle est le debut. Ainsi la coupe ne laisse jamais une puce
 * ou un titre vide sur la page d'avant.
 */
export function rowStart(root: HTMLElement, m: MeasuredRows, row: Row): Range | null {
  let best: Range | null = null;
  for (const i of row.members) {
    const [node, offset] = m.items[i].start();
    if (!root.contains(node)) continue;
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    if (!best || r.compareBoundaryPoints(Range.START_TO_START, best) < 0) best = r;
  }
  if (!best) return null;
  liftToStart(best, root);
  return best;
}

/** Remonte une position en debut de noeud jusqu'au plus haut parent dont elle est le debut. */
function liftToStart(r: Range, root: HTMLElement): void {
  for (let guard = 0; guard < 50; guard++) {
    const node = r.startContainer;
    const offset = r.startOffset;
    if (node === root) return;
    if (node.nodeType === Node.TEXT_NODE) {
      // Rien de visible avant le point dans ce texte (ancres invisibles comprises).
      if ((node.textContent ?? "").slice(0, offset).replace(/\u200b/g, "")) return;
    } else if (Array.from(node.childNodes).slice(0, offset).some((c) => !blank(c))) {
      return;
    }
    // Le point est au debut de `node` : on passe juste avant lui, dans son parent.
    if (!node.parentNode) return;
    r.setStartBefore(node);
    r.collapse(true);
  }
}

function blank(n: Node): boolean {
  return n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").replace(/\u200b/g, "");
}
