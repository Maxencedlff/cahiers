/**
 * Pages de PDF en fond des feuilles (priorite 3) : quand rendre, a quelle
 * taille, quand liberer. PageView appelle `sync` apres chaque mise en page
 * d'une feuille et au defilement ; le rendu lui-meme est dans ui/pdf.ts.
 *
 * Batterie et memoire (un poly de 100 pages en defilement) :
 *  - seules les pages a l'ecran ou a moins d'un ecran sont rendues ; les
 *    autres rendent leur image (canvas remis a 0) et gardent un cadre blanc ;
 *  - le rendu est a la taille exacte de la zone dans le canvas d'encre
 *    (deja borne par zoom.ts) et refait seulement quand cette taille change :
 *    a la fin d'un geste de zoom, jamais pendant (la feuille garde l'ancien
 *    rendu etire en attendant, comme l'encre) ;
 *  - un seul rendu a la fois, abandonne si la page est partie entre-temps.
 */
import type { InkSurface } from "./canvas";
import type { Bounds } from "../core/ink/stroke";
import type { Page, PdfBlock } from "../core/types";
import { backdropPixels, fitPdfRect, locateTerms, pdfBlockOf } from "../core/pdf/pdf";
import { pdfDoc, placedText, renderPage } from "./pdf";
import { toast } from "./dom";

/** Ce que PdfLayer lit d'une page affichee (LoadedPage de PageView). */
export interface PdfHostPage {
  page: Page;
  surface: InkSurface | null;
  wrap: HTMLElement;
  dead?: boolean;
}

interface State {
  /** Rendu net actuel, et sa taille en pixels. */
  img: HTMLCanvasElement | null;
  w: number;
  h: number;
  /** Largeur demandee au dernier rendu lance (0 : aucun en cours). */
  want: number;
  /** Compteur des demandes : une plus recente abandonne la precedente. */
  gen: number;
  /** Ce qui est pose sur le canvas d'encre (evite de repeindre a chaque frappe). */
  shown: HTMLCanvasElement | "frame" | null;
  rect: Bounds;
}

export interface PdfSource {
  /** Cle unique du fichier (cahier/intercalaire/src). */
  key(src: string): string;
  /** Octets du PDF. */
  read(src: string): Promise<Uint8Array>;
}

export class PdfLayer {
  private states = new Map<PdfHostPage, State>();
  /** Fichiers deja signales illisibles (un seul message par fichier). */
  private failed = new Set<string>();

  constructor(private source: PdfSource) {}

  /** Place de la page du PDF sur la feuille. */
  static rectOf(b: PdfBlock): Bounds {
    return b.rect ?? fitPdfRect(b.size?.w ?? 595, b.size?.h ?? 842);
  }

  /**
   * Met la page a jour : rendu net si elle est proche de l'ecran (et de la
   * taille du canvas), sinon image liberee. `root` = la vue qui defile.
   */
  sync(p: PdfHostPage, root: HTMLElement | null): void {
    const block = pdfBlockOf(p.page);
    const s = p.surface;
    if (!block || !s || p.dead) { if (this.states.has(p)) this.drop(p); return; }
    const rect = PdfLayer.rectOf(block);
    let st = this.states.get(p);
    if (!st) {
      st = { img: null, w: 0, h: 0, want: 0, gen: 0, shown: null, rect };
      this.states.set(p, st);
    }
    st.rect = rect;
    // Vue detachee (menu, autre onglet) : rien ne change, rien ne se rend.
    if (root && !root.isConnected) return;
    if (!this.isNear(p, root)) {
      this.release(p, st);
      return;
    }
    const px = backdropPixels(rect, s.pixelWidth);
    if (st.img && st.w === px.w) {
      this.show(p, st, st.img);
      return;
    }
    // L'ancien rendu (zoom) reste pose, etire, en attendant le net.
    this.show(p, st, st.img ?? "frame");
    if (st.want === px.w) return;
    st.want = px.w;
    const gen = ++st.gen;
    const state = st;
    void this.render(block, px.w, px.h, () => !p.dead && state.gen === gen && this.states.get(p) === state)
      .then((img) => {
        if (!img) return;
        if (state.img && state.img !== img) state.img.width = state.img.height = 0;
        state.img = img;
        state.w = img.width;
        state.h = img.height;
        state.want = 0;
        state.shown = null;
        this.show(p, state, img);
      })
      .catch((e) => {
        state.want = 0;
        this.fail(block, e);
      });
  }

  /** Toutes les pages de la vue (defilement, zoom). */
  syncAll(list: readonly PdfHostPage[], root: HTMLElement | null): void {
    // Pages retirees sans passer par drop (pagination annulee) : oubliees.
    for (const p of [...this.states.keys()]) if (p.dead) this.drop(p);
    for (const p of list) this.sync(p, root);
  }

  /**
   * Export : rendu a la taille actuelle du canvas (densite 3), attendu.
   * Sans PDF, ne fait rien.
   */
  async ensure(p: PdfHostPage): Promise<void> {
    const block = pdfBlockOf(p.page);
    const s = p.surface;
    if (!block || !s) return;
    const rect = PdfLayer.rectOf(block);
    const px = backdropPixels(rect, s.pixelWidth);
    let st = this.states.get(p);
    if (!st) {
      st = { img: null, w: 0, h: 0, want: 0, gen: 0, shown: null, rect };
      this.states.set(p, st);
    }
    if (st.img && st.w === px.w) { this.show(p, st, st.img); return; }
    const gen = ++st.gen;
    const state = st;
    try {
      const img = await this.render(block, px.w, px.h, () => state.gen === gen);
      if (!img) return;
      if (state.img) state.img.width = state.img.height = 0;
      Object.assign(state, { img, w: img.width, h: img.height, want: 0, shown: null });
      this.show(p, state, img);
      // Le canvas d'encre se repeint a la frame suivante : on l'attend.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    } catch (e) {
      this.fail(block, e);
    }
  }

  /** Oublie la page (retiree de l'ecran) et rend la memoire de son rendu tout de suite. */
  drop(p: PdfHostPage): void {
    const st = this.states.get(p);
    if (!st) return;
    st.gen++;
    if (st.img) st.img.width = st.img.height = 0;
    this.states.delete(p);
    if (!p.dead) p.surface?.setBackdrop(st.rect);
  }

  /**
   * Cadre (unites de page) d'un mot cherche dans le texte du PDF, pour le
   * montrer a l'ouverture d'un resultat de recherche. null : pas trouve.
   */
  async locate(page: Page, terms: readonly string[]): Promise<Bounds | null> {
    const block = pdfBlockOf(page);
    if (!block || !terms.length) return null;
    try {
      const doc = await pdfDoc(this.source.key(block.src), () => this.source.read(block.src));
      const items = await placedText(doc, block.page, PdfLayer.rectOf(block));
      return locateTerms(items, terms);
    } catch {
      return null;
    }
  }

  /* ---------------- interne ---------------- */

  private async render(block: PdfBlock, w: number, h: number, wanted: () => boolean): Promise<HTMLCanvasElement | null> {
    const doc = await pdfDoc(this.source.key(block.src), () => this.source.read(block.src));
    if (!wanted()) return null;
    if (block.page < 1 || block.page > doc.numPages) {
      throw new Error(`page ${block.page} absente (le PDF en a ${doc.numPages})`);
    }
    return renderPage(doc, block.page, w, h, wanted);
  }

  private show(p: PdfHostPage, st: State, what: HTMLCanvasElement | "frame"): void {
    if (st.shown === what || p.dead || !p.surface) return;
    st.shown = what;
    if (what === "frame") p.surface.setBackdrop(st.rect);
    else p.surface.setBackdrop(st.rect, what, st.w || what.width, st.h || what.height);
  }

  /** Page loin de l'ecran : son rendu est libere, un cadre blanc reste. */
  private release(p: PdfHostPage, st: State): void {
    st.gen++;
    st.want = 0;
    if (st.img) {
      st.img.width = st.img.height = 0;
      st.img = null;
      st.w = st.h = 0;
    }
    this.show(p, st, "frame");
  }

  /** A l'ecran, ou a moins d'un ecran au-dessus ou au-dessous. */
  private isNear(p: PdfHostPage, root: HTMLElement | null): boolean {
    if (!root) return true;
    const view = root.getBoundingClientRect();
    if (!view.height) return true;
    const r = p.wrap.getBoundingClientRect();
    if (!r.height) return true;
    return r.bottom > view.top - view.height && r.top < view.bottom + view.height;
  }

  private fail(block: PdfBlock, e: unknown): void {
    const key = this.source.key(block.src);
    if (this.failed.has(key)) return;
    this.failed.add(key);
    const why = e instanceof Error ? e.message : String(e);
    toast(`PDF illisible (${block.src}) : ${why}. Les notes de la page restent intactes.`, "err", 7000);
  }
}
