/**
 * pdf.js (paquet `pdfjs-dist`, licence Apache-2.0), charge a la demande :
 * rien n'est telecharge ni parse tant qu'aucun PDF n'est ouvert (lancement
 * et batterie). Documents ouverts gardes en petit nombre (LRU), rendus d'une
 * page a la fois (un seul worker).
 */
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { Bounds } from "../core/ink/stroke";
import { joinTextItems, placeTextItem, type PlacedText } from "../core/pdf/pdf";

type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;

/** Charge pdf.js et son worker (fichier servi par Vite, meme origine : CSP 'self'). */
export function loadPdfJs(): Promise<PdfJs> {
  lib ??= (async () => {
    const [m, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  })().catch((e) => { lib = null; throw e; });
  return lib;
}

/** Octets d'une data URL (lecture d'un asset), sans fetch (CSP connect-src). */
export function bytesOfDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Ouvre un PDF depuis ses octets (copies : pdf.js transfere le tampon au worker). */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    // Pas de WebAssembly (CSP sans 'wasm-unsafe-eval') ni de polices a
    // telecharger : les polices non embarquees passent par celles du systeme.
    useWasm: false,
    useSystemFonts: true,
    stopAtErrors: false,
  });
  return task.promise;
}

/* ---------------- documents ouverts (LRU) ---------------- */

const MAX_DOCS = 3;
const docs = new Map<string, Promise<PDFDocumentProxy>>();

/**
 * Document d'un PDF de l'intercalaire, ouvert une fois et garde tant qu'il
 * sert (3 au plus : un poly, un sujet de TD, une datasheet). `key` =
 * chemin de l'asset ; `read` le lit si besoin.
 */
export function pdfDoc(key: string, read: () => Promise<Uint8Array>): Promise<PDFDocumentProxy> {
  const hit = docs.get(key);
  if (hit) {
    docs.delete(key);
    docs.set(key, hit);
    return hit;
  }
  const p = read().then(openPdf);
  p.catch(() => { if (docs.get(key) === p) docs.delete(key); });
  docs.set(key, p);
  while (docs.size > MAX_DOCS) {
    const [oldKey, old] = docs.entries().next().value as [string, Promise<PDFDocumentProxy>];
    docs.delete(oldKey);
    void old.then((d) => d.loadingTask.destroy()).catch(() => undefined);
  }
  return p;
}

/** Document deja ouvert (import) range sous sa cle : pas de seconde lecture. */
export function adoptPdfDoc(key: string, doc: PDFDocumentProxy): void {
  if (!docs.has(key)) docs.set(key, Promise.resolve(doc));
}

/* ---------------- rendu et texte ---------------- */

/** Taille d'une page en points, rotation de la page comprise. */
export function pageSize(page: PDFPageProxy): { w: number; h: number } {
  const vp = page.getViewport({ scale: 1 });
  return { w: vp.width, h: vp.height };
}

/** Texte simple d'une page (recherche). Vide si la page n'a que des images (scan). */
export async function pageText(page: PDFPageProxy): Promise<string> {
  try {
    const content = await page.getTextContent();
    return joinTextItems(content.items.map((it) => ("str" in it ? it : { str: "", hasEOL: false })));
  } catch {
    return "";
  }
}

/** File des rendus : un a la fois (le worker est unique, la batterie aussi). */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Rend la page `n` a `w`×`h` pixels dans un canvas neuf. `wanted()` faux au
 * moment de passer : rendu abandonne (page partie, autre taille demandee),
 * null rendu.
 */
export function renderPage(
  doc: PDFDocumentProxy, n: number, w: number, h: number, wanted: () => boolean,
): Promise<HTMLCanvasElement | null> {
  const run = async (): Promise<HTMLCanvasElement | null> => {
    if (!wanted()) return null;
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: w / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = Math.max(1, Math.min(h, Math.round(viewport.height)));
    const task = page.render({ canvas, viewport, background: "#ffffff" });
    try {
      await task.promise;
    } catch (e) {
      canvas.width = canvas.height = 0;
      if ((e as { name?: string })?.name === "RenderingCancelledException") return null;
      throw e;
    } finally {
      page.cleanup();
    }
    if (!wanted()) { canvas.width = canvas.height = 0; return null; }
    return canvas;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

/**
 * Morceaux de texte de la page places sur la feuille (unites de page), pour
 * encadrer un mot trouve par Ctrl+K. `rect` = place de la page sur la feuille.
 */
export async function placedText(doc: PDFDocumentProxy, n: number, rect: Bounds): Promise<PlacedText[]> {
  const pdfjs = await loadPdfJs();
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const vpScale = 1;
  const viewport = page.getViewport({ scale: rect.w / base.width });
  const content = await page.getTextContent();
  const out: PlacedText[] = [];
  for (const it of content.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const t = pdfjs.Util.transform(viewport.transform, it.transform) as number[];
    out.push({ str: it.str, box: placeTextItem(t, it.width * viewport.scale, rect, vpScale) });
  }
  return out;
}
