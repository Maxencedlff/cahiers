import type { InkWord, Stroke } from "../types";
import type { Bounds } from "./stroke";
import { strokeBounds } from "./stroke";

/**
 * Conversion mot a mot, "a la place" (facon Scribble sur iPad).
 *
 * Chaque mot reconnu garde sa position sur la page et la liste des traits qui
 * le composent. En rendu propre, ces traits laissent la place au mot tape,
 * pose exactement la ou il a ete ecrit. L'encre n'est jamais jetee
 * (section 2) : elle reste dans le bloc, le bouton "Rendu" la ramene.
 */

/** Resolution declaree a MyScript dans la requete batch (xDPI / yDPI). */
export const RECO_DPI = 96;

/** Le JIIX donne les boites en millimetres ; la page est en unites de 1/96 de pouce. */
export function mmToUnits(mm: number, dpi = RECO_DPI): number {
  return (mm * dpi) / 25.4;
}

/**
 * Lit les mots du JIIX texte et rattache chaque trait a son mot.
 *
 * Le rattachement se fait par position : un trait appartient au mot dont la
 * boite contient son centre, a defaut au mot le plus proche. Les identifiants
 * que MyScript renvoie ne sont pas les notres, la position est le seul lien
 * fiable. Les separateurs (" ", "\n") sont gardes tels quels, sans boite :
 * ils portent les espaces et les retours a la ligne de la transcription.
 */
export function wordsFromJiix(jiix: any, strokes: Stroke[], dpi = RECO_DPI): InkWord[] {
  const raw: any[] = Array.isArray(jiix?.words) ? jiix.words : [];
  const words: InkWord[] = raw.map((w) => {
    const label: string = typeof w?.label === "string" ? w.label : "";
    const bb = w?.["bounding-box"];
    const word: InkWord = { label, strokeIds: [] };
    if (bb && label.trim()) {
      word.box = {
        x: mmToUnits(bb.x, dpi), y: mmToUnits(bb.y, dpi),
        w: mmToUnits(bb.width, dpi), h: mmToUnits(bb.height, dpi),
      };
      const cands: string[] = Array.isArray(w.candidates) ? w.candidates : [];
      const others = cands.filter((c) => c !== label);
      if (others.length) word.candidates = others;
    }
    return word;
  });

  const boxed = words.filter((w) => w.box);
  if (boxed.length === 0) return words;
  for (const s of strokes) {
    const b = strokeBounds(s);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let best: InkWord | null = null;
    let bestDist = Infinity;
    for (const w of boxed) {
      const d = distanceToBox(cx, cy, w.box!);
      if (d < bestDist) { bestDist = d; best = w; }
    }
    best?.strokeIds.push(s.id);
  }
  return words;
}

function distanceToBox(x: number, y: number, b: Bounds): number {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/**
 * Reporte les corrections faites a la main sur une nouvelle reconnaissance.
 *
 * Chaque pause d'ecriture reconvertit la page : sans ce report, le trait
 * suivant effacerait la correction. Un mot corrige est reconnu a ses traits :
 * s'il partage au moins la moitie de ses traits avec un nouveau mot, sa
 * correction s'applique a ce nouveau mot.
 */
export function carryEdits(previous: InkWord[] | undefined, next: InkWord[]): InkWord[] {
  const edited = (previous ?? []).filter((w) => w.edited && w.strokeIds.length);
  if (edited.length === 0) return next;
  return next.map((w) => {
    if (!w.box || w.strokeIds.length === 0) return w;
    const ids = new Set(w.strokeIds);
    const match = edited.find((e) => {
      const shared = e.strokeIds.filter((id) => ids.has(id)).length;
      return shared / Math.max(e.strokeIds.length, w.strokeIds.length) >= 0.5;
    });
    return match ? { ...w, label: match.label, edited: true, candidates: undefined } : w;
  });
}

/** Transcription complete, pour la recherche et l'export. */
export function joinWords(words: InkWord[]): string {
  return words.map((w) => w.label).join("").replace(/[ \t]+\n/g, "\n").trim();
}

/** Identifiants des traits deja remplaces par un mot tape. */
export function convertedStrokeIds(words: InkWord[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of words ?? []) {
    if (w.box && w.label.trim()) for (const id of w.strokeIds) out.add(id);
  }
  return out;
}

/**
 * Retire des traits gommes. Un mot dont tout l'encre a disparu disparait
 * avec elle, et les separateurs devenus inutiles sont fusionnes.
 */
export function dropStrokes(words: InkWord[], removed: Set<string>): InkWord[] {
  const kept: InkWord[] = [];
  for (const w of words) {
    if (!w.box) { kept.push(w); continue; }
    const ids = w.strokeIds.filter((id) => !removed.has(id));
    if (ids.length === 0) continue;
    kept.push(ids.length === w.strokeIds.length ? w : { ...w, strokeIds: ids });
  }
  // Pas de separateur en tete, en queue, ni deux a la suite.
  const out: InkWord[] = [];
  for (const w of kept) {
    if (!w.box && (out.length === 0 || !out[out.length - 1].box)) {
      if (w.label.includes("\n") && out.length) out[out.length - 1] = w;
      continue;
    }
    out.push(w);
  }
  while (out.length && !out[out.length - 1].box) out.pop();
  return out;
}

/** Un mot tape pose sur la page, en unites de page. */
export interface PlacedWord {
  word: InkWord;
  /** Index dans le tableau d'origine, pour retrouver le mot a corriger. */
  index: number;
  x: number;
  /** Haut de la ligne de texte (boite de hauteur `fontSize * LINE_HEIGHT`). */
  y: number;
  fontSize: number;
}

export const LINE_HEIGHT = 1.2;

/** Au-dela de cet ecart manuscrit (en tailles de police), le blanc est voulu. */
const WIDE_GAP = 4;

/**
 * Pose les mots tapes a la place de l'encre.
 *
 * Une ligne manuscrite n'a pas une hauteur reguliere : "une" est plus petit
 * que "Riemann". Pour un rendu propre, tous les mots d'une meme ligne
 * partagent une taille et un axe, pris sur la mediane de la ligne. Chaque mot
 * part de l'abscisse ou il a ete ecrit, sans jamais chevaucher le precedent.
 *
 * `measure(text, fontSize)` donne la largeur du texte tape en unites de page.
 */
export function layoutWords(
  words: InkWord[],
  measure: (text: string, fontSize: number) => number,
): PlacedWord[] {
  const lines: { word: InkWord; index: number }[][] = [[]];
  words.forEach((w, index) => {
    if (!w.box) {
      if (w.label.includes("\n")) lines.push([]);
      return;
    }
    if (w.label.trim()) lines[lines.length - 1].push({ word: w, index });
  });

  const placed: PlacedWord[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const heights = line.map((l) => l.word.box!.h);
    const centers = line.map((l) => l.word.box!.y + l.word.box!.h / 2);
    // La boite d'un mot manuscrit va des hampes aux jambages : une police
    // a ~60 % de cette hauteur a la meme presence visuelle.
    const fontSize = clamp(median(heights) * 0.6, 12, 72);
    const y = median(centers) - (fontSize * LINE_HEIGHT) / 2;
    const space = measure(" ", fontSize);
    let right = -Infinity;
    let prevInkEnd = -Infinity;
    for (const { word, index } of [...line].sort((a, b) => a.word.box!.x - b.word.box!.x)) {
      const box = word.box!;
      // Le texte tape est plus etroit que l'ecriture : reprendre l'abscisse
      // manuscrite de chaque mot laisserait des trous. Les mots s'enchainent
      // avec une espace normale ; seul un vrai blanc volontaire (colonne,
      // alinea) garde sa position d'origine.
      const gap = box.x - prevInkEnd;
      const x = right === -Infinity || gap > fontSize * WIDE_GAP
        ? Math.max(box.x, right + space)
        : right + space;
      placed.push({ word, index, x, y, fontSize });
      right = x + measure(word.label, fontSize);
      prevInkEnd = box.x + box.w;
    }
  }
  return placed;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
