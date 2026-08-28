import { el, askText, toast, confirmDialog, pick } from "./dom";
import { InkSurface, PAGE_W, PAGE_H } from "./canvas";
import { renderTex } from "./tex";
import type { Bounds } from "../core/ink/stroke";
import { strokeBounds, unionBounds } from "../core/ink/stroke";
import type {
  Block, ColorKey, InkBlock, MathBlock, Page, Stroke, ToolKind,
} from "../core/types";
import { uuid } from "../core/id";
import type { Repo } from "../core/storage/repo";
import type { RecoResult } from "../core/ink/recognizer";

export type ViewMode = "pages" | "scroll";
export type RenderMode = "ink" | "clean";

export interface PageViewHost {
  repo: Repo;
  getTool: () => ToolKind | "region" | "textregion";
  getColor: () => ColorKey;
  getWidth: () => number;
  touchRole: () => "write" | "navigate";
  /** Demande la reconnaissance d'un bloc math ou texte manuscrit. */
  requestRecognition: (key: string, kind: "math" | "text", strokes: Stroke[]) => void;
  onDirty: () => void;
  openLink: (target: string) => void;
}

/** Cle stable d'un bloc dans toute l'arborescence, utilisee par la file. */
export function blockKey(nb: string, div: string, page: number, blockId: string): string {
  return `${nb}/${div}/${String(page).padStart(4, "0")}#${blockId}`;
}

interface LoadedPage {
  number: number;
  page: Page;
  surface: InkSurface | null;
  wrap: HTMLElement;
  overlay: HTMLElement;
  sheet: HTMLElement;
}

/**
 * Vue d'un intercalaire. La page reste l'unite de base dans les deux modes
 * (section 5) : en defilement les pages sont simplement empilees, separees
 * par un trait discret, et gardent leur numero.
 */
export class PageView {
  readonly root: HTMLElement;
  private list: LoadedPage[] = [];
  private viewMode: ViewMode = "pages";
  private renderMode: RenderMode = "ink";
  private current = 1;
  private undoStack: { number: number; blocks: string }[] = [];
  private redoStack: { number: number; blocks: string }[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bloc texte a mettre au clavier des qu'il est rendu. */
  private focusBlockId: string | null = null;
  private pendingSave = new Map<number, Page>();
  private resizeObserver: ResizeObserver;

  constructor(
    private host: PageViewHost,
    public notebook: string,
    public divider: string,
  ) {
    this.root = el("div", { class: "pages" });
    this.resizeObserver = new ResizeObserver(() => this.relayout());
    this.resizeObserver.observe(this.root);
  }

  get pageNumber(): number { return this.current; }
  get mode(): ViewMode { return this.viewMode; }
  get rendering(): RenderMode { return this.renderMode; }

  async load(startPage?: number): Promise<void> {
    const meta = await this.host.repo.readMeta(this.notebook);
    this.viewMode = meta.viewMode?.[this.divider] ?? "pages";
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    if (nums.length === 0) {
      await this.host.repo.createPage(this.notebook, this.divider);
      nums.push(1);
    }
    this.current = clamp(startPage ?? meta.lastPosition?.page ?? 1, 1, nums[nums.length - 1]);
    await this.render();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    for (const p of this.list) p.surface?.dispose();
    void this.flush();
  }

  /* ---------------- rendu ---------------- */

  async render(): Promise<void> {
    await this.flush();
    for (const p of this.list) p.surface?.dispose();
    this.list = [];
    this.root.replaceChildren();
    this.root.classList.toggle("scroll-mode", this.viewMode === "scroll");

    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    const visible = this.viewMode === "pages"
      ? nums.filter((n) => n === this.current)
      : nums;

    for (const n of visible) {
      let page: Page;
      try {
        page = await this.host.repo.readPage(this.notebook, this.divider, n);
      } catch {
        continue;
      }
      const loaded = this.buildPage(n, page);
      this.list.push(loaded);
      // Separateur discret entre deux pages en mode defilement.
      if (this.viewMode === "scroll" && this.list.length > 1) {
        this.root.append(el("div", { class: "page-sep" }));
      }
      this.root.append(loaded.wrap);
    }
    this.relayout();
    if (this.viewMode === "scroll") this.watchScroll(nums);
  }

  private buildPage(n: number, page: Page): LoadedPage {
    const canvas = el("canvas");
    const overlay = el("div", { class: "overlay" });
    const sheet = el("div", { class: "sheet" }, canvas, overlay);
    // Les numeros de page restent affiches dans les deux modes (section 5).
    const wrap = el("div", { class: "page-wrap", dataset: { page: String(n) } },
      sheet,
      el("div", { class: "page-num" }, `${this.divider} p. ${n}`),
    );

    const loaded: LoadedPage = { number: n, page, surface: null, wrap, overlay, sheet };

    const surface = new InkSurface(canvas, {
      getTool: this.host.getTool,
      getColor: this.host.getColor,
      getWidth: this.host.getWidth,
      touchRole: this.host.touchRole,
      onStrokeEnd: (s) => this.onStrokeEnd(loaded, s),
      onErase: (ids) => this.onErase(loaded, ids),
      onRegion: (b) => void this.onRegion(
        loaded, b, this.host.getTool() === "textregion" ? "text" : "math",
      ),
    });
    loaded.surface = surface;
    surface.setStrokes(this.visibleStrokes(page));
    this.paintOverlay(loaded);
    return loaded;
  }

  /**
   * Traits affiches sur le canvas. En rendu propre, les traits d'un bloc math
   * deja reconnu laissent la place a la formule : bascule instantanee, aucune
   * donnee perdue (section 4).
   */
  private visibleStrokes(page: Page): Stroke[] {
    const out: Stroke[] = [];
    for (const b of page.blocks) {
      if (b.type === "ink") {
        const hidden = this.renderMode === "clean" && b.recognized && b.rect;
        if (!hidden) out.push(...b.strokes);
      }
      if (b.type === "math") {
        const hidden = this.renderMode === "clean" && b.latex;
        if (!hidden) out.push(...b.strokes);
      }
      if (b.type === "pdf") out.push(...b.annotations);
    }
    return out;
  }

  private relayout(): void {
    const width = Math.min(900, Math.max(280, this.root.clientWidth - 36));
    for (const p of this.list) {
      p.wrap.style.maxWidth = `${width}px`;
      p.sheet.style.height = `${Math.round(width * (PAGE_H / PAGE_W))}px`;
      p.surface?.layout(width);
      this.paintOverlay(p);
    }
  }

  /** Repere la page en vue pour que "derniere position" reste juste. */
  private watchScroll(nums: number[]): void {
    const onScroll = () => {
      const top = this.root.scrollTop + 80;
      let best = nums[0] ?? 1;
      for (const p of this.list) {
        if (p.wrap.offsetTop <= top) best = p.number;
      }
      if (best !== this.current) {
        this.current = best;
        void this.host.repo.setLastPosition(this.notebook, this.divider, best);
        this.host.onDirty();
      }
    };
    this.root.addEventListener("scroll", throttle(onScroll, 250));
  }

  /* ---------------- edition ---------------- */

  private mainInk(page: Page): InkBlock {
    let ink = page.blocks.find((b): b is InkBlock => b.type === "ink");
    if (!ink) {
      ink = { id: uuid(), type: "ink", strokes: [], recognized: null, mode: "raw" };
      page.blocks.push(ink);
    }
    return ink;
  }

  private onStrokeEnd(loaded: LoadedPage, stroke: Stroke): void {
    this.pushUndo(loaded);
    this.mainInk(loaded.page).strokes.push(stroke);
    this.queueSave(loaded);
  }

  private onErase(loaded: LoadedPage, ids: string[]): void {
    this.pushUndo(loaded);
    const set = new Set(ids);
    for (const b of loaded.page.blocks) {
      if (b.type === "ink") b.strokes = b.strokes.filter((s) => !set.has(s.id));
      if (b.type === "math") {
        const before = b.strokes.length;
        b.strokes = b.strokes.filter((s) => !set.has(s.id));
        // Un bloc math dont toute l'encre a ete gommee n'a plus de raison
        // d'exister : on ne garde jamais un LaTeX orphelin.
        if (before > 0 && b.strokes.length === 0) b.latex = null;
      }
      if (b.type === "pdf") b.annotations = b.annotations.filter((s) => !set.has(s.id));
    }
    loaded.page.blocks = loaded.page.blocks.filter(
      (b) => !(b.type === "math" && b.strokes.length === 0),
    );
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  /**
   * Une zone entouree devient un bloc math : les traits sont deplaces du
   * fond vers le bloc, puis envoyes a la reconnaissance. L'encre brute reste
   * dans le bloc, c'est la regle absolue de la section 2.
   */
  private async onRegion(
    loaded: LoadedPage, b: Bounds, kind: "math" | "text",
  ): Promise<void> {
    const ink = this.mainInk(loaded.page);
    const inside = ink.strokes.filter((s) => insideBounds(strokeBounds(s), b));
    if (inside.length === 0) {
      toast("Aucun trait dans la zone", "warn");
      return;
    }
    this.pushUndo(loaded);
    const ids = new Set(inside.map((s) => s.id));
    ink.strokes = ink.strokes.filter((s) => !ids.has(s.id));

    const box = unionBounds(inside.map((s) => strokeBounds(s, 4)));
    const id = uuid();
    // Une zone math donne un bloc math et du LaTeX ; une zone texte donne un
    // bloc d'encre dont le texte reconnu vit dans `recognized` (section 4).
    const block: Block = kind === "math"
      ? { id, type: "math", mode: "math", strokes: inside, latex: null, pending: true, rect: box }
      : { id, type: "ink", mode: "raw", strokes: inside, recognized: null, pending: true, rect: box };
    loaded.page.blocks.push(block);
    this.paintOverlay(loaded);
    this.queueSave(loaded);

    this.host.requestRecognition(
      blockKey(this.notebook, this.divider, loaded.number, id),
      kind,
      inside,
    );
  }

  /** Appele quand la reconnaissance revient, eventuellement bien plus tard. */
  async applyRecognition(key: string, result: RecoResult): Promise<void> {
    const hash = key.indexOf("#");
    const blockId = key.slice(hash + 1);
    const pageNum = Number(key.slice(0, hash).split("/").pop());
    const loaded = this.list.find((p) => p.number === pageNum);

    if (loaded) {
      const block = loaded.page.blocks.find((b) => b.id === blockId);
      if (block) {
        applyToBlock(block, result);
        this.paintOverlay(loaded);
        this.queueSave(loaded);
      }
      return;
    }
    // La page n'est pas a l'ecran : on ecrit directement sur le disque.
    const path = key.slice(0, hash).split("/");
    const nb = path[0], div = path[1];
    try {
      const page = await this.host.repo.readPage(nb, div, pageNum);
      const block = page.blocks.find((b) => b.id === blockId);
      if (block) {
        applyToBlock(block, result);
        await this.host.repo.writePage(nb, div, pageNum, page);
      }
    } catch { /* page disparue entre temps */ }
  }

  /* ---------------- blocs affiches ---------------- */

  private paintOverlay(loaded: LoadedPage): void {
    const scale = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    loaded.overlay.replaceChildren();

    for (const block of loaded.page.blocks) {
      const node = this.renderBlock(loaded, block, scale);
      if (node) loaded.overlay.append(node);
    }
  }

  private renderBlock(loaded: LoadedPage, block: Block, scale: number): HTMLElement | null {
    const place = (node: HTMLElement, r?: Bounds) => {
      if (!r) return node;
      Object.assign(node.style, {
        left: `${r.x * scale}px`,
        top: `${r.y * scale}px`,
        width: `${r.w * scale}px`,
        minHeight: `${r.h * scale}px`,
      });
      return node;
    };

    switch (block.type) {
      case "math": {
        // En mode encre le bloc n'est qu'un cadre : l'encre brute dessous
        // doit rester lisible, c'est elle qui fait foi si la conversion se trompe.
        const clean = this.renderMode === "clean" && !!block.latex;
        const box = el("div", {
          class: `block-box math${block.pending ? " pending" : ""}${clean ? " clean" : ""}`,
        }, el("span", { class: "tag" },
          block.pending ? "conversion en attente"
            : block.latex ? "math" : "math, non reconnu"));
        if (clean) {
          const tex = renderTex(block.latex!);
          tex.style.fontSize = `${Math.max(14, 20 * scale)}px`;
          box.append(tex);
        }
        if (block.latex) {
          box.title = block.latex;
          box.style.cursor = "pointer";
          box.addEventListener("click", () => void this.correctMath(loaded, block));
        }
        return place(box, block.rect);
      }
      case "text": {
        const box = el("div", { class: "block-box text" });
        const area = el("textarea", { class: "block-text-edit", rows: "1" });
        area.value = block.content;
        // La zone grandit avec le texte : on ecrit sans jamais gerer une
        // barre de defilement dans un bloc de cours.
        const grow = () => {
          area.style.height = "auto";
          area.style.height = `${area.scrollHeight}px`;
          if (block.rect) block.rect.h = Math.max(40, area.scrollHeight / scale);
        };
        area.addEventListener("input", () => {
          block.content = area.value;
          grow();
          this.queueSave(loaded);
        });
        box.append(area);
        queueMicrotask(grow);
        if (this.focusBlockId === block.id) {
          this.focusBlockId = null;
          queueMicrotask(() => area.focus());
        }
        return place(box, block.rect ?? { x: 40, y: 40, w: PAGE_W - 80, h: 60 });
      }
      case "calc": {
        const box = el("div", { class: "block-box math" },
          el("span", { class: "tag" }, "calcul"),
          renderTex(`${safeTex(block.expr)} = ${safeTex(String(block.result ?? ""))}`),
        );
        return place(box, block.rect);
      }
      case "graph": {
        const box = el("div", { class: "block-box math" }, el("span", { class: "tag" }, "courbe"));
        const canvas = el("canvas");
        box.append(canvas);
        queueMicrotask(() => drawMini(canvas, block.fn, block.domain));
        return place(box, block.rect);
      }
      case "flag": {
        const pin = el("button", { class: "flag-pin", title: block.note }, "?");
        pin.addEventListener("click", async () => {
          const done = await confirmDialog("Repere", block.note, "Marquer comme compris");
          if (done) {
            block.resolved = true;
            this.paintOverlay(loaded);
            this.queueSave(loaded);
          }
        });
        if (block.resolved) return null;
        const r = block.rect ?? { x: PAGE_W - 60, y: 20, w: 30, h: 30 };
        Object.assign(pin.style, { left: `${r.x * scale}px`, top: `${r.y * scale}px` });
        return pin;
      }
      case "link": {
        const box = el("div", { class: "block-box" },
          el("button", { class: "ghost", onclick: () => this.host.openLink(block.target) },
            `→ ${block.label}`));
        return place(box, block.rect);
      }
      case "image": {
        const img = el("img", { style: { maxWidth: "100%", display: "block", borderRadius: "4px" } });
        const box = el("div", { class: "block-box" },
          el("span", { class: "tag" }, block.ocr ? "photo, texte extrait" : "photo"),
          img);
        if (block.ocr) box.title = block.ocr;
        // Le fichier est lu a l'affichage : la page JSON ne porte que le chemin.
        void this.host.repo.readAsset(this.notebook, this.divider, block.src)
          .then((url) => { img.src = url; })
          .catch(() => { box.append(el("span", { class: "small muted" }, "image introuvable")); });
        return place(box, block.rect);
      }
      case "ink": {
        // Seule une zone passee au moteur Text a un cadre : le fond de page,
        // lui, n'est qu'un tas de traits libres.
        if (!block.rect) return null;
        const clean = this.renderMode === "clean" && !!block.recognized;
        const box = el("div", {
          class: `block-box math${block.pending ? " pending" : ""}${clean ? " clean" : ""}`,
        }, el("span", { class: "tag" },
          block.pending ? "conversion en attente"
            : block.recognized ? "texte" : "texte, non reconnu"));
        if (clean) {
          const line = el("div", { style: { fontSize: `${Math.max(14, 19 * scale)}px` } },
            block.recognized!);
          box.append(line);
        }
        if (block.recognized) box.title = block.recognized;
        return place(box, block.rect);
      }
      case "pdf":
        return null;
    }
  }

  /**
   * Correction en un geste (section 4). Un appui sur la formule propose les
   * autres lectures du moteur : dx pris pour dz, a pour alpha, une apostrophe
   * avalee. La reconnaissance ne sera jamais parfaite, la correction doit
   * couter un geste, pas une reecriture.
   */
  private async correctMath(loaded: LoadedPage, block: MathBlock): Promise<void> {
    const options = (block.candidates ?? []).map((c) => ({ value: c, label: c }));
    options.push({ value: EDIT_SENTINEL, label: "Corriger a la main..." });
    const choice = await pick(
      options.length > 1 ? "Autres lectures possibles" : "Corriger la formule",
      options,
    );
    if (choice === null) return;
    if (choice === EDIT_SENTINEL) { await this.editLatex(loaded, block); return; }
    // La lecture choisie devient la principale, l'ancienne rejoint les autres.
    const previous = block.latex;
    block.candidates = [
      ...(block.candidates ?? []).filter((c) => c !== choice),
      ...(previous && previous !== choice ? [previous] : []),
    ];
    block.latex = choice;
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  private async editLatex(loaded: LoadedPage, block: MathBlock): Promise<void> {
    const next = await askText("Corriger la formule", "LaTeX reconnu", block.latex ?? "");
    if (next === null) return;
    if (block.latex && block.latex !== next) {
      block.candidates = [...(block.candidates ?? []).filter((c) => c !== next), block.latex];
    }
    block.latex = next;
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  /* ---------------- insertion de blocs ---------------- */

  private activePage(): LoadedPage | undefined {
    return this.list.find((p) => p.number === this.current) ?? this.list[0];
  }

  addBlock(block: Block): void {
    const loaded = this.activePage();
    if (!loaded) return;
    this.pushUndo(loaded);
    loaded.page.blocks.push(block);
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  /**
   * Ordonnee libre sous les blocs deja poses. Sans cela, deux insertions
   * successives se superposent et le texte devient illisible.
   */
  nextFreeY(defaultY = 60): number {
    const loaded = this.activePage();
    if (!loaded) return defaultY;
    let bottom = 0;
    for (const b of loaded.page.blocks) {
      if (b.type === "flag" || !b.rect) continue;
      bottom = Math.max(bottom, b.rect.y + b.rect.h);
    }
    // Les traits libres comptent aussi : on ne recouvre pas ce qui est ecrit.
    for (const b of loaded.page.blocks) {
      if (b.type !== "ink") continue;
      for (const s of b.strokes) {
        const sb = strokeBounds(s);
        bottom = Math.max(bottom, sb.y + sb.h);
      }
    }
    return bottom > 0 ? Math.min(bottom + 24, PAGE_H - 140) : defaultY;
  }

  /**
   * Repere "pas compris" : un seul bouton, aucun texte a ecrire.
   * En amphi on n'a pas le temps d'ecrire une note, on a le temps d'appuyer.
   */
  addFlag(note = "A revoir"): void {
    const loaded = this.activePage();
    if (!loaded) return;
    const y = 20 + loaded.page.blocks.filter((b) => b.type === "flag").length * 40;
    this.addBlock({ id: uuid(), type: "flag", note, rect: { x: PAGE_W - 62, y, w: 30, h: 30 } });
    toast("Repere pose sur la page");
  }

  /** Insere une photo redressee : le fichier part dans assets/. */
  async addImageBlock(
    dataUrl: string, width: number, height: number, ocr: string | null,
  ): Promise<void> {
    const loaded = this.activePage();
    if (!loaded) return;
    const id = uuid();
    const name = `${id}.png`;
    let src: string;
    try {
      src = await this.host.repo.writeAsset(this.notebook, this.divider, name, dataUrl);
    } catch (e) {
      toast(`Image non enregistree : ${(e as Error).message}`, "err", 6000);
      return;
    }
    // Largeur de page moins les marges, hauteur proportionnelle.
    const w = Math.min(PAGE_W - 120, 640);
    const h = Math.max(60, Math.round((height / width) * w));
    this.addBlock({
      id, type: "image", src, ocr,
      rect: { x: 60, y: this.nextFreeY(), w, h },
    });
    toast(ocr ? "Photo inseree, texte extrait pour la recherche" : "Photo inseree");
  }

  /** Ajoute un bloc de texte et met le curseur dedans : on tape aussitot. */
  addTextBlock(): void {
    if (!this.activePage()) return;
    const id = uuid();
    this.focusBlockId = id;
    this.addBlock({
      id, type: "text", content: "",
      rect: { x: 60, y: this.nextFreeY(), w: PAGE_W - 120, h: 44 },
    });
  }

  /* ---------------- navigation ---------------- */

  async goTo(n: number): Promise<void> {
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    if (!nums.includes(n)) return;
    this.current = n;
    await this.host.repo.setLastPosition(this.notebook, this.divider, n);
    if (this.viewMode === "pages") {
      await this.render();
    } else {
      this.list.find((p) => p.number === n)?.wrap.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    this.host.onDirty();
  }

  async next(): Promise<void> {
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    const i = nums.indexOf(this.current);
    if (i >= 0 && i < nums.length - 1) await this.goTo(nums[i + 1]);
    else toast("Derniere page. Utilise « Nouvelle page ».", "info", 1800);
  }

  async prev(): Promise<void> {
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    const i = nums.indexOf(this.current);
    if (i > 0) await this.goTo(nums[i - 1]);
  }

  async newPage(insertHere = false): Promise<void> {
    await this.flush();
    const n = await this.host.repo.createPage(
      this.notebook, this.divider, insertHere ? this.current + 1 : undefined,
    );
    this.current = n;
    await this.render();
    this.host.onDirty();
  }

  async deleteCurrentPage(): Promise<void> {
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    if (nums.length <= 1) { toast("Un intercalaire garde au moins une page", "warn"); return; }
    const ok = await confirmDialog(
      "Supprimer la page",
      `La page ${this.current} de ${this.divider} sera supprimee et les suivantes renumerotees.`,
      "Supprimer",
    );
    if (!ok) return;
    this.pendingSave.delete(this.current);
    await this.host.repo.deletePage(this.notebook, this.divider, this.current);
    this.current = Math.max(1, this.current - 1);
    await this.render();
    this.host.onDirty();
  }

  async setViewMode(mode: ViewMode): Promise<void> {
    this.viewMode = mode;
    await this.host.repo.setViewMode(this.notebook, this.divider, mode);
    await this.render();
    if (mode === "scroll") {
      this.list.find((p) => p.number === this.current)?.wrap.scrollIntoView({ block: "start" });
    }
  }

  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    for (const p of this.list) {
      p.surface?.setStrokes(this.visibleStrokes(p.page));
      this.paintOverlay(p);
    }
  }

  /** Va a un bloc precis, apres une recherche ou un lien. */
  async focusBlock(pageNumber: number, blockId: string): Promise<void> {
    await this.goTo(pageNumber);
    const loaded = this.list.find((p) => p.number === pageNumber);
    if (!loaded) return;
    const block = loaded.page.blocks.find((b) => b.id === blockId);
    if (!block?.rect) { loaded.wrap.scrollIntoView({ block: "center" }); return; }
    loaded.wrap.scrollIntoView({ block: "center" });
    const scale = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    const marker = el("div", {
      class: "block-box",
      style: {
        left: `${(block.rect.x - 6) * scale}px`,
        top: `${(block.rect.y - 6) * scale}px`,
        width: `${(block.rect.w + 12) * scale}px`,
        height: `${(block.rect.h + 12) * scale}px`,
        border: "2px solid #2563eb",
        background: "rgba(37,99,235,.10)",
      },
    });
    loaded.overlay.append(marker);
    setTimeout(() => marker.remove(), 1800);
  }

  /* ---------------- annulation ---------------- */

  private pushUndo(loaded: LoadedPage): void {
    this.undoStack.push({ number: loaded.number, blocks: JSON.stringify(loaded.page.blocks) });
    // Annulation profonde, mais pas infinie : 200 pas suffisent largement.
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void { this.step(this.undoStack, this.redoStack); }
  redo(): void { this.step(this.redoStack, this.undoStack); }

  private step(from: { number: number; blocks: string }[], to: { number: number; blocks: string }[]): void {
    const entry = from.pop();
    if (!entry) return;
    const loaded = this.list.find((p) => p.number === entry.number);
    if (!loaded) return;
    to.push({ number: entry.number, blocks: JSON.stringify(loaded.page.blocks) });
    loaded.page.blocks = JSON.parse(entry.blocks) as Block[];
    loaded.surface?.setStrokes(this.visibleStrokes(loaded.page));
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  /* ---------------- ecriture disque groupee ---------------- */

  /**
   * Ecriture groupee, pas a chaque trait (section 9). Un trait qui declenche
   * une ecriture disque, c'est la batterie qui part en fumee et OneDrive qui
   * synchronise en boucle.
   */
  private queueSave(loaded: LoadedPage): void {
    this.pendingSave.set(loaded.number, loaded.page);
    this.host.onDirty();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 1200);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const pending = [...this.pendingSave.entries()];
    this.pendingSave.clear();
    for (const [n, page] of pending) {
      try {
        await this.host.repo.writePage(this.notebook, this.divider, n, page);
      } catch (e) {
        toast(`Ecriture impossible : ${(e as Error).message}`, "err", 6000);
        this.pendingSave.set(n, page);
      }
    }
  }

  get hasUnsaved(): boolean { return this.pendingSave.size > 0; }
}

/** Range le resultat la ou le bloc l'attend : LaTeX pour math, texte pour l'encre. */
function applyToBlock(block: Block, result: RecoResult): void {
  if (block.type === "math") {
    block.latex = result.value;
    block.candidates = result.candidates.length ? result.candidates : undefined;
    block.pending = false;
  } else if (block.type === "ink") {
    block.recognized = result.value;
    block.candidates = result.candidates.length ? result.candidates : undefined;
    block.pending = false;
  }
}

/** Valeur reservee du menu de correction, jamais un LaTeX valide. */
const EDIT_SENTINEL = "\u0000corriger-a-la-main";

/* ---------------- utilitaires ---------------- */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function insideBounds(inner: Bounds, outer: Bounds): boolean {
  const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...args); }
    else if (!timer) {
      timer = setTimeout(() => { timer = null; last = performance.now(); fn(...args); }, ms - (now - last));
    }
  }) as T;
}

function safeTex(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, (c) => `\\${c}`);
}

/** Apercu de courbe dans un bloc graph. Le bloc reste vivant : il stocke
 *  l'expression, jamais une image. */
function drawMini(canvas: HTMLCanvasElement, fn: string, domain: [number, number]): void {
  const parent = canvas.parentElement;
  const w = Math.max(160, (parent?.clientWidth ?? 240) - 8);
  const h = Math.round(w * 0.42);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  void import("../core/calc/plot").then(({ samplePlot }) => {
    const plot = samplePlot(fn, domain[0], domain[1], 300);
    if (!plot.ok || !plot.samples) {
      ctx.fillStyle = "#a51b1b";
      ctx.font = "12px system-ui";
      ctx.fillText("expression invalide", 6, 16);
      return;
    }
    let yMin = plot.yMin!, yMax = plot.yMax!;
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const X = (x: number) => ((x - domain[0]) / (domain[1] - domain[0])) * w;
    const Y = (y: number) => h - ((y - yMin) / (yMax - yMin)) * h;
    ctx.strokeStyle = "#c9d2e0";
    if (0 >= yMin && 0 <= yMax) {
      ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
    }
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.6;
    ctx.beginPath();
    let pen = false;
    for (const s of plot.samples) {
      if (s.y === null) { pen = false; continue; }
      const px = X(s.x), py = Y(s.y);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  });
}
