/**
 * Import et annotation de PDF (priorite 3) : logique pure, sans pdf.js ni
 * DOM. Le rendu (pdf.js) est dans src/ui/pdf.ts, l'orchestration dans
 * src/ui/pdflayer.ts et PageView.
 *
 * Principe : une page de l'appli par page du PDF. Chaque page porte un bloc
 * `pdf` { src: "assets/<nom>-<hash>.pdf", page: N } peint en fond, sous le
 * canvas d'encre et sous le texte. Le PDF n'est copie qu'une fois dans
 * assets/ (dedoublonnage par empreinte du contenu).
 */
import type { Bounds } from "../ink/stroke";
import { PAGE_H, PAGE_W } from "../ink/sheet";
import { SCHEMA_VERSION, type Page, type PdfBlock } from "../types";
import { fold } from "../text/find";

/* ---------------- choix des pages ---------------- */

/**
 * Saisie du dialogue d'import : « toutes » (ou vide), « 3 », « 1-4 »,
 * « 2, 5-7 », « 6- » (jusqu'a la fin). Pages dans l'ordre de la saisie,
 * sans doublon. Rend un message en francais si la saisie ne va pas.
 */
export function parsePageRange(input: string, total: number): { pages: number[] } | { error: string } {
  const s = input.trim().toLowerCase();
  if (total < 1) return { error: "Ce PDF n'a aucune page" };
  if (s === "" || s === "toutes" || s === "tout" || s === "*") {
    return { pages: Array.from({ length: total }, (_, i) => i + 1) };
  }
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of s.split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d{1,5})?\s*(?:(-|–|à|a)\s*(\d{1,5})?)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) return { error: `« ${raw.trim()} » : tape par exemple 1-3, 5` };
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : total) : from;
    if (from < 1 || to < 1) return { error: "Les pages commencent à 1" };
    if (from > total || to > total) {
      return { error: `Ce PDF a ${total} page${total > 1 ? "s" : ""} : ${Math.max(from, to)} n'existe pas` };
    }
    const step = from <= to ? 1 : -1;
    for (let n = from; step > 0 ? n <= to : n >= to; n += step) {
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  if (!out.length) return { error: "Aucune page choisie" };
  return { pages: out };
}

/** Libelle court d'une liste de pages : « 1-3, 5 ». */
export function rangeLabel(pages: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(j > i ? `${pages[i]}-${pages[j]}` : String(pages[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

/* ---------------- empreinte et nom du fichier ---------------- */

/**
 * Empreinte du contenu (64 bits, deux voies independantes facon cyrb53, en
 * hexadecimal). Pas de crypto.subtle : il n'existe pas hors contexte
 * securise, et on n'a besoin que de reconnaitre le meme fichier importe deux
 * fois, pas de resister a une attaque. La taille entre dans l'empreinte.
 */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef ^ bytes.length;
  let h2 = 0x41c6ce57 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** Nombre de caracteres de l'empreinte gardes dans le nom du fichier. */
export const HASH_IN_NAME = 12;

/**
 * Nom du PDF dans assets/ : nom d'origine lisible (accents retires, sans
 * caractere interdit sous Windows) + empreinte. « TD 3 : filtres.pdf » →
 * « TD-3-filtres-1a2b3c4d5e6f.pdf ». L'utilisateur retrouve son fichier
 * dans l'explorateur, et deux PDF homonymes differents ne se melangent pas.
 */
export function pdfAssetName(fileName: string, hash: string): string {
  const base = fileName.replace(/\.pdf$/i, "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40)
    .replace(/[-.]+$/, "");
  const h = hash.slice(0, HASH_IN_NAME);
  return `${base || "document"}-${h}.pdf`;
}

/** PDF deja present dans assets/ avec le meme contenu (meme empreinte), ou null. */
export function findPdfAsset(files: readonly string[], hash: string): string | null {
  const tail = `${hash.slice(0, HASH_IN_NAME)}.pdf`;
  return files.find((f) => f.toLowerCase().endsWith(`-${tail}`) || f.toLowerCase() === tail) ?? null;
}

/** Fichier PDF d'apres son type ou son extension (Windows ne donne pas toujours le type). */
export function isPdfFile(f: { name: string; type?: string }): boolean {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}

/* ---------------- mise a l'echelle ---------------- */

/**
 * Place de la page du PDF sur la feuille A4 de l'appli (unites de page) :
 * la plus grande possible sans deformer, centree en largeur, calee en haut.
 * Une page paysage est ajustee en largeur (lisible sans tourner la tete) et
 * laisse de la place dessous pour les notes ; une page A4 portrait remplit
 * la feuille.
 */
export function fitPdfRect(w: number, h: number): Bounds {
  if (!(w > 0) || !(h > 0)) return { x: 0, y: 0, w: PAGE_W, h: PAGE_H };
  const k = Math.min(PAGE_W / w, PAGE_H / h);
  const rw = Math.round(w * k * 10) / 10;
  const rh = Math.round(h * k * 10) / 10;
  return { x: Math.round(((PAGE_W - rw) / 2) * 10) / 10, y: 0, w: rw, h: rh };
}

/**
 * Taille en pixels du rendu de la page du PDF pour un canvas d'encre de
 * `canvasW` pixels de large (densite comprise) : exactement la zone qu'elle
 * couvre, rien de plus. Le canvas est deja borne (zoom.ts, MAX_CANVAS_PX) :
 * le rendu du PDF ne pese jamais plus que lui.
 */
export function backdropPixels(rect: Bounds, canvasW: number): { w: number; h: number } {
  const k = canvasW / PAGE_W;
  return { w: Math.max(1, Math.round(rect.w * k)), h: Math.max(1, Math.round(rect.h * k)) };
}

/* ---------------- blocs et pages ---------------- */

/** Le bloc `pdf` de fond d'une page, s'il y en a un. */
export function pdfBlockOf(page: Page): PdfBlock | undefined {
  return page.blocks.find((b): b is PdfBlock => b.type === "pdf");
}

/** Une page de l'appli pour une page du PDF. */
export function makePdfPage(
  ids: { page: string; block: string }, now: string,
  spec: { src: string; page: number; size: { w: number; h: number }; text: string; name: string },
): Page {
  const block: PdfBlock = {
    id: ids.block, type: "pdf", src: spec.src, page: spec.page, annotations: [],
    rect: fitPdfRect(spec.size.w, spec.size.h),
    size: { w: Math.round(spec.size.w * 10) / 10, h: Math.round(spec.size.h * 10) / 10 },
    name: spec.name,
    ...(spec.text ? { text: spec.text } : {}),
  };
  return { version: SCHEMA_VERSION, id: ids.page, created: now, modified: now, blocks: [block] };
}

/* ---------------- texte extrait ---------------- */

/** Morceau de texte tel que rendu par pdf.js (getTextContent). */
export interface TextItemLike {
  str: string;
  hasEOL?: boolean;
}

/**
 * Texte simple d'une page a partir des morceaux de pdf.js : fins de ligne
 * gardees, blancs ramenes a un seul, mot coupe en fin de ligne recolle
 * (« électro-\nnique » → « électronique ») pour que la recherche le trouve.
 */
export function joinTextItems(items: readonly TextItemLike[]): string {
  let out = "";
  for (const it of items) {
    const s = typeof it.str === "string" ? it.str : "";
    if (s) {
      // Deux morceaux colles sans blanc sur la meme ligne restent colles
      // (pdf.js coupe souvent un mot en plusieurs morceaux).
      out += s;
    }
    if (it.hasEOL) {
      if (/[a-zà-ÿ]-$/i.test(out)) out = out.slice(0, -1) + "\u0000";
      else out += "\n";
    }
  }
  return out
    .replace(/\u0000\s*(?=[a-zà-ÿ])/g, "")
    .replace(/\u0000/g, "-\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Morceau de texte place sur la feuille (unites de page), pour retrouver un mot cherche. */
export interface PlacedText {
  str: string;
  box: Bounds;
}

/**
 * Premier morceau du PDF qui contient un des mots cherches (meme pliage que
 * la recherche : casse, accents, grec). `terms` : deja plies (parseQuery).
 */
export function locateTerms(items: readonly PlacedText[], terms: readonly string[]): Bounds | null {
  const wanted = terms.filter((t) => t.trim());
  if (!wanted.length) return null;
  for (const it of items) {
    const f = fold(it.str).text;
    if (wanted.some((t) => f.includes(t))) return it.box;
  }
  return null;
}

/**
 * Cadre d'un morceau de texte de pdf.js sur la feuille. `transform` =
 * matrice du texte deja passee par le viewport (pixels du viewport, origine
 * en haut a gauche, ligne de base), `width` en pixels du viewport,
 * `vpScale` = pixels du viewport par unite de page.
 */
export function placeTextItem(
  transform: readonly number[], width: number, rect: Bounds, vpScale: number,
): Bounds {
  const [a, b, , , e, f] = transform;
  const fontH = Math.hypot(a, b) || 10;
  const x = rect.x + e / vpScale;
  const y = rect.y + (f - fontH) / vpScale;
  return { x, y, w: Math.max(width / vpScale, 4), h: Math.max(fontH * 1.2 / vpScale, 4) };
}
