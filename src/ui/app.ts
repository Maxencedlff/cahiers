import { el, clear, toast, dismissToast, askText, askFields, confirmDialog, pick } from "./dom";
import { buildMenu, buildFlagsView, buildSearchView } from "./menu";
import { buildProbe } from "./probe";
import { PageView, type ViewMode, type RenderMode } from "./pageview";
import { buildMathBar, MATH_TEMPLATES } from "./mathbar";
import { insertMathTemplate, isEditingDoc, setAutoMath, setSpellcheck, setTypingColor } from "./textdoc";
import type { Calculator } from "./calculator/index";
import { PALETTE, NEUTRAL_INK, labelOf, shortcutOf } from "../core/palette";
import type { ColorKey, InkColor, ToolKind } from "../core/types";
import { uuid } from "../core/id";
import { Repo, safeName, type TrashEntry } from "../core/storage/repo";
import { searchAll, type FlagHit } from "../core/storage/search";
import type { FsAdapter } from "../core/storage/fs";
import {
  RecognitionQueue, SEND_DEBOUNCE_MS, AUTO_DEBOUNCE_MS, MyScriptBackend, NoBackend, testKeys,
  type RecognitionBackend, type QueueState, type RecoResult, type MyScriptKeys,
} from "../core/ink/recognizer";
import {
  applyToBlock, findBlockOnDisk, isPending, markFailed, parseBlockKey, updateBlockOnDisk,
  type BlockRef,
} from "../core/ink/recokey";
import {
  MONTHLY_QUOTA, bumpUsage, currentUsage, shouldWarn, usageLabel, type Usage,
} from "../core/ink/usage";
import type { Block, Stroke } from "../core/types";
import { loadSettings, saveSettings, type Settings } from "../core/settings";
import { ctrlCommand, isReloadKey, pageLabel, parsePageInput, titleOf, type Command } from "../core/shortcuts";
import { showShortcuts } from "./help";
import type { Presence } from "../platform";

type Screen = "menu" | "notebook" | "search" | "flags" | "probe";
type Tool = ToolKind | "region" | "textregion";

const isZone = (t: Tool): t is "region" | "textregion" => t === "region" || t === "textregion";

/**
 * Largeur minimale pour ancrer la calculatrice a droite. En dessous (le
 * portable fait 1280 px), elle flotte : la feuille garde sa largeur.
 */
const CALC_DOCK_MIN = 1400;

interface Tab {
  id: string;
  notebook: string;
  title: string;
  color: string;
  divider: string;
  view: PageView | null;
  host: HTMLElement;
}

/**
 * Application. Instance unique, donc onglets en haut : c'est la consequence
 * directe du verrou d'instance (section 5).
 */
export class App {
  private repo: Repo;
  private queue: RecognitionQueue;
  /** Chargee au premier appel : mathjs pese lourd et ne sert pas toujours. */
  private calculator: Calculator | null = null;
  private calculatorLoading: Promise<Calculator> | null = null;
  private settings: Settings;

  private screen: Screen = "menu";
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  /** Onglet affiche dans le panneau droit, quand le split est ouvert. */
  private splitId: string | null = null;
  /**
   * Vues quittees (autre intercalaire, onglet ferme) dont une ecriture a
   * echoue. Elles retentent toutes les 3 s ; gardees ici pour que la barre
   * d'etat et la fermeture de la fenetre les voient encore.
   */
  private orphans = new Set<PageView>();
  /**
   * Ecran d'ou l'on est venu a la recherche ou aux reperes : Echap et
   * « Retour » y ramenent, a la page ou l'on ecrivait plutot qu'au menu.
   */
  private auxFrom: "menu" | "notebook" = "menu";
  /** Derniere recherche tapee, reproposee au Ctrl+K suivant. */
  private lastQuery = "";

  private tool: Tool = "pen";
  /**
   * Outil a remettre apres une zone math ou texte : ces outils sont
   * ponctuels, sinon le trait suivant tracait une nouvelle zone et
   * l'ecriture etait perdue.
   */
  private prevTool: Tool = "pen";
  /** Zone verrouillee (Alt+Z deux fois) : on enchaine plusieurs zones. */
  private toolLocked = false;
  /** Couleur de l'encre ET du texte tape : une seule pastille active. */
  private color: InkColor = "normal";
  /** Couleur du texte tape ; null = noir, le texte normal. */
  private textColor: ColorKey | null = null;
  private width = 2.2;
  private sawPen = false;
  /** Ce que fait le doigt tant qu'aucun stylet n'a ete vu (section 3). */
  private touchWrites = true;
  private renderMode: RenderMode = "ink";
  /** Convertir l'ecriture au fil de la plume plutot qu'a la demande. */
  private autoConvert = false;

  private root = el("div", { class: "app" });
  private tabbar = el("div", { class: "tabbar" });
  private main = el("div", { class: "notebook", style: { flex: "1", minHeight: "0", display: "flex", flexDirection: "column" } });
  private statusbar = el("div", { class: "status" });
  private queueState: QueueState;
  /** Indicateur « p. 4 / 12 » de la colonne d'outils, mis a jour sur place. */
  private pageLabelEl: HTMLElement | null = null;
  /** Ou poser la calculatrice sur l'ecran cahier : colonne ou zone de travail. */
  private calcSlot: { side: HTMLElement; work: HTMLElement } | null = null;
  /** Envois a MyScript ce mois-ci, sur cette machine (quota, reco-3). */
  private usage: Usage = currentUsage(null, new Date());

  constructor(
    fs: FsAdapter,
    private rootLabel: string,
    private presence: Presence | null,
    private ocr: ((dataUrl: string) => Promise<string>) | null = null,
    private machineKeys: { applicationKey: string; hmacKey: string } | null = null,
    private saveKeys: ((a: string, h: string) => Promise<void>) | null = null,
  ) {
    this.repo = new Repo(fs);
    this.settings = loadSettings();
    // Une zone n'est jamais l'outil de depart : elle est ponctuelle.
    this.tool = isZone(this.settings.tool) ? "pen" : this.settings.tool;
    this.color = this.settings.color;
    // Stylet deja vu sur cette machine : le doigt navigue des le lancement,
    // il ne trace plus sur les notes en attendant le premier contact.
    this.sawPen = this.settings.penSeen;
    this.textColor = this.settings.textColor;
    setTypingColor(this.textColor);
    this.width = this.settings.width;
    this.autoConvert = this.settings.autoConvert;
    setAutoMath(this.settings.autoMath);
    setSpellcheck(this.settings.spellcheck);
    if (this.autoConvert) this.renderMode = "clean";

    // Les cles de la machine passent devant celles du navigateur : elles
    // survivent a un vidage du stockage local. Une fois la, la cle HMAC n'a
    // plus rien a faire en clair dans le stockage du navigateur.
    if (machineKeys?.applicationKey && this.settings.myscript.hmacKey) {
      this.settings.myscript = { applicationKey: "", hmacKey: "" };
      saveSettings(this.settings);
    }
    const active = machineKeys?.applicationKey ? machineKeys : this.settings.myscript;
    this.usage = currentUsage(readJson<Usage>(USAGE_KEY), new Date());

    this.queue = new RecognitionQueue(
      this.makeBackend(active),
      (key, result) => this.onRecognized(key, result),
      undefined,
      (key, message) => this.onRecoFailed(key, message),
    );
    this.queueState = this.queue.state();
    this.queue.subscribe((s) => { this.queueState = s; this.paintStatus(); });

    this.root.append(this.tabbar, this.main, this.statusbar);
    document.addEventListener("keydown", (e) => this.onKey(e));
    // Fenetre retaillee (moitie d'ecran, portable tourne) : la calculatrice
    // passe de la colonne a la fenetre flottante, ou l'inverse.
    let resizing: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener("resize", () => {
      clearTimeout(resizing);
      resizing = setTimeout(() => {
        if (this.calculator) this.placeCalculator(this.calculator);
      }, 200);
    });
    // Le premier stylet vu bascule l'application en separation stylet/doigt.
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "pen" && !this.sawPen) {
        this.sawPen = true;
        this.settings.penSeen = true;
        saveSettings(this.settings);
        this.paintToolbar();
        this.paintStatus();
        toast("Stylet détecté : le doigt sert maintenant à naviguer");
      }
    }, true);
    // Filet de securite seulement : beforeunload n'attend pas une ecriture.
    // La fermeture de la fenetre passe par main.ts (onCloseRequested).
    window.addEventListener("beforeunload", () => { void this.flushAll(); });
    // Fenetre reduite, PC mis en veille, session verrouillee : on ecrit tout
    // de suite plutot qu'au bout du delai.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flushAll();
    });
  }

  get element(): HTMLElement { return this.root; }

  /**
   * Un stylet detecte impose la separation : le doigt navigue, la paume ne
   * trace plus. Sans stylet, c'est l'utilisateur qui decide.
   */
  private touchRole(): "write" | "navigate" {
    if (this.sawPen) return "navigate";
    return this.touchWrites ? "write" : "navigate";
  }

  /** Charge la calculatrice a la demande, une seule fois. */
  private async loadCalculator(): Promise<Calculator> {
    if (this.calculator) return this.calculator;
    if (!this.calculatorLoading) {
      this.calculatorLoading = import("./calculator/index").then(({ Calculator }) => {
        this.calculator = new Calculator({
          canInsert: () => this.screen === "notebook" && !!this.activeTab()?.view,
          onVisibility: (visible) => {
            this.settings.calcOpen = visible;
            saveSettings(this.settings);
            // Flottante, elle ne reserve pas de colonne.
            this.main.querySelector(".side-calc")
              ?.classList.toggle("closed", !visible || !this.calculator?.isDocked);
          },
          insertGraph: (fn, domain) => {
            const view = this.activeTab()?.view;
            view?.addBlock({
              id: uuid(), type: "graph", fn, domain,
              rect: { x: 80, y: view.nextFreeY(560), w: 420, h: 200 },
            });
          },
          insertCalc: (expr, result) => {
            const view = this.activeTab()?.view;
            view?.addBlock({
              id: uuid(), type: "calc", expr, result,
              rect: { x: 80, y: view.nextFreeY(560), w: 420, h: 46 },
            });
          },
        });
        return this.calculator;
      });
    }
    return this.calculatorLoading;
  }

  private async toggleCalculator(): Promise<void> {
    const calc = await this.loadCalculator();
    this.placeCalculator(calc);
    calc.toggle();
  }

  /**
   * Pose la calculatrice sur l'ecran cahier : ancree a droite sur un grand
   * ecran, flottante sur le portable. Hors cahier, elle reste ou elle est.
   */
  private placeCalculator(calc: Calculator): void {
    const slot = this.calcSlot;
    if (this.screen !== "notebook" || !slot || !slot.side.isConnected) return;
    if (window.innerWidth >= CALC_DOCK_MIN) {
      if (!calc.isIn(slot.side)) calc.dock(slot.side);
    } else if (!calc.isIn(slot.work)) {
      calc.float(slot.work);
      // Ouverte, elle est ramenee dans l'ecran (show la recale).
      if (calc.isVisible) calc.show();
    }
    slot.side.classList.toggle("closed", !calc.isVisible || !calc.isDocked);
  }

  async start(): Promise<void> {
    await this.repo.ensureRootLayout();
    await this.showMenu();
    // Conversions laissees en route a la derniere fermeture : elles repartent
    // sans attendre qu'on rouvre leur page.
    void this.resumeSaved();
  }

  /* ---------------- ecrans ---------------- */

  private async showMenu(): Promise<void> {
    this.screen = "menu";
    await this.flushAll();
    clear(this.main);
    this.main.append(await buildMenu(this.menuHost()));
    this.paintTabs();
    this.paintStatus();
  }

  private menuHost() {
    return {
      repo: this.repo,
      rootLabel: this.rootLabel,
      openNotebook: (dir: string, divider?: string, page?: number) =>
        void this.openNotebook(dir, divider, page),
      openAt: (dir: string, divider: string, page: number, blockId: string, query?: string) =>
        void this.openAt(dir, divider, page, blockId, query),
      openSearch: () => void this.showSearch(),
      openFlags: (notebook?: string) => void this.showFlags(notebook),
      setFlagResolved: (f: FlagHit, resolved: boolean) => this.setFlagResolved(f, resolved),
      openProbe: () => this.showProbe(),
    };
  }

  /** Retient l'ecran de travail avant d'ouvrir la recherche ou les reperes. */
  private noteAuxFrom(): void {
    if (this.screen === "menu" || this.screen === "notebook") this.auxFrom = this.screen;
  }

  /** Echap ou « Retour » depuis la recherche ou les reperes. */
  private leaveAux(): void {
    if (this.auxFrom === "notebook" && this.tabs.length) void this.backToWork();
    else void this.showMenu();
  }

  private async showSearch(): Promise<void> {
    this.noteAuxFrom();
    // Lancee depuis un cahier : la recherche part dans cette matiere (on
    // peut l'elargir d'un appui).
    const tab = this.auxFrom === "notebook" ? this.activeTab() : undefined;
    this.screen = "search";
    await this.flushAll();
    clear(this.main);
    this.paintTabs();
    this.main.append(buildSearchView(
      this.menuHost(),
      () => this.leaveAux(),
      (q, opts) => searchAll(this.repo, q, opts),
      {
        initial: this.lastQuery,
        onQuery: (q) => { this.lastQuery = q; },
        notebook: tab ? { dir: tab.notebook, title: tab.title } : undefined,
      },
    ));
  }

  private async showFlags(notebook?: string): Promise<void> {
    this.noteAuxFrom();
    this.screen = "flags";
    // Les reperes poses a l'instant doivent etre sur le disque pour etre listes.
    await this.flushAll();
    clear(this.main);
    this.paintTabs();
    this.main.append(await buildFlagsView(this.menuHost(), () => this.leaveAux(), notebook));
  }

  /** Ouvre une page et va au bloc (resultat de recherche, repere). */
  private async openAt(dir: string, divider: string, page: number, blockId: string, query?: string): Promise<void> {
    await this.openNotebook(dir, divider, page);
    await this.activeTab()?.view?.focusBlock(page, blockId, query);
  }

  /**
   * Repere marque compris (ou rendu) depuis la liste. Une vue qui a cette
   * page en memoire la modifie elle-meme ; sinon on ecrit le fichier.
   */
  private async setFlagResolved(f: FlagHit, resolved: boolean): Promise<boolean> {
    const views = [...this.tabs.map((t) => t.view), ...this.orphans]
      .filter((v): v is PageView => !!v && v.notebook === f.notebook && v.divider === f.divider);
    try {
      for (const v of views) if (await v.setFlagResolved(f.page, f.blockId, resolved)) return true;
      const page = await this.repo.readPage(f.notebook, f.divider, f.page);
      const block = page.blocks.find((b) => b.id === f.blockId);
      if (block?.type !== "flag") {
        toast("Ce repère n'est plus sur sa page (pages renumérotées ?)", "warn");
        return false;
      }
      if (resolved) block.resolved = true; else delete block.resolved;
      await this.repo.writePage(f.notebook, f.divider, f.page, page);
      return true;
    } catch (e) {
      toast(`Repère non modifié : ${(e as Error).message}`, "err", 6000);
      return false;
    }
  }

  private showProbe(): void {
    this.screen = "probe";
    clear(this.main);
    this.main.append(buildProbe(() => void this.showMenu()));
  }

  /* ---------------- onglets ---------------- */

  private activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  async openNotebook(dir: string, divider?: string, page?: number): Promise<void> {
    const existing = this.tabs.find((t) => t.notebook === dir);
    const meta = await this.repo.readMeta(dir);
    const dividers = await this.repo.listDividers(dir);
    if (dividers.length === 0) dividers.push(await this.repo.createDivider(dir, "Cours"));
    const target = divider && dividers.includes(divider) ? divider : (meta.lastPosition?.divider ?? dividers[0]);

    if (existing) {
      this.activeId = existing.id;
      if (existing.divider !== target) {
        await this.switchDivider(existing, target, page);
      } else if (page) {
        await existing.view?.goTo(page);
      }
    } else {
      const tab: Tab = {
        id: uuid(), notebook: dir, title: meta.title, color: meta.color,
        divider: target, view: null,
        host: el("div", { class: "pane" }),
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      await this.mountView(tab, page);
    }
    this.screen = "notebook";
    await this.renderNotebookScreen();
  }

  private async mountView(tab: Tab, page?: number): Promise<void> {
    // La vue precedente finit d'ecrire AVANT que la suivante relise le disque.
    const old = tab.view;
    await old?.dispose();
    if (old?.hasUnsaved) this.orphans.add(old);
    const view = new PageView({
      repo: this.repo,
      recognitionReady: () => this.queueState.backendReady,
      autoConvert: () => this.autoConvert,
      getTool: () => this.tool,
      getColor: () => this.color,
      getWidth: () => this.width,
      touchRole: () => this.touchRole(),
      onRegionDone: () => this.restoreTool(),
      requestRecognition: (key, kind, strokes, auto) => this.enqueue(key, kind, strokes, auto),
      resumeRecognition: (key, kind, strokes) => this.resume(key, kind, strokes),
      cancelRecognition: (key) => this.cancelRecognition(key),
      onDirty: () => this.paintStatus(),
      // Seule la vue de l'onglet actif pilote l'indicateur de la colonne.
      onPageChange: (n, total) => {
        if (this.activeTab()?.view === view && this.pageLabelEl) {
          this.pageLabelEl.textContent = pageLabel(n, total);
        }
      },
      openLink: (target) => void this.followLink(target),
      onTrashed: (entry) => this.offerRestore(entry),
    }, tab.notebook, tab.divider);
    // Une vue quittee en echec sur ce meme intercalaire : la nouvelle reprend
    // sa file, pour qu'une seule vue ecrive ces pages.
    for (const o of [...this.orphans]) {
      if (o.notebook === tab.notebook && o.divider === tab.divider) {
        this.orphans.delete(o);
        await view.adopt(o);
      }
    }
    tab.view = view;
    view.setRenderMode(this.renderMode);
    await view.load(page);
  }

  private async switchDivider(tab: Tab, divider: string, page?: number): Promise<void> {
    await tab.view?.flush();
    tab.divider = divider;
    await this.mountView(tab, page);
    await this.repo.setLastPosition(tab.notebook, divider, tab.view?.pageNumber ?? 1);
  }

  private async closeTab(id: string): Promise<void> {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const view = this.tabs[i].view;
    await view?.flush();
    if (view?.hasUnsaved) {
      const close = await confirmDialog(
        "Modifications non enregistrées",
        `Une page n'a pas pu être écrite (${view.unsavedError ?? "erreur inconnue"}). `
          + "Fermer l'onglet maintenant la ferait perdre si l'écriture échoue encore.",
        "Fermer quand même",
      );
      if (!close) return;
    }
    await view?.dispose();
    // Fermer quand meme : la page continue d'etre retentee et reste signalee.
    if (view?.hasUnsaved) this.orphans.add(view);
    this.tabs.splice(i, 1);
    if (this.splitId === id) this.splitId = null;
    if (this.activeId === id) this.activeId = this.tabs[Math.max(0, i - 1)]?.id ?? null;
    if (!this.tabs.length) { await this.showMenu(); return; }
    await this.renderNotebookScreen();
  }

  private paintTabs(): void {
    this.tabbar.replaceChildren();
    this.tabbar.append(el("button", {
      class: "ghost",
      title: titleOf("Menu", "menu"),
      onclick: () => void this.showMenu(),
    }, "Menu"));

    for (const tab of this.tabs) {
      const node = el("div", {
        class: `tab${tab.id === this.activeId ? " active" : ""}`,
        draggable: "true",
      },
        el("span", { class: "dot", style: { background: tab.color } }),
        el("span", { class: "label" }, `${tab.title} · ${tab.divider}`),
        el("button", {
          class: "close",
          title: titleOf("Fermer l'onglet", "closeTab"),
          onclick: (e: Event) => { e.stopPropagation(); void this.closeTab(tab.id); },
        }, "✕"),
      );
      node.addEventListener("click", () => {
        this.activeId = tab.id;
        void this.renderNotebookScreen();
      });
      // Glisser un onglet sur la moitie droite ouvre le split (section 5).
      node.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", tab.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      this.tabbar.append(node);
    }

    this.tabbar.append(el("div", { class: "spacer" }));
    if (this.tabs.length) {
      this.tabbar.append(
        el("button", {
          class: this.splitId ? "on" : "",
          title: titleOf("Split gauche/droite", "split"),
          onclick: () => void this.toggleSplit(),
        }, "Split"),
      );
    }
    // Le menu a deja son propre bouton de recherche : deux au meme instant
    // font doublon a l'ecran.
    if (this.screen !== "menu") {
      this.tabbar.append(el("button", {
        title: titleOf("Recherche dans tous les cahiers", "search"),
        onclick: () => void this.showSearch(),
      }, "Rechercher"));
    }
    // Au doigt et au stylet, aucune infobulle : la fiche est a un appui.
    this.tabbar.append(el("button", {
      class: "ghost help-btn",
      title: "Raccourcis clavier (F1)",
      onclick: () => showShortcuts(),
    }, "?"));
  }

  /* ---------------- ecran cahier ---------------- */

  private async renderNotebookScreen(): Promise<void> {
    const tab = this.activeTab();
    if (!tab) { await this.showMenu(); return; }
    if (this.splitId === tab.id) this.splitId = null;
    this.screen = "notebook";
    this.paintTabs();

    clear(this.main);
    const dividers = await this.repo.listDividers(tab.notebook);
    // Outils a gauche, calculatrice a droite : la hauteur de l'ecran reste
    // a la feuille.
    const tools = this.buildToolbar();
    const calcSide = el("aside", { class: "side-calc closed" });
    const work = el("div", { class: "work" });
    this.main.append(this.buildDividerBar(tab, dividers), work);
    this.calcSlot = { side: calcSide, work };
    // Fermee par defaut (D6) : mathjs n'est charge qu'au premier Ctrl+L.
    if (this.settings.calcOpen || this.calculator) {
      void this.loadCalculator().then((calc) => {
        if (this.calcSlot?.side !== calcSide) return;
        this.placeCalculator(calc);
        if (this.settings.calcOpen && !calc.isVisible) calc.show();
      });
    }

    const panes = el("div", { class: "panes" });
    panes.append(this.buildPane(tab, false));
    if (this.splitId) {
      const other = this.tabs.find((t) => t.id === this.splitId);
      if (other) {
        if (!other.view) await this.mountView(other);
        panes.append(this.buildPane(other, true));
      } else {
        this.splitId = null;
      }
    }
    work.append(tools, panes, calcSide);
    this.paintStatus();

    if (tab.view) tab.host.append(tab.view.root);
    if (this.splitId) {
      const other = this.tabs.find((t) => t.id === this.splitId);
      if (other?.view) other.host.append(other.view.root);
    }
  }

  private buildPane(tab: Tab, isRight: boolean): HTMLElement {
    const pane = tab.host;
    pane.replaceChildren();
    pane.className = "pane";
    // Hors split, l'onglet et la bande d'intercalaires disent deja ou l'on
    // est : l'en-tete de panneau ne ferait que prendre de la hauteur.
    if (this.splitId) pane.append(el("div", { class: "pane-head" },
      el("span", { class: "dot", style: { background: tab.color, width: "9px", height: "9px", borderRadius: "50%" } }),
      el("strong", {}, tab.title),
      el("span", { class: "muted" }, tab.divider),
      el("div", { class: "spacer" }),
      isRight
        ? el("button", { class: "ghost", title: titleOf("Fermer le panneau droit", "closeSplit"), onclick: () => void this.closeSplit() }, "Fermer")
        : null,
      el("button", { class: "ghost", title: titleOf("Permuter les panneaux", "swap"), onclick: () => void this.swapPanes() }, "Permuter"),
    ));

    // Zone de depot : lacher un onglet ici ouvre le split.
    pane.addEventListener("dragover", (e) => {
      e.preventDefault();
      const r = pane.getBoundingClientRect();
      const onRightHalf = e.clientX > r.left + r.width / 2;
      pane.classList.toggle("drop-target", onRightHalf || isRight);
    });
    pane.addEventListener("dragleave", () => pane.classList.remove("drop-target"));
    pane.addEventListener("drop", (e) => {
      e.preventDefault();
      pane.classList.remove("drop-target");
      const id = e.dataTransfer?.getData("text/plain");
      if (!id) return;
      const r = pane.getBoundingClientRect();
      const onRightHalf = isRight || e.clientX > r.left + r.width / 2;
      if (onRightHalf && id !== this.activeId) {
        this.splitId = id;
        void this.renderNotebookScreen();
      } else if (!onRightHalf) {
        this.activeId = id;
        if (this.splitId === id) this.splitId = null;
        void this.renderNotebookScreen();
      }
    });
    return pane;
  }

  private buildDividerBar(tab: Tab, dividers: string[]): HTMLElement {
    const bar = el("div", { class: "dividers" });
    for (const d of dividers) {
      const node = el("button", {
        class: `divider-tab${d === tab.divider ? " active" : ""}`,
        onclick: () => void this.switchDividerAndRender(tab, d),
      }, d);
      node.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        const choice = await pick(d, [
          { value: "rename", label: "Renommer" },
          { value: "delete", label: "Supprimer l'intercalaire" },
        ]);
        if (choice === "rename") {
          const next = await askText("Renommer l'intercalaire", "Nouveau nom", d);
          if (next) await this.renameDivider(tab, d, next);
        } else if (choice === "delete") {
          const ok = await confirmDialog(
            "Supprimer l'intercalaire",
            `${d} et toutes ses pages partent à la corbeille (dossier ESEO/.corbeille). `
              + "Le bouton « Annuler » du message qui suit le remet en place.",
            "Supprimer",
          );
          if (ok) await this.deleteDivider(tab, d);
        }
      });
      bar.append(node);
    }
    bar.append(el("button", {
      class: "divider-tab",
      title: "Nouvel intercalaire",
      "aria-label": "Nouvel intercalaire",
      onclick: async () => {
        const name = await askText("Nouvel intercalaire", "Nom", "");
        if (!name) return;
        const d = await this.repo.createDivider(tab.notebook, name);
        await this.switchDividerAndRender(tab, d);
      },
    }, "+"));
    return bar;
  }

  /**
   * Renomme le dossier reel. Ce qui attend d'etre ecrit l'est d'abord, puis
   * la vue est remontee sur le nouveau nom : sinon la frappe suivante
   * recreait l'ancien dossier et y partait.
   */
  private async renameDivider(tab: Tab, d: string, next: string): Promise<void> {
    if (!(await this.settle(tab.notebook, d, "renommage annulé"))) return;
    let applied: string;
    try {
      applied = await this.repo.renameDivider(tab.notebook, d, next);
    } catch (e) {
      toast(`Renommage impossible : ${(e as Error).message}`, "err", 6000);
      return;
    }
    if (applied === d) {
      const wanted = safeName(next);
      if (wanted.startsWith(".") || wanted.toLowerCase() === "assets") toast("Ce nom est réservé", "warn");
      else if (wanted !== d) toast("Un intercalaire porte déjà ce nom", "warn");
      return;
    }
    if (tab.divider === d) {
      // Une ecriture tardive de l'ancienne vue va dans le nouveau dossier.
      if (tab.view) tab.view.divider = applied;
      tab.divider = applied;
      await this.mountView(tab, tab.view?.pageNumber);
    }
    await this.renderNotebookScreen();
  }

  /**
   * L'intercalaire part a la corbeille avec ce qu'on vient d'ecrire : la file
   * est videe sur le disque, puis abandonnee, pour qu'aucune ecriture
   * tardive ne recree le dossier.
   */
  private async deleteDivider(tab: Tab, d: string): Promise<void> {
    for (const v of this.holders(tab.notebook, d)) {
      await v.flush();
      v.discard();
    }
    let entry: TrashEntry;
    try {
      entry = await this.repo.deleteDivider(tab.notebook, d);
    } catch (e) {
      toast(`Suppression impossible : ${(e as Error).message}`, "err", 6000);
      return;
    }
    if (tab.divider === d) {
      const rest = await this.repo.listDividers(tab.notebook);
      tab.divider = rest[0] ?? await this.repo.createDivider(tab.notebook, "Cours");
      await this.mountView(tab);
    }
    await this.renderNotebookScreen();
    this.offerRestore(entry);
  }

  /** Message « Annuler » de 8 s apres une suppression (page ou intercalaire). */
  private offerRestore(entry: TrashEntry): void {
    const what = entry.page != null
      ? `Page ${entry.page} de ${entry.divider} mise à la corbeille`
      : `Intercalaire ${entry.divider} mis à la corbeille`;
    toast(what, "info", 8000, { label: "Annuler", run: () => void this.restore(entry) });
  }

  private async restore(entry: TrashEntry): Promise<void> {
    const tab = this.tabs.find((t) => t.notebook === entry.dir);
    if (entry.page != null) {
      // La vue de cet intercalaire tient des numeros de page : c'est elle
      // qui restaure, pour les decaler en meme temps que le disque.
      if (tab?.view && tab.divider === entry.divider) {
        await tab.view.restorePage(entry);
        this.paintToolbar();
        return;
      }
      // Une vue quittee en echec sur cet intercalaire tient des numeros :
      // on ne decale rien tant qu'elle n'a pas ecrit.
      if (!(await this.settle(entry.dir, entry.divider, "restauration annulée"))) return;
      try {
        const n = await this.repo.restorePage(entry);
        toast(`Page ${n} de ${entry.divider} restaurée`);
      } catch (e) {
        toast(`Restauration impossible : ${(e as Error).message}. La page reste dans ESEO/.corbeille.`, "err", 8000);
      }
      return;
    }
    let name: string;
    try {
      name = await this.repo.restoreDivider(entry);
    } catch (e) {
      toast(`Restauration impossible : ${(e as Error).message}. L'intercalaire reste dans ESEO/.corbeille.`, "err", 8000);
      return;
    }
    toast(`Intercalaire ${name} restauré`);
    if (tab && this.screen === "notebook") {
      await this.switchDivider(tab, name);
      await this.renderNotebookScreen();
    }
  }

  private async switchDividerAndRender(tab: Tab, d: string): Promise<void> {
    if (tab.divider === d) return;
    await this.switchDivider(tab, d);
    await this.renderNotebookScreen();
  }

  /**
   * Colonne d'outils. En haut, tout ce qui sert en direct et doit rester a
   * l'ecran du portable (1280x800) sans faire defiler la colonne : outils,
   * couleurs, epaisseur, annuler, pages et « Pas compris ». Dessous, le
   * ruban Maths, repliable. Les actions rares et les reglages vont dans le
   * menu « ⋯ ».
   */
  private buildToolbar(): HTMLElement {
    const bar = el("div", { class: "toolbar" });
    const view = () => this.activeTab()?.view;
    // Pas de focus sur ces boutons a la souris : la selection et le curseur
    // du texte restent, on continue de taper aussitot.
    const keep = <T extends HTMLElement>(b: T): T => {
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") e.preventDefault(); });
      return b;
    };

    const toolButton = (id: Tool, label: string, title: string) =>
      el("button", {
        class: `${this.tool === id ? "on" : ""}${this.tool === id && this.toolLocked ? " locked" : ""}`,
        title,
        onclick: () => this.selectTool(id),
      }, label);

    bar.append(
      toolButton("pen", "Stylo", "Écrire (Alt+E). La souris tape du texte."),
      toolButton("highlighter", "Surligneur", "Surligner (Alt+H)"),
      toolButton("eraser", "Gomme", "Effacer les traits touchés (Alt+G). Le bout gomme du stylet gomme aussi."),
      toolButton("region", "Zone math",
        "Entourer une formule manuscrite pour la convertir (Alt+Z). Une zone, puis retour au stylo ; "
          + "deux fois pour enchaîner plusieurs zones."),
      toolButton("textregion", "Zone texte",
        "Entourer du texte manuscrit pour le convertir (Alt+T). Une zone, puis retour au stylo ; "
          + "deux fois pour enchaîner plusieurs zones."),
    );
    // Sans stylet, ce que fait le doigt : a cote des outils, c'en est un.
    if (!this.sawPen) {
      bar.append(el("button", {
        class: this.touchWrites ? "on" : "",
        title: titleOf("Ce que fait le doigt, faute de stylet", "finger"),
        onclick: () => this.toggleFinger(),
      }, this.touchWrites ? "Doigt : écrit" : "Doigt : navigue"));
    }
    bar.append(el("div", { class: "sep" }));

    // Palette fermee a 5 couleurs a semantique fixe (section 8), plus
    // l'encre neutre noire. La couleur choisie vaut pour l'encre ET pour le
    // texte tape : une seule pastille active, sa legende en dessous.
    bar.append(keep(el("button", {
      class: `swatch${this.color === "normal" ? " on" : ""}`,
      title: "Normal, en noir (Alt+0) : encre et texte tapé",
      "aria-label": "Normal, en noir",
      onclick: () => this.pickColor(null),
    }, el("i", { style: { background: NEUTRAL_INK.ink } }))));
    for (const p of PALETTE) {
      bar.append(keep(el("button", {
        class: `swatch${this.color === p.key ? " on" : ""}`,
        title: `${p.label} (Alt+${p.shortcut}) : encre et texte tapé`,
        "aria-label": p.label,
        onclick: () => this.pickColor(p.key),
      }, el("i", { style: { background: p.ink } }))));
    }
    // Le sens de la couleur, a l'ecran : au doigt, aucune infobulle.
    bar.append(el("div", { class: "swatch-legend small muted" },
      `${labelOf(this.color)} · Alt+${shortcutOf(this.color)}`));

    // Trois epaisseurs sur une seule ligne.
    const widths: [string, number, string][] = [
      ["Fin", 1.4, "Trait fin"], ["Moyen", 2.2, "Trait moyen"], ["Épais", 3.6, "Trait épais"],
    ];
    bar.append(
      el("div", { class: "sep" }),
      el("div", { class: "seg widths" }, ...widths.map(([label, w, title]) => keep(el("button", {
        class: this.width === w ? "on" : "",
        title,
        "aria-pressed": String(this.width === w),
        onclick: () => { this.width = w; this.persist(); this.paintToolbar(); },
      }, label)))),
      el("div", { class: "sep" }),
      keep(el("button", { onclick: () => view()?.undo(), title: titleOf("Annuler", "undo") }, "Annuler")),
      keep(el("button", { onclick: () => view()?.redo(), title: titleOf("Rétablir", "redo") }, "Rétablir")),
      el("div", { class: "sep" }),
    );

    // Pages : ou l'on est, et un appui pour bouger. Un appui sur
    // l'indicateur = Ctrl+G.
    const v = view();
    this.pageLabelEl = el("button", {
      class: "page-label ghost",
      title: titleOf("Aller à la page", "goto"),
      onclick: () => void this.goToPrompt(),
    }, pageLabel(v?.pageNumber ?? 1, v?.pageCount ?? 0));
    bar.append(
      el("div", { class: "page-nav" },
        keep(el("button", { onclick: () => void view()?.prev(), title: titleOf("Page précédente", "prevPage"), "aria-label": "Page précédente" }, "◀")),
        this.pageLabelEl,
        keep(el("button", { onclick: () => void view()?.next(), title: titleOf("Page suivante", "nextPage"), "aria-label": "Page suivante" }, "▶")),
        keep(el("button", { onclick: () => void view()?.newPage(), title: titleOf("Nouvelle page à la fin", "newPage"), "aria-label": "Nouvelle page" }, "+")),
      ),
      // « Pas compris » : un appui, en plein cours (section 6).
      keep(el("button", {
        class: "flag-btn",
        title: titleOf("Pas compris : repère sur la page", "flag"),
        onclick: () => view()?.addFlag(),
      }, "Pas compris")),
      el("button", {
        class: "more-btn",
        title: "Plus : photo, export, affichage, réglages",
        "aria-label": "Plus d'actions",
        onclick: (e: Event) => this.openMoreMenu(e.currentTarget as HTMLElement),
      }, "⋯"),
    );

    // Ruban Maths, repliable ; l'etat est retenu sur cette machine.
    const mathOpen = this.settings.mathOpen;
    const maths = el("div", { class: "math-section" },
      el("button", {
        class: "section-toggle",
        "aria-expanded": String(mathOpen),
        title: mathOpen ? "Replier le ruban Maths" : "Déplier le ruban Maths",
        onclick: () => {
          this.settings.mathOpen = !this.settings.mathOpen;
          saveSettings(this.settings);
          this.paintToolbar();
        },
      }, el("span", {}, "Maths"), el("span", { class: "chevron" }, mathOpen ? "▾" : "▸")),
      mathOpen ? buildMathBar(() => this.activeTab()?.view?.activeDoc) : null,
    );

    // Outils a gauche : la hauteur de l'ecran reste a la feuille.
    return el("aside", { class: "side-tools" }, bar, maths);
  }

  /**
   * Menu « ⋯ » : actions rares et reglages, en controles a deux choix dont
   * l'actif est surligne (on voit l'etat, pas une action a deviner).
   */
  private openMoreMenu(anchor: HTMLElement): void {
    if (document.querySelector(".more-backdrop")) return;
    const panel = el("div", { class: "more-menu", role: "menu" });
    const backdrop = el("div", { class: "backdrop more-backdrop" }, panel);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    const close = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const view = () => this.activeTab()?.view;

    // Une action ferme le menu avant de s'executer : un dialogue qui suit
    // ne s'ouvre pas sous lui.
    const action = (label: string, title: string, run: () => void, cls = "") =>
      el("button", { class: `more-item ${cls}`.trim(), title, role: "menuitem", onclick: () => { close(); run(); } }, label);
    const segment = (name: string, title: string, options: [string, boolean, () => unknown][]) =>
      el("div", { class: "more-seg", title },
        el("span", { class: "small muted" }, name),
        el("div", { class: "seg" }, ...options.map(([label, on, run]) => el("button", {
          class: on ? "on" : "",
          "aria-pressed": String(on),
          onclick: async () => {
            if (on) return;
            await run();
            paint();
          },
        }, label))),
      );

    const paint = () => {
      const mode = view()?.mode ?? "pages";
      const calcShown = !!this.calculator?.isVisible;
      panel.replaceChildren(
        action("Photo du tableau", "Photo redressée et lue, posée dans le texte", () => void this.importImage()),
        action(calcShown ? "Fermer la calculatrice" : "Calculatrice", titleOf("Calculatrice", "calc"),
          () => void this.toggleCalculator()),
        action("Insérer une page ici", titleOf("Insérer une page après la page courante", "insertPage"),
          () => void view()?.newPage(true)),
        action("Aller à la page…", titleOf("Aller à la page", "goto"), () => void this.goToPrompt()),
        action("Exporter la page (PDF)", titleOf("La page courante, puis « Enregistrer au format PDF »", "exportPage"),
          () => void view()?.exportPdf("current")),
        action("Exporter l'intercalaire (PDF)", titleOf("Toutes les pages de l'intercalaire", "exportAll"),
          () => void view()?.exportPdf("all")),
        el("div", { class: "sep" }),
        segment("Affichage", "Une page à la fois, ou toutes les pages à la suite", [
          ["Pages", mode === "pages", () => this.setViewMode("pages")],
          ["Défilement", mode === "scroll", () => this.setViewMode("scroll")],
        ]),
        segment("Encre", "Montrer l'encre telle qu'écrite, ou le rendu converti", [
          ["Brute", this.renderMode === "ink", () => this.setRenderMode("ink")],
          ["Propre", this.renderMode === "clean", () => this.setRenderMode("clean")],
        ]),
        segment("Conversion de l'écriture", titleOf("Au fil de la plume, ou seulement les zones entourées", "convert"), [
          ["Auto", this.autoConvert, () => this.setAutoConvert(true)],
          ["Sur zone", !this.autoConvert, () => this.setAutoConvert(false)],
        ]),
        segment("Formules tapées", "Vs = Vz - Vbe, a/b, beta… mises en forme pendant la frappe", [
          ["Auto", this.settings.autoMath, () => this.setTypedMath(true)],
          ["Off", !this.settings.autoMath, () => this.setTypedMath(false)],
        ]),
        segment("Orthographe", "Souligner les fautes dans le texte tapé", [
          ["Oui", this.settings.spellcheck, () => this.setSpelling(true)],
          ["Non", !this.settings.spellcheck, () => this.setSpelling(false)],
        ]),
        el("div", { class: "sep" }),
        action("Raccourcis clavier", "Fiche des raccourcis (F1)", () => showShortcuts()),
        // En bas, loin des autres actions : un appui de travers au stylet
        // ne doit pas tomber dessus.
        el("div", { class: "sep" }),
        action("Supprimer la page", "La page part à la corbeille (ESEO/.corbeille), « Annuler » la remet en place",
          () => void view()?.deleteCurrentPage(), "danger"),
      );
      place();
    };
    // A droite du bouton, sans sortir de l'ecran.
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const col = anchor.closest(".side-tools")?.getBoundingClientRect();
      panel.style.left = `${Math.round((col?.right ?? r.right) + 6)}px`;
      const h = panel.offsetHeight;
      panel.style.top = `${Math.round(Math.max(8, Math.min(r.top, window.innerHeight - h - 8)))}px`;
    };

    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    paint();
  }

  /**
   * Import d'une photo prise au telephone : recadrage, redressement, OCR.
   * Sans OCR, une photo serait un trou noir dans la recherche (section 6).
   */
  private async importImage(): Promise<void> {
    const view = this.activeTab()?.view;
    if (!view) return;
    const { pickImage, cropDialog } = await import("./image-import");
    const img = await pickImage();
    if (!img) return;
    const result = await cropDialog(img, this.ocr ? { ocr: this.ocr } : {});
    if (!result) return;
    await view.addImageBlock(result.dataUrl, result.width, result.height, result.ocr);
  }

  private paintToolbar(): void {
    const old = this.main.querySelector(".side-tools");
    if (!old) return;
    const next = this.buildToolbar();
    old.replaceWith(next);
    next.scrollTop = old.scrollTop;
  }

  private async setViewMode(mode: ViewMode): Promise<void> {
    await this.activeTab()?.view?.setViewMode(mode);
    this.paintToolbar();
  }

  private async toggleSplit(): Promise<void> {
    if (this.splitId) { await this.closeSplit(); return; }
    const other = this.tabs.find((t) => t.id !== this.activeId);
    if (!other) { toast("Ouvre un second cahier pour utiliser le split", "warn"); return; }
    this.splitId = other.id;
    await this.renderNotebookScreen();
  }

  private async closeSplit(): Promise<void> {
    this.splitId = null;
    await this.renderNotebookScreen();
  }

  private async swapPanes(): Promise<void> {
    if (!this.splitId) return;
    const left = this.activeId;
    this.activeId = this.splitId;
    this.splitId = left;
    await this.renderNotebookScreen();
  }

  /* ---------------- reconnaissance ---------------- */

  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private warnedNoKeys = false;
  /** Ecritures disque de resultats, l'une apres l'autre. */
  private recoIo: Promise<unknown> = Promise.resolve();

  /** Moteur pour ces cles ; chaque envoi reel est compte (quota mensuel). */
  private makeBackend(keys: MyScriptKeys): RecognitionBackend {
    return keys.applicationKey && keys.hmacKey
      ? new MyScriptBackend(keys, () => this.countRequest())
      : new NoBackend();
  }

  /**
   * N'envoyer qu'au lever du stylet plus une pause (section 4) : 500 ms
   * pour une zone, 1,5 s au fil de la plume (D14), ou chaque envoi porte
   * toute la page. Dix fois moins d'allers-retours, et de la batterie.
   */
  private enqueue(key: string, kind: "math" | "text", strokes: Stroke[], auto = false): void {
    if (!this.queueState.backendReady && !this.warnedNoKeys) {
      this.warnedNoKeys = true;
      toast(
        "Aucune clé MyScript : l'encre est gardée mais rien ne sera converti.",
        "warn", 7000, { label: "Saisir les clés", run: () => void this.editKeys() }, "no-keys",
      );
    }
    this.remember(key, kind);
    const running = this.debounceTimers.get(key);
    if (running) clearTimeout(running);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.queue.enqueue({ key, kind, strokes });
    }, auto ? AUTO_DEBOUNCE_MS : SEND_DEBOUNCE_MS));
  }

  /** Bloc reste en attente : en file tout de suite, s'il n'y est pas deja. */
  private resume(key: string, kind: "math" | "text", strokes: Stroke[]): void {
    if (this.queue.has(key) || this.debounceTimers.has(key)) return;
    this.remember(key, kind);
    this.queue.enqueue({ key, kind, strokes });
  }

  private cancelRecognition(key: string): boolean {
    const timer = this.debounceTimers.get(key);
    if (timer) { clearTimeout(timer); this.debounceTimers.delete(key); }
    const had = this.queue.cancel(key) || !!timer;
    if (had) this.forget(key);
    return had;
  }

  /** Une autre version de ce bloc attend ou part : le resultat est provisoire. */
  private moreComing(key: string): boolean {
    return this.queue.has(key) || this.debounceTimers.has(key);
  }

  private async onRecognized(key: string, result: RecoResult): Promise<void> {
    const more = this.moreComing(key);
    await this.toBlock(key, (block) => applyToBlock(block, result, more));
    if (!more) this.forget(key);
  }

  /** Requete refusee par MyScript : le bloc dit « non reconnu, réessayer ». */
  private async onRecoFailed(key: string, message: string): Promise<void> {
    if (this.moreComing(key)) return;
    await this.toBlock(key, (block) => markFailed(block, message));
    this.forget(key);
  }

  /**
   * Porte un resultat jusqu'a son bloc. D'abord les vues qui tiennent la
   * page en memoire (meme cahier, meme intercalaire, meme bloc) ; sinon UNE
   * seule ecriture disque, passee dans la file de la vue de cet
   * intercalaire s'il y en a une : jamais deux ecritures croisees d'une
   * meme page, qui perdaient les derniers traits.
   */
  private async toBlock(key: string, change: (block: Block) => void): Promise<void> {
    const ref = parseBlockKey(key);
    if (!ref) return;
    if (this.applyInViews(ref, change)) return;
    const holder = this.holders(ref.notebook, ref.divider)[0];
    const write = async () => {
      // La page a pu s'ouvrir entre-temps : la vue la tient, elle ecrira.
      if (this.applyInViews(ref, change)) return;
      try { await updateBlockOnDisk(this.repo, ref, change); } catch { /* page disparue */ }
    };
    const run = holder ? holder.runIo(write) : this.recoIo.then(write, write);
    if (!holder) this.recoIo = run.catch(() => undefined);
    await run;
  }

  private applyInViews(ref: BlockRef, change: (block: Block) => void): boolean {
    let done = false;
    for (const v of this.holders(ref.notebook, ref.divider)) {
      // Deux onglets sur le meme intercalaire : chacun garde sa copie a jour.
      if (v.applyChange(ref, change)) done = true;
    }
    return done;
  }

  /* -- conversions en attente, retenues d'une seance a l'autre -- */

  /**
   * Cles des blocs en route, gardees dans le stockage local de la machine
   * (jamais dans le dossier synchronise). Au lancement suivant, elles
   * repartent sans qu'on ait a rouvrir chaque page.
   */
  private saved = new Map<string, "math" | "text">(
    Object.entries(readJson<Record<string, "math" | "text">>(PENDING_KEY) ?? {}),
  );

  private remember(key: string, kind: "math" | "text"): void {
    if (this.saved.get(key) === kind) return;
    this.saved.set(key, kind);
    writeJson(PENDING_KEY, Object.fromEntries(this.saved));
  }

  private forget(key: string): void {
    if (!this.saved.delete(key)) return;
    writeJson(PENDING_KEY, Object.fromEntries(this.saved));
  }

  /** Remet en file les blocs encore en attente sur le disque. */
  private async resumeSaved(): Promise<void> {
    for (const [key, kind] of [...this.saved]) {
      if (this.moreComing(key)) continue;
      const ref = parseBlockKey(key);
      const found = ref ? await findBlockOnDisk(this.repo, ref).catch(() => null) : null;
      const b = found?.block;
      if (!b || !isPending(b) || (b.type !== "math" && b.type !== "ink")) { this.forget(key); continue; }
      // Le fond de page ne part qu'en conversion au fil de la plume.
      if (b.type === "ink" && !b.rect && !this.autoConvert) continue;
      const strokes = b.strokes.filter((st) => st.tool === "pen");
      if (!strokes.length) { this.forget(key); continue; }
      this.resume(key, kind, strokes);
    }
  }

  /** Un envoi reel de plus ce mois-ci ; alerte une fois a 80 % du quota. */
  private countRequest(): void {
    this.usage = bumpUsage(this.usage, new Date());
    if (shouldWarn(this.usage)) {
      this.usage = { ...this.usage, warned: true };
      toast(`Reconnaissance : ${usageLabel(this.usage)}. Au-delà de ${MONTHLY_QUOTA.toLocaleString("fr-FR")}, `
        + "plus rien ne sera converti avant le mois prochain. La conversion sur zone consomme moins.",
      "warn", 12000);
    }
    writeJson(USAGE_KEY, this.usage);
  }

  /* ---------------- liens ---------------- */

  private async followLink(target: string): Promise<void> {
    const [path, blockId] = target.split("#");
    const parts = path.split("/");
    if (parts.length < 3) { toast("Lien invalide", "warn"); return; }
    const [nb, div, num] = parts;
    await this.openNotebook(nb, div, Number(num));
    if (blockId) await this.activeTab()?.view?.focusBlock(Number(num), blockId);
  }

  /* ---------------- raccourcis ---------------- */

  private onKey(e: KeyboardEvent): void {
    if (this.calculator?.handleKey(e)) { e.preventDefault(); return; }
    const inDoc = isEditingDoc(e.target);
    const tag = (e.target as HTMLElement)?.tagName;
    const inField = tag === "INPUT" || tag === "TEXTAREA";
    const typing = inDoc || inField;
    // Une fenetre de dialogue (ou le menu « ⋯ ») garde le clavier.
    const dialog = !!document.querySelector(".backdrop");
    const view = this.activeTab()?.view;

    // Alt : formules, outils et couleurs. Les lettres seules tapent du texte,
    // comme dans Word ; les raccourcis passent donc tous par Alt.
    if (e.altKey && !e.ctrlKey && !e.metaKey && this.screen === "notebook" && !dialog) {
      if (this.onAltKey(e, inDoc)) { e.preventDefault(); return; }
    }

    // Ctrl (et F1) : table unique dans core/shortcuts.ts. Ces commandes
    // passent AVANT le test « en train de taper » : on tape presque
    // toujours, Ctrl+F ou Ctrl+Pg↓ doivent marcher quand meme.
    const cmd = ctrlCommand(e);
    if (cmd) {
      // En split, la commande vise le panneau ou l'on tape : Ctrl+F pose le
      // repere sur la page qu'on ecrit, pas sur celle de gauche.
      const pane = this.tabs.find((t) => t.host.contains(e.target as Node));
      if (this.runCommand(cmd, { typing, dialog, view: pane?.view ?? view })) e.preventDefault();
      return;
    }
    // F5 et Ctrl+Maj+R rechargeraient le WebView2 : une appli de bureau ne
    // se recharge pas, et les dernieres frappes pas encore ecrites partiraient.
    if (isReloadKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;

    // Echap dans le texte rend la main a la page ; un second Echap va au menu.
    if (inDoc && e.key === "Escape") { (document.activeElement as HTMLElement | null)?.blur(); return; }
    if (typing) return;
    // Une fenetre de dialogue ouverte garde le clavier : Echap la ferme, et
    // ne doit pas en plus renvoyer au menu.
    if (dialog) return;

    if (e.key === "Escape" && (this.screen === "search" || this.screen === "flags")) {
      e.preventDefault();
      this.leaveAux();
      return;
    }
    if (e.key === "Escape" && this.screen !== "menu") { e.preventDefault(); void this.showMenu(); return; }
    if (this.screen !== "notebook") return;

    if (e.key === "PageDown") { e.preventDefault(); void view?.next(); return; }
    if (e.key === "PageUp") { e.preventDefault(); void view?.prev(); return; }

    // Taper n'importe ou : le clavier va au texte de la page, sans cliquer
    // ni inserer de zone. La touche continue sa route vers le texte.
    if (!e.altKey && (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace")) {
      view?.focusText();
      if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertLineBreak"); }
    }
  }

  /**
   * Execute une commande Ctrl. Renvoie true si la touche est prise
   * (preventDefault) ; false la laisse au texte (Ctrl+Z natif du texte).
   */
  private runCommand(
    cmd: Command,
    ctx: { typing: boolean; dialog: boolean; view: PageView | null | undefined },
  ): boolean {
    const view = ctx.view;
    const notebook = this.screen === "notebook";
    if (ctx.dialog) {
      // Sous un dialogue, rien ne se declenche, mais la touche est prise
      // quand meme : sinon le WebView2 ouvre sa recherche (Ctrl+F), imprime
      // l'interface (Ctrl+P) ou recharge l'appli (Ctrl+R). Seuls Ctrl+Z et
      // Ctrl+Y restent au champ de saisie.
      return cmd !== "undo" && cmd !== "redo";
    }
    switch (cmd) {
      case "menu": void (this.screen === "menu" ? this.backToWork() : this.showMenu()); return true;
      case "search": void this.showSearch(); return true;
      case "calc": void this.toggleCalculator(); return true;
      // Dans le texte, Ctrl+Z appartient au texte (son propre historique).
      case "undo": if (ctx.typing) return false; view?.undo(); return true;
      case "redo": if (ctx.typing) return false; view?.redo(); return true;
      // Toujours pris, meme en pleine frappe : le repere ne touche pas au
      // texte, et le curseur reste ou il etait (D3).
      case "flag": if (notebook) view?.addFlag(); return true;
      case "convert": this.setAutoConvert(!this.autoConvert); return true;
      case "finger": this.toggleFinger(); return true;
      case "newPage": if (notebook) void view?.newPage(); return true;
      case "insertPage": if (notebook) void view?.newPage(true); return true;
      case "goto": if (notebook) void this.goToPrompt(view); return true;
      case "nextPage": if (notebook) void view?.next(); return true;
      case "prevPage": if (notebook) void view?.prev(); return true;
      case "nextDivider": if (notebook) void this.switchDividerBy(1); return true;
      case "prevDivider": if (notebook) void this.switchDividerBy(-1); return true;
      case "exportPage": if (notebook) void view?.exportPdf("current"); return true;
      case "exportAll": if (notebook) void view?.exportPdf("all"); return true;
      case "closeTab": if (this.activeId) void this.closeTab(this.activeId); return true;
      case "nextTab": this.cycleTab(1); return true;
      case "prevTab": this.cycleTab(-1); return true;
      case "split": void this.toggleSplit(); return true;
      case "swap": void this.swapPanes(); return true;
      case "closeSplit": void this.closeSplit(); return true;
      case "help": showShortcuts(); return true;
    }
  }

  private cycleTab(delta: number): void {
    if (!this.tabs.length) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(i + delta + this.tabs.length) % this.tabs.length];
    if (next) { this.activeId = next.id; void this.renderNotebookScreen(); }
  }

  /** Ctrl+G, ou un appui sur « p. 4 / 12 ». */
  private async goToPrompt(target?: PageView | null): Promise<void> {
    const view = target ?? this.activeTab()?.view;
    if (!view || this.screen !== "notebook" || document.querySelector(".backdrop")) return;
    const nums = await view.pageNumbers();
    const last = nums[nums.length - 1] ?? 1;
    const input = await askText("Aller à la page", `Numéro de page, de 1 à ${last}`, "");
    if (input == null || !input.trim()) return;
    const r = parsePageInput(input, nums);
    if ("error" in r) { toast(r.error, "warn"); return; }
    await view.goTo(r.page);
  }

  /** Ctrl+Maj+Pg↓ / Pg↑ : intercalaire suivant ou precedent du cahier. */
  private async switchDividerBy(delta: number): Promise<void> {
    const tab = this.activeTab();
    if (!tab) return;
    const dividers = await this.repo.listDividers(tab.notebook);
    const next = dividers[dividers.indexOf(tab.divider) + delta];
    if (!next) {
      toast(delta > 0 ? "Dernier intercalaire" : "Premier intercalaire", "info", 1500);
      return;
    }
    await this.switchDividerAndRender(tab, next);
  }

  /**
   * Conversion de l'ecriture au fil de la plume, ou seulement sur zone.
   * Sans cles MyScript, l'activer ne convertirait rien : on le dit, avec
   * un bouton vers la saisie des cles.
   */
  private setAutoConvert(on: boolean): void {
    if (on && !this.queueState.backendReady) {
      // Sans cles, rien ne serait converti : on les demande tout de suite,
      // et la conversion s'active des qu'elles sont bonnes (reco-15).
      void this.editKeys().then((ok) => { if (ok && this.queueState.backendReady) this.setAutoConvert(true); });
      return;
    }
    if (on === this.autoConvert) return;
    this.autoConvert = on;
    this.settings.autoConvert = on;
    saveSettings(this.settings);
    if (on) {
      // Bascule aussitot en rendu propre : sans cela on active la
      // conversion sans rien voir arriver.
      this.renderMode = "clean";
      for (const t of this.tabs) t.view?.setRenderMode(this.renderMode);
      this.activeTab()?.view?.reconvert();
    }
    this.paintToolbar();
    toast(on
      ? "Conversion au fil de la plume activée"
      : "Conversion sur zone : entoure ce qu'il faut convertir (Alt+Z, Alt+T)");
  }

  /** Affichage double : encre brute ou rendu propre, instantane (section 4). */
  private setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    for (const t of this.tabs) t.view?.setRenderMode(mode);
    this.paintToolbar();
  }

  private setTypedMath(on: boolean): void {
    this.settings.autoMath = on;
    setAutoMath(on);
    saveSettings(this.settings);
    toast(on ? "Formules tapées mises en forme automatiquement" : "Formules tapées laissées telles quelles");
  }

  private setSpelling(on: boolean): void {
    this.settings.spellcheck = on;
    setSpellcheck(on);
    saveSettings(this.settings);
    toast(on ? "Correcteur orthographique activé" : "Correcteur orthographique coupé");
  }

  /**
   * Ctrl+D. Sans stylet : le doigt ecrit ou navigue. Avec un stylet
   * memorise : l'oublier, sinon un stylet a plat ou oublie laisserait le
   * doigt sans moyen d'ecrire. Le prochain contact du stylet remet la
   * separation.
   */
  private toggleFinger(): void {
    if (this.sawPen) {
      this.sawPen = false;
      this.touchWrites = true;
      this.settings.penSeen = false;
      saveSettings(this.settings);
      this.paintToolbar();
      this.paintStatus();
      toast("Stylet oublié : le doigt écrit jusqu'au prochain contact du stylet");
      return;
    }
    this.touchWrites = !this.touchWrites;
    this.paintToolbar();
    this.paintStatus();
    toast(this.touchWrites ? "Le doigt écrit" : "Le doigt fait défiler la page");
  }

  /** Raccourcis Alt. Renvoie true si la touche a ete prise. */
  private onAltKey(e: KeyboardEvent, inDoc: boolean): boolean {
    const view = this.activeTab()?.view;
    // Alt+= : nouvelle formule, comme l'equation de Word.
    if (e.key === "=" && !e.shiftKey) {
      if (!inDoc) view?.focusText();
      insertMathTemplate("", view?.activeDoc);
      return true;
    }
    const k = e.key.toLowerCase();
    const tpl = MATH_TEMPLATES.find((t) => t.key === k);
    if (tpl) {
      if (!inDoc) view?.focusText();
      insertMathTemplate(tpl.insert, view?.activeDoc);
      return true;
    }
    // Couleurs Alt+1 a 5, dans l'ordre de la palette. e.code : en AZERTY
    // la rangee du haut donne & e " ' ( sans Maj.
    const digit = /^Digit([1-5])$/.exec(e.code)?.[1];
    const idx = digit ? PALETTE.findIndex((p) => p.shortcut === digit) : -1;
    if (idx >= 0) { this.pickColor(PALETTE[idx].key); return true; }
    if (e.code === "Digit0") { this.pickColor(null); return true; }

    const tools: Record<string, Tool> = {
      KeyE: "pen", KeyH: "highlighter", KeyG: "eraser", KeyZ: "region", KeyT: "textregion",
    };
    const t = tools[e.code];
    if (t) { this.selectTool(t); return true; }
    return false;
  }

  /** Retour au meme endroit apres un passage par le menu (section 5). */
  private async backToWork(): Promise<void> {
    if (this.tabs.length) await this.renderNotebookScreen();
  }

  /* ---------------- etat et statut ---------------- */

  /**
   * Outil choisi (bouton ou Alt+lettre). Les zones sont ponctuelles : une
   * zone tracee remet l'outil d'avant. Choisir deux fois la meme zone la
   * verrouille, pour en enchainer plusieurs ; une troisieme fois rend
   * l'outil d'avant.
   */
  private selectTool(t: Tool): void {
    if (isZone(t)) {
      if (this.tool === t && !this.toolLocked) {
        this.toolLocked = true;
        toast(`${t === "region" ? "Zone math" : "Zone texte"} verrouillée : plusieurs zones de suite`, "info", 1800);
      } else if (this.tool === t) {
        this.toolLocked = false;
        this.tool = this.prevTool;
      } else {
        if (!isZone(this.tool)) this.prevTool = this.tool;
        this.tool = t;
        this.toolLocked = false;
      }
    } else {
      this.tool = t;
      this.toolLocked = false;
    }
    this.persist();
    this.paintToolbar();
  }

  /** Une zone vient d'etre tracee : retour a l'outil d'avant, sauf verrou. */
  private restoreTool(): void {
    if (!isZone(this.tool) || this.toolLocked) return;
    this.tool = this.prevTool;
    this.persist();
    this.paintToolbar();
  }

  /**
   * Couleur choisie : l'encre et le texte tape. null = l'encre neutre
   * (noire) et le texte normal.
   */
  private pickColor(key: ColorKey | null): void {
    this.color = key ?? "normal";
    this.textColor = key;
    setTypingColor(key);
    this.persist();
    this.paintToolbar();
  }

  private persist(): void {
    this.settings.textColor = this.textColor;
    // Une zone ponctuelle n'est pas memorisee : on rouvre sur l'outil d'avant.
    this.settings.tool = isZone(this.tool) && !this.toolLocked ? this.prevTool : this.tool;
    this.settings.color = this.color;
    this.settings.width = this.width;
    saveSettings(this.settings);
  }

  /** Toutes les vues qui peuvent encore ecrire : onglets, puis vues quittees en echec. */
  private views(): PageView[] {
    for (const o of this.orphans) if (!o.hasUnsaved) this.orphans.delete(o);
    const shown = this.tabs.map((t) => t.view).filter((v): v is PageView => !!v);
    return [...shown, ...this.orphans];
  }

  /** Vues qui tiennent des pages de cet intercalaire. */
  private holders(notebook: string, divider: string): PageView[] {
    return this.views().filter((v) => v.notebook === notebook && v.divider === divider);
  }

  /**
   * Avant de renommer ou de renumeroter un intercalaire : tout ce qui
   * l'attend est ecrit. Faux (et un message) si une page reste refusee.
   */
  private async settle(notebook: string, divider: string, cancelled: string): Promise<boolean> {
    const held = this.holders(notebook, divider);
    for (const v of held) await v.flush();
    if (!held.some((v) => v.hasUnsaved)) return true;
    toast(`Une page n'est pas encore enregistrée : ${cancelled} pour ne rien écraser. `
      + "Réessaie dans un instant.", "err", 6000);
    return false;
  }

  /** Ecrit tout ce qui attend, dans tous les onglets et les vues quittees. */
  async flushAll(): Promise<void> {
    for (const v of this.views()) await v.flush();
  }

  /** Il reste des pages que le disque n'a pas acceptees. */
  get hasUnsaved(): boolean {
    return this.views().some((v) => v.hasUnsaved);
  }

  /** Derniere erreur d'ecriture, pour la demande de confirmation a la fermeture. */
  get unsavedError(): string | null {
    for (const v of this.views()) if (v.unsavedError) return v.unsavedError;
    return null;
  }

  private paintStatus(): void {
    const q = this.queueState;
    const unsaved = this.hasUnsaved;
    const failed = this.unsavedError;
    this.statusbar.replaceChildren(
      el("span", { class: "pill" },
        el("span", { class: `led ${q.online ? "" : "off"}` }),
        q.online ? "en ligne" : "hors ligne",
      ),
      el("span", { class: "pill" },
        el("span", { class: `led ${!q.backendReady && q.pending ? "off" : q.pending ? "wait" : ""}` }),
        // Une file qui n'ira nulle part doit le dire, sinon l'attente est
        // indistinguable d'une conversion qui prend son temps.
        !q.backendReady
          ? (q.pending
              ? `${q.pending} en attente, reconnaissance non configurée`
              : "reconnaissance non configurée")
          : q.pending
            ? `${q.pending} conversion${q.pending > 1 ? "s" : ""} en attente`
            : "aucune conversion en attente",
      ),
      // Une ecriture en echec reste affichee en rouge tant qu'elle n'a pas
      // abouti : on ne doit pas fermer l'appli en la croyant enregistree.
      failed
        ? el("span", { class: "pill unsaved", title: failed }, el("span", { class: "led err" }), "Non enregistré")
        : el("span", { class: "pill" },
          el("span", { class: `led ${unsaved ? "wait" : ""}` }),
          unsaved ? "enregistrement…" : "enregistré",
        ),
      el("span", { class: "pill" },
        el("span", { class: `led ${this.sawPen ? "" : "off"}` }),
        this.sawPen
          ? "stylet actif, le doigt navigue"
          : this.touchWrites
            ? "pas de stylet, le doigt écrit"
            : "pas de stylet, le doigt navigue",
      ),
      el("div", { class: "spacer" }),
      ...(q.blocked === "keys"
        ? [el("button", {
            class: "ghost small keys-btn reco-blocked",
            title: "La file de conversion est arrêtée : saisis des clés valides",
            onclick: () => void this.editKeys(),
          }, q.lastError ?? "Clés MyScript refusées")]
        : q.lastError ? [el("span", { class: "pill", title: q.lastError }, `dernière erreur : ${q.lastError}`)] : []),
      ...(q.backendReady && this.usage.count > 0
        ? [el("span", {
            class: `pill${this.usage.count >= MONTHLY_QUOTA * 0.8 ? " usage-high" : ""}`,
            title: "Envois à MyScript ce mois-ci, sur cette machine (quota mensuel du compte)",
          }, usageLabel(this.usage))]
        : []),
      el("span", { class: "pill" }, this.rootLabel),
      el("button", {
        class: "ghost small keys-btn",
        title: "Clés de la reconnaissance manuscrite",
        onclick: () => void this.editKeys(),
      }, "Clés MyScript"),
    );
  }

  /**
   * Saisie des cles MyScript. Elles sont essayees avant d'etre gardees (un
   * petit trait envoye), puis servent tout de suite : plus de relance de
   * l'appli, qui vidait la file. Vrai si des cles valides sont en place.
   */
  private async editKeys(): Promise<boolean> {
    const r = await askFields("Reconnaissance manuscrite", [
      { name: "app", label: "applicationKey MyScript",
        value: this.machineKeys?.applicationKey || this.settings.myscript.applicationKey },
      { name: "hmac", label: "hmacKey MyScript",
        value: this.machineKeys?.hmacKey || this.settings.myscript.hmacKey },
    ], "Enregistrer", async (v) => {
      if (!v.app && !v.hmac) return null; // retirer les cles
      if (!v.app || !v.hmac) return { message: "Il faut les deux clés : applicationKey et hmacKey." };
      const err = await testKeys({ applicationKey: v.app, hmacKey: v.hmac }, () => this.countRequest());
      if (!err) return null;
      if (err.kind === "keys" && err.status) {
        return { message: "MyScript refuse ces clés. Vérifie-les (copier-coller complet, sans espace)." };
      }
      return {
        message: `Clés non vérifiées : ${err.message.replace(/\.$/, "")}. Elles serviront dès que MyScript répondra.`,
        force: "Enregistrer sans tester",
      };
    });
    if (!r) return false;
    const keys = { applicationKey: r.app, hmacKey: r.hmac };
    let onMachine = false;
    if (this.saveKeys) {
      try { await this.saveKeys(r.app, r.hmac); onMachine = true; } catch { /* stockage local indisponible */ }
    }
    // Stockees sur la machine : rien en clair dans le stockage du navigateur.
    this.settings.myscript = onMachine ? { applicationKey: "", hmacKey: "" } : keys;
    this.machineKeys = onMachine ? keys : null;
    saveSettings(this.settings);
    this.queue.setBackend(this.makeBackend(keys));
    if (!keys.applicationKey) {
      toast("Clés retirées : la reconnaissance est coupée, l'encre reste.");
      return false;
    }
    // Les blocs restes en attente partent maintenant, pages ouvertes ou non.
    for (const v of this.views()) v.resumeAll();
    void this.resumeSaved();
    dismissToast("no-keys");
    toast("Clés MyScript enregistrées : la conversion est active.");
    return true;
  }

  /** Avertissement de presence OneDrive, non bloquant (section 11). */
  async checkPresence(notebook: string): Promise<void> {
    if (!this.presence) return;
    const other = await this.presence.check(notebook);
    if (!other) return;
    const readOnly = await confirmDialog(
      "Cahier peut-être ouvert ailleurs",
      `${other} semble avoir ce cahier ouvert. Ouvrir quand même en lecture seule ?`,
      "Ouvrir en lecture seule",
    );
    if (readOnly) toast("Lecture seule : les modifications ne seront pas enregistrées", "warn", 6000);
  }
}

/* ---------------- stockage local de la reconnaissance ---------------- */

/** Blocs en route vers MyScript (cle -> moteur), d'une seance a l'autre. */
const PENDING_KEY = "cahiers.reco.pending.v1";
/** Compteur mensuel des envois. */
const USAGE_KEY = "cahiers.reco.usage.v1";

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
}
