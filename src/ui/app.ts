import { el, clear, toast, askText, askFields, confirmDialog, pick } from "./dom";
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
import { searchAll } from "../core/storage/search";
import type { FsAdapter } from "../core/storage/fs";
import {
  RecognitionQueue, SEND_DEBOUNCE_MS, MyScriptBackend, NoBackend,
  type RecognitionBackend, type QueueState,
} from "../core/ink/recognizer";
import { loadSettings, saveSettings, type Settings } from "../core/settings";
import type { Presence } from "../platform";

type Screen = "menu" | "notebook" | "search" | "flags" | "probe";
type Tool = ToolKind | "region" | "textregion";

const isZone = (t: Tool): t is "region" | "textregion" => t === "region" || t === "textregion";

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
    // survivent a un vidage du stockage local.
    const active = machineKeys?.applicationKey ? machineKeys : this.settings.myscript;
    const backend: RecognitionBackend = active.applicationKey
      ? new MyScriptBackend(active)
      : new NoBackend();

    this.queue = new RecognitionQueue(backend, (key, result) => this.onRecognized(key, result));
    this.queueState = this.queue.state();
    this.queue.subscribe((s) => { this.queueState = s; this.paintStatus(); });

    this.root.append(this.tabbar, this.main, this.statusbar);
    document.addEventListener("keydown", (e) => this.onKey(e));
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
            this.main.querySelector(".side-calc")?.classList.toggle("closed", !visible);
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
    (await this.loadCalculator()).toggle();
  }

  async start(): Promise<void> {
    await this.repo.ensureRootLayout();
    await this.showMenu();
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
      openSearch: () => void this.showSearch(),
      openFlags: () => void this.showFlags(),
      openProbe: () => this.showProbe(),
    };
  }

  private async showSearch(): Promise<void> {
    this.screen = "search";
    await this.flushAll();
    clear(this.main);
    this.main.append(buildSearchView(
      this.menuHost(),
      () => void this.showMenu(),
      (q) => searchAll(this.repo, q),
    ));
  }

  private async showFlags(): Promise<void> {
    this.screen = "flags";
    clear(this.main);
    this.main.append(await buildFlagsView(this.menuHost(), () => void this.showMenu()));
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
      requestRecognition: (key, kind, strokes) => this.enqueue(key, kind, strokes),
      onDirty: () => this.paintStatus(),
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
      title: "Menu (Ctrl+M)",
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
          title: "Fermer",
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
          title: "Split gauche/droite (Ctrl+\\)",
          onclick: () => void this.toggleSplit(),
        }, "Split"),
      );
    }
    // Le menu a deja son propre bouton de recherche : deux au meme instant
    // font doublon a l'ecran.
    if (this.screen !== "menu") {
      this.tabbar.append(el("button", {
        title: "Recherche globale (Ctrl+K)",
        onclick: () => void this.showSearch(),
      }, "Rechercher"));
    }
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
    const calcSide = el("aside", { class: `side-calc${this.settings.calcOpen ? "" : " closed"}` });
    const work = el("div", { class: "work" });
    this.main.append(this.buildDividerBar(tab, dividers), work);
    void this.loadCalculator().then((calc) => {
      calc.dock(calcSide);
      if (this.settings.calcOpen && !calc.isVisible) calc.show();
    });

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
    pane.append(el("div", { class: "pane-head" },
      el("span", { class: "dot", style: { background: tab.color, width: "9px", height: "9px", borderRadius: "50%" } }),
      el("strong", {}, tab.title),
      el("span", { class: "muted" }, tab.divider),
      el("div", { class: "spacer" }),
      isRight
        ? el("button", { class: "ghost", title: "Fermer le panneau droit (Ctrl+Maj+W)", onclick: () => void this.closeSplit() }, "Fermer")
        : null,
      this.splitId
        ? el("button", { class: "ghost", title: "Permuter les panneaux (Ctrl+Maj+X)", onclick: () => void this.swapPanes() }, "Permuter")
        : null,
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

  private buildToolbar(): HTMLElement {
    const bar = el("div", { class: "toolbar" });
    const view = () => this.activeTab()?.view;

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
      el("div", { class: "sep" }),
    );

    // Palette fermee a 5 couleurs a semantique fixe (section 8), plus
    // l'encre neutre noire. La couleur choisie vaut pour l'encre ET pour le
    // texte tape : une seule pastille active, sa legende en dessous.
    // Pas de focus sur la pastille : la selection du texte reste, et prend
    // la couleur.
    const keep = (b: HTMLElement) => {
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") e.preventDefault(); });
      return b;
    };
    bar.append(keep(el("button", {
      class: `swatch${this.color === "normal" ? " on" : ""}`,
      title: "Normal, en noir (Alt+0) : encre et texte tapé",
      onclick: () => this.pickColor(null),
    }, el("i", { style: { background: NEUTRAL_INK.ink } }))));
    for (const p of PALETTE) {
      bar.append(keep(el("button", {
        class: `swatch${this.color === p.key ? " on" : ""}`,
        title: `${p.label} (Alt+${p.shortcut}) : encre et texte tapé`,
        onclick: () => this.pickColor(p.key),
      }, el("i", { style: { background: p.ink } }))));
    }
    // Le sens de la couleur, a l'ecran : au doigt, aucune infobulle.
    bar.append(el("div", { class: "swatch-legend small muted" },
      `${labelOf(this.color)} · Alt+${shortcutOf(this.color)}`));

    const widths: [string, number][] = [["Fin", 1.4], ["Moyen", 2.2], ["Épais", 3.6]];
    bar.append(el("div", { class: "sep" }));
    for (const [label, w] of widths) {
      bar.append(el("button", {
        class: this.width === w ? "on" : "",
        onclick: () => { this.width = w; this.persist(); this.paintToolbar(); },
      }, label));
    }

    bar.append(
      el("div", { class: "sep" }),
      el("button", { onclick: () => view()?.undo(), title: "Annuler (Ctrl+Z)" }, "Annuler"),
      el("button", { onclick: () => view()?.redo(), title: "Rétablir (Ctrl+Y)" }, "Rétablir"),
      el("div", { class: "sep" }),
      ...(this.sawPen ? [] : [
        el("button", {
          class: this.touchWrites ? "on" : "",
          title: "Ce que fait le doigt, faute de stylet (Ctrl+D)",
          onclick: () => {
            this.touchWrites = !this.touchWrites;
            this.paintToolbar();
            toast(this.touchWrites
              ? "Le doigt ecrit"
              : "Le doigt fait defiler la page");
          },
        }, this.touchWrites ? "Doigt : ecrit" : "Doigt : navigue"),
        el("div", { class: "sep" }),
      ]),
    );

    // Seconde moitie de la colonne, sous le ruban Maths : ce qui sert moins
    // souvent qu'ecrire.
    const more = el("div", { class: "toolbar" },
      el("div", { class: "page-nav" },
        el("button", { onclick: () => void view()?.prev(), title: "Page precedente (PageUp)" }, "◀"),
        el("span", { class: "small muted" }, `p. ${view()?.pageNumber ?? 1}`),
        el("button", { onclick: () => void view()?.next(), title: "Page suivante (PageDown)" }, "▶"),
      ),
      el("div", { class: "sep" }),
      el("button", {
        title: "Photo du tableau, redressee et lue",
        onclick: () => void this.importImage(),
      }, "Photo"),
      el("button", { onclick: () => view()?.addFlag(), title: "Pas compris (Ctrl+F)" }, "Pas compris"),
      el("button", { onclick: () => void this.toggleCalculator(), title: "Calculatrice (Ctrl+L)" }, "Calculatrice"),
      el("button", {
        class: this.settings.autoMath ? "on" : "",
        title: "Formules tapees (Vs = Vz - Vbe, a/b, beta...) mises en forme a chaque Entree",
        onclick: () => {
          this.settings.autoMath = !this.settings.autoMath;
          setAutoMath(this.settings.autoMath);
          saveSettings(this.settings);
          this.paintToolbar();
          toast(this.settings.autoMath ? "Formules automatiques activees" : "Formules automatiques coupees");
        },
      }, "Formules auto"),
      el("button", {
        class: this.settings.spellcheck ? "on" : "",
        title: "Souligner les fautes d'orthographe dans le texte tapé",
        onclick: () => {
          this.settings.spellcheck = !this.settings.spellcheck;
          setSpellcheck(this.settings.spellcheck);
          saveSettings(this.settings);
          this.paintToolbar();
          toast(this.settings.spellcheck ? "Correcteur orthographique activé" : "Correcteur orthographique coupé");
        },
      }, "Orthographe"),
      el("button", {
        onclick: () => void view()?.exportPdf(),
        title: "Toutes les pages de l'intercalaire, puis « Enregistrer au format PDF »",
      }, "Exporter PDF"),
      el("div", { class: "sep" }),
      el("button", { onclick: () => void view()?.newPage(), title: "Nouvelle page a la fin" }, "Nouvelle page"),
      el("button", { onclick: () => void view()?.newPage(true), title: "Inserer apres la page courante" }, "Inserer ici"),
      el("div", { class: "sep" }),
    );

    // Bascule pages / defilement, a tout moment (section 5).
    const mode = view()?.mode ?? "pages";
    more.append(
      el("button", {
        class: mode === "scroll" ? "on" : "",
        title: "Bascule pages / defilement",
        onclick: () => void this.setViewMode(mode === "pages" ? "scroll" : "pages"),
      }, mode === "pages" ? "Mode pages" : "Mode defilement"),
      // Affichage double : bascule instantanee encre / rendu propre (section 4).
      el("button", {
        class: this.autoConvert ? "on" : "",
        title: "Convertir l'ecriture au fil de la plume (Ctrl+R)",
        onclick: () => {
          this.autoConvert = !this.autoConvert;
          this.settings.autoConvert = this.autoConvert;
          saveSettings(this.settings);
          this.paintToolbar();
          if (this.autoConvert) {
            // Bascule aussitot en rendu propre : sans cela on active la
            // conversion sans rien voir arriver.
            this.renderMode = "clean";
            for (const t of this.tabs) t.view?.setRenderMode(this.renderMode);
            this.activeTab()?.view?.reconvert();
            toast("Conversion au fil de la plume activee");
          } else {
            toast("Conversion a la demande : entoure une zone");
          }
          this.paintToolbar();
        },
      }, this.autoConvert ? "Auto" : "A la demande"),
      el("button", {
        class: this.renderMode === "clean" ? "on" : "",
        title: "Encre brute ou rendu propre",
        onclick: () => {
          this.renderMode = this.renderMode === "ink" ? "clean" : "ink";
          for (const t of this.tabs) t.view?.setRenderMode(this.renderMode);
          this.paintToolbar();
        },
      }, this.renderMode === "ink" ? "Encre" : "Rendu"),
      // En bas de la colonne, loin de « Inserer ici » : un appui de travers
      // au stylet ne doit pas tomber dessus.
      el("div", { class: "sep" }),
      el("button", {
        class: "danger",
        title: "La page part à la corbeille (ESEO/.corbeille), « Annuler » la remet en place",
        onclick: () => void view()?.deleteCurrentPage(),
      }, "Supprimer la page"),
    );
    // Outils a gauche : la hauteur de l'ecran reste a la feuille.
    return el("aside", { class: "side-tools" },
      bar,
      buildMathBar(() => this.activeTab()?.view?.activeDoc),
      more,
    );
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

  /**
   * N'envoyer qu'au lever du stylet plus 500 ms de pause (section 4) :
   * dix fois moins d'allers-retours reseau, et de la batterie economisee.
   */
  private enqueue(key: string, kind: "math" | "text", strokes: import("../core/types").Stroke[]): void {
    if (!this.queueState.backendReady && !this.warnedNoKeys) {
      this.warnedNoKeys = true;
      toast(
        "Aucune cle MyScript : l'encre est gardee mais rien ne sera converti. " +
        "Bouton « Cles MyScript », en bas a droite.",
        "warn", 7000,
      );
    }
    const running = this.debounceTimers.get(key);
    if (running) clearTimeout(running);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.queue.enqueue({ key, kind, strokes });
    }, SEND_DEBOUNCE_MS));
  }

  private async onRecognized(key: string, result: import("../core/ink/recognizer").RecoResult): Promise<void> {
    for (const tab of this.tabs) {
      if (key.startsWith(`${tab.notebook}/`)) {
        await tab.view?.applyRecognition(key, result);
      }
    }
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
    const typing = inDoc || ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName);
    const view = this.activeTab()?.view;

    // Alt : formules, outils et couleurs. Les lettres seules tapent du texte,
    // comme dans Word ; les raccourcis passent donc tous par Alt.
    if (e.altKey && !e.ctrlKey && !e.metaKey && this.screen === "notebook"
        && !document.querySelector(".backdrop")) {
      if (this.onAltKey(e, inDoc)) { e.preventDefault(); return; }
    }

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "m") { e.preventDefault(); void (this.screen === "menu" ? this.backToWork() : this.showMenu()); return; }
      if (k === "k") { e.preventDefault(); void this.showSearch(); return; }
      if (k === "l") { e.preventDefault(); void this.toggleCalculator(); return; }
      if (k === "z" && !typing) { e.preventDefault(); view?.undo(); return; }
      if (k === "y" && !typing) { e.preventDefault(); view?.redo(); return; }
      if (k === "f" && !typing) { e.preventDefault(); view?.addFlag(); return; }
      if (k === "r") {
        e.preventDefault();
        this.autoConvert = !this.autoConvert;
        this.settings.autoConvert = this.autoConvert;
        saveSettings(this.settings);
        if (this.autoConvert) {
          this.renderMode = "clean";
          for (const t of this.tabs) t.view?.setRenderMode(this.renderMode);
          view?.reconvert();
        }
        this.paintToolbar();
        toast(this.autoConvert
          ? "Conversion au fil de la plume activee"
          : "Conversion a la demande");
        return;
      }
      if (k === "d" && this.sawPen) {
        // penSeen est memorise : sans cette sortie, un stylet a plat ou
        // oublie laisserait le doigt sans moyen d'ecrire. Le prochain
        // contact du stylet remet la separation.
        e.preventDefault();
        this.sawPen = false;
        this.touchWrites = true;
        this.settings.penSeen = false;
        saveSettings(this.settings);
        this.paintToolbar();
        this.paintStatus();
        toast("Stylet oublié : le doigt écrit jusqu'au prochain contact du stylet");
        return;
      }
      if (k === "d" && !this.sawPen) {
        e.preventDefault();
        this.touchWrites = !this.touchWrites;
        this.paintToolbar();
        toast(this.touchWrites ? "Le doigt ecrit" : "Le doigt fait defiler la page");
        return;
      }
      if (k === "n") { e.preventDefault(); void view?.newPage(); return; }
      if (k === "w") { e.preventDefault(); if (this.activeId) void this.closeTab(this.activeId); return; }
      if (e.key === "\\") { e.preventDefault(); void this.toggleSplit(); return; }
      if (e.shiftKey && k === "x") { e.preventDefault(); void this.swapPanes(); return; }
      if (e.shiftKey && k === "w") { e.preventDefault(); void this.closeSplit(); return; }
      if (k === "tab") {
        e.preventDefault();
        const i = this.tabs.findIndex((t) => t.id === this.activeId);
        const next = this.tabs[(i + 1) % Math.max(1, this.tabs.length)];
        if (next) { this.activeId = next.id; void this.renderNotebookScreen(); }
        return;
      }
      return;
    }

    // Echap dans le texte rend la main a la page ; un second Echap va au menu.
    if (inDoc && e.key === "Escape") { (document.activeElement as HTMLElement | null)?.blur(); return; }
    if (typing) return;
    // Une fenetre de dialogue ouverte garde le clavier : Echap la ferme, et
    // ne doit pas en plus renvoyer au menu.
    if (document.querySelector(".backdrop")) return;

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
              ? `${q.pending} en attente, reconnaissance non configuree`
              : "reconnaissance non configuree")
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
          unsaved ? "enregistrement..." : "enregistre",
        ),
      el("span", { class: "pill" },
        el("span", { class: `led ${this.sawPen ? "" : "off"}` }),
        this.sawPen
          ? "stylet actif, le doigt navigue"
          : this.touchWrites
            ? "pas de stylet, le doigt ecrit"
            : "pas de stylet, le doigt navigue",
      ),
      el("div", { class: "spacer" }),
      ...(q.lastError ? [el("span", { class: "pill" }, `derniere erreur : ${q.lastError}`)] : []),
      el("span", { class: "pill" }, this.rootLabel),
      el("button", {
        class: "ghost small",
        style: { minHeight: "24px", minWidth: "0", padding: "0 8px" },
        onclick: () => void this.editKeys(),
      }, "Cles MyScript"),
    );
  }

  private async editKeys(): Promise<void> {
    const r = await askFields("Reconnaissance manuscrite", [
      { name: "app", label: "applicationKey MyScript",
        value: this.machineKeys?.applicationKey || this.settings.myscript.applicationKey },
      { name: "hmac", label: "hmacKey MyScript",
        value: this.machineKeys?.hmacKey || this.settings.myscript.hmacKey },
    ], "Enregistrer");
    if (!r) return;
    this.settings.myscript = { applicationKey: r.app, hmacKey: r.hmac };
    saveSettings(this.settings);
    if (this.saveKeys) {
      try { await this.saveKeys(r.app, r.hmac); } catch { /* stockage local indisponible */ }
    }
    toast("Cles enregistrees. Relance l'application pour les activer.");
  }

  /** Avertissement de presence OneDrive, non bloquant (section 11). */
  async checkPresence(notebook: string): Promise<void> {
    if (!this.presence) return;
    const other = await this.presence.check(notebook);
    if (!other) return;
    const readOnly = await confirmDialog(
      "Cahier peut-etre ouvert ailleurs",
      `${other} semble avoir ce cahier ouvert. Ouvrir quand meme en lecture seule ?`,
      "Ouvrir en lecture seule",
    );
    if (readOnly) toast("Lecture seule : les modifications ne seront pas enregistrees", "warn", 6000);
  }
}
