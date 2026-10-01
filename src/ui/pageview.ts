import { el, askText, toast, confirmDialog, pick } from "./dom";
import { InkSurface, PAGE_W, PAGE_H } from "./canvas";
import { renderTex } from "./tex";
import type { Bounds } from "../core/ink/stroke";
import { cachedBounds, strokeBounds, unionBounds } from "../core/ink/stroke";
import { growForStroke, sheetHeight, shrinkToInk } from "../core/ink/sheet";
import type {
  Block, ImageBlock, InkBlock, InkColor, MathBlock, Page, Stroke, TextBlock, ToolKind,
} from "../core/types";
import { isFutureVersion } from "../core/types";
import { dayLabel } from "../core/nav";
import { uuid, nowIso } from "../core/id";
import type { ConflictCopy, Repo, TrashEntry } from "../core/storage/repo";
import { mergeInk } from "../core/sync";
import {
  convertedStrokeIds, dropStrokes, joinWords, layoutWords,
  LINE_HEIGHT, type PlacedWord,
} from "../core/ink/words";
import { blockKey, isPending, type BlockRef } from "../core/ink/recokey";
import { confusionCandidates } from "../core/ink/confusions";
import { askLatex } from "./mathdialog";
import { colorOf } from "../core/palette";
import { TextDoc } from "./textdoc";
import { absorbTextBoxes } from "../core/text/doc";
import { flagContext, fold, parseQuery } from "../core/text/find";
import { DEFAULT_FLAG_NOTE } from "../core/storage/search";
import { PageHistory, applyStrokeCommand, restoreBlocks } from "../core/history";
import { planPrint, type Span } from "../core/print";
import type { ImportResult } from "./image-import";
import { FINAL_MAX, JPEG_QUALITY, fitRatio, unreadableMessage } from "../core/image/photo";

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
  /**
   * Demande la reconnaissance d'un bloc math ou texte manuscrit, apres la
   * pause d'ecriture. `auto` = conversion au fil de la plume (pause plus
   * longue, D14).
   */
  requestRecognition: (key: string, kind: "math" | "text", strokes: Stroke[], auto?: boolean) => void;
  /**
   * Remet en file un bloc reste « en attente » (page rouverte apres une
   * fermeture de l'appli, cles saisies), sans pause ni message. Ne fait
   * rien si ce bloc attend deja ou part en ce moment.
   */
  resumeRecognition: (key: string, kind: "math" | "text", strokes: Stroke[]) => void;
  /** Retire la demande en attente d'un bloc. Vrai s'il y en avait une. */
  cancelRecognition: (key: string) => boolean;
  onDirty: () => void;
  /** La page en vue a change (navigation, defilement, ajout, suppression). */
  onPageChange?: (n: number, total: number) => void;
  openLink: (target: string) => void;
  /** Une page vient de partir a la corbeille : l'appli propose « Annuler ». */
  onTrashed: (entry: TrashEntry) => void;
  /**
   * La page vue a change : l'appli la retient sur cette machine (D8),
   * jamais dans cahier.json.
   */
  rememberPage?: (notebook: string, divider: string, n: number) => void;
  /** Une copie de conflit OneDrive est partie ou revenue : pastilles a refaire. */
  onConflictsChanged?: () => void;
  /** OCR de la plateforme (Windows), pour une image collee ou deposee. */
  ocr?: (dataUrl: string) => Promise<string>;
}

/**
 * Bandeau en tete de la vue. `lock` = lecture seule (cahier ouvert sur
 * l'autre PC) : rien n'est ecrit, ni page ni renumerotation. `warn` = simple
 * avertissement, l'ecriture continue.
 */
export interface ViewNotice {
  kind: "lock" | "warn";
  text: string;
  actions?: { label: string; run: () => void }[];
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
  /**
   * Ce qu'on a fait en dernier sur la page, et ou : le repere « pas
   * compris » se pose a la hauteur du curseur ou du dernier trait.
   */
  lastEdit?: "text" | "ink";
  lastInk?: Bounds;
  /**
   * Lecture seule : page ecrite par une version plus recente de l'appli
   * (elle perdrait ce que cette version ne connait pas), vue verrouillee
   * (cahier ouvert sur l'autre PC), ou copie de conflit montree. Affichee,
   * jamais reenregistree.
   */
  readOnly?: boolean;
  /** Copie de conflit OneDrive montree a la place de la page (nom du fichier). */
  copy?: string;
  /** Bandeaux de la page (version future, copies de conflit). */
  notes: HTMLElement;
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
  /** Nombre de pages de l'intercalaire, lu au dernier rendu. */
  private total = 0;
  /** Annulation par page, par id : un numero change a chaque suppression. */
  private history = new PageHistory();
  /** Derniere page modifiee, que suit Ctrl+Z en mode defilement. */
  private lastEditedId: string | null = null;
  /**
   * Page du dernier geste, texte ou trait (LoadedPage.lastEdit) : en
   * defilement, le repere « pas compris » y va, meme si une autre page
   * occupe le haut de l'ecran.
   */
  private lastGestureId: string | null = null;
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
  /**
   * Defilement de la vue, garde quand elle quitte l'ecran : le menu, un
   * autre onglet ou le split la detachent, et un element detache perd son
   * scrollTop. Ctrl+M aller-retour ramenait en haut de l'intercalaire.
   */
  private savedScroll = 0;
  /** A refaire des que la vue est de nouveau a l'ecran et mise en page. */
  private restore: { top: number } | { page: number } | null = null;
  private attachedOnce = false;
  /** Avertissement « lecture seule » deja donne. */
  private warnedReadOnly = false;
  /** Bandeau de la vue (presence sur l'autre PC) ; `lock` = lecture seule. */
  private notice: ViewNotice | null = null;
  /** Bandeaux de la vue : presence, copies de conflit sans page. */
  private viewNotes = el("div", { class: "view-notes" });
  /** Copies de conflit OneDrive de l'intercalaire, lues a chaque rendu. */
  private conflicts: ConflictCopy[] = [];
  /** Copie montree seule, en lecture seule (« Voir la copie »). */
  private peek: ConflictCopy | null = null;
  /** Copies dont l'encre a deja ete reprise pendant la seance. */
  private merged = new Set<string>();

  constructor(
    private host: PageViewHost,
    public notebook: string,
    public divider: string,
  ) {
    this.root = el("div", { class: "pages" });
    // Detachee, la vue mesure 0 : on ne remet pas les feuilles a 280 px, elles
    // retrouvent leur largeur au rattachement (et le defilement avec elles).
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.root.isConnected) return;
      this.relayout();
      this.applyRestore();
    });
    this.resizeObserver.observe(this.root);
    // Pose une seule fois : un ecouteur par rendu s'accumulait.
    this.root.addEventListener("scroll", throttle(() => this.onScroll(), 250));
    this.root.addEventListener("scroll", () => {
      if (this.root.isConnected && !this.restore) this.savedScroll = this.root.scrollTop;
    }, { passive: true });
  }

  get pageNumber(): number { return this.current; }
  get pageCount(): number { return this.total; }
  get mode(): ViewMode { return this.viewMode; }
  get rendering(): RenderMode { return this.renderMode; }
  /** Vue verrouillee : rien n'est ecrit (cahier ouvert sur l'autre PC). */
  get readOnly(): boolean { return this.notice?.kind === "lock"; }
  /** Copies de conflit vues au dernier rendu. */
  get conflictCount(): number { return this.conflicts.length; }

  /**
   * Pose ou retire le bandeau de la vue. Passer en lecture seule ecrit
   * d'abord ce qui attend (c'etait du travail fait avant) ; si une page
   * reste refusee par le disque, la vue reste en ecriture (faux rendu).
   */
  async setNotice(notice: ViewNotice | null): Promise<boolean> {
    const was = this.readOnly;
    if (notice?.kind === "lock" && !was) {
      await this.flush();
      if (this.hasUnsaved) {
        toast("Lecture seule impossible pour l'instant : une page attend encore d'être écrite", "err", 6000);
        return false;
      }
    }
    this.notice = notice;
    this.warnedReadOnly = false;
    if (was !== this.readOnly && this.list.length) await this.render();
    else this.paintViewNotes();
    return true;
  }

  /**
   * `startPage` : la page ou l'on etait dans CET intercalaire (l'appli la
   * tient, voir core/position.ts) ; la premiere sinon.
   */
  async load(startPage?: number): Promise<void> {
    const meta = await this.host.repo.readMeta(this.notebook);
    this.viewMode = meta.viewMode?.[this.divider] ?? "pages";
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    if (nums.length === 0) {
      // Dossier range en sous-dossiers (E3A/S1/Chapitre 1) : aucune page n'y
      // est creee d'office, elle polluait le vrai rangement (D4, palier 1).
      if (this.readOnly || (await this.host.repo.listSubfolders(this.notebook, this.divider)).length) {
        this.current = 0;
        await this.render();
        return;
      }
      await this.host.repo.createPage(this.notebook, this.divider);
      nums.push(1);
    }
    this.current = clamp(startPage ?? 1, 1, nums[nums.length - 1]);
    await this.render();
  }

  /**
   * La vue vient d'etre posee a l'ecran (ouverture, retour du menu, autre
   * onglet, split). Elle reprend son defilement ; la premiere fois, en
   * defilement, elle va a la page ou l'on etait.
   */
  attached(): void {
    if (!this.attachedOnce) {
      this.attachedOnce = true;
      if (!this.restore && this.viewMode === "scroll" && this.current > 1) this.restore = { page: this.current };
    } else if (!this.restore) {
      this.restore = { top: this.savedScroll };
    }
    // Filet : sans changement de taille, le ResizeObserver ne repasse pas.
    requestAnimationFrame(() => requestAnimationFrame(() => this.applyRestore()));
  }

  private applyRestore(): void {
    const r = this.restore;
    if (!r || !this.root.isConnected || !this.root.clientWidth) return;
    this.restore = null;
    if ("page" in r) {
      const p = this.list.find((x) => x.number === r.page);
      if (p) this.root.scrollTop += p.wrap.getBoundingClientRect().top - this.root.getBoundingClientRect().top;
    } else {
      this.root.scrollTop = r.top;
    }
    this.savedScroll = this.root.scrollTop;
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
    this.conflicts = await this.host.repo.listConflicts(this.notebook, this.divider);
    if (gen !== this.renderGen) return;
    this.total = nums.length;
    this.paintViewNotes();
    this.root.append(this.viewNotes);
    if (this.peek) {
      const c = this.conflicts.find((x) => x.file === this.peek!.file);
      if (c) { await this.renderPeek(c, gen); return; }
      this.peek = null;
    }
    if (!nums.length) {
      // Aucune page (dossier range en sous-dossiers) : on le dit, sans rien creer.
      this.current = 0;
      const subs = await this.host.repo.listSubfolders(this.notebook, this.divider);
      if (gen !== this.renderGen) return;
      this.host.onPageChange?.(0, 0);
      this.root.append(this.folderSheet(subs));
      return;
    }
    this.host.onPageChange?.(this.current, this.total);
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
        if (this.viewMode === "scroll" && this.root.childElementCount > 1) {
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
      if (this.viewMode === "scroll" && this.root.childElementCount > 1) {
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
      // Une page tronquee peut avoir une copie OneDrive intacte : elle se voit ici.
      el("div", { class: "page-notes" }, ...this.conflictNotes(n)),
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

  /**
   * A la place des pages d'un intercalaire qui n'a que des sous-dossiers :
   * ce qu'il contient, et de quoi y ecrire quand meme.
   */
  private folderSheet(subs: string[]): HTMLElement {
    return el("div", { class: "page-wrap folder-wrap" },
      el("div", { class: "sheet folder-sheet" },
        el("h2", {}, subs.length ? "Dossier rangé en sous-dossiers" : "Aucune page"),
        subs.length
          ? el("p", {}, `${this.divider} contient ${subs.length > 1 ? `${subs.length} sous-dossiers` : "un sous-dossier"}. `
              + "Cahiers ne lit pas encore les sous-dossiers, et n'y crée aucune page d'office : ton rangement reste intact.")
          : el("p", {}, "Cet intercalaire est vide."),
        subs.length ? el("ul", { class: "folder-list" }, ...subs.map((d) => el("li", {}, d))) : null,
        el("div", { class: "unreadable-actions" },
          el("button", { class: "primary", onclick: () => void this.newPage() }, "Nouvelle page ici"),
          this.host.repo.canReveal
            ? el("button", {
                onclick: () => void this.host.repo.revealDir(this.notebook, this.divider)
                  .catch((e) => toast(`Dossier introuvable : ${errorText(e)}`, "err", 6000)),
              }, "Ouvrir le dossier")
            : null,
        ),
      ),
    );
  }

  /* ---------------- bandeaux : lecture seule et copies de conflit ---------------- */

  /**
   * Bandeaux de la vue : presence sur l'autre PC (lecture seule ou simple
   * avertissement), puis les copies de conflit sans page sous leur numero.
   */
  private paintViewNotes(): void {
    const items: HTMLElement[] = [];
    const n = this.notice;
    if (n) {
      items.push(el("div", { class: `readonly-note view-lock${n.kind === "warn" ? " warn" : ""}` },
        el("span", {}, n.text),
        ...(n.actions ?? []).map((a) => el("button", { class: "small", onclick: () => a.run() }, a.label)),
      ));
    }
    if (!this.peek) {
      for (const c of this.conflicts.filter((x) => x.orphan)) {
        items.push(el("div", { class: "readonly-note conflict-note" },
          el("span", {}, `Copie OneDrive sans page, venue de ${c.label} : `, el("code", {}, c.file),
            ". Sa page n'existe plus ici (supprimée ou renumérotée sur l'autre PC)."),
          el("button", { class: "small", onclick: () => void this.showCopy(c) }, "Voir la copie"),
          el("button", { class: "small", onclick: () => void this.adoptCopy(c) }, "En faire une page"),
          el("button", { class: "small", onclick: () => void this.trashCopy(c) }, "Supprimer la copie"),
        ));
      }
    }
    this.viewNotes.replaceChildren(...items);
    this.viewNotes.hidden = items.length === 0;
  }

  /** Bandeaux d'une page : version future, copies de conflit. */
  private paintNotes(loaded: LoadedPage): void {
    const items: HTMLElement[] = [];
    if (isFutureVersion(loaded.page)) {
      items.push(el("div", { class: "readonly-note" },
        "Page créée par une version plus récente de Cahiers : lecture seule. "
          + "Mets l'application à jour sur ce PC pour la modifier."));
    }
    if (loaded.copy) {
      const c = this.conflicts.find((x) => x.file === loaded.copy);
      if (c) items.push(this.peekNote(c));
    } else {
      items.push(...this.conflictNotes(loaded.number));
    }
    loaded.notes.replaceChildren(...items);
  }

  /**
   * « Autre version de cette page » : une ligne par copie de conflit
   * OneDrive. Rien n'est jamais supprime sans un appui ici.
   */
  private conflictNotes(n: number): HTMLElement[] {
    return this.conflicts.filter((c) => c.page === n && !c.orphan).map((c) =>
      el("div", { class: "readonly-note conflict-note" },
        el("span", {}, this.merged.has(c.file)
          ? `Encre de la copie venue de ${c.label} reprise sur cette page. La copie reste là tant que tu ne la supprimes pas.`
          : `Autre version de cette page, venue de ${c.label} (copie OneDrive `, this.merged.has(c.file) ? null : el("code", {}, c.file),
          this.merged.has(c.file) ? null : ")."),
        el("button", { class: "small", onclick: () => void this.showCopy(c) }, "Voir la copie"),
        el("button", { class: "small", onclick: () => void this.mergeCopy(c) }, "Fusionner l'encre"),
        el("button", { class: "small", onclick: () => void this.trashCopy(c) }, "Supprimer la copie"),
      ));
  }

  /** Bandeau de la copie montree seule. */
  private peekNote(c: ConflictCopy): HTMLElement {
    return el("div", { class: "readonly-note conflict-note" },
      el("span", {}, `Copie venue de ${c.label}, en lecture seule : `, el("code", {}, c.file), "."),
      el("button", { class: "small primary", onclick: () => void this.leavePeek() },
        c.orphan ? "Revenir aux pages" : "Revenir à ma page"),
      c.orphan
        ? el("button", { class: "small", onclick: () => void this.adoptCopy(c) }, "En faire une page")
        : el("button", { class: "small", onclick: () => void this.mergeCopy(c) }, "Fusionner l'encre"),
      el("button", { class: "small", onclick: () => void this.trashCopy(c) }, "Supprimer la copie"),
    );
  }

  /** Rendu de la copie seule, a la place des pages, jamais ecrite. */
  private async renderPeek(c: ConflictCopy, gen: number): Promise<void> {
    let page: Page;
    try {
      page = await this.host.repo.readConflict(this.notebook, this.divider, c.file);
    } catch (e) {
      if (gen !== this.renderGen) return;
      this.peek = null;
      toast(`Copie illisible : ${errorText(e)}`, "err", 6000);
      await this.render();
      return;
    }
    if (gen !== this.renderGen) return;
    const loaded = this.buildPage(c.page, page, c);
    this.list.push(loaded);
    this.root.append(loaded.wrap);
    this.relayout();
    this.root.scrollTop = 0;
  }

  /** « Voir la copie » : la copie seule, en lecture seule. */
  private async showCopy(c: ConflictCopy): Promise<void> {
    this.peek = c;
    await this.render();
  }

  private async leavePeek(): Promise<void> {
    const c = this.peek;
    this.peek = null;
    if (c && !c.orphan && c.page !== this.current) await this.goTo(c.page);
    else await this.render();
  }

  /**
   * « Fusionner l'encre » : les traits de la copie absents de la page la
   * rejoignent (par id, core/sync.ts). Annulable par Ctrl+Z. La copie
   * reste sur le disque : la supprimer est un autre appui.
   */
  private async mergeCopy(c: ConflictCopy): Promise<void> {
    if (this.locked()) return;
    if (this.peek || this.current !== c.page) {
      this.peek = null;
      this.current = c.page;
      await this.render();
    }
    const loaded = this.list.find((p) => p.number === c.page && !p.copy && !p.dead);
    if (!loaded) { toast("Page introuvable : fusion impossible", "err", 6000); return; }
    if (loaded.readOnly) { toast("Page en lecture seule : fusion impossible ici", "warn", 6000); return; }
    let other: Page;
    try {
      other = await this.host.repo.readConflict(this.notebook, this.divider, c.file);
    } catch (e) {
      toast(`Copie illisible : ${errorText(e)}`, "err", 6000);
      return;
    }
    const r = mergeInk(loaded.page, other);
    const text = r.textDiffers ? " Le texte tapé diffère : il n'est pas fusionné, regarde la copie." : "";
    if (!r.added) {
      toast(`Rien à reprendre : toute l'encre de la copie est déjà sur la page.${text}`, "info", 7000);
      return;
    }
    this.pushUndo(loaded);
    loaded.page.blocks = r.blocks;
    if (r.height != null) loaded.page.height = r.height;
    this.merged.add(c.file);
    this.fitSheet(loaded);
    this.paintStrokes(loaded);
    this.paintOverlay(loaded);
    this.paintNotes(loaded);
    this.queueSave(loaded);
    this.resumePending(loaded);
    await this.flush();
    toast(`${r.added} trait${r.added > 1 ? "s" : ""} repris de la copie de ${c.label} (Ctrl+Z annule). `
      + `La copie reste là : supprime-la quand tu as vérifié.${text}`, "info", 9000);
  }

  /** « Supprimer la copie » : a la corbeille, jamais effacee, « Annuler » la remet. */
  private async trashCopy(c: ConflictCopy): Promise<void> {
    if (this.locked()) return;
    const ok = await confirmDialog(
      "Supprimer la copie",
      `La copie venue de ${c.label} (${c.file}) part à la corbeille (dossier ESEO/.corbeille). `
        + (c.orphan ? "" : this.merged.has(c.file)
          ? "Son encre est déjà sur ta page. "
          : "Ta page n'est pas touchée : si la copie contient de l'encre à garder, fusionne-la d'abord. "),
      "Supprimer la copie",
    );
    if (!ok) return;
    let entry: TrashEntry;
    try {
      entry = await this.serial(() => this.host.repo.trashConflict(this.notebook, this.divider, c.file));
    } catch (e) {
      toast(`Suppression impossible : ${errorText(e)}`, "err", 6000);
      return;
    }
    if (this.peek?.file === c.file) this.peek = null;
    this.merged.delete(c.file);
    await this.render();
    this.host.onConflictsChanged?.();
    toast(`Copie venue de ${c.label} mise à la corbeille`, "info", 8000, {
      label: "Annuler",
      run: () => void this.serial(() => this.host.repo.restoreConflict(entry))
        .then(() => this.render(), (e) => toast(`Restauration impossible : ${errorText(e)}`, "err", 6000))
        .then(() => this.host.onConflictsChanged?.()),
    });
  }

  /** Copie sans page : elle devient une page normale, en fin d'intercalaire. */
  private async adoptCopy(c: ConflictCopy): Promise<void> {
    if (this.locked()) return;
    let n: number;
    try {
      n = await this.serial(() => this.host.repo.adoptConflict(this.notebook, this.divider, c.file));
    } catch (e) {
      toast(`Impossible : ${errorText(e)}`, "err", 6000);
      return;
    }
    this.peek = null;
    this.current = n;
    await this.render();
    this.revealCurrent();
    this.host.onConflictsChanged?.();
    this.host.onDirty();
    toast(`Copie venue de ${c.label} récupérée : page ${n}`);
  }

  private buildPage(n: number, page: Page, copy?: ConflictCopy): LoadedPage {
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
          original: !!b.original,
        };
      },
      recrop: (id) => void this.recropImage(loaded, id),
      resized: (id, width) => {
        const b = imageOf(id);
        if (!b) return;
        b.width = width;
        this.queueSave(loaded);
      },
      addFile: (file) => this.addImageFile(loaded, file),
    });
    const readOnly = isFutureVersion(page) || this.readOnly || !!copy;
    const sheet = el("div", { class: `sheet${readOnly ? " readonly" : ""}` }, canvas, doc.root, overlay);
    // Les numeros de page restent affiches dans les deux modes (section 5),
    // avec le jour de la page : « la demo du 3 octobre » se retrouve.
    const day = dayLabel(page.created);
    const notes = el("div", { class: "page-notes" });
    const wrap = el("div", { class: `page-wrap${copy ? " conflict-copy" : ""}`, dataset: { page: String(n) } },
      notes,
      sheet,
      el("div", { class: "page-num" }, copy
        ? `${this.divider} · copie de la p. ${n} venue de ${copy.label}`
        : `${this.divider} p. ${n}${day ? ` · ${day}` : ""}`),
    );

    const loaded: LoadedPage = {
      number: n, page, surface: null, wrap, overlay, sheet, doc, ro: null, readOnly, notes,
      ...(copy ? { copy: copy.file } : {}),
    };
    this.paintNotes(loaded);

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
    if (migrated && !readOnly) this.queueSave(loaded);
    if (!readOnly) this.resumePending(loaded);
    return loaded;
  }

  /**
   * Blocs restes « en attente » sur le disque (appli fermee hors ligne, cles
   * saisies apres coup) : ils repartent a l'ouverture de la page. La file
   * vit en memoire, sans cela ils attendaient a vie. Le fond de page ne
   * repart qu'en conversion au fil de la plume.
   */
  private resumePending(loaded: LoadedPage): void {
    for (const b of loaded.page.blocks) {
      if (!isPending(b) || (b.type !== "math" && b.type !== "ink")) continue;
      if (b.type === "ink" && !b.rect && !this.host.autoConvert()) continue;
      const strokes = b.strokes.filter((st) => st.tool === "pen");
      if (!strokes.length) continue;
      this.host.resumeRecognition(this.keyOf(loaded, b.id), kindOf(b), strokes);
    }
  }

  /** Remet en file les blocs en attente des pages affichees (cles saisies). */
  resumeAll(): void {
    for (const p of this.list) this.resumePending(p);
  }

  private keyOf(loaded: LoadedPage, blockId: string): string {
    return blockKey(this.notebook, this.divider, loaded.page.id, blockId);
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
    loaded.lastEdit = "text";
    this.lastGestureId = loaded.page.id;
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
      // Photo dans le texte : elle se selectionne, se deplace et se retaille
      // au stylet comme a la souris (TextDoc). Seul le doigt sur une photo
      // non selectionnee fait encore defiler la page.
      const fig = (e.target as Element).closest?.(".doc-img");
      if (fig) {
        if (e.pointerType === "touch" && !fig.classList.contains("selected")
            && this.host.touchRole() === "navigate" && !(e.target as Element).closest(".doc-img-bar, .doc-img-grip")) {
          loaded.surface?.forwardDown(e);
        }
        return;
      }
      const tool = this.host.getTool();
      const toInk = e.pointerType === "pen" || e.pointerType === "touch"
        || (e.pointerType === "mouse" && e.button === 0 && tool !== "pen");
      if (!toInk) { loaded.lastEdit = "text"; this.lastGestureId = loaded.page.id; return; }
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
  private fitSheet(loaded: LoadedPage, force = false, density?: number): void {
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
    if (force) loaded.surface?.layout(width, h, density);
    else loaded.surface?.fit(width, h);
  }

  /** Donne le clavier au texte de la page en cours. */
  focusText(): void {
    const p = this.activePage();
    if (p && !p.readOnly) p.doc.focus();
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
    options.push({ value: EDIT_SENTINEL, label: "Corriger à la main…" });
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
    // La lecture du moteur, gardee a la premiere correction : une nouvelle
    // lecture ne recoit la correction que si elle refait la meme erreur.
    if (!word.edited) word.misread = word.label;
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
    // Position de chaque page par rapport au haut de la vue. offsetTop se
    // mesurait depuis le body (la vue n'est pas positionnee) : les barres du
    // haut s'y ajoutaient et l'indicateur restait une page en retard.
    const top = this.root.getBoundingClientRect().top + 80;
    let best = this.list[0].number;
    for (const p of this.list) {
      if (p.wrap.getBoundingClientRect().top <= top) best = p.number;
    }
    if (best !== this.current) {
      this.current = best;
      this.host.rememberPage?.(this.notebook, this.divider, best);
      this.host.onDirty();
      this.host.onPageChange?.(best, this.total);
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
    loaded.lastEdit = "ink";
    loaded.lastInk = strokeBounds(stroke);
    this.lastGestureId = loaded.page.id;
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
    delete ink.recoError;
    this.paintOverlay(loaded);
    // Seule l'ecriture part chez MyScript : un surlignage la perturbe.
    this.host.requestRecognition(
      this.keyOf(loaded, ink.id),
      "text",
      ink.strokes.filter((s) => s.tool === "pen"),
      true,
    );
  }

  /** Relance la conversion de la page, meme apres une correction clavier. */
  reconvert(): void {
    const loaded = this.activePage();
    if (!loaded) return;
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return; }
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
    /** Un mot du fond de page a perdu une partie de son encre. */
    let amputated = false;
    for (const b of loaded.page.blocks) {
      if (b.type === "ink") {
        b.strokes = b.strokes.filter((s) => !set.has(s.id));
        if (b.words) {
          if (!b.rect) {
            amputated ||= b.words.some((w) => {
              const lost = w.strokeIds.filter((id) => set.has(id)).length;
              return lost > 0 && lost < w.strokeIds.length;
            });
          }
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
    // « courants » gomme en « courant » : le mot tape doit suivre. Sans
    // relecture, la recherche et l'export gardaient l'ancien mot.
    if (amputated && this.host.autoConvert()) this.scheduleAutoConvert(loaded);
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
    // Les mots lus dans ces traits (souvent absurdes : une integrale lue en
    // texte) partent avec eux, de l'affichage comme de la recherche.
    if (ink.words) {
      ink.words = dropStrokes(ink.words, ids);
      ink.recognized = joinWords(ink.words) || null;
    }
    // Une lecture du fond de page en attente porte encore ces traits : elle
    // repart sans eux. Celle deja partie les perdra a son retour (applyToBlock).
    if (this.host.cancelRecognition(this.keyOf(loaded, ink.id))) {
      if (this.host.autoConvert() && ink.strokes.some((s) => s.tool === "pen")) {
        this.scheduleAutoConvert(loaded);
      } else {
        ink.pending = false;
      }
    }
    this.paintStrokes(loaded);

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

    this.host.requestRecognition(this.keyOf(loaded, id), kind, inside);
  }

  /**
   * Un resultat de reconnaissance revient, eventuellement bien plus tard
   * (`change` le range dans le bloc : applyToBlock, markFailed). Applique
   * seulement si cette vue tient la page en memoire (affichee, ou quittee
   * mais pas encore ecrite) : sinon l'appli l'ecrit une seule fois sur le
   * disque. Faux si la page n'est pas ici.
   */
  applyChange(ref: BlockRef, change: (block: Block) => void): boolean {
    if (ref.notebook !== this.notebook || ref.divider !== this.divider) return false;
    // Le bloc est retrouve par son id : la page a pu changer de numero.
    const find = (p: LoadedPage) => p.page.blocks.find((b) => b.id === ref.blockId);
    // Une copie de conflit montree n'est jamais une cible : elle n'est pas ecrite.
    const live = this.list.filter((p) => !p.copy);
    const loaded = live.find((p) => p.page.id === ref.pageId && find(p))
      ?? live.find(find);
    if (loaded) {
      change(find(loaded)!);
      // Le rendu propre masque l'encre convertie : il faut redessiner.
      this.paintStrokes(loaded);
      this.paintOverlay(loaded);
      this.queueSave(loaded);
      return true;
    }
    // Page quittee mais pas encore ecrite : le resultat part avec elle.
    const waiting = [...this.pendingSave.values()].find(find);
    if (waiting) {
      change(find(waiting)!);
      return true;
    }
    return false;
  }

  /**
   * Fait passer un acces disque dans la file de cette vue : une ecriture de
   * l'appli sur une page de cet intercalaire ne croise jamais une
   * sauvegarde de la vue.
   */
  runIo<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(fn);
  }

  /** Relance un bloc refuse par la reconnaissance. */
  private retryRecognition(loaded: LoadedPage, block: MathBlock | InkBlock): void {
    const strokes = block.strokes.filter((st) => st.tool === "pen");
    if (!strokes.length) return;
    delete block.recoError;
    if (block.type === "ink" && !block.rect) { this.scheduleAutoConvert(loaded); return; }
    block.pending = true;
    this.paintOverlay(loaded);
    this.queueSave(loaded);
    this.host.requestRecognition(this.keyOf(loaded, block.id), kindOf(block), strokes);
  }

  /** Etiquette « non reconnu, réessayer » d'un bloc refuse. */
  private failTag(loaded: LoadedPage, block: MathBlock | InkBlock): HTMLElement {
    const tag = el("button", {
      class: "tag reco-fail",
      title: block.recoError ?? "",
      onclick: (e: Event) => { e.stopPropagation(); this.retryRecognition(loaded, block); },
    }, "non reconnu, réessayer");
    return tag;
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
        const failed = !block.pending && !!block.recoError;
        const box = el("div", {
          class: `block-box math${block.pending ? " pending" : ""}${clean ? " clean" : ""}${failed ? " failed" : ""}`,
        }, failed ? this.failTag(loaded, block) : el("span", { class: "tag" },
          block.pending
            ? (this.host.recognitionReady() ? "conversion en attente" : "clés MyScript manquantes")
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
        const said = block.context || block.note;
        const pin = el("button", { class: "flag-pin", title: said }, "?");
        pin.addEventListener("click", async () => {
          const done = await confirmDialog("Repère « pas compris »", said, "Marquer comme compris");
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
        const failed = !block.pending && !!block.recoError;
        const box = el("div", {
          class: `block-box math${block.pending ? " pending" : ""}${clean ? " clean" : ""}${failed ? " failed" : ""}`,
        }, failed ? this.failTag(loaded, block) : el("span", { class: "tag" },
          block.pending
            ? (this.host.recognitionReady() ? "conversion en attente" : "clés MyScript manquantes")
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
    // Lectures du moteur d'abord, puis les confusions classiques de
    // l'ecriture a la main (dx/dz, a/alpha...), chacune rendue en formule.
    const latex = block.latex ?? "";
    const values = [...new Set([...(block.candidates ?? []), ...confusionCandidates(latex)])]
      .filter((c) => c && c !== latex)
      .slice(0, 6);
    const options: { value: string; label: string | Node }[] =
      values.map((c) => ({ value: c, label: renderTex(c) }));
    options.push({ value: EDIT_SENTINEL, label: "Corriger à la main…" });
    const choice = await pick(
      options.length > 1 ? "Autres lectures possibles" : "Corriger la formule",
      options,
    );
    if (choice === null) return;
    if (choice === EDIT_SENTINEL) { await this.editLatex(loaded, block); return; }
    this.pushUndo(loaded);
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
    const failed = !block.pending && block.recoError ? this.transcriptFail(loaded, block) : null;
    if (this.renderMode !== "clean") {
      if (failed) return failed;
      if (!block.pending) return null;
      const wait = el("div", { class: "block-box math pending" },
        el("span", { class: "tag" },
          this.host.recognitionReady() ? "conversion en cours" : "clés MyScript manquantes"));
      Object.assign(wait.style, { left: "12px", top: "8px", width: "auto", minHeight: "0" });
      return wait;
    }
    if (block.words?.length) {
      const layer = this.renderWords(loaded, block, scale);
      if (failed) layer.append(failed);
      return layer;
    }
    loaded.placed = undefined;
    // Premiere conversion en route : l'encre reste visible, rien a afficher.
    if (!block.recognized) {
      if (failed) return failed;
      if (!block.pending || this.host.recognitionReady()) return null;
      const wait = el("div", { class: "block-box math pending" },
        el("span", { class: "tag" }, "clés MyScript manquantes"));
      Object.assign(wait.style, { left: "12px", top: "8px", width: "auto", minHeight: "0" });
      return wait;
    }

    const area = el("textarea", { class: "block-text-edit", rows: "3" });
    area.value = block.recognized ?? "";
    area.placeholder = "Conversion en cours…";
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
          : block.editedByHand ? "texte, corrigé au clavier" : "texte converti"),
      area);
    Object.assign(box.style, {
      left: `${40 * scale}px`,
      top: `${40 * scale}px`,
      width: `${(PAGE_W - 80) * scale}px`,
      fontSize: `${Math.max(15, 19 * scale)}px`,
    });
    return box;
  }

  /** Etiquette « non reconnu » du fond de page, en haut a gauche. */
  private transcriptFail(loaded: LoadedPage, block: InkBlock): HTMLElement {
    const box = el("div", { class: "block-box math failed" }, this.failTag(loaded, block));
    Object.assign(box.style, { left: "12px", top: "8px", width: "auto", minHeight: "0" });
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
        el("span", { class: "tag" }, "clés MyScript manquantes"));
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
    options.push({ value: EDIT_SENTINEL, label: "Corriger à la main…" });
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
    const next = await askLatex("Corriger la formule", block.latex ?? "");
    if (next === null || next === (block.latex ?? "")) return;
    this.pushUndo(loaded);
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

  addBlock(block: Block, loaded = this.activePage()): void {
    if (!loaded) return;
    if (loaded.readOnly) { this.warnReadOnly(); return; }
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
   * Il se pose a l'endroit exact (section 6) : a la hauteur du curseur, ou
   * du dernier trait si l'on ecrivait au stylet, et garde la ligne en
   * contexte pour que la vue « Pas compris » dise ce qui n'etait pas compris.
   */
  addFlag(): void {
    const loaded = this.flagTarget();
    if (!loaded) return;
    const spot = this.flagSpot(loaded);
    // La pastille fait 30 de large mais au moins 44 px de haut a l'ecran
    // (cible tactile) : centree sur la ligne, pas posee 15 unites au-dessus.
    const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    const half = Math.max(30, 44 / k) / 2;
    const bottom = (loaded.surface?.height ?? PAGE_H) - 2 * half - 4;
    const y = clamp(Math.round(spot ? spot.mid - half : 20 + this.openFlags(loaded).length * 40), 4, bottom);
    // Deux reperes sur la meme ligne : cote a cote, pas l'un sur l'autre.
    let x = PAGE_W - 62;
    while (x > 40 && this.openFlags(loaded).some((b) =>
      Math.abs(b.rect!.x - x) < 30 && Math.abs(b.rect!.y - y) < half * 2)) x -= 36;
    const id = uuid();
    this.addBlock({
      id, type: "flag", note: DEFAULT_FLAG_NOTE, rect: { x, y, w: 30, h: 30 },
      created: nowIso(), ...(spot?.context ? { context: spot.context } : {}),
    }, loaded);
    // Un seul message, mis a jour, meme apres trois appuis de suite. Un
    // repere pose par erreur s'enleve d'un appui, sans chercher la pastille.
    const burst = this.flagBurst?.page === loaded.page.id ? this.flagBurst : { page: loaded.page.id, ids: [] };
    burst.ids.push(id);
    if (burst.timer) clearTimeout(burst.timer);
    burst.timer = setTimeout(() => { if (this.flagBurst === burst) this.flagBurst = null; }, 5000);
    this.flagBurst = burst;
    const n = burst.ids.length;
    const what = spot?.context ? ` : « ${shorten(spot.context, 40)} »` : "";
    toast(n > 1 ? `${n} repères « pas compris » posés, p. ${loaded.number}`
      : `Repère « pas compris » posé, p. ${loaded.number}${what}`, "info", 5000,
      { label: "Annuler", run: () => {
        const last = burst.ids.pop();
        if (last) this.removeFlag(loaded.page.id, last);
        // Le message est parti : le prochain appui repart de un.
        if (this.flagBurst === burst) this.flagBurst = null;
      } }, "flag");
  }

  /**
   * Page du repere. En defilement, celle du dernier geste tant qu'elle est
   * a l'ecran : on tape souvent en bas d'une page alors que la precedente
   * occupe encore le haut de la vue (page « en vue »).
   */
  private flagTarget(): LoadedPage | undefined {
    if (this.viewMode === "scroll" && this.lastGestureId) {
      const p = this.list.find((x) => x.page.id === this.lastGestureId && !x.dead);
      if (p) {
        const r = p.wrap.getBoundingClientRect(), v = this.root.getBoundingClientRect();
        if (r.bottom > v.top && r.top < v.bottom) return p;
      }
    }
    return this.activePage();
  }

  /** Reperes encore ouverts d'une page, places dans la marge. */
  private openFlags(loaded: LoadedPage): Block[] {
    return loaded.page.blocks.filter((b) => b.type === "flag" && !b.resolved && !!b.rect);
  }

  /** Derniers reperes poses d'affilee, pour un seul message « Annuler ». */
  private flagBurst: { page: string; ids: string[]; timer?: ReturnType<typeof setTimeout> } | null = null;

  /**
   * Ou poser le repere (milieu de la ligne, unites de page) et quelle ligne
   * garder. Le curseur du texte si l'on tapait ; le dernier trait si l'on
   * ecrivait au stylet depuis ; sinon rien (haut de page, comme avant).
   */
  private flagSpot(loaded: LoadedPage): { mid: number; context: string } | null {
    const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    const sheet = loaded.sheet.getBoundingClientRect();
    // Le texte garde le clavier pendant qu'on ecrit au stylet : c'est le
    // dernier geste (frappe, clic dans le texte, ou trait) qui decide.
    const caret = loaded.lastEdit !== "ink" ? loaded.doc.caretSpot() : null;
    if (caret) {
      const mid = ((caret.top + caret.bottom) / 2 - sheet.top) / k;
      return { mid, context: flagContext(caret.before, caret.after) };
    }
    const ink = loaded.lastInk ?? this.lastStrokeBounds(loaded.page);
    if (!ink) return null;
    const mid = ink.y + ink.h / 2;
    return { mid, context: this.inkLine(loaded, ink, k, sheet) };
  }

  /** Le dernier trait de la page, a defaut d'un trait ecrit pendant la seance. */
  private lastStrokeBounds(page: Page): Bounds | null {
    // Le meme bloc que mainInk, sans en creer un.
    const ink = page.blocks.find((b): b is InkBlock => b.type === "ink");
    const last = ink?.strokes[ink.strokes.length - 1];
    return last ? strokeBounds(last) : null;
  }

  /**
   * Ce qui est ecrit a la hauteur d'un trait : les mots reconnus de cette
   * ligne, sinon le texte tape a cette hauteur. Vide si rien n'est lisible.
   */
  private inkLine(loaded: LoadedPage, ink: Bounds, k: number, sheet: DOMRect): string {
    const mid = ink.y + ink.h / 2;
    const ink0 = loaded.page.blocks.find((b): b is InkBlock => b.type === "ink");
    const words = ink0?.words ?? [];
    const line = words.filter((w) => w.box && w.box.y <= mid && w.box.y + w.box.h >= mid)
      .sort((a, b) => a.box!.x - b.box!.x).map((w) => w.label).join(" ").trim();
    if (line) return flagContext(line, "");
    // La couche des blocs gene le reperage du texte sous le point.
    loaded.overlay.style.display = "none";
    const typed = loaded.doc.textLineAt(sheet.left + 70 * k, sheet.top + mid * k);
    loaded.overlay.style.display = "";
    return typed ? flagContext(typed, "") : "";
  }

  /**
   * Marque un repere compris (ou de nouveau pas compris) depuis la vue
   * « Pas compris ». Si la page est en memoire ici (affichee, ou en attente
   * d'ecriture), c'est elle qui change et qui s'ecrit : une ecriture directe
   * sur le disque serait ecrasee par la prochaine sauvegarde de cette vue.
   * false si la vue n'a pas cette page.
   */
  async setFlagResolved(pageNumber: number, blockId: string, resolved: boolean): Promise<boolean> {
    const loaded = this.list.find((p) => p.number === pageNumber && !p.dead)
      ?? [...this.pendingSave.values()].find((p) => p.number === pageNumber);
    const block = loaded?.page.blocks.find((b) => b.id === blockId);
    // Page en lecture seule : rien a modifier ici (l'appli le dira en
    // tentant le disque, qui refuse aussi).
    if (!loaded || block?.type !== "flag" || loaded.readOnly) return false;
    if (resolved) block.resolved = true; else delete block.resolved;
    if (!loaded.dead) {
      this.paintOverlay(loaded);
      this.queueSave(loaded);
    }
    await this.flush();
    return true;
  }

  /** Retire un repere, sur la page qui le porte (meme si on a change de page). */
  private removeFlag(pageId: string, blockId: string): void {
    const loaded = this.list.find((p) => p.page.id === pageId && !p.dead);
    if (!loaded) {
      toast("Cette page n'est plus affichée : retire le repère depuis la page", "warn");
      return;
    }
    if (!loaded.page.blocks.some((b) => b.id === blockId)) return;
    this.pushUndo(loaded);
    const i = loaded.page.blocks.findIndex((b) => b.id === blockId);
    loaded.page.blocks.splice(i, 1);
    this.paintOverlay(loaded);
    this.queueSave(loaded);
  }

  /**
   * Insere une photo redressee : l'image et son original partent dans
   * assets/ (savePhoto, bon format : PNG en noir et blanc, JPEG en couleur).
   * Rend false si rien n'a ete pose (lecture seule, ecriture refusee) :
   * l'import de plusieurs photos s'arrete alors.
   */
  async addImageBlock(result: ImportResult): Promise<boolean> {
    const loaded = this.activePage();
    if (!loaded) return false;
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return false; }
    const id = uuid();
    const { savePhoto } = await import("./image-import");
    let fields;
    try {
      fields = await savePhoto(result, id, (name, url) => this.host.repo.writeAsset(this.notebook, this.divider, name, url));
    } catch (e) {
      toast(`Image non enregistrée : ${(e as Error).message}`, "err", 6000);
      return false;
    }
    // Posee dans le texte, au curseur : le texte passe au-dessus et en
    // dessous, comme une image dans Word.
    loaded.page.blocks.push({
      // Une petite image n'est pas etiree.
      id, type: "image", ...fields, width: Math.max(120, Math.min(PAGE_W - 128, 640, result.width)),
    });
    loaded.doc.insertImage(id);
    this.fitSheet(loaded);
    toast(result.ocr ? "Photo insérée, texte extrait pour la recherche" : "Photo insérée");
    return true;
  }

  /**
   * « Redresser a nouveau » (mini-barre de la photo) : le dialogue rouvre
   * l'original avec ses coins. La nouvelle image prend un nouveau nom,
   * l'ancienne reste dans assets/ : « Annuler » remet l'ancien bloc.
   */
  private async recropImage(loaded: LoadedPage, id: string): Promise<void> {
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return; }
    const block = loaded.page.blocks.find((b): b is ImageBlock => b.type === "image" && b.id === id);
    if (!block) return;
    const { recropPhoto, savePhoto } = await import("./image-import");
    const r = await recropPhoto(block, (src) => this.host.repo.readAsset(this.notebook, this.divider, src),
      this.host.ocr ? { ocr: this.host.ocr } : {});
    if (!r) return;
    let fields;
    try {
      fields = await savePhoto(r, uuid(), (name, url) => this.host.repo.writeAsset(this.notebook, this.divider, name, url),
        block.original);
    } catch (e) {
      toast(`Image non enregistrée : ${(e as Error).message}`, "err", 6000);
      return;
    }
    const before = { src: block.src, ocr: block.ocr, bw: block.bw, quad: block.quad, original: block.original };
    const apply = (f: typeof before) => {
      // La vue a pu etre rendue a nouveau : on vise la page en memoire.
      const now = this.list.find((p) => p.page.id === loaded.page.id) ?? loaded;
      const b = now.page.blocks.find((x): x is ImageBlock => x.type === "image" && x.id === id);
      if (!b || now.readOnly) return;
      b.src = f.src; b.ocr = f.ocr;
      if (f.bw === undefined) delete b.bw; else b.bw = f.bw;
      if (f.quad === undefined) delete b.quad; else b.quad = f.quad;
      if (f.original === undefined) delete b.original; else b.original = f.original;
      now.doc.refreshImage(id);
      this.queueSave(now);
    };
    apply({ src: fields.src, ocr: fields.ocr, bw: fields.bw, quad: fields.quad ?? before.quad, original: fields.original ?? before.original });
    toast("Photo redressée à nouveau", "info", 8000, { label: "Annuler", run: () => apply(before) });
  }

  /**
   * Image collee (capture Win+Maj+S) ou deposee depuis l'Explorateur :
   * enregistree telle quelle, sans recadrage ni noir et blanc (une capture
   * est deja droite). Le bloc est cree ici, TextDoc la pose dans le texte.
   * L'OCR part en fond et complete le bloc a son retour.
   */
  private async addImageFile(loaded: LoadedPage, file: File): Promise<string | null> {
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return null; }
    const label = file.name || "image collée";
    const dataUrl = await readAsDataUrl(file).catch(() => null);
    const img = dataUrl ? await loadImage(dataUrl) : null;
    if (!dataUrl || !img) {
      toast(unreadableMessage(label, file.type), "err", 9000);
      return null;
    }
    // Capture deja droite : ni recadrage ni noir et blanc. Elle passe par
    // savePhoto comme une photo en couleur (JPEG, 1600 px au plus) : un
    // seul format sur le disque, quel que soit le fichier depose (BMP, GIF).
    const k = fitRatio(img.naturalWidth, img.naturalHeight, FINAL_MAX);
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = el("canvas", { width: String(w), height: String(h) });
    const cx = c.getContext("2d")!;
    // Fond blanc : une capture a fond transparent sortirait noire en JPEG.
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, w, h);
    cx.drawImage(img, 0, 0, w, h);
    const jpeg = c.toDataURL("image/jpeg", JPEG_QUALITY);
    c.width = c.height = 0;
    const id = uuid();
    const { savePhoto } = await import("./image-import");
    let fields;
    try {
      fields = await savePhoto({
        dataUrl: jpeg, ext: "jpg", width: w, height: h, ocr: null, bw: false, original: null,
        quad: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
      }, id, (name, url) => this.host.repo.writeAsset(this.notebook, this.divider, name, url));
    } catch (e) {
      toast(`Image non enregistrée : ${(e as Error).message}`, "err", 6000);
      return null;
    }
    // Largeur a l'ecran (pixels physiques ramenes en px CSS ~ unites de
    // page) : une petite capture n'est pas etiree.
    const width = img.naturalWidth / (window.devicePixelRatio || 1);
    loaded.page.blocks.push({
      id, type: "image", ...fields, width: Math.round(Math.max(120, Math.min(PAGE_W - 128, 640, width))),
    });
    const pageId = loaded.page.id;
    const ocr = this.host.ocr;
    if (ocr) {
      void ocr(jpeg).then((text) => {
        const t = text.trim();
        if (!t) return;
        // La page a pu etre rendue a nouveau entre-temps : on vise celle en vue.
        const now = this.list.find((p) => p.page.id === pageId);
        const b = now?.page.blocks.find((x): x is ImageBlock => x.type === "image" && x.id === id);
        if (!now || !b || now.readOnly) return;
        b.ocr = t;
        now.doc.refreshImage(id);
        this.queueSave(now);
      }).catch(() => undefined);
    }
    toast("Image insérée");
    return id;
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

  /** `scroll` false : en defilement, l'appelant amene lui-meme la vue au bon endroit. */
  async goTo(n: number, scroll = true): Promise<void> {
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    if (!nums.includes(n)) return;
    // Aller a une page quitte la copie de conflit montree.
    if (this.peek) { this.peek = null; if (this.viewMode !== "pages") await this.render(); }
    this.current = n;
    this.host.rememberPage?.(this.notebook, this.divider, n);
    if (this.viewMode === "pages") {
      await this.render();
      // Une autre page : on la lit depuis le haut, meme hors de l'ecran.
      this.root.scrollTop = 0;
      this.savedScroll = 0;
      if (!this.root.isConnected) this.restore = { top: 0 };
    } else {
      // Vue detachee (menu, autre onglet) : elle ira a la page au rattachement.
      if (!this.root.isConnected) this.restore = { page: n };
      else if (scroll) this.list.find((p) => p.number === n)?.wrap.scrollIntoView({ behavior: "smooth", block: "start" });
      this.host.onPageChange?.(n, this.total);
    }
    this.host.onDirty();
  }

  async next(): Promise<void> {
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    const i = nums.indexOf(this.current);
    if (i >= 0 && i < nums.length - 1) await this.goTo(nums[i + 1]);
    else toast("Dernière page. Nouvelle page : Ctrl+N.", "info", 1800);
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
    if (this.locked()) return;
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
    if (this.locked()) return;
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
    if (this.locked()) return;
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
    // En lecture seule, le mode change ici sans toucher a cahier.json.
    if (!this.readOnly) await this.host.repo.setViewMode(this.notebook, this.divider, mode);
    await this.render();
    if (mode === "scroll") {
      this.list.find((p) => p.number === this.current)?.wrap.scrollIntoView({ block: "start" });
    }
  }

  /** Un export en cours : un second Ctrl+P ne relance pas l'impression. */
  private exporting = false;

  /**
   * Export PDF : la page courante (Ctrl+P) ou tout l'intercalaire
   * (Ctrl+Maj+P). Passe par l'impression du WebView2 : la boite de dialogue
   * propose « Enregistrer au format PDF ». Les pages sont posees seules sur
   * une feuille A4 le temps de l'impression, puis la vue revient exactement
   * ou elle etait.
   */
  async exportPdf(scope: "current" | "all" = "all"): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    const prevMode = this.viewMode;
    const prevPage = this.current;
    const parent = this.root.parentElement;
    const nextSibling = this.root.nextSibling;
    const prevTitle = document.title;
    const host = el("div", { class: "print-host" });
    document.body.append(host);
    /** Tranches d'encre a liberer apres l'impression. */
    const urls: string[] = [];
    try {
      await this.flush();
      // Poser la vue hors ecran AVANT le rendu : les feuilles se calent
      // directement sur la largeur A4 (sinon elles gardent la hauteur de
      // l'ecran et debordent sur une seconde feuille).
      host.append(this.root);
      // Mode pages = la page courante seule ; defilement = toutes.
      this.viewMode = scope === "current" ? "pages" : "scroll";
      await this.render();
      // Passer en media print change la largeur de la vue : sans cela les
      // feuilles se recalculent a 900 px au milieu de l'impression.
      this.resizeObserver.disconnect();
      // Les photos doivent etre chargees avant la mesure, sinon trous blancs
      // et hauteurs fausses (en Tauri, le src arrive apres l'IPC).
      await Promise.all(this.list.map((p) => p.doc.imagesReady()));
      await Promise.all([...this.root.querySelectorAll("img")].map((img) =>
        img.src ? img.decode().catch(() => undefined) : undefined));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (this.list.length > 3) toast("Préparation du PDF…", "info", 2000);
      // Chaque page devient une ou plusieurs feuilles A4 imprimees a part
      // (clones), l'encre rendue en densite 3 et decoupee par feuille.
      for (const p of this.list) {
        const sheets = await this.printSheets(p, urls);
        p.wrap.after(...sheets);
      }
      for (const p of this.list) p.wrap.classList.add("print-src");
      document.title = scope === "current"
        ? `${this.notebook} - ${this.divider} p. ${prevPage}`
        : `${this.notebook} - ${this.divider}`;
      document.body.classList.add("printing");
      const done = new Promise<void>((r) => window.addEventListener("afterprint", () => r(), { once: true }));
      window.print();
      await done;
    } finally {
      document.body.classList.remove("printing");
      this.resizeObserver.observe(this.root);
      document.title = prevTitle;
      parent?.insertBefore(this.root, nextSibling);
      host.remove();
      for (const u of urls) URL.revokeObjectURL(u);
      this.viewMode = prevMode;
      this.current = prevPage;
      this.exporting = false;
      await this.render();
      if (prevMode === "scroll") {
        this.list.find((p) => p.number === prevPage)?.wrap.scrollIntoView({ block: "start" });
      }
    }
  }

  /**
   * Feuilles A4 d'une page pour l'impression. La page est decoupee entre
   * deux lignes (core/print.ts) ; chaque feuille montre sa tranche : un
   * clone du texte et des blocs decale vers le haut, et la tranche d'encre
   * correspondante, rendue en densite 3 (traits nets a l'impression).
   */
  private async printSheets(p: LoadedPage, urls: string[]): Promise<HTMLElement[]> {
    this.fitSheet(p, true);
    const sheet = p.sheet;
    const H = sheet.offsetHeight;
    const numEl = p.wrap.querySelector<HTMLElement>(".page-num");
    const numH = numEl?.offsetHeight ?? 26;
    const label = numEl?.textContent ?? "";
    const top = sheet.getBoundingClientRect().top;
    const span = (r: DOMRect): Span => ({ top: r.top - top, bottom: r.bottom - top });
    const hard: Span[] = [];
    const walker = document.createTreeWalker(p.doc.root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.textContent ?? "").trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) hard.push(span(r));
    }
    p.doc.root.querySelectorAll(".eq, .doc-img").forEach((e) => hard.push(span(e.getBoundingClientRect())));
    for (const c of Array.from(p.overlay.children)) hard.push(span(c.getBoundingClientRect()));
    const k = (sheet.clientWidth || PAGE_W) / PAGE_W;
    const soft: Span[] = [];
    for (const b of p.page.blocks) {
      if (b.type !== "ink" && b.type !== "math") continue;
      for (const st of b.strokes) {
        const bb = cachedBounds(st, st.width);
        soft.push({ top: bb.y * k, bottom: (bb.y + bb.h) * k });
      }
    }
    const plan = planPrint(H, numH, hard, soft);

    // Encre en densite 3, le temps de copier les tranches, puis retour a
    // la densite de l'ecran (une page en densite 3 pese ~30 Mo).
    const canvas = sheet.querySelector("canvas");
    this.fitSheet(p, true, 3);
    const slices: Blob[] = [];
    if (canvas && canvas.height) {
      const ratio = canvas.height / H;
      const tmp = el("canvas");
      const ctx = tmp.getContext("2d")!;
      for (let i = 0; i + 1 < plan.cuts.length; i++) {
        const a = plan.cuts[i], b = plan.cuts[i + 1];
        tmp.width = canvas.width;
        tmp.height = Math.max(1, Math.round((b - a) * ratio));
        ctx.drawImage(canvas, 0, Math.round(a * ratio), canvas.width, tmp.height, 0, 0, tmp.width, tmp.height);
        const blob = await new Promise<Blob | null>((r) => tmp.toBlob(r, "image/png"));
        if (blob) slices.push(blob);
      }
      tmp.width = tmp.height = 0;
    }
    this.fitSheet(p, true);

    const n = plan.cuts.length - 1;
    const out: HTMLElement[] = [];
    for (let i = 0; i < n; i++) {
      const a = plan.cuts[i], b = plan.cuts[i + 1];
      const s = sheet.cloneNode(false) as HTMLElement;
      s.classList.add("print-slice-sheet");
      Object.assign(s.style, { height: `${b - a}px`, minHeight: "0" });
      const inner = el("div", {
        class: "print-inner",
        style: { position: "absolute", left: "0", top: `${-a}px`, width: "100%", height: `${H}px` },
      });
      if (slices[i]) {
        const url = URL.createObjectURL(slices[i]);
        urls.push(url);
        const ink = el("img", {
          class: "print-ink", alt: "",
          style: { position: "absolute", left: "0", top: `${a}px`, width: "100%", height: `${b - a}px` },
        });
        ink.src = url;
        await ink.decode().catch(() => undefined);
        inner.append(ink);
      }
      inner.append(cloneWithCanvases(p.doc.root), cloneWithCanvases(p.overlay));
      const wrap = el("div", { class: "page-wrap print-slice" }, s,
        el("div", { class: "page-num" }, n > 1 ? `${label} · ${i + 1}/${n}` : label));
      wrap.style.maxWidth = p.wrap.style.maxWidth;
      if (plan.zoom < 1) wrap.style.zoom = String(plan.zoom);
      s.append(inner);
      out.push(wrap);
    }
    return out;
  }

  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    for (const p of this.list) {
      this.paintStrokes(p);
      this.paintOverlay(p);
    }
  }

  /** Numeros des pages de l'intercalaire, tels que sur le disque. */
  async pageNumbers(): Promise<number[]> {
    return this.host.repo.listPageNumbers(this.notebook, this.divider);
  }

  /**
   * Va a un bloc precis, apres une recherche, un lien ou un repere.
   * `query` (la recherche tapee) : dans le texte de la page, le passage
   * trouve est amene a l'ecran et surligne, pas seulement le haut de page.
   */
  async focusBlock(pageNumber: number, blockId: string, query?: string): Promise<void> {
    await this.goTo(pageNumber, false);
    const loaded = this.list.find((p) => p.number === pageNumber);
    if (!loaded) return;
    // La page vient d'etre rendue ou rattachee : on mesure apres sa mise en
    // page. Deux images, car la largeur de la feuille n'est posee qu'apres la
    // premiere (ResizeObserver, voir relayout) ; mesure plus tot, le passage
    // trouve n'etait pas encore a sa place et restait hors de l'ecran.
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    const block = loaded.page.blocks.find((b) => b.id === blockId);
    const terms = query ? parseQuery(query).terms : [];
    if (block?.type === "image" && !block.rect && loaded.doc.revealImage(blockId)) return;
    if (block?.type === "text" && !block.rect && terms.length && loaded.doc.revealText(terms)) return;
    let rect = block?.rect;
    // Mot manuscrit reconnu : son cadre sur la page.
    if (!rect && block?.type === "ink" && terms.length) {
      rect = block.words?.find((w) => w.box && terms.some((t) => fold(w.label).text.includes(t)))?.box;
    }
    if (!rect) { loaded.wrap.scrollIntoView({ block: "center" }); return; }
    const scale = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    const marker = el("div", {
      class: "block-box",
      style: {
        left: `${(rect.x - 6) * scale}px`,
        top: `${(rect.y - 6) * scale}px`,
        width: `${(rect.w + 12) * scale}px`,
        height: `${(rect.h + 12) * scale}px`,
        border: "2px solid #2563eb",
        background: "rgba(37,99,235,.10)",
        pointerEvents: "none",
        zIndex: "3",
      },
    });
    // Sur la feuille, pas dans la couche des blocs : celle-ci est repeinte
    // a chaque mise en page (la vue qui se rattache), le cadre disparaissait.
    loaded.sheet.append(marker);
    // Le cadre lui-meme au centre : sur une page longue, le haut de la
    // feuille ne suffit pas.
    marker.scrollIntoView({ block: "center" });
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
    if (loaded.readOnly || this.readOnly) { this.warnReadOnly(); return; }
    this.pendingSave.set(loaded.page.id, loaded);
    this.host.onDirty();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 1200);
  }

  /** Une seule fois par vue : la page n'enregistre rien, le bandeau le dit deja. */
  private warnReadOnly(): void {
    if (this.warnedReadOnly) return;
    this.warnedReadOnly = true;
    toast(this.readOnly
      ? "Cahier en lecture seule (ouvert sur l'autre PC) : rien n'y est enregistré"
      : "Page en lecture seule : rien n'y est enregistré", "warn", 6000);
  }

  /** Vrai (et un message) si la vue est verrouillee : action refusee. */
  private locked(): boolean {
    if (!this.readOnly) return false;
    this.warnedReadOnly = false;
    this.warnReadOnly();
    return true;
  }

  /**
   * Ecrit la file. Chaque page part sous son numero DU MOMENT. Un echec
   * (OneDrive ou l'antivirus tient le fichier) garde la page en file et
   * relance un essai 3 s plus tard, sans attendre le prochain trait.
   */
  flush(): Promise<void> {
    return this.serial(async () => {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      // Lecture seule : rien ne part sur le disque (setNotice a tout ecrit avant).
      if (this.readOnly) return;
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

/** Moteur de reconnaissance d'un bloc : Math pour une zone math, Texte sinon. */
function kindOf(block: MathBlock | InkBlock): "math" | "text" {
  return block.type === "math" ? "math" : "text";
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

/** Texte coupe sur un mot pour tenir dans un message. */
function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut) + "…";
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

/** Clone statique pour l'impression : les canvas gardent leur dessin. */
function cloneWithCanvases(node: HTMLElement): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.removeAttribute("contenteditable");
  const from = node.querySelectorAll("canvas");
  const to = copy.querySelectorAll("canvas");
  from.forEach((c, i) => {
    const d = to[i];
    if (c.width && c.height) d.getContext("2d")?.drawImage(c, 0, 0);
  });
  copy.querySelectorAll(".doc-img-bar").forEach((b) => b.remove());
  copy.querySelectorAll(".selected").forEach((b) => b.classList.remove("selected"));
  return copy;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Image decodee, ou null si le navigateur ne sait pas la lire (HEIC). */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? img : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
