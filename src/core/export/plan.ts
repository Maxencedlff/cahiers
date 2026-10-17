/**
 * Export Word, logique pure : une page du cahier (ou la fiche de revision)
 * devient une suite de paragraphes Word (modele de docx.ts).
 *
 *  - Le texte tape donne les paragraphes : titres, puces et numeros (vraies
 *    listes Word), gras, italique, couleurs, formules (equations OMML).
 *  - L'encre manuscrite est groupee par zones (traits proches, puis zones
 *    qui se chevauchent en hauteur), chaque zone devient une image posee
 *    dans le flux a sa hauteur par rapport aux lignes du texte, avec son
 *    retrait a gauche. Une ligne vide recouverte par une zone disparait
 *    (l'image prend sa place).
 *  - En option (`replaceRecognized`), l'ecriture reconnue (mots, zones
 *    texte, zones math) remplace son encre : texte ou equation.
 *  - Surligneur seul sur une ligne de texte tape : fond de la ligne.
 *
 * Le rendu des images (encre, photos, courbes) est fait par l'interface
 * (src/ui/docx-export.ts) au travers d'un `Assets`.
 */

import type { Block, ColorKey, InkBlock, MathBlock, Page, Stroke, TextBlock } from "../types";
import { PALETTE } from "../palette";
import { docLines, listNumbers, parseDoc, texToPlain, type DocLine, type DocToken } from "../text/doc";
import { cachedBounds, unionBounds, type Bounds } from "../ink/stroke";
import { PAGE_W } from "../ink/sheet";
import { LINE, TEXT_FONT, TEXT_LEFT, TEXT_RIGHT, TEXT_TOP } from "../textlayout";
import { clusterStrokes, whereLabel, type ReviewItem, type ReviewResult, type ReviewToken } from "../review";
import { linkLabel } from "../links";
import { EMU_PER_TWIP, TEXT_W_EMU, type DxImage, type DxPara, type DxRun } from "./docx";

/** Intervalle vertical en unites de page. */
export interface VSpan { top: number; bottom: number }

/**
 * Echelle d'une unite de page dans Word, en EMU. Une unite vaut 210/900 mm
 * sur la feuille de l'appli ; le texte de l'appli (21 unites, ~14 pt) est
 * plus grand que le Calibri 11 de Word : l'encre est reduite d'autant
 * (x 0,8) pour garder ses proportions avec le texte.
 */
export const EMU_PER_UNIT = 6720;
/** Marge autour d'une zone d'encre recadree, en unites de page. */
export const INK_PAD = 6;
/** Marge pour rattacher deux traits a la meme zone (une ligne = 34 unites). */
export const INK_CLUSTER_PAD = 18;

export type PlanItem =
  | { kind: "line"; line: DocLine; num: number | null; color?: ColorKey; shade?: string }
  /** Zone d'encre a rendre en image : `box` (marge comprise) = cadre de l'image. */
  | { kind: "ink"; strokes: Stroke[]; box: Bounds }
  /** Zone math reconnue (option) : equation. */
  | { kind: "equation"; latex: string; color?: ColorKey; box: Bounds }
  /** Ecriture reconnue (option) : texte. */
  | { kind: "words"; text: string; color?: ColorKey; box: Bounds };

export interface PlanOptions {
  /** Remplacer l'ecriture reconnue (mots, zones) par du texte ou une equation. */
  replaceRecognized?: boolean;
  /** Hauteur (unites de page) d'une photo ou d'un bloc pose dans le texte, pour l'estimation. */
  blockHeight?: (id: string) => number | null;
}

/** Couleur Word (hex sans #) d'une couleur de la palette. */
export function wordColor(key: ColorKey | undefined | null): string | undefined {
  const p = PALETTE.find((x) => x.key === key);
  return p ? p.ink.slice(1).toUpperCase() : undefined;
}

/** Couleur Word du surligneur (version claire). */
function washColor(key: string): string {
  const p = PALETTE.find((x) => x.key === key);
  return (p ? p.wash : "#e5e7eb").slice(1).toUpperCase();
}

const SEMANTIC = new Set<string>(PALETTE.map((p) => p.key));

/** Couleur dominante d'un groupe de traits (majorite stricte d'une couleur semantique). */
function majorityColor(strokes: readonly Stroke[]): ColorKey | undefined {
  const count = new Map<string, number>();
  for (const s of strokes) count.set(s.color, (count.get(s.color) ?? 0) + 1);
  let best: string | undefined, most = 0;
  for (const [c, n] of count) if (n > most) { best = c; most = n; }
  return best && SEMANTIC.has(best) && most * 2 > strokes.length ? best as ColorKey : undefined;
}

/* ---------------- lignes du texte ---------------- */

/** Texte tape de la page (blocs texte sans cadre) et sa couleur de bloc. */
function pageText(page: Page): { content: string; color?: ColorKey } {
  const texts = page.blocks.filter((b): b is TextBlock => b.type === "text" && !b.rect);
  return { content: texts.map((t) => t.content).filter(Boolean).join("\n"), color: texts[0]?.color };
}

/** Ligne vide : ni mise en forme, ni contenu. */
function isEmptyLine(l: DocLine): boolean {
  return !l.format && l.tokens.every((t) => t.kind === "text" && !t.text.trim());
}

/** Formule haute (fraction, integrale...) : deux lignes de la grille. */
const TALL_TEX = /\\(?:frac|dfrac|tfrac|int|iint|oint|sum|prod|lim|begin|sqrt|binom|over|underbrace|overbrace|cfrac)|\^\{[^}]{2,}\}/;

/**
 * Hauteurs des lignes estimees sans mesure (page hors ecran) : grille de
 * l'appli (LINE), titres 1-2 sur deux lignes, formule haute deux lignes,
 * photo/bloc a sa hauteur, retour automatique a ~0,5 em par caractere.
 */
export function estimateSpans(lines: readonly DocLine[], opts: PlanOptions = {}): VSpan[] {
  let y = TEXT_TOP;
  const avail = PAGE_W - TEXT_LEFT - TEXT_RIGHT;
  return lines.map((l) => {
    let rows = 1;
    const f = l.format;
    if (f && (f.style === "h1" || f.style === "h2")) rows = 2;
    let chars = 0, tall = false, blockH = 0;
    for (const t of l.tokens) {
      if (t.kind === "text") chars += t.text.length;
      else if (t.kind === "math") { chars += texToPlain(t.latex).length; if (TALL_TEX.test(t.latex)) tall = true; }
      else if (t.kind === "image") blockH = Math.max(blockH, opts.blockHeight?.(t.id) ?? 480);
      else if (t.kind === "table") blockH = Math.max(blockH, t.rows.length * (LINE + 1));
      else if (t.kind === "codeblock") blockH = Math.max(blockH, (t.text.split("\n").length + 1) * LINE * 0.75);
    }
    const indent = f && (f.style === "ul" || f.style === "ol") ? ((f.level ?? 0) + 1) * 1.5 * TEXT_FONT : 0;
    rows = Math.max(rows, Math.ceil((chars * TEXT_FONT * 0.5) / (avail - indent)) || 1);
    if (tall) rows = Math.max(rows, 2);
    if (blockH) rows = Math.max(rows, Math.ceil(blockH / LINE) + (chars ? 1 : 0));
    const s = { top: y, bottom: y + rows * LINE };
    y = s.bottom;
    return s;
  });
}

/* ---------------- encre ---------------- */

/** Traits avec un dessin (au moins un point). */
function drawn(s: Stroke): boolean {
  return s.points.length > 0;
}

/** Zones d'encre : traits proches, puis zones qui se chevauchent en hauteur reunies (un schema et sa legende a cote). */
export function inkZones(strokes: readonly Stroke[], pad = INK_CLUSTER_PAD): Stroke[][] {
  const groups = clusterStrokes(strokes.filter(drawn), pad).map((g) => ({ g, b: unionBounds(g.map((s) => cachedBounds(s))) }));
  groups.sort((a, b) => a.b.y - b.b.y);
  const out: { g: Stroke[]; b: Bounds }[] = [];
  for (const cur of groups) {
    const last = out[out.length - 1];
    if (last && cur.b.y < last.b.y + last.b.h - 2) {
      last.g.push(...cur.g);
      last.b = unionBounds([last.b, cur.b]);
    } else {
      out.push({ g: [...cur.g], b: cur.b });
    }
  }
  return out.map((x) => x.g);
}

function padded(b: Bounds, pad = INK_PAD): Bounds {
  return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}

/** Mots reconnus d'un bloc, ligne par ligne (separateurs « \n »), avec leur cadre et leurs traits. */
function wordLines(block: InkBlock): { text: string; box: Bounds; strokeIds: string[] }[] {
  const out: { text: string; boxes: Bounds[]; ids: string[] }[] = [{ text: "", boxes: [], ids: [] }];
  for (const w of block.words ?? []) {
    if (!w.box) {
      if (w.label.includes("\n")) out.push({ text: "", boxes: [], ids: [] });
      else out[out.length - 1].text += w.label;
      continue;
    }
    if (!w.label.trim()) continue;
    const cur = out[out.length - 1];
    cur.text += w.label;
    cur.boxes.push(w.box);
    cur.ids.push(...w.strokeIds);
  }
  return out.filter((l) => l.text.trim() && l.boxes.length)
    .map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), box: unionBounds(l.boxes), strokeIds: l.ids }));
}

/* ---------------- plan d'une page ---------------- */

/**
 * Plan d'une page : lignes du texte et zones d'encre dans l'ordre de
 * lecture. `spans` : bords mesures des lignes du texte (docLines), sinon
 * estimes.
 */
export function planPage(page: Page, spans: readonly VSpan[] | null | undefined, opts: PlanOptions = {}): PlanItem[] {
  const text = pageText(page);
  const lines = docLines(parseDoc(text.content));
  // Lignes vides en fin de texte : rien a exporter.
  while (lines.length && isEmptyLine(lines[lines.length - 1])) lines.pop();
  const nums = listNumbers(lines.map((l) => l.format));
  const sp = spans && spans.length >= lines.length ? spans.slice(0, lines.length) : estimateSpans(lines, opts);

  // Ecriture : reconnue (option) ou en encre.
  const floating: Exclude<PlanItem, { kind: "line" }>[] = [];
  const pool: Stroke[] = [];
  for (const b of page.blocks) {
    if (b.type === "math") {
      const m = b as MathBlock;
      const strokes = m.strokes.filter(drawn);
      if (opts.replaceRecognized && m.latex?.trim() && !m.pending && strokes.length) {
        floating.push({ kind: "equation", latex: m.latex, color: majorityColor(strokes), box: unionBounds(strokes.map((s) => cachedBounds(s))) });
      } else {
        pool.push(...strokes);
      }
      continue;
    }
    if (b.type !== "ink") continue;
    const ink = b as InkBlock;
    const strokes = ink.strokes.filter(drawn);
    if (!opts.replaceRecognized || ink.pending && !ink.words?.length) { pool.push(...strokes); continue; }
    const byId = new Map(strokes.map((s) => [s.id, s]));
    const used = new Set<string>();
    const lines = wordLines(ink);
    for (const l of lines) {
      const own = l.strokeIds.map((id) => byId.get(id)).filter((s): s is Stroke => !!s);
      floating.push({ kind: "words", text: l.text, color: majorityColor(own), box: l.box });
      for (const id of l.strokeIds) used.add(id);
    }
    if (!lines.length && ink.recognized?.trim() && ink.rect && strokes.length) {
      floating.push({ kind: "words", text: ink.recognized.trim(), color: majorityColor(strokes), box: unionBounds(strokes.map((s) => cachedBounds(s))) });
      continue;
    }
    pool.push(...strokes.filter((s) => !used.has(s.id)));
  }

  // Surligneur seul sur des lignes de texte tape : fond de ces lignes.
  const shade: (string | undefined)[] = lines.map(() => undefined);
  for (const zone of inkZones(pool)) {
    const box = unionBounds(zone.map((s) => cachedBounds(s)));
    if (zone.every((s) => s.tool === "highlighter")) {
      const hit = sp.map((s, i) => (!isEmptyLine(lines[i]) && overlap(s, box) > 0.4 * (s.bottom - s.top) ? i : -1)).filter((i) => i >= 0);
      if (hit.length) {
        for (const i of hit) shade[i] = washColor(majorityColor(zone) ?? zone[0].color);
        continue;
      }
    }
    floating.push({ kind: "ink", strokes: zone, box: padded(box) });
  }

  // Placement : une zone passe apres les lignes dont le milieu est au-dessus de son haut.
  floating.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  // Haut reel de l'encre (le cadre d'une zone d'encre porte sa marge).
  const top = (f: Exclude<PlanItem, { kind: "line" }>) => f.box.y + (f.kind === "ink" ? INK_PAD : 0);
  const out: PlanItem[] = [];
  let fi = 0;
  const covered = (s: VSpan) => floating.some((f) => {
    const mid = (s.top + s.bottom) / 2;
    return mid >= f.box.y && mid <= f.box.y + f.box.h;
  });
  lines.forEach((line, i) => {
    const mid = (sp[i].top + sp[i].bottom) / 2;
    while (fi < floating.length && top(floating[fi]) <= mid) out.push(floating[fi++]);
    if (isEmptyLine(line) && covered(sp[i])) return;
    out.push({
      kind: "line", line, num: nums[i],
      ...(text.color ? { color: text.color } : {}),
      ...(shade[i] ? { shade: shade[i] } : {}),
    });
  });
  while (fi < floating.length) out.push(floating[fi++]);
  return out;
}

function overlap(s: VSpan, b: Bounds): number {
  return Math.max(0, Math.min(s.bottom, b.y + b.h) - Math.max(s.top, b.y));
}

/* ---------------- paragraphes Word ---------------- */

/** Ce que l'interface fournit : images rendues, LaTeX des blocs vivants. */
export interface Assets {
  /** Image d'une zone d'encre (cadre `box`), null si rien a dessiner. */
  ink: (strokes: Stroke[], box: Bounds) => DxImage | null;
  /** Morceaux Word d'un jeton image du texte : photo, calcul (equation), courbe (titre + trace). */
  inline: (id: string) => DxRun[];
}

/** Taille Word (EMU) d'un cadre en unites de page, ramenee a la largeur utile si besoin. */
export function fitEmu(w: number, h: number, maxW = TEXT_W_EMU): { cx: number; cy: number } {
  let cx = w * EMU_PER_UNIT, cy = h * EMU_PER_UNIT;
  if (cx > maxW) { cy = (cy * maxW) / cx; cx = maxW; }
  return { cx: Math.round(cx), cy: Math.round(cy) };
}

/** Retrait gauche (twips) d'un element pose a l'abscisse `x` de la page, sans depasser la marge droite. */
export function indentOf(x: number, cx: number): number {
  const emu = Math.max(0, Math.min((x - TEXT_LEFT) * EMU_PER_UNIT, TEXT_W_EMU - cx));
  return Math.round(emu / EMU_PER_TWIP);
}

/** Morceaux Word d'une suite de jetons du texte. */
export function tokenRuns(tokens: readonly DocToken[], assets: Pick<Assets, "inline">, base?: ColorKey): DxRun[] {
  const out: DxRun[] = [];
  for (const t of tokens) {
    if (t.kind === "text") {
      // Taille choisie (14 = normal de l'appli = 11 pt de Word), en demi-points.
      out.push({ kind: "text", text: t.text, ...(t.bold ? { bold: true } : {}), ...(t.italic ? { italic: true } : {}), ...(t.code ? { code: true } : {}), ...colorOf(t.color ?? base),
        ...(t.size ? { size: Math.round(t.size * (11 / 14) * 2) } : {}) });
    } else if (t.kind === "math") {
      out.push({ kind: "math", latex: t.latex, ...colorOf(t.color ?? base) });
    } else if (t.kind === "image") {
      out.push(...assets.inline(t.id));
    } else if (t.kind === "br") {
      out.push({ kind: "br" });
    } else if (t.kind === "link") {
      // Lien entre pages : seul le libelle passe dans Word, souligne comme un renvoi.
      out.push({ kind: "text", text: linkLabel(t), underline: true, ...colorOf(base) });
    }
  }
  return out;
}

function colorOf(key: ColorKey | undefined): { color?: string } {
  const c = wordColor(key);
  return c ? { color: c } : {};
}

/** Paragraphes Word d'un plan de page. */
export function planToParas(items: readonly PlanItem[], assets: Assets): DxPara[] {
  const out: DxPara[] = [];
  for (const it of items) {
    if (it.kind === "line") {
      const f = it.line.format;
      const tb = it.line.tokens[0];
      if (tb?.kind === "table") {
        out.push({ runs: [], table: tb.rows.map((r) => r.map((c) => tokenRuns(c, assets, it.color))) });
        continue;
      }
      // Bloc de code : Consolas sur fond gris, une ligne Word par ligne de code (sauts dans le paragraphe).
      if (tb?.kind === "codeblock") {
        out.push({ runs: [{ kind: "text", text: tb.text || " ", code: true }], shade: "F3F4F6" });
        continue;
      }
      const p: DxPara = { runs: tokenRuns(it.line.tokens, assets, it.color) };
      if (f?.style === "h1" || f?.style === "h2" || f?.style === "h3") p.heading = Number(f.style[1]) as 1 | 2 | 3;
      else if (f?.style === "ul" || f?.style === "ol") {
        p.list = { ordered: f.style === "ol", level: f.level ?? 0, ...(it.num != null ? { num: it.num } : {}) };
      }
      if (f?.style === "box") p.boxed = true;
      if (it.shade) p.shade = it.shade;
      out.push(p);
    } else if (it.kind === "ink") {
      const img = assets.ink(it.strokes, it.box);
      if (!img) continue;
      out.push({ runs: [{ kind: "image", image: img }], indent: indentOf(it.box.x, img.cx) });
    } else if (it.kind === "equation") {
      out.push({ runs: [{ kind: "math", latex: it.latex, ...colorOf(it.color) }] });
    } else {
      const lines = it.text.split("\n");
      out.push({
        runs: [{ kind: "text", text: lines.join("\n"), ...colorOf(it.color) }],
        indent: indentOf(it.box.x, 0) || undefined,
      });
    }
  }
  return out;
}

/**
 * Pages a la suite dans un document : un saut de page Word entre deux pages
 * de l'appli (« saut de page avant » sur le premier paragraphe).
 */
export function joinPages(pages: readonly DxPara[][]): DxPara[] {
  const out: DxPara[] = [];
  pages.forEach((paras, i) => {
    const list = paras.length ? paras.map((p) => ({ ...p })) : [{ runs: [] }];
    if (i > 0) list[0].pageBreakBefore = true;
    out.push(...list);
  });
  return out;
}

/* ---------------- fiche de revision ---------------- */

/** Morceaux Word d'un extrait tape de la fiche. */
function reviewRuns(tokens: readonly ReviewToken[], color: string | undefined): DxRun[] {
  return tokens.map((t): DxRun => (t.kind === "br" ? { kind: "br" }
    : t.kind === "math" ? { kind: "math", latex: t.latex, ...(color ? { color } : {}) }
    : { kind: "text", text: t.text, ...(t.bold ? { bold: true } : {}), ...(t.italic ? { italic: true } : {}), ...(color ? { color } : {}) }));
}

/** Libelle d'une couleur (« Théorème »). */
function labelOfColor(key: ColorKey): string {
  return PALETTE.find((p) => p.key === key)?.label ?? key;
}

/**
 * Fiche de revision (vue Reviser) en paragraphes : titre, matiere,
 * « Cours p. 4 », puis chaque extrait precede de sa couleur.
 */
export function reviewToParas(result: ReviewResult, title: string, showNotebook: boolean,
  ink: (item: ReviewItem) => DxImage | null): DxPara[] {
  const out: DxPara[] = [{ heading: 1, runs: [{ kind: "text", text: title }] }];
  for (const nb of result.notebooks) {
    if (showNotebook) out.push({ heading: 1, runs: [{ kind: "text", text: nb.notebookTitle }] });
    for (const dv of nb.dividers) {
      for (const pg of dv.pages) {
        out.push({ heading: 2, runs: [{ kind: "text", text: whereLabel(dv.divider, pg.page) }] });
        for (const it of pg.items) {
          const color = wordColor(it.color);
          const tag: DxRun = { kind: "text", text: `${labelOfColor(it.color)} : `, bold: true, ...(color ? { color } : {}) };
          if (it.kind === "text") {
            out.push({ runs: [tag, ...reviewRuns(it.tokens ?? [], color)] });
          } else if (it.kind === "math" && it.latex) {
            out.push({ runs: [tag, { kind: "math", latex: it.latex, ...(color ? { color } : {}) }] });
          } else if (it.kind === "zone" && it.plain) {
            out.push({ runs: [tag, { kind: "text", text: it.plain, ...(color ? { color } : {}) }] });
          } else {
            const img = ink(it);
            out.push({ runs: [tag, ...(img ? [{ kind: "br" } as DxRun, { kind: "image", image: img } as DxRun] : [])] });
            if (it.plain) out.push({ caption: true, runs: [{ kind: "text", text: `Lu : ${it.plain}` }] });
            else if (it.kind === "highlight" && !(it.strokes ?? []).some((s) => s.tool === "pen")) {
              out.push({ caption: true, runs: [{ kind: "text", text: "Surlignage sur le texte tapé : ouvrir la page pour le lire" }] });
            }
          }
        }
      }
    }
  }
  return out;
}

/* ---------------- nom du fichier ---------------- */

/** Morceau de nom de fichier Windows sur (caracteres interdits retires). */
export function safeFilePart(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "Sans titre";
}

/** « Matière - Intercalaire - p.N.docx » (page) ou « Matière - Intercalaire.docx » (tout l'intercalaire). */
export function docxFileName(notebook: string, divider: string, page?: number): string {
  const parts = [safeFilePart(notebook), ...divider.split(/[\\/]/).map(safeFilePart)];
  if (page !== undefined) parts.push(`p.${page}`);
  return `${parts.join(" - ")}.docx`;
}

/** Blocs de la page par id (photos, calculs, courbes du texte). */
export function blocksById(page: Page): Map<string, Block> {
  return new Map(page.blocks.map((b) => [b.id, b]));
}
