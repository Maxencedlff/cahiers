import { el, askText, toast, confirmDialog, pick } from "./dom";
import { InkSurface, PAGE_W, PAGE_H } from "./canvas";
import { renderTex } from "./tex";
import type { Bounds } from "../core/ink/stroke";
import { strokeBounds, unionBounds } from "../core/ink/stroke";
import { growForStroke, sheetHeight, shrinkToInk } from "../core/ink/sheet";
import type {
  Block, ImageBlock, InkBlock, InkColor, MathBlock, Page, Stroke, TextBlock, ToolKind,
} from "../core/types";
import { uuid } from "../core/id";
import type { Repo, TrashEntry } from "../core/storage/repo";
import type { RecoResult } from "../core/ink/recognizer";
import {
  carryEdits, convertedStrokeIds, dropStrokes, joinWords, layoutWords,
  LINE_HEIGHT, type PlacedWord,
} from "../core/ink/words";
import { colorOf } from "../core/palette";
import { TextDoc } from "./textdoc";
import { absorbTextBoxes } from "../core/text/doc";
import { PageHistory, applyStrokeCommand, restoreBlocks } from "../core/history";

export type ViewMode = "pages" | "scroll";
export type RenderMode = "ink" | "clean";

export interface PageViewHost {
  repo: Repo;
  /** false quand aucun moteur de reconnaissance n'est configure. */
  recognitionReady: () => boolean;
  /** Convertir l'ecriture au fil de la plume, sans entourer de zone. */
  autoConvert: () => boolean;
  getTool: () => ToolKind | "region" | "textregion";
  getColor: () => InkColor;
  getWidth: () => number;
  touchRole: () => "write" | "navigate";
  /**
   * Une zone math ou texte vient d'etre tracee. Les outils de zone sont
   * ponctuels : l'appli remet l'outil d'avant, le trait suivant ecrit.
   */
  onRegionDone?: () => void;
  /** Demande la reconnaissance d'un bloc math ou texte manuscrit. */
  requestRecognition: (key: string, kind: "math" | "text", strokes: Stroke[]) => void;
  onDirty: () => void;
  openLink: (target: string) => void;
  /** Une page vient de partir a la corbeille : l'appli propose « Annuler ». */
  onTrashed: (entry: TrashEntry) => void;
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
  /** Derniere mise en page des mots tapes, pour retrouver le mot touche. */
  placed?: PlacedWord[];
  /** Texte tape au clavier, toujours present sur la page. */
  doc: TextDoc;
  /** Suit la hauteur du texte ; deconnecte quand la page quitte l'ecran. */
  ro: ResizeObserver | null;
  /**
   * Page retiree de l'ecran (changement de page, suppression). Elle ne se
   * met plus en file d'ecriture : ce qu'elle contenait a deja ete ecrit ou
   * attend dans la file.
   */
  dead?: boolean;
  /** Le geste de gomme en cours a deja son entree d'annulation. */
  eraseNoted?: boolean;
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
  /** Annulation par page, par id : un numero change a chaque suppression. */
  private history = new PageHistory();
  /** Derniere page modifiee, que suit Ctrl+Z en mode defilement. */
  private lastEditedId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bloc texte a mettre au clavier des qu'il est rendu. */
  private focusBlockId: string | null = null;
  /**
   * Pages a ecrire, par id de page. Le numero n'est lu qu'au moment
   * d'ecrire (LoadedPage.number, tenu a jour a chaque renumerotation) :
   * indexee par numero, la file ecrivait une page sur sa voisine apres une
   * suppression.
   */
  private pendingSave = new Map<string, LoadedPage>();
  /** Derniere ecriture en echec, affichee dans la barre d'etat. */
  private saveError: string | null = null;
  /**
   * Les ecritures et les renumerotations passent l'une apres l'autre : une
   * sauvegarde ne part jamais au milieu d'une suppression de page.
   */
  private io: Promise<unknown> = Promise.resolve();
  /** Un rendu plus recent abandonne le precedent (deux PageDown rapides). */
  private renderGen = 0;
  private resizeObserver: ResizeObserver;

  constructor(
    private host: PageViewHost,
    public notebook: string,
    public divider: string,
  ) {
    this.root = el("div", { class: "pages" });
    this.resizeObserver = new ResizeObserver(() => this.relayout());
    this.resizeObserver.observe(this.root);
    // Pose une seule fois : un ecouteur par rendu s'accumulait.
    this.root.addEventListener("scroll", throttle(() => this.onScroll(), 250));
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

  /**
   * La vue quitte l'ecran. Ce qui attend d'etre ecrit l'est avant de rendre
   * la main : la vue suivante relit le disque et doit y trouver la derniere
   * frappe. Une ecriture en echec continue d'etre retentee.
   */
  async dispose(): Promise<void> {
    this.resizeObserver.disconnect();
    this.renderGen++;
    this.teardown();
    await this.flush();
  }

  /**
   * Abandonne la file sans rien ecrire. Sert avant de mettre l'intercalaire
   * a la corbeille : une ecriture tardive recreerait son dossier.
   */
  discard(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.pendingSave.clear();
    this.saveError = null;
  }

  /**
   * Reprend la file d'une vue quittee sur le meme intercalaire, dont une
   * ecriture a echoue. A appeler avant load() : la nouvelle vue affiche
   * alors la version en attente, pas l'ancienne version du disque. Sans
   * cela, les deux vues ecrivaient chacune leur version de la page et la
   * derniere effacait l'autre.
   */
  async adopt(old: PageView): Promise<void> {
    // Laisse finir un essai en cours de l'ancienne vue.
    await old.io;
    for (const [id, p] of old.pendingSave) if (!this.pendingSave.has(id)) this.pendingSave.set(id, p);
    if (old.saveError) this.saveError = old.saveError;
    old.discard();
    if (this.pendingSave.size && !this.saveTimer) {
      this.saveTimer = setTimeout(() => void this.flush(), 3000);
    }
  }

  /** Detache les pages affichees et libere leur memoire (canvas, ecouteurs). */
  private teardown(): void {
    for (const p of this.list) {
      p.dead = true;
      p.ro?.disconnect();
      p.doc.dispose();
      p.surface?.dispose();
    }
    this.list = [];
  }

  /* ---------------- rendu ---------------- */

  async render(): Promise<void> {
    const gen = ++this.renderGen;
    // Les pages quittent l'ecran AVANT l'ecriture : une frappe pendant le
    // rendu ne peut plus aller dans une page qu'on s'apprete a relire.
    this.teardown();
    this.root.replaceChildren();
    await this.flush();
    if (gen !== this.renderGen) return;
    this.root.classList.toggle("scroll-mode", this.viewMode === "scroll");

    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    if (gen !== this.renderGen) return;
    const visible = this.viewMode === "pages"
      ? nums.filter((n) => n === this.current)
      : nums;

    for (const n of visible) {
      let page: Page;
      try {
        page = await this.host.repo.readPage(this.notebook, this.divider, n);
      } catch (e) {
        if (gen !== this.renderGen) return;
        // Jamais d'ecran gris muet : on dit ce qui se passe. Rien n'est
        // ecrit sous ce numero tant que la page reste illisible.
        if (this.viewMode === "scroll" && this.root.childElementCount) {
          this.root.append(el("div", { class: "page-sep" }));
        }
        this.root.append(this.unreadableSheet(n, e, nums));
        toast(`Page ${n} de ${this.divider} illisible : ${errorText(e)}`, "err", 6000);
        continue;
      }
      if (gen !== this.renderGen) return;
      // Page dont l'ecriture a echoue : le disque a une version ancienne.
      // On reprend la version en attente, sinon la frappe suivante
      // l'ecraserait.
      const waiting = this.pendingSave.get(page.id);
      if (waiting) page = waiting.page;
      const loaded = this.buildPage(n, page);
      if (waiting) this.pendingSave.set(page.id, loaded);
      this.list.push(loaded);
      // Separateur discret entre deux pages en mode defilement.
      if (this.viewMode === "scroll" && this.root.childElementCount) {
        this.root.append(el("div", { class: "page-sep" }));
      }
      this.root.append(loaded.wrap);
    }
    this.relayout();
  }

  /**
   * A la place d'une page qu'on ne peut pas lire (JSON tronque, fichier
   * OneDrive pas encore telecharge) : ce qui se passe et quoi faire.
   */
  private unreadableSheet(n: number, err: unknown, nums: number[]): HTMLElement {
    const path = this.host.repo.pagePath(this.notebook, this.divider, n);
    const other = nums.find((x) => x > n) ?? [...nums].reverse().find((x) => x < n);
    const actions = el("div", { class: "unreadable-actions" },
      el("button", { class: "primary", onclick: () => void this.render() }, "Réessayer"),
      this.host.repo.canReveal
        ? el("button", {
            onclick: () => void this.host.repo.revealPage(this.notebook, this.divider, n)
              .catch((e) => toast(`Dossier introuvable : ${errorText(e)}`, "err", 6000)),
          }, "Ouvrir le dossier")
        : null,
      other != null
        ? el("button", { onclick: () => void this.goTo(other) },
            other > n ? "Page suivante" : "Page précédente")
        : null,
    );
    return el("div", { class: "page-wrap unreadable-wrap", dataset: { page: String(n) } },
      el("div", { class: "sheet unreadable" },
        el("h2", {}, "Page illisible"),
        el("p", {}, "Cette page n'a pas pu être lue. Elle n'est pas modifiée : rien ne sera "
          + "écrit dessus tant qu'elle reste illisible."),
        el("p", { class: "muted" }, "Si le dossier est dans OneDrive, vérifie que le fichier est "
          + "bien téléchargé («\u00a0Toujours conserver sur cet appareil\u00a0»), puis réessaie."),
        el("p", { class: "small muted" }, el("code", {}, path), " : ", errorText(err)),
        actions,
      ),
      el("div", { class: "page-num" }, `${this.divider} p. ${n}`),
    );
  }

  private buildPage(n: number, page: Page): LoadedPage {
    const migrated = absorbTextBoxes(page.blocks as never[], uuid);
    // Encre gommee sous l'A4 lors d'une seance precedente : la page se
    // rouvre a la taille de l'encre restante. Pas pendant la seance, ou la
    // feuille se replierait sous la gomme avant qu'on reecrive a la place.
    shrinkToInk(page);
    const canvas = el("canvas");
    const overlay = el("div", { class: "overlay" });
    const imageOf = (id: string) =>
      page.blocks.find((b): b is ImageBlock => b.type === "image" && b.id === id);
    const doc = new TextDoc(this.bodyText(page)?.content ?? "", (content) => {
      this.setBodyText(loaded, content);
    }, {
      lookup: (id) => {
        const b = imageOf(id);
        if (!b) return null;
        return {
          url: this.host.repo.readAsset(this.notebook, this.divider, b.src),
          width: b.width ?? Math.min(PAGE_W - 128, 640),
          ocr: b.ocr,
        };
      },
      resized: (id, width) => {
        const b = imageOf(id);
        if (!b) return;
        b.width = width;
        this.queueSave(loaded);
      },
    });
    const sheet = el("div", { class: "sheet" }, canvas, doc.root, overlay);
    // Les numeros de page restent affiches dans les deux modes (section 5).
    const wrap = el("div", { class: "page-wrap", dataset: { page: String(n) } },
      sheet,
      el("div", { class: "page-num" }, `${this.divider} p. ${n}`),
    );

    const loaded: LoadedPage = { number: n, page, surface: null, wrap, overlay, sheet, doc, ro: null };

    const surface = new InkSurface(canvas, {
      getTool: this.host.getTool,
      getColor: this.host.getColor,
      getWidth: this.host.getWidth,
      touchRole: this.host.touchRole,
      onStrokeEnd: (s) => this.onStrokeEnd(loaded, s),
      onEraseStart: () => { loaded.eraseNoted = false; },
      onErase: (ids) => this.onErase(loaded, ids),
      // L'outil du geste, fige au pointerdown : pas celui du moment.
      onRegion: (b, tool) => {
        this.host.onRegionDone?.();
        void this.onRegion(loaded, b, tool === "textregion" ? "text" : "math");
      },
    });
    loaded.surface = surface;
    this.routePointers(loaded);
    // Une photo qui finit de charger allonge le texte : la feuille suit.
    loaded.ro = new ResizeObserver(() => this.fitSheet(loaded));
    loaded.ro.observe(doc.root);
    this.paintStrokes(loaded);
    this.watchWordTaps(loaded);
    this.paintOverlay(loaded);
    if (migrated) this.queueSave(loaded);
    return loaded;
  }

  /* ---------------- texte au clavier ---------------- */

  /** Le texte tape de la page : un bloc `text` sans cadre. */
  private bodyText(page: Page): TextBlock | undefined {
    return page.blocks.find((b): b is TextBlock => b.type === "text" && !b.rect);
  }

  private setBodyText(loaded: LoadedPage, content: string): void {
    let body = this.bodyText(loaded.page);
    if (!body) {
      if (!content) return;
      body = { id: uuid(), type: "text", content: "" };
      loaded.page.blocks.push(body);
    }
    if (body.content === content) return;
    body.content = content;
    this.fitSheet(loaded);
    this.queueSave(loaded);
  }

  /**
   * La couche texte couvre la page et passe devant l'encre. La souris y
   * place le curseur ; le stylet et le doigt sont rendus au canvas, sinon
   * on ne pourrait plus ecrire ni defiler sur une page qui contient du texte.
   * Les outils autres que le stylo (gomme, surligneur, zones) gardent la
   * souris pour l'encre.
   */
  private routePointers(loaded: LoadedPage): void {
    loaded.doc.root.addEventListener("pointerdown", (e) => {
      const tool = this.host.getTool();
      const toInk = e.pointerType === "pen" || e.pointerType === "touch"
        || (e.pointerType === "mouse" && e.button === 0 && tool !== "pen");
      if (!toInk) return;
      e.preventDefault();
      loaded.surface?.forwardDown(e);
    });
    // Survol relaye au canvas (apercu de la gomme) : la couche texte le couvre.
    loaded.sheet.addEventListener("pointermove", (e) => loaded.surface?.hover(e));
    loaded.sheet.addEventListener("pointerleave", () => loaded.surface?.hover(null));
  }

  /**
   * Anciennes photos posees par-dessus la page : elles cachaient le texte et
   * ne bougeaient pas. Chacune rejoint le texte avant la ligne qui passait
   * sous son bord haut. De la plus basse a la plus haute, pour qu'une photo
   * rangee ne decale pas la position des suivantes.
   */
  private adoptFloatingImages(loaded: LoadedPage): void {
    const floating = loaded.page.blocks
      .filter((b): b is ImageBlock => b.type === "image" && !!b.rect)
      .sort((a, b) => b.rect!.y - a.rect!.y);
    if (!floating.length) return;
    const sheet = loaded.sheet.getBoundingClientRect();
    const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    // La couche des blocs gene le reperage du texte sous le point : on la
    // retire le temps de la mesure.
    loaded.overlay.style.display = "none";
    for (const b of floating) {
      const r = b.rect!;
      b.width = Math.max(120, Math.min(PAGE_W - 128, Math.round(r.w)));
      delete b.rect;
      loaded.doc.adoptImage(b.id, sheet.left + 70 * k, sheet.top + (r.y + 4) * k);
    }
    loaded.overlay.style.display = "";
    this.setBodyText(loaded, loaded.doc.content);
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  /**
   * La feuille s'allonge quand le texte ou l'encre depasse le bas de l'A4.
   * Le canvas prend la meme hauteur : sans cela, l'encre ecrite dans la
   * partie allongee etait ecrasee sur le bord bas (y = PAGE_H). `force`
   * redimensionne le canvas meme sans changement (fenetre retaillee).
   */
  private fitSheet(loaded: LoadedPage, force = false): void {
    const width = loaded.sheet.clientWidth || PAGE_W;
    const k = width / PAGE_W;
    // Le texte couvre au moins toute la feuille (min-height: 100 %) : mesure
    // tel quel, il retenait la feuille a sa taille d'avant, et une page ne
    // redescendait jamais (texte efface, trait annule). On mesure donc le
    // contenu seul, le temps d'une lecture, sans peinture entre les deux.
    const root = loaded.doc.root;
    const minH = root.style.minHeight;
    root.style.minHeight = "0px";
    const textPx = root.scrollHeight;
    root.style.minHeight = minH;
    const h = sheetHeight(loaded.page, textPx / k);
    loaded.sheet.style.minHeight = `${Math.round(h * k)}px`;
    if (force) loaded.surface?.layout(width, h);
    else loaded.surface?.fit(width, h);
  }

  /** Donne le clavier au texte de la page en cours. */
  focusText(): void {
    this.activePage()?.doc.focus();
  }

  /** Texte de la page en cours, pour poser une formule depuis le ruban. */
  get activeDoc(): TextDoc | undefined {
    return this.activePage()?.doc;
  }

  /**
   * Traits affiches sur le canvas. En rendu propre, les traits d'un bloc math
   * deja reconnu laissent la place a la formule : bascule instantanee, aucune
   * donnee perdue (section 4).
   */
  private visibleStrokes(page: Page): { visible: Stroke[]; hidden: Stroke[] } {
    const out: Stroke[] = [];
    const hiddenOut: Stroke[] = [];
    const clean = this.renderMode === "clean";
    // Un surlignage n'est jamais converti : il reste visible en rendu propre.
    const marks = (list: Stroke[]) => list.filter((st) => st.tool === "highlighter");
    for (const b of page.blocks) {
      if (b.type === "ink") {
        if (clean && !b.rect && b.words?.length) {
          // Mot a mot : seuls les traits deja convertis s'effacent devant le
          // mot tape. Ce qui vient d'etre ecrit reste a l'encre jusqu'a la
          // prochaine pause, comme sur iPad.
          const done = convertedStrokeIds(b.words);
          for (const st of b.strokes) {
            (done.has(st.id) && st.tool !== "highlighter" ? hiddenOut : out).push(st);
          }
          continue;
        }
        // En rendu propre, l'encre convertie laisse la place au texte.
        // Elle n'est pas perdue pour autant : un clic sur "Rendu" la ramene.
        const hidden = clean && !!b.recognized;
        out.push(...(hidden ? marks(b.strokes) : b.strokes));
      }
      if (b.type === "math") {
        const hidden = clean && b.latex;
        out.push(...(hidden ? marks(b.strokes) : b.strokes));
      }
      if (b.type === "pdf") out.push(...b.annotations);
    }
    return { visible: out, hidden: hiddenOut };
  }

  private paintStrokes(loaded: LoadedPage): void {
    const { visible, hidden } = this.visibleStrokes(loaded.page);
    loaded.surface?.setStrokes(visible, hidden);
  }

  /**
   * Correction d'un mot tape : appui au doigt, ou clic droit a la souris.
   * Le stylet reste reserve a l'ecriture, le mot tape ne capte jamais le
   * trait : on peut ecrire par-dessus sans gene.
   */
  private watchWordTaps(loaded: LoadedPage): void {
    let down: { id: number; x: number; y: number; t: number } | null = null;
    const hit = (e: MouseEvent) => {
      if (this.renderMode !== "clean" || !loaded.placed?.length) return null;
      const r = loaded.sheet.getBoundingClientRect();
      const scale = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
      const x = (e.clientX - r.left) / scale, y = (e.clientY - r.top) / scale;
      const measure = measurer();
      return loaded.placed.find((p) =>
        x >= p.x - 4 && x <= p.x + measure(p.word.label, p.fontSize) + 4
        && y >= p.y - 4 && y <= p.y + p.fontSize * LINE_HEIGHT + 4) ?? null;
    };
    loaded.sheet.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
    });
    loaded.sheet.addEventListener("pointerup", (e) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || e.timeStamp - d.t > 500) return;
      const p = hit(e);
      if (p) void this.correctWord(loaded, p.index);
    });
    loaded.sheet.addEventListener("contextmenu", (e) => {
      // Bouton lateral du stylet : c'est une gomme, pas un menu.
      if ((e as PointerEvent).pointerType === "pen") { e.preventDefault(); return; }
      const p = hit(e);
      if (!p) return;
      e.preventDefault();
      void this.correctWord(loaded, p.index);
    });
  }

  /** Correction en un geste sur un mot tape (section 4). */
  private async correctWord(loaded: LoadedPage, index: number): Promise<void> {
    const ink = this.mainInk(loaded.page);
    const word = ink.words?.[index];
    if (!word) return;
    const options = (word.candidates ?? []).map((c) => ({ value: c, label: c }));
    options.push({ value: EDIT_SENTINEL, label: "Corriger a la main..." });
    const choice = await pick(
      options.length > 1 ? `Autres lectures de « ${word.label} »` : `Corriger « ${word.label} »`,
      options,
    );
    if (choice === null) return;
    let next = choice;
    if (choice === EDIT_SENTINEL) {
      const typed = await askText("Corriger le mot", "Mot reconnu", word.label);
      if (typed === null || !typed.trim()) return;
      next = typed.trim();
    }
    if (next === word.label) return;
    this.pushUndo(loaded);
    word.candidates = [
      ...(word.candidates ?? []).filter((c) => c !== next), word.label,
    ];
    word.label = next;
    word.edited = true;
    ink.recognized = joinWords(ink.words!);
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  private relayout(): void {
    const width = Math.min(900, Math.max(280, this.root.clientWidth - 36));
    for (const p of this.list) {
      p.wrap.style.maxWidth = `${width}px`;
      p.sheet.style.height = "";
      p.sheet.style.setProperty("--k", String(width / PAGE_W));
      this.fitSheet(p, true);
      // Il faut la page reellement a l'ecran pour savoir quelle ligne passe
      // sous chaque ancienne photo : c'est le cas au premier relayout visible.
      if (this.root.isConnected && this.root.clientWidth > 0) this.adoptFloatingImages(p);
      this.paintOverlay(p);
    }
  }

  /** Repere la page en vue pour que "derniere position" reste juste. */
  private onScroll(): void {
    if (this.viewMode !== "scroll" || !this.list.length) return;
    const top = this.root.scrollTop + 80;
    let best = this.list[0].number;
    for (const p of this.list) {
      if (p.wrap.offsetTop <= top) best = p.number;
    }
    if (best !== this.current) {
      this.current = best;
      void this.host.repo.setLastPosition(this.notebook, this.divider, best);
      this.host.onDirty();
    }
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
    const ink = this.mainInk(loaded.page);
    // Commande legere : l'ajout d'un trait ne serialise plus toute la page.
    this.history.push(loaded.page.id, { op: "add", blockId: ink.id, stroke });
    this.lastEditedId = loaded.page.id;
    ink.strokes.push(stroke);
    // Trait ecrit sous l'A4 : la feuille (et le canvas) s'allongent.
    if (growForStroke(loaded.page, stroke)) this.fitSheet(loaded);
    this.queueSave(loaded);
    // Un surlignage ne part pas a la reconnaissance.
    if (stroke.tool === "pen" && this.host.autoConvert()) this.scheduleAutoConvert(loaded);
  }

  /**
   * Conversion au fil de la plume (section 4). L'envoi part au lever du
   * stylet plus une pause, jamais en flux continu : sans cela on paierait
   * une requete par trait et la batterie avec.
   */
  private scheduleAutoConvert(loaded: LoadedPage): void {
    const ink = this.mainInk(loaded.page);
    // Ancienne transcription pleine page reprise au clavier : ne pas l'ecraser.
    // En mot a mot, les corrections sont reportees mot par mot (carryEdits).
    if (ink.editedByHand && !ink.words) return;
    ink.pending = true;
    this.paintOverlay(loaded);
    // Seule l'ecriture part chez MyScript : un surlignage la perturbe.
    this.host.requestRecognition(
      blockKey(this.notebook, this.divider, loaded.number, ink.id),
      "text",
      ink.strokes.filter((s) => s.tool === "pen"),
    );
  }

  /** Relance la conversion de la page, meme apres une correction clavier. */
  reconvert(): void {
    const loaded = this.activePage();
    if (!loaded) return;
    const ink = this.mainInk(loaded.page);
    if (!ink.strokes.some((s) => s.tool === "pen")) { toast("Rien à convertir sur cette page", "warn"); return; }
    ink.editedByHand = false;
    this.scheduleAutoConvert(loaded);
  }

  private onErase(loaded: LoadedPage, ids: string[]): void {
    // Un geste de gomme = une seule entree d'annulation, prise au premier
    // trait touche (un geste dans le vide n'en cree aucune).
    if (!loaded.eraseNoted) { this.pushUndo(loaded); loaded.eraseNoted = true; }
    const set = new Set(ids);
    for (const b of loaded.page.blocks) {
      if (b.type === "ink") {
        b.strokes = b.strokes.filter((s) => !set.has(s.id));
        if (b.words) {
          b.words = dropStrokes(b.words, set);
          b.recognized = joinWords(b.words) || null;
        }
      }
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
    // Les surlignages restent sur la page : ils ne sont pas a convertir.
    const inside = ink.strokes.filter((s) => s.tool === "pen" && insideBounds(strokeBounds(s), b));
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
    // Le bloc est retrouve par son id, pas par le numero de la cle : une
    // page supprimee ou inseree entre temps a decale les numeros.
    const has = (p: LoadedPage) => p.page.blocks.some((b) => b.id === blockId);
    const loaded = this.list.find(has);

    if (loaded) {
      const block = loaded.page.blocks.find((b) => b.id === blockId);
      if (block) {
        applyToBlock(block, result);
        // Le rendu propre masque l'encre convertie : il faut redessiner.
        this.paintStrokes(loaded);
        this.paintOverlay(loaded);
        this.queueSave(loaded);
      }
      return;
    }
    // Page quittee mais pas encore ecrite : le resultat part avec elle.
    const waiting = [...this.pendingSave.values()].find(has);
    if (waiting) {
      const block = waiting.page.blocks.find((b) => b.id === blockId);
      if (block) applyToBlock(block, result);
      return;
    }
    // La page n'est pas a l'ecran : on ecrit directement sur le disque, a la
    // suite des autres ecritures. Si le numero a change, le bloc n'est pas
    // dans la page lue et rien n'est ecrit.
    const path = key.slice(0, hash).split("/");
    const nb = path[0], div = path[1];
    await this.serial(async () => {
      try {
        const page = await this.host.repo.readPage(nb, div, pageNum);
        const block = page.blocks.find((b) => b.id === blockId);
        if (block) {
          applyToBlock(block, result);
          await this.host.repo.writePage(nb, div, pageNum, page);
        }
      } catch { /* page disparue entre temps */ }
    });
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
          block.pending
            ? (this.host.recognitionReady() ? "conversion en attente" : "cles MyScript manquantes")
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
        // Le texte de la page vit dans sa propre couche (TextDoc).
        if (!block.rect) return null;
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
        // Posee dans le texte : c'est TextDoc qui l'affiche.
        if (!block.rect) return null;
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
        // Le fond de page n'a pas de cadre. En rendu propre, il devient la
        // transcription de la page, modifiable au clavier.
        if (!block.rect) return this.renderPageTranscript(loaded, block, scale);
        const clean = this.renderMode === "clean" && !!block.recognized;
        const box = el("div", {
          class: `block-box math${block.pending ? " pending" : ""}${clean ? " clean" : ""}`,
        }, el("span", { class: "tag" },
          block.pending
            ? (this.host.recognitionReady() ? "conversion en attente" : "cles MyScript manquantes")
            : block.recognized ? "texte" : "texte, non reconnu"));
        if (clean) {
          const line = el("div", { style: { fontSize: `${Math.max(14, 19 * scale)}px` } },
            block.recognized!);
          box.append(line);
        }
        if (block.recognized) {
          box.title = block.recognized;
          box.style.cursor = "pointer";
          box.addEventListener("click", () => void this.correctText(loaded, block));
        }
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

  /**
   * Transcription de la page entiere, editable au clavier.
   *
   * L'encre reste intacte dessous : on corrige le texte sans jamais toucher
   * a ce qui a ete ecrit a la main.
   */
  private renderPageTranscript(
    loaded: LoadedPage, block: InkBlock, scale: number,
  ): HTMLElement | null {
    if (this.renderMode !== "clean") {
      if (!block.pending) return null;
      const wait = el("div", { class: "block-box math pending" },
        el("span", { class: "tag" },
          this.host.recognitionReady() ? "conversion en cours" : "cles MyScript manquantes"));
      Object.assign(wait.style, { left: "12px", top: "8px", width: "auto", minHeight: "0" });
      return wait;
    }
    if (block.words?.length) return this.renderWords(loaded, block, scale);
    loaded.placed = undefined;
    // Premiere conversion en route : l'encre reste visible, rien a afficher.
    if (!block.recognized) {
      if (!block.pending || this.host.recognitionReady()) return null;
      const wait = el("div", { class: "block-box math pending" },
        el("span", { class: "tag" }, "cles MyScript manquantes"));
      Object.assign(wait.style, { left: "12px", top: "8px", width: "auto", minHeight: "0" });
      return wait;
    }

    const area = el("textarea", { class: "block-text-edit", rows: "3" });
    area.value = block.recognized ?? "";
    area.placeholder = "Conversion en cours...";
    const grow = () => {
      area.style.height = "auto";
      area.style.height = `${Math.max(60, area.scrollHeight)}px`;
    };
    area.addEventListener("input", () => {
      block.recognized = area.value;
      // A partir d'ici, la conversion automatique ne reprend plus la main.
      block.editedByHand = true;
      grow();
      this.queueSave(loaded);
    });
    queueMicrotask(grow);

    const box = el("div", { class: "block-box text" },
      el("span", { class: "tag" },
        block.pending ? "conversion en cours"
          : block.editedByHand ? "texte, corrige au clavier" : "texte converti"),
      area);
    Object.assign(box.style, {
      left: `${40 * scale}px`,
      top: `${40 * scale}px`,
      width: `${(PAGE_W - 80) * scale}px`,
      fontSize: `${Math.max(15, 19 * scale)}px`,
    });
    return box;
  }

  /**
   * Mots tapes poses a la place de l'encre (facon Scribble). La couche ne
   * capte aucun pointeur : le stylet ecrit a travers, la gomme efface le mot
   * en frottant dessus, le doigt le corrige (watchWordTaps).
   */
  private renderWords(loaded: LoadedPage, block: InkBlock, scale: number): HTMLElement {
    // Couleur du mot = celle de son ecriture, jamais d'un surlignage pose dessus.
    const pens = new Map(block.strokes.filter((st) => st.tool === "pen")
      .map((st) => [st.id, colorOf(st.color, st.tool)]));
    const placed = layoutWords(block.words!, measurer());
    loaded.placed = placed;
    const layer = el("div", { class: "word-layer" });
    // Inline : la regle ".overlay > *" rendrait la couche cliquable et
    // bloquerait le stylet.
    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    for (const p of placed) {
      const span = el("span", { class: `typed-word${p.word.edited ? " edited" : ""}` }, p.word.label);
      Object.assign(span.style, {
        left: `${p.x * scale}px`,
        top: `${p.y * scale}px`,
        fontSize: `${p.fontSize * scale}px`,
        lineHeight: String(LINE_HEIGHT),
        fontFamily: WORD_FONT,
        color: p.word.strokeIds.map((id) => pens.get(id)).find(Boolean) ?? "#16181d",
      });
      layer.append(span);
    }
    if (block.pending && !this.host.recognitionReady()) {
      const wait = el("div", { class: "block-box math pending" },
        el("span", { class: "tag" }, "cles MyScript manquantes"));
      Object.assign(wait.style, { left: "12px", top: "8px", width: "auto", minHeight: "0" });
      layer.append(wait);
    }
    return layer;
  }

  /**
   * Correction en un geste sur un mot. C'est la ou elle sert le plus : le
   * francais d'un cours technique fait trebucher le moteur sur les accents,
   * les apostrophes et les termes anglais.
   */
  private async correctText(loaded: LoadedPage, block: InkBlock): Promise<void> {
    const options = (block.candidates ?? []).map((c) => ({ value: c, label: c }));
    options.push({ value: EDIT_SENTINEL, label: "Corriger a la main..." });
    const choice = await pick(
      options.length > 1 ? "Autres lectures possibles" : "Corriger le texte",
      options,
    );
    if (choice === null) return;
    if (choice === EDIT_SENTINEL) {
      const next = await askText("Corriger le texte", "Texte reconnu", block.recognized ?? "");
      if (next === null) return;
      if (block.recognized && block.recognized !== next) {
        block.candidates = [
          ...(block.candidates ?? []).filter((c) => c !== next), block.recognized,
        ];
      }
      block.recognized = next;
    } else {
      const previous = block.recognized;
      block.candidates = [
        ...(block.candidates ?? []).filter((c) => c !== choice),
        ...(previous && previous !== choice ? [previous] : []),
      ];
      block.recognized = choice;
    }
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
    const pageH = loaded.surface?.height ?? PAGE_H;
    return bottom > 0 ? Math.min(bottom + 24, pageH - 140) : defaultY;
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
    dataUrl: string, width: number, _height: number, ocr: string | null,
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
    // Posee dans le texte, au curseur : le texte passe au-dessus et en
    // dessous, comme une image dans Word.
    loaded.page.blocks.push({
      // Une petite image n'est pas etiree.
      id, type: "image", src, ocr, width: Math.max(120, Math.min(PAGE_W - 128, 640, width)),
    });
    loaded.doc.insertImage(id);
    this.fitSheet(loaded);
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

  /**
   * Toute renumerotation part d'un disque a jour : si une page n'a pas pu
   * etre ecrite, on ne decale rien, sinon elle atterrirait sur sa voisine.
   */
  private async readyToRenumber(what: string): Promise<boolean> {
    await this.flush();
    if (!this.hasUnsaved) return true;
    toast(`Une page n'est pas encore enregistrée : ${what} annulée pour ne rien écraser. `
      + "Réessaie dans un instant.", "err", 6000);
    return false;
  }

  /** En defilement, ramene a l'ecran la page courante apres un nouveau rendu. */
  private revealCurrent(): void {
    if (this.viewMode !== "scroll") return;
    this.list.find((p) => p.number === this.current)?.wrap.scrollIntoView({ block: "start" });
  }

  /** Decale les numeros des pages en memoire (affichees ou en file d'ecriture). */
  private shiftNumbers(from: number, delta: number): void {
    const all = new Set<LoadedPage>([...this.list, ...this.pendingSave.values()]);
    for (const p of all) if (p.number >= from) p.number += delta;
  }

  async newPage(insertHere = false): Promise<void> {
    if (!(await this.readyToRenumber(insertHere ? "insertion" : "création"))) return;
    const at = insertHere ? this.current + 1 : undefined;
    const n = await this.serial(async () => {
      const made = await this.host.repo.createPage(this.notebook, this.divider, at);
      this.shiftNumbers(made, +1);
      return made;
    });
    this.current = n;
    await this.render();
    this.revealCurrent();
    this.host.onDirty();
  }

  /**
   * La page part a la corbeille (ESEO/.corbeille), jamais effacee. En
   * defilement, c'est la page en vue qui est visee : la confirmation la nomme.
   */
  async deleteCurrentPage(): Promise<void> {
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    if (nums.length <= 1) { toast("Un intercalaire garde au moins une page", "warn"); return; }
    // La page courante, meme illisible (pas de repli sur une autre page).
    const n = this.current;
    const ok = await confirmDialog(
      "Supprimer la page",
      `La page ${n} de ${this.divider} part à la corbeille et les suivantes sont renumérotées. `
        + "Le bouton « Annuler » du message qui suit la remet en place.",
      "Supprimer",
    );
    if (!ok) return;
    if (!(await this.readyToRenumber("suppression"))) return;
    let entry: TrashEntry;
    try {
      entry = await this.serial(async () => {
        const made = await this.host.repo.deletePage(this.notebook, this.divider, n);
        for (const p of this.list.filter((x) => x.number === n)) {
          // Plus rien ne doit s'ecrire sous ce numero, qui est maintenant
          // celui de la page suivante.
          p.dead = true;
          p.number = 0;
          this.pendingSave.delete(p.page.id);
          this.history.drop(p.page.id);
        }
        this.shiftNumbers(n + 1, -1);
        return made;
      });
    } catch (e) {
      toast(`Suppression impossible : ${errorText(e)}`, "err", 6000);
      await this.render();
      return;
    }
    this.current = Math.max(1, n - 1);
    await this.render();
    this.revealCurrent();
    this.host.onDirty();
    this.host.onTrashed(entry);
  }

  /** « Annuler » apres une suppression : la page revient a son numero. */
  async restorePage(entry: TrashEntry): Promise<void> {
    if (!(await this.readyToRenumber("restauration"))) return;
    let n: number;
    try {
      n = await this.serial(async () => {
        const at = await this.host.repo.restorePage(entry);
        this.shiftNumbers(at, +1);
        return at;
      });
    } catch (e) {
      toast(`Restauration impossible : ${errorText(e)}. La page reste dans ESEO/.corbeille.`, "err", 8000);
      return;
    }
    this.current = n;
    await this.render();
    this.revealCurrent();
    this.host.onDirty();
    toast(`Page ${n} restaurée`);
  }

  async setViewMode(mode: ViewMode): Promise<void> {
    this.viewMode = mode;
    await this.host.repo.setViewMode(this.notebook, this.divider, mode);
    await this.render();
    if (mode === "scroll") {
      this.list.find((p) => p.number === this.current)?.wrap.scrollIntoView({ block: "start" });
    }
  }

  /**
   * Export PDF de tout l'intercalaire. Passe par l'impression du WebView2 :
   * la boite de dialogue propose « Enregistrer au format PDF ». Les pages
   * sont posees seules sur une feuille A4 le temps de l'impression, puis la
   * vue revient exactement ou elle etait.
   */
  async exportPdf(): Promise<void> {
    const prevMode = this.viewMode;
    const prevPage = this.current;
    const parent = this.root.parentElement;
    const nextSibling = this.root.nextSibling;
    const prevTitle = document.title;
    const host = el("div", { class: "print-host" });
    document.body.append(host);
    // Poser la vue hors ecran AVANT le rendu : les feuilles se calent
    // directement sur la largeur A4 (sinon elles gardent la hauteur de
    // l'ecran et debordent sur une seconde feuille).
    host.append(this.root);
    this.viewMode = "scroll";
    await this.render();
    // Passer en media print change la largeur de la vue : sans cela les
    // feuilles se recalculent a 900 px au milieu de l'impression.
    this.resizeObserver.disconnect();
    // Les photos doivent etre chargees avant l'apercu, sinon trous blancs.
    await Promise.all([...this.root.querySelectorAll("img")].map((img) =>
      img.decode().catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Hauteur utile d'une A4 a 96 dpi : 297 mm moins 10 mm en haut et une
    // marge de securite en bas. Au-dela, la page est reduite pour tenir.
    const usable = 1000;
    for (const p of this.list) {
      const h = p.wrap.offsetHeight;
      if (h > usable) p.wrap.style.zoom = String(usable / h);
    }
    document.title = `${this.notebook} - ${this.divider}`;
    document.body.classList.add("printing");
    const done = new Promise<void>((r) => window.addEventListener("afterprint", () => r(), { once: true }));
    window.print();
    await done;
    document.body.classList.remove("printing");
    this.resizeObserver.observe(this.root);
    document.title = prevTitle;
    parent?.insertBefore(this.root, nextSibling);
    host.remove();
    this.viewMode = prevMode;
    this.current = prevPage;
    await this.render();
    if (prevMode === "scroll") {
      this.list.find((p) => p.number === prevPage)?.wrap.scrollIntoView({ block: "start" });
    }
  }

  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    for (const p of this.list) {
      this.paintStrokes(p);
      this.paintOverlay(p);
    }
  }

  /** Va a un bloc precis, apres une recherche ou un lien. */
  async focusBlock(pageNumber: number, blockId: string): Promise<void> {
    await this.goTo(pageNumber);
    const loaded = this.list.find((p) => p.number === pageNumber);
    if (!loaded) return;
    const block = loaded.page.blocks.find((b) => b.id === blockId);
    if (block?.type === "image" && !block.rect && loaded.doc.revealImage(blockId)) return;
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
    this.history.push(loaded.page.id, JSON.stringify(loaded.page.blocks));
    this.lastEditedId = loaded.page.id;
  }

  undo(): void { this.step("undo"); }
  redo(): void { this.step("redo"); }

  /**
   * Page visee par Ctrl+Z. En mode pages, celle qu'on voit. En defilement,
   * la derniere modifiee tant qu'elle est a l'ecran, sinon celle en vue.
   */
  private undoTarget(): LoadedPage | undefined {
    if (this.viewMode === "scroll" && this.lastEditedId) {
      const p = this.list.find((x) => x.page.id === this.lastEditedId);
      if (p) {
        const r = p.wrap.getBoundingClientRect(), v = this.root.getBoundingClientRect();
        if (r.bottom > v.top && r.top < v.bottom) return p;
      }
    }
    return this.activePage();
  }

  private step(dir: "undo" | "redo"): void {
    const loaded = this.undoTarget();
    if (!loaded) return;
    const id = loaded.page.id;
    // L'etat courant n'est serialise que si l'entree est un instantane.
    const current = () => JSON.stringify(loaded.page.blocks);
    const entry = dir === "undo" ? this.history.undo(id, current) : this.history.redo(id, current);
    if (entry === null) {
      toast(dir === "undo" ? "Rien à annuler sur cette page" : "Rien à rétablir sur cette page", "info", 1800);
      return;
    }
    this.lastEditedId = id;
    if (typeof entry === "string") {
      loaded.page.blocks = restoreBlocks(loaded.page.blocks, JSON.parse(entry) as Block[]);
    } else {
      loaded.page.blocks = applyStrokeCommand(loaded.page.blocks, entry, dir);
      if (dir === "redo") growForStroke(loaded.page, entry.stroke);
      // Annuler le trait qui avait allonge la feuille la rend a sa taille.
      else shrinkToInk(loaded.page);
      // Un trait remis repart a la conversion, comme a son premier lever.
      if (dir === "redo" && entry.stroke.tool === "pen" && this.host.autoConvert()) {
        queueMicrotask(() => this.scheduleAutoConvert(loaded));
      }
    }
    this.fitSheet(loaded);
    this.paintStrokes(loaded);
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  /* ---------------- ecriture disque groupee ---------------- */

  /** File unique des acces disque de la vue (ecritures, renumerotations). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.io.then(fn, fn);
    this.io = run.catch(() => undefined);
    return run;
  }

  /**
   * Ecriture groupee, pas a chaque trait (section 9). Un trait qui declenche
   * une ecriture disque, c'est la batterie qui part en fumee et OneDrive qui
   * synchronise en boucle.
   */
  private queueSave(loaded: LoadedPage): void {
    if (loaded.dead) return;
    this.pendingSave.set(loaded.page.id, loaded);
    this.host.onDirty();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 1200);
  }

  /**
   * Ecrit la file. Chaque page part sous son numero DU MOMENT. Un echec
   * (OneDrive ou l'antivirus tient le fichier) garde la page en file et
   * relance un essai 3 s plus tard, sans attendre le prochain trait.
   */
  flush(): Promise<void> {
    return this.serial(async () => {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      const pending = [...this.pendingSave.values()];
      if (!pending.length) return;
      this.pendingSave.clear();
      let error: string | null = null;
      for (const p of pending) {
        try {
          await this.host.repo.writePage(this.notebook, this.divider, p.number, p.page);
        } catch (e) {
          error = errorText(e);
          if (!this.pendingSave.has(p.page.id)) this.pendingSave.set(p.page.id, p);
        }
      }
      const before = this.saveError;
      this.saveError = error;
      if (error) {
        if (!before) toast(`Écriture impossible : ${error}. Nouvel essai dans 3 s.`, "err", 6000);
        if (!this.saveTimer) this.saveTimer = setTimeout(() => void this.flush(), 3000);
      } else if (before) {
        toast("Enregistrement rétabli");
      }
      this.host.onDirty();
    });
  }

  get hasUnsaved(): boolean { return this.pendingSave.size > 0; }

  /** Message de la derniere ecriture en echec, null si tout est sur le disque. */
  get unsavedError(): string | null { return this.hasUnsaved ? this.saveError : null; }
}

/** Range le resultat la ou le bloc l'attend : LaTeX pour math, texte pour l'encre. */
function applyToBlock(block: Block, result: RecoResult): void {
  if (block.type === "math") {
    block.latex = result.value;
    block.candidates = result.candidates.length ? result.candidates : undefined;
    block.pending = false;
  } else if (block.type === "ink" && !block.rect && result.words) {
    // Mot a mot. Un trait gomme pendant l'aller-retour reseau ne doit pas
    // ressusciter dans un mot : on ne garde que les traits encore la.
    const alive = new Set(block.strokes.map((st) => st.id));
    const gone = new Set(result.words.flatMap((w) => w.strokeIds).filter((id) => !alive.has(id)));
    block.words = dropStrokes(carryEdits(block.words, result.words), gone);
    block.recognized = joinWords(block.words) || null;
    block.candidates = undefined;
    block.pending = false;
  } else if (block.type === "ink") {
    block.recognized = result.value;
    block.candidates = result.candidates.length ? result.candidates : undefined;
    block.pending = false;
  }
}

/** Police des mots tapes. La meme sert a les mesurer et a les afficher. */
const WORD_FONT = '"Segoe UI", system-ui, sans-serif';

let measureCtx: CanvasRenderingContext2D | null = null;
/** Largeur d'un texte tape, dans l'unite de la taille de police donnee. */
function measurer(): (text: string, fontSize: number) => number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx;
  return (text, fontSize) => {
    if (!ctx) return text.length * fontSize * 0.5;
    ctx.font = `${fontSize}px ${WORD_FONT}`;
    return ctx.measureText(text).width;
  };
}

/** Valeur reservee du menu de correction, jamais un LaTeX valide. */
const EDIT_SENTINEL = "\u0000corriger-a-la-main";

/* ---------------- utilitaires ---------------- */

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
