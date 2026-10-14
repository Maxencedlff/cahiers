/**
 * Export Word (.docx), cote interface. La logique (plan de la page,
 * equations OMML, ecriture du document) est dans src/core/export/ ; ici :
 * mesure des lignes du texte a l'ecran, rendu des images (encre en PNG
 * densite 3 sur fond transparent, photos, courbes), repli d'une formule en
 * image, puis « Enregistrer sous » (Tauri) ou telechargement (navigateur).
 *
 * Charge a la demande (import() dynamique) : rien au demarrage de l'appli.
 */

import { el, toast } from "./dom";
import { paintStroke } from "./review";
import { PAGE_W } from "../core/ink/sheet";
import { GRAPH_RATIO, graphWidth } from "../core/liveblock";
import { texToPlain } from "../core/text/doc";
import { TEXT_LEFT, TEXT_RIGHT } from "../core/textlayout";
import type { Bounds } from "../core/ink/stroke";
import type { Block, CalcBlock, GraphBlock, ImageBlock, SchemaBlock, Page, Stroke } from "../core/types";
import type { ReviewItem, ReviewResult } from "../core/review";
import type { Repo } from "../core/storage/repo";
import { buildDocx, EMU_PER_MM, type DxImage, type DxPara, type DxRun } from "../core/export/docx";
import { latexToMathml, latexToOmml } from "../core/export/omml";
import {
  EMU_PER_UNIT, blocksById, docxFileName, fitEmu, joinPages, planPage, planToParas, reviewToParas, safeFilePart,
  type Assets, type VSpan,
} from "../core/export/plan";

/** Pixels d'image par unite de page : traits nets a l'impression (~400 dpi dans Word). */
const DENSITY = 3;
/** Cote maximal d'une image rendue (memoire du canvas). */
const MAX_PX = 6000;
/** Hauteur maximale d'une image dans Word : la page utile moins un peu. */
const MAX_H_EMU = 230 * EMU_PER_MM;
/** Largeur d'une photo sans largeur notee (textdoc.ts, --w). */
const PHOTO_W = 640;
/** Largeur du texte de l'appli, en unites de page. */
const TEXT_W = PAGE_W - TEXT_LEFT - TEXT_RIGHT;

/** Une page a exporter, avec son texte a l'ecran s'il y est (mesure des lignes). */
export interface DocxPage {
  number: number;
  page: Page;
  root?: HTMLElement | null;
  sheet?: HTMLElement | null;
}

/* ---------------- options ---------------- */

const OPT_KEY = "cahiers.docx.v1";

function loadReplace(): boolean {
  try { return JSON.parse(localStorage.getItem(OPT_KEY) ?? "{}").replace === true; } catch { return false; }
}
function saveReplace(v: boolean): void {
  try { localStorage.setItem(OPT_KEY, JSON.stringify({ replace: v })); } catch { /* stockage indisponible */ }
}

/** La page porte de l'ecriture reconnue (mots, zone texte, zone math lue). */
function hasRecognized(p: Page): boolean {
  return p.blocks.some((b) => (b.type === "math" && !!b.latex?.trim())
    || (b.type === "ink" && (!!b.words?.some((w) => w.box && w.label.trim()) || !!b.recognized?.trim())));
}

/**
 * Options de l'export, seulement quand elles servent : « Remplacer
 * l'écriture reconnue par du texte ». null = annule.
 */
function askOptions(title: string): Promise<{ replace: boolean } | null> {
  return new Promise((resolve) => {
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = loadReplace();
    const close = (v: { replace: boolean } | null) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const ok = () => { saveReplace(box.checked); close({ replace: box.checked }); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); ok(); }
    };
    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal" },
        el("header", {}, title),
        el("div", { class: "content" },
          el("label", { class: "docx-option" }, box,
            el("span", {}, "Remplacer l'écriture reconnue par du texte",
              el("span", { class: "small muted docx-option-note" },
                "Mots et formules reconnus deviennent du texte et des équations Word ; sinon l'écriture part en image."))),
        ),
        el("footer", {},
          el("button", { onclick: () => close(null) }, "Annuler"),
          el("button", { class: "primary", onclick: ok }, "Exporter"),
        ),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    setTimeout(() => box.focus(), 30);
  });
}

/* ---------------- mesure des lignes ---------------- */

/** Boite d'un saut de ligne (une ligne vide n'a pas d'autre boite). */
function brRect(br: Element): DOMRect | null {
  const b = br.getBoundingClientRect();
  if (b.height > 0) return b;
  const r = document.createRange();
  r.selectNode(br);
  return Array.from(r.getClientRects()).find((x) => x.height > 0) ?? null;
}

/** Boite d'un noeud du texte (texte replie sur plusieurs lignes : toutes). */
function nodeRect(n: Node): { top: number; bottom: number } | null {
  if (n instanceof Element) {
    const r = n.getBoundingClientRect();
    return r.height > 0 ? r : null;
  }
  if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").replace(/​/g, "")) return null;
  const range = document.createRange();
  range.selectNodeContents(n);
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
  if (!rects.length) return null;
  return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
}

/**
 * Bords des lignes du texte (docLines) mesures a l'ecran, en unites de page.
 * Suit la construction de TextDoc : une ligne mise en forme = un `div.dl`
 * qui la termine ; les autres lignes sont a plat, separees par des <br>.
 * null si la page n'est pas affichee (estimation alors).
 */
export function measureLineSpans(root: HTMLElement, sheet: HTMLElement): VSpan[] | null {
  if (!root.isConnected || !sheet.isConnected) return null;
  const sr = sheet.getBoundingClientRect();
  if (sr.width < 10) return null;
  const k = sr.width / PAGE_W;
  const spans: (VSpan | undefined)[] = [];
  let idx = 0, has = false;
  const add = (r: { top: number; bottom: number } | null) => {
    if (!r) return;
    const s = { top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k };
    const cur = spans[idx];
    spans[idx] = cur ? { top: Math.min(cur.top, s.top), bottom: Math.max(cur.bottom, s.bottom) } : s;
  };
  for (const n of Array.from(root.childNodes)) {
    if (n instanceof HTMLElement && n.classList.contains("dl")) {
      if (has) idx++;
      add(nodeRect(n));
      idx++;
      has = false;
      continue;
    }
    if (n.nodeName === "BR") {
      if (!spans[idx]) add(brRect(n as Element));
      idx++;
      has = false;
      continue;
    }
    const r = nodeRect(n);
    if (r) { add(r); has = true; }
  }
  // Ligne sans boite (rare) : entre ses voisines.
  const out: VSpan[] = [];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i] ?? { top: out[i - 1]?.bottom ?? 0, bottom: out[i - 1]?.bottom ?? 0 };
    out.push(s);
  }
  return out;
}

/* ---------------- images ---------------- */

function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => {
      if (!b) { reject(new Error("image vide")); return; }
      void b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}

/** Taille Word d'un cadre (unites de page), bornee en largeur et en hauteur. */
function fitBox(w: number, h: number): { cx: number; cy: number } {
  const f = fitEmu(w, h);
  if (f.cy > MAX_H_EMU) return { cx: Math.round((f.cx * MAX_H_EMU) / f.cy), cy: MAX_H_EMU };
  return f;
}

/** Traits dessines dans le cadre `box`, densite 3, fond transparent. */
async function inkImage(strokes: Stroke[], box: Bounds, descr: string): Promise<DxImage | null> {
  if (!strokes.length || box.w <= 0 || box.h <= 0) return null;
  const d = Math.min(DENSITY, MAX_PX / box.w, MAX_PX / box.h);
  const c = el("canvas");
  c.width = Math.max(1, Math.round(box.w * d));
  c.height = Math.max(1, Math.round(box.h * d));
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(d, 0, 0, d, -box.x * d, -box.y * d);
  ctx.lineJoin = "round";
  // Surligneur sous l'encre, comme sur la page.
  for (const s of strokes) if (s.tool === "highlighter") paintStroke(ctx, s);
  for (const s of strokes) if (s.tool !== "highlighter") paintStroke(ctx, s);
  const data = await canvasPng(c);
  c.width = c.height = 0;
  return { data, type: "png", ...fitBox(box.w, box.h), descr };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image illisible"));
    img.src = url;
  });
}

/** Photo du texte : JPEG/PNG tels quels, autre format repasse en PNG ; largeur de la page de l'appli. */
async function photoImage(repo: Repo, notebook: string, divider: string, b: ImageBlock): Promise<DxImage | null> {
  try {
    const url = await repo.readAsset(notebook, divider, b.src);
    const img = await loadImg(url);
    if (!img.naturalWidth || !img.naturalHeight) return null;
    const w = Math.min(b.width ?? PHOTO_W, TEXT_W);
    // Photo etiree aux poignees : sa forme de la page, pas celle du fichier.
    const size = fitBox(w, b.height ? (b.height * w) / (b.width ?? PHOTO_W) : (w * img.naturalHeight) / img.naturalWidth);
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    const mime = m?.[1] ?? "";
    if (m && (mime === "image/jpeg" || mime === "image/png")) {
      return { data: base64ToBytes(m[2]), type: mime === "image/png" ? "png" : "jpeg", ...size, descr: b.ocr ?? "photo" };
    }
    const c = el("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")?.drawImage(img, 0, 0);
    const data = await canvasPng(c);
    c.width = c.height = 0;
    return { data, type: "png", ...size, descr: b.ocr ?? "photo" };
  } catch {
    return null;
  }
}

/** Trace d'une courbe, densite 3 (meme dessin que la page, plotdraw.ts). */
async function graphImage(b: GraphBlock): Promise<DxImage | null> {
  try {
    const [plot, draw] = await Promise.all([import("../core/calc/plot"), import("./plotdraw")]);
    const W = graphWidth(b, PAGE_W), H = Math.round(W * GRAPH_RATIO);
    const c = el("canvas");
    c.width = W * DENSITY;
    c.height = H * DENSITY;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(DENSITY, 0, 0, DENSITY, 0, 0);
    const p = plot.samplePlot(b.fn, b.domain[0], b.domain[1], 500, "x", b.angle, !!b.logX);
    if (!p.ok || !p.samples) {
      ctx.fillStyle = "#a51b1b";
      ctx.font = "16px system-ui, sans-serif";
      ctx.fillText(p.message ?? "expression invalide", 10, 24);
    } else {
      const win = plot.plotWindow(p.samples, b.range);
      draw.drawPlot(ctx, W, H, p.samples, { from: b.domain[0], to: b.domain[1], ...win }, { font: 14, line: 2.2, logX: !!b.logX });
    }
    const data = await canvasPng(c);
    c.width = c.height = 0;
    return { data, type: "png", ...fitBox(W, H), descr: `courbe y = ${b.fn}` };
  } catch {
    return null;
  }
}

/** Schema : SVG autonome (etiquettes en texte) rendu en PNG densite 3, a sa largeur dans la page. */
async function schemaImage(b: SchemaBlock): Promise<DxImage | null> {
  try {
    const { schemaSvgString, schemaWidth } = await import("./schema-view");
    const W = schemaWidth(b);
    const { svg, w, h } = schemaSvgString(b);
    const H = Math.round((W * h) / Math.max(1, w));
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = el("canvas");
      c.width = W * DENSITY;
      c.height = H * DENSITY;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = await canvasPng(c);
      c.width = c.height = 0;
      return { data, type: "png", ...fitBox(W, H), descr: "schéma" };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/**
 * Repli d'une formule que le convertisseur OMML refuse : rendu MathML natif
 * du WebView2 (Cambria Math) dans une image SVG, copie en PNG densite 3.
 */
async function formulaImage(latex: string): Promise<DxImage | null> {
  const mathml = latexToMathml(latex);
  if (!mathml) return null;
  try {
    const probe = el("div", { style: { position: "fixed", left: "-10000px", top: "0", font: "22px 'Cambria Math', serif" } });
    probe.innerHTML = mathml;
    document.body.append(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    const w = Math.ceil(r.width) + 8, h = Math.ceil(r.height) + 8;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="font:22px 'Cambria Math',serif;padding:4px">${mathml}</div></foreignObject></svg>`;
    const img = await loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const c = el("canvas");
    c.width = w * DENSITY;
    c.height = h * DENSITY;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.scale(DENSITY, DENSITY);
    ctx.drawImage(img, 0, 0, w, h);
    const data = await canvasPng(c);
    c.width = c.height = 0;
    // 22 px ~ 11 pt : 1 px CSS = 0,75 pt.
    return { data, type: "png", cx: Math.round(w * 9525 * 0.75), cy: Math.round(h * 9525 * 0.75), descr: texToPlain(latex) };
  } catch {
    return null;
  }
}

/** Images de repli des formules qui ne passent pas en OMML (rares). */
async function mathFallbacks(paras: DxPara[]): Promise<Map<string, DxImage>> {
  const out = new Map<string, DxImage>();
  for (const p of paras) {
    for (const r of p.runs) {
      if (r.kind !== "math" || out.has(r.latex) || latexToOmml(r.latex)) continue;
      const img = await formulaImage(r.latex);
      if (img) out.set(r.latex, img);
    }
  }
  return out;
}

/* ---------------- pages -> document ---------------- */

/** Paragraphes Word d'une page : lignes mesurees si elle est a l'ecran, images rendues. */
async function pageParas(repo: Repo, notebook: string, divider: string, src: DocxPage, replace: boolean): Promise<DxPara[]> {
  const blocks = blocksById(src.page);
  // Photos et courbes chargees d'avance : leur hauteur sert a l'estimation des lignes.
  const inline = new Map<string, DxRun[]>();
  const heights = new Map<string, number>();
  let live: typeof import("../core/calc/live") | null = null;
  for (const b of blocks.values()) {
    if (b.rect) continue;
    if (b.type === "image") {
      const img = await photoImage(repo, notebook, divider, b);
      if (img) {
        inline.set(b.id, [{ kind: "image", image: img }]);
        heights.set(b.id, (img.cy / EMU_PER_UNIT));
      } else {
        inline.set(b.id, [{ kind: "text", text: "[photo introuvable]", italic: true }]);
      }
    } else if (b.type === "schema") {
      const img = await schemaImage(b);
      inline.set(b.id, img ? [{ kind: "image", image: img }] : [{ kind: "text", text: "[schéma]", italic: true }]);
      if (img) heights.set(b.id, img.cy / EMU_PER_UNIT);
    } else if (b.type === "calc" || b.type === "graph") {
      live ??= await import("../core/calc/live");
      inline.set(b.id, await liveRuns(b, live));
      if (b.type === "graph") heights.set(b.id, graphWidth(b, PAGE_W) * GRAPH_RATIO + 40);
    }
  }
  const spans = src.root && src.sheet ? measureLineSpans(src.root, src.sheet) : null;
  const items = planPage(src.page, spans, { replaceRecognized: replace, blockHeight: (id) => heights.get(id) ?? null });
  // Encre rendue d'avance (asynchrone), puis paragraphes (synchrone).
  const byStrokes = new Map<Stroke[], DxImage | null>();
  for (const it of items) {
    if (it.kind === "ink") byStrokes.set(it.strokes, await inkImage(it.strokes, it.box, "écriture manuscrite"));
  }
  const assets: Assets = {
    ink: (strokes) => byStrokes.get(strokes) ?? null,
    inline: (id) => inline.get(id) ?? missing(blocks.get(id)),
  };
  return planToParas(items, assets);
}

function missing(b: Block | undefined): DxRun[] {
  return b ? [] : [{ kind: "text", text: "[élément introuvable]", italic: true }];
}

/** Calcul : equation ; courbe : titre en equation puis le trace. */
async function liveRuns(b: CalcBlock | GraphBlock, live: typeof import("../core/calc/live")): Promise<DxRun[]> {
  if (b.type === "calc") {
    const runs: DxRun[] = [{ kind: "math", latex: live.calcTex(b.expr, b.result) }];
    if (b.angle === "DEG") runs.push({ kind: "text", text: " (degrés)", italic: true });
    return runs;
  }
  const img = await graphImage(b);
  const runs: DxRun[] = [{ kind: "math", latex: live.graphTex(b.fn) }];
  if (b.angle === "DEG") runs.push({ kind: "text", text: " (x en degrés)", italic: true });
  if (img) runs.push({ kind: "br" }, { kind: "image", image: img });
  return runs;
}

/* ---------------- enregistrement ---------------- */

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Enregistre le document : boite « Enregistrer sous » de Windows (Tauri,
 * commande save_export), ou telechargement en mode navigateur. Rend le
 * chemin ecrit (ou le nom telecharge), null si l'utilisateur a annule.
 */
export async function saveDocx(bytes: Uint8Array, name: string): Promise<string | null> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("save_export", {
      name, filter: "Document Word", extension: "docx", base64: bytesToBase64(bytes),
    });
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: DOCX_MIME }));
  const a = el("a", { href: url, download: name, style: { display: "none" } }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}

let busy = false;

/** Ecrit le document puis le dit (ou dit pourquoi il n'est pas parti). */
async function finish(title: string, paras: DxPara[], name: string): Promise<void> {
  const fallback = await mathFallbacks(paras);
  const bytes = buildDocx({ title, paras }, { fallback: (l) => fallback.get(l) ?? null, plain: texToPlain });
  const where = await saveDocx(bytes, name);
  if (where) toast(`Document Word enregistré : ${where}`, "info", 5000, undefined, "docx-export");
}

/**
 * Export Word d'un intercalaire : la page courante ou toutes les pages
 * (dans l'ordre, un saut de page Word entre deux pages de l'appli).
 * `shown` : pages en memoire de la vue (plus fraiches que le disque, texte
 * a l'ecran pour mesurer les lignes).
 */
export async function exportDividerDocx(opts: {
  repo: Repo;
  notebook: string;
  notebookTitle: string;
  divider: string;
  scope: "current" | "all";
  current: number;
  shown: DocxPage[];
}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const { repo, notebook, divider } = opts;
    const numbers = opts.scope === "current" ? [opts.current] : await repo.listPageNumbers(notebook, divider);
    const pages: DocxPage[] = [];
    for (const n of numbers) {
      const mine = opts.shown.find((p) => p.number === n);
      if (mine) { pages.push(mine); continue; }
      try { pages.push({ number: n, page: await repo.readPage(notebook, divider, n) }); } catch {
        toast(`Page ${n} illisible : laissée hors du document`, "warn", 5000);
      }
    }
    if (!pages.length) { toast("Rien à exporter", "warn"); return; }
    let replace = false;
    if (pages.some((p) => hasRecognized(p.page))) {
      const o = await askOptions(opts.scope === "current" ? "Exporter la page en Word" : "Exporter l'intercalaire en Word");
      if (!o) return;
      replace = o.replace;
    }
    if (pages.length > 3) toast("Préparation du document Word…", "info", 2500);
    const all: DxPara[][] = [];
    for (const p of pages) all.push(await pageParas(repo, notebook, divider, p, replace));
    const name = docxFileName(opts.notebookTitle, divider, opts.scope === "current" ? opts.current : undefined);
    await finish(name.replace(/\.docx$/, ""), joinPages(all), name);
  } catch (e) {
    toast(`Export Word impossible : ${(e as Error).message ?? e}`, "err", 6000);
  } finally {
    busy = false;
  }
}

/** Encre d'un extrait de la fiche, recadree avec une marge. */
function reviewInk(item: ReviewItem): Promise<DxImage | null> {
  const box = item.box;
  if (!box || !item.strokes?.length) return Promise.resolve(null);
  const pad = 10;
  return inkImage(item.strokes, { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }, item.plain || "écriture manuscrite");
}

/** Export Word de la fiche de revision (vue Reviser), a cote de son export PDF. */
export async function exportReviewDocx(result: ReviewResult, title: string, showNotebook: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const imgs = new Map<ReviewItem, DxImage | null>();
    for (const nb of result.notebooks) for (const dv of nb.dividers) for (const pg of dv.pages) {
      for (const it of pg.items) if (it.kind === "ink" || it.kind === "highlight" || (it.kind === "math" && !it.latex) || (it.kind === "zone" && !it.plain)) {
        imgs.set(it, await reviewInk(it));
      }
    }
    const paras = reviewToParas(result, title, showNotebook, (it) => imgs.get(it) ?? null);
    const name = `${safeFilePart(title.replace(/·/g, "-")).replace(/\s*-\s*/g, " - ")}.docx`;
    await finish(title, paras, name);
  } catch (e) {
    toast(`Export Word impossible : ${(e as Error).message ?? e}`, "err", 6000);
  } finally {
    busy = false;
  }
}
