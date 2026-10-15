/**
 * Selection « tout le document » (Ctrl+A facon Word), logique pure.
 *
 * Un document = une suite de pages chainees par la pagination automatique
 * (`Page.continues` : la page de suite d'une page qui a deborde). Ctrl+A
 * dans le texte d'une de ces pages selectionne toutes les pages de la
 * chaine ; copier, couper, supprimer, gras/italique, couleur et taille
 * s'appliquent a chacune (PageView.docSel). Les pages ajoutees a la main
 * (sans `continues`) bornent le document.
 */
import type { Block, ColorKey, Page } from "./types";
import { NORMAL_SIZE, normalizeTokens, parseDoc, serializeDoc, type DocToken } from "./text/doc";

/** Juste ce qu'il faut d'une page pour suivre la chaine. */
export interface ChainLink { id: string; continues?: string }

/** `next` est-elle la page de suite de `prev` ? */
export function linked(prev: ChainLink | null | undefined, next: ChainLink | null | undefined): boolean {
  return !!prev && !!next && next.continues === prev.id;
}

/** Bornes [debut, fin] (indices compris) de la chaine qui contient la page `i`. */
export function chainBounds(pages: readonly (ChainLink | null)[], i: number): [number, number] {
  let a = i, b = i;
  while (a > 0 && linked(pages[a - 1], pages[a])) a--;
  while (b < pages.length - 1 && linked(pages[b], pages[b + 1])) b++;
  return [a, b];
}

/** Texte du document entier : les pages bout a bout, une ligne par saut de page. */
export function joinDoc(contents: readonly string[]): string {
  return contents.join("\n");
}

/** Mise en forme appliquee a tout le document. `color: null` = couleur retiree. */
export interface DocFormat {
  bold?: boolean;
  italic?: boolean;
  color?: ColorKey | null;
  size?: number;
}

/** Texte d'une page avec la mise en forme `f` sur tout son texte et ses formules. */
export function formatContent(content: string, f: DocFormat): string {
  if (!content) return content;
  const tokens: DocToken[] = parseDoc(content).map((t) => {
    if (t.kind !== "text" && t.kind !== "math") return t;
    const out = { ...t } as DocToken & { bold?: boolean; italic?: boolean; color?: ColorKey; size?: number };
    if (t.kind === "text") {
      if (f.bold !== undefined) { if (f.bold) out.bold = true; else delete out.bold; }
      if (f.italic !== undefined) { if (f.italic) out.italic = true; else delete out.italic; }
    }
    if (f.color !== undefined) { if (f.color) out.color = f.color; else delete out.color; }
    if (f.size !== undefined) { if (f.size !== NORMAL_SIZE) out.size = f.size; else delete out.size; }
    return out;
  });
  return serializeDoc(normalizeTokens(tokens));
}

/**
 * Tout le texte (hors blancs) est-il deja en gras (ou italique) ? Comme
 * Word : Ctrl+B sur une selection deja toute en gras retire le gras.
 */
export function allStyled(contents: readonly string[], style: "bold" | "italic"): boolean {
  let any = false;
  for (const c of contents) {
    for (const t of parseDoc(c)) {
      if (t.kind !== "text" || !t.text.trim()) continue;
      any = true;
      if (!t[style]) return false;
    }
  }
  return any;
}

/** Ids des photos et blocs poses dans un texte. */
function placedIds(content: string): Set<string> {
  return new Set(parseDoc(content).flatMap((t) => (t.kind === "image" ? [t.id] : [])));
}

/**
 * Suppression du document (Suppr, Couper, frappe par-dessus) : le texte de
 * chaque page part, la premiere recoit `replacement`. Une page suivante
 * qui n'a plus rien (pas d'encre, de zone, de repere ni de bloc a elle :
 * seulement les photos de son texte efface) part a la corbeille ; celle qui
 * garde de l'encre reste, son texte vide. `continues` recousu par-dessus
 * les pages retirees. Rend, par page : le nouveau texte, et la page a
 * suivre (null : a la corbeille).
 */
export function planDocDelete(pages: readonly Page[], replacement: string):
  { contents: string[]; trash: boolean[]; continues: (string | undefined)[] } {
  const contents = pages.map((_, i) => (i === 0 ? replacement : ""));
  const trash = pages.map((p, i) => {
    if (i === 0) return false;
    const body = p.blocks.find((b) => b.type === "text" && !b.rect);
    const gone = placedIds(body && body.type === "text" ? body.content : "");
    return p.blocks.every((b: Block) => b === body || (gone.has(b.id) && !b.rect));
  });
  const continues: (string | undefined)[] = [];
  let keptPrev: string | undefined;
  pages.forEach((p, i) => {
    continues.push(i === 0 ? p.continues : keptPrev);
    if (!trash[i]) keptPrev = p.id;
  });
  return { contents, trash, continues };
}

/** Texte sans blancs ni ancres invisibles. */
function squash(s: string): string {
  return s.replace(/[\s​]/g, "");
}

/**
 * Ctrl+Z d'une operation sur le document : seulement si rien n'a change
 * depuis, a part au plus `typed` caracteres tapes sur la premiere page
 * (la frappe qui a remplace la selection). Sinon, on n'ecrase rien.
 */
export function docUndoValid(after: readonly string[], current: readonly (string | null)[], typed = 10): boolean {
  if (after.length !== current.length) return false;
  return after.every((a, i) => {
    const c = current[i];
    if (c === null) return false;
    if (c === a) return true;
    if (i !== 0) return false;
    const sa = squash(a), sc = squash(c);
    return sc.length - sa.length <= typed && sc.length >= sa.length && sc.startsWith(sa);
  });
}
