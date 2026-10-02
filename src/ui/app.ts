import {
  el, clear, toast, dismissToast, askText, askFields, confirmDialog, chooseDialog, pick,
  appendToToast, dismissPageToasts, APP_TOAST, type DialogField,
} from "./dom";
import { buildMenu, buildFlagsView, buildSearchView } from "./menu";
import { pageListDialog } from "./pagelist";
import { buildProbe } from "./probe";
import { buildReviewView, markRect, type ReviewState, type ReviewWhere } from "./review";
import { REVIEW_COLORS, focusQuery, type ReviewItem } from "../core/review";
import type { Bounds } from "../core/ink/stroke";
import { PageView, type ViewMode, type RenderMode, type ViewNotice } from "./pageview";
import { buildMathBar, MATH_TEMPLATES } from "./mathbar";
import { insertMathTemplate, isEditingDoc, setAutoMath, setSpellcheck, setTypingColor } from "./textdoc";
import type { Calculator } from "./calculator/index";
import { PALETTE, NEUTRAL_INK, labelOf, shortcutOf } from "../core/palette";
import type { ColorKey, InkColor, ToolKind } from "../core/types";
import { uuid } from "../core/id";
import { calcSpecOf, graphSpecOf, type CalcSpec, type GraphSpec } from "../core/liveblock";
import { Repo, safeName, type TrashEntry } from "../core/storage/repo";
import { Positions } from "../core/position";
import { NavHistory, dayLabel, dropIndex, pickSplitDivider, type NavSpot } from "../core/nav";
import {
  MAX_DEPTH, defaultExpanded, depthOf, dividerLabel, expandedChain, findNode, flattenTree,
  isUnder, leafName, moveAmongSiblings, moveRefusal, openableDividers, parentPath, parsePagePath,
  renamePrefix, subtreeHeight, type DividerNode,
} from "../core/dividers";
import { collectLinkPages, searchAll, type FlagHit } from "../core/storage/search";
import {
  blockLinkRef, indexById, linkCandidates, parseLinkUrl, resolveLink, spotExists, backlinksTo,
  type LinkPage, type LinkRef,
} from "../core/links";
import type { PageLinks } from "./linkpicker";
import type { DocLinkRef } from "./textdoc";
import type { FsAdapter } from "../core/storage/fs";
import {
  RecognitionQueue, SEND_DEBOUNCE_MS, AUTO_DEBOUNCE_MS, MyScriptBackend, NoBackend, testKeys,
  type RecognitionBackend, type QueueState, type RecoResult, type MyScriptKeys, type RecoJob,
} from "../core/ink/recognizer";
import { planIncremental } from "../core/ink/bands";
import {
  applyToBlock, findBlockOnDisk, isPending, markFailed, parseBlockKey, updateBlockOnDisk,
  type BlockRef,
} from "../core/ink/recokey";
import {
  MONTHLY_QUOTA, bumpUsage, currentUsage, shouldWarn, usageLabel, type Usage,
} from "../core/ink/usage";
import type { Block, NotebookMeta, Stroke } from "../core/types";
import { isPhotoImportKey, PHOTO_IMPORT_KEYS } from "../core/image/photo";
import { isPdfFile } from "../core/pdf/pdf";
import { PAPERS } from "../core/paper";
import { loadSettings, saveSettings, type Settings } from "../core/settings";
import {
  ctrlCommand, escapeAction, isReloadKey, pageLabel, parsePageInput, titleOf, type Command,
} from "../core/shortcuts";
import { showShortcuts } from "./help";
import type { Presence } from "../platform";
import { PRESENCE_CLAIM_MS, presenceAgo, type OtherPresence } from "../core/sync";

type Screen = "menu" | "notebook" | "search" | "flags" | "probe" | "review";
type Tool = ToolKind | "region" | "textregion" | "lasso" | "space";
/** Lasso et insertion d'espace : la selection n'existe qu'avec eux. */
const isSelect = (t: Tool): t is "lasso" | "space" => t === "lasso" || t === "space";

const isZone = (t: Tool): t is "region" | "textregion" => t === "region" || t === "textregion";

/**
 * Largeur minimale pour ancrer la calculatrice a droite. En dessous (le
 * portable fait 1280 px), elle flotte : la feuille garde sa largeur.
 */
const CALC_DOCK_MIN = 1400;

/**
 * Un onglet = un cahier ET un intercalaire : Cours et Exos du meme cahier
 * peuvent etre cote a cote (section 5). Jamais deux onglets sur le meme
 * intercalaire : une seule vue ecrit ses pages.
 */
interface Tab {
  id: string;
  notebook: string;
  title: string;
  color: string;
  /** Chemin de l'intercalaire dans la matiere (« E3A/S1/Chapitre 1 », D4). */
  divider: string;
  /**
   * Groupe dont la sous-bande est ouverte : choisi d'un appui sur un
   * groupe ; absent, celui de l'intercalaire affiche (defaultExpanded).
   */
  expanded?: string | null;
  view: PageView | null;
  host: HTMLElement;
  /** Dernier usage (ms) : rouvrir une matiere reprend son onglet le plus recent. */
  used: number;
}

/**
 * Presence d'un cahier ouvert (section 11). `readOnly` : on l'a ouvert en
 * lecture seule parce que l'autre PC l'avait ; on n'y signale alors pas sa
 * propre presence. `other` : l'autre PC vu au dernier passage.
 */
interface NotebookPresence {
  readOnly: boolean;
  other: OtherPresence | null;
}

/** L'onglet utilise le plus recemment. */
const mostRecent = (tabs: Tab[]): Tab | undefined =>
  tabs.reduce<Tab | undefined>((a, t) => (!a || t.used > a.used ? t : a), undefined);

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
   * Panneau qui a la main en split (dernier appui ou focus) : clavier,
   * colonne d'outils, intercalaires et calculatrice agissent sur lui.
   */
  private focusedId: string | null = null;
  /** Derniere position par cahier et intercalaire, sur cette machine (D8). */
  private positions: Positions;
  /** Endroits quittes par un saut : Alt+← y revient. */
  private nav = new NavHistory();
  /**
   * Pages vues par les liens (id, titres, liens poses), relues au plus une
   * fois toutes les 2,5 s : une page en defilement, ses retroliens et ses
   * liens a griser ne relancent pas chacun un parcours des cahiers.
   */
  private linkScan: { at: number; pages: Promise<LinkPage[]> } | null = null;
  /** Clavier du menu (Entree reprend, lettres filtrent, fleches). */
  private menuKeys: ((e: KeyboardEvent) => boolean) | null = null;
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
  /** Filtres de la vue Reviser, gardes d'une ouverture a l'autre. */
  private reviewState: ReviewState = { colors: [...REVIEW_COLORS] };
  /**
   * Taille de la pile de retour juste apres un saut depuis la vue Reviser :
   * Alt+← a cette taille revient a la vue (et non a la page d'avant).
   */
  private reviewBack: number | null = null;
  /**
   * La touche d'avant etait un Echap, sans appui ni autre touche entre les
   * deux : le suivant va au menu (escapeAction).
   */
  private lastEsc = false;
  /** Ruban Maths ouvert en volet (colonne trop basse pour l'avoir en dessous). */
  private mathFly = false;

  private tool: Tool = "pen";
  /**
   * Outil a remettre apres une zone math ou texte : ces outils sont
   * ponctuels, sinon le trait suivant tracait une nouvelle zone et
   * l'ecriture etait perdue.
   */
  private prevTool: Tool = "pen";
  /** Zone verrouillee (Alt+Z deux fois) : on enchaine plusieurs zones. */
  private toolLocked = false;
  /** Gomme au trait entier ou precise (encre-14). */
  private eraserMode: "stroke" | "precise" = "stroke";
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
  /** Cahiers ouverts dans un onglet et leur presence (section 11). */
  private present = new Map<string, NotebookPresence>();
  /** Rafraichissement de la presence, seulement tant qu'un cahier est ouvert. */
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

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
    this.positions = new Positions(localStore());
    // Une zone n'est jamais l'outil de depart : elle est ponctuelle.
    this.tool = isZone(this.settings.tool) ? "pen" : this.settings.tool;
    this.eraserMode = this.settings.eraserMode === "precise" ? "precise" : "stroke";
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
    // Glisser-deposer HTML5 rendu au WebView (dragDropEnabled: false) : un
    // fichier lache hors d'une page ouvrirait le fichier a la place de
    // l'appli. Seule la page (TextDoc) accepte un depot de fichier.
    for (const type of ["dragover", "drop"] as const) {
      window.addEventListener(type, (e) => {
        if (!e.dataTransfer?.types.includes("Files") || e.defaultPrevented) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
        if (type === "drop") toast("Déposez l'image sur une page ouverte.", "warn");
      });
    }
    // Un .pdf depose sur un cahier ouvert : importe dans le panneau vise,
    // apres sa page courante. En capture, avant le depot d'images du texte.
    window.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (this.screen !== "notebook" || !dt) return;
      if (!Array.from(dt.items ?? []).some((i) => i.kind === "file" && i.type === "application/pdf")) return;
      e.preventDefault();
      e.stopPropagation();
      dt.dropEffect = "copy";
    }, true);
    window.addEventListener("drop", (e) => {
      const pdf = Array.from(e.dataTransfer?.files ?? []).find((f) => isPdfFile(f));
      if (!pdf || this.screen !== "notebook") return;
      e.preventDefault();
      e.stopPropagation();
      void this.importPdf(pdf, e.target);
    }, true);
    document.addEventListener("keydown", (e) => this.onKey(e));
    // Un appui entre deux Echap : le second ne va plus au menu.
    window.addEventListener("pointerdown", () => { this.lastEsc = false; }, true);
    // Fenetre retaillee (moitie d'ecran, portable tourne) : la calculatrice
    // passe de la colonne a la fenetre flottante, ou l'inverse.
    let resizing: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener("resize", () => {
      clearTimeout(resizing);
      resizing = setTimeout(() => {
        if (this.calculator) this.placeCalculator(this.calculator);
        // Colonne d'outils : une ou deux sous-colonnes selon la place.
        if (this.screen === "notebook") this.paintToolbar();
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
    // Bouton « retour » de la souris : comme Alt+←, revient d'avant le saut.
    window.addEventListener("mousedown", (e) => { if (e.button === 3) e.preventDefault(); });
    window.addEventListener("mouseup", (e) => {
      if (e.button !== 3 || document.querySelector(".backdrop")) return;
      e.preventDefault();
      void this.goBack();
    });
    // Filet de securite seulement : beforeunload n'attend pas une ecriture.
    // La fermeture de la fenetre passe par main.ts (onCloseRequested).
    window.addEventListener("beforeunload", () => { void this.flushAll(); void this.releaseAll(); });
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
          canInsert: () => this.screen === "notebook" && !!this.focusedTab()?.view,
          onVisibility: (visible) => {
            this.settings.calcOpen = visible;
            saveSettings(this.settings);
            // Flottante, elle ne reserve pas de colonne.
            this.main.querySelector(".side-calc")
              ?.classList.toggle("closed", !visible || !this.calculator?.isDocked);
          },
          // Blocs vivants poses dans le texte de la page en vue du panneau
          // vise : au curseur du texte, sinon sous le dernier contenu.
          insertGraph: (g) => {
            const block = { id: uuid(), type: "graph" as const, fn: g.fn, domain: g.domain };
            this.focusedTab()?.view?.insertLive(Object.assign(block,
              g.range ? { range: g.range } : {}, g.angle === "DEG" ? { angle: "DEG" as const } : {},
              g.logX ? { logX: true } : {}));
          },
          insertCalc: (c) => {
            const block = { id: uuid(), type: "calc" as const, expr: c.expr, result: c.result };
            this.focusedTab()?.view?.insertLive(Object.assign(block, c.angle === "DEG" ? { angle: "DEG" as const } : {}));
          },
          // Matrices, Résoudre, Littéral : une formule du texte, éditable.
          onSend: (_expr, _result, latex) => { this.focusedTab()?.view?.insertFormula(latex); },
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
    dismissPageToasts();
    this.mathFly = false;
    await this.flushAll();
    const menu = await buildMenu(this.menuHost());
    // Un autre ecran a pu s'ouvrir pendant la lecture du disque.
    if (this.screen !== "menu") return;
    clear(this.main);
    this.menuKeys = menu.onKey;
    this.main.append(menu.root);
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
      openReview: (o?: { notebook?: string | null; colors?: ColorKey[] }) => void this.showReview(o),
      setFlagResolved: (f: FlagHit, resolved: boolean) => this.setFlagResolved(f, resolved),
      lastSpot: (dirs: string[]) => this.positions.latest(dirs),
      createNotebook: (title: string, color: string) => this.createNotebook(title, color),
      renameNotebook: (dir: string, title: string) => this.renameNotebook(dir, title),
      setNotebookColor: (dir: string, color: string) => this.setNotebookColor(dir, color),
      deleteNotebook: (dir: string) => this.deleteNotebook(dir),
      adoptNotebook: (dir: string, title: string, color: string) => this.adoptNotebook(dir, title, color),
      unmarkNotebooks: (dirs: string[]) => this.unmarkNotebooks(dirs),
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
    const tab = this.auxFrom === "notebook" ? this.focusedTab() : undefined;
    this.screen = "search";
    dismissPageToasts();
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
    dismissPageToasts();
    // Les reperes poses a l'instant doivent etre sur le disque pour etre listes.
    await this.flushAll();
    clear(this.main);
    this.paintTabs();
    this.main.append(await buildFlagsView(this.menuHost(), () => this.leaveAux(), notebook));
  }

  /**
   * Vue Reviser (lot 11) : extraits d'une couleur par matiere. Sans
   * argument, les derniers filtres ; depuis un cahier, sa matiere.
   */
  private async showReview(o?: { notebook?: string | null; colors?: ColorKey[] }): Promise<void> {
    this.noteAuxFrom();
    const st = this.reviewState;
    const from = this.auxFrom === "notebook" ? this.focusedTab()?.notebook : undefined;
    const nb = o ? (o.notebook === null ? undefined : o.notebook ?? from ?? st.notebook) : st.notebook;
    if (nb !== st.notebook || o?.colors) { st.divider = undefined; st.focusKey = undefined; st.scroll = undefined; }
    st.notebook = nb;
    if (o?.colors?.length) st.colors = [...o.colors];
    this.screen = "review";
    dismissPageToasts();
    await this.flushAll();
    clear(this.main);
    this.paintTabs();
    this.main.append(buildReviewView({
      repo: this.repo,
      openItem: (w, item) => void this.openReviewItem(w, item),
      openPage: (w) => void this.openReviewItem(w, null),
    }, () => this.leaveAux(), st));
  }

  /** Extrait choisi dans la vue Reviser : la page, a l'endroit ; Alt+← y revient. */
  private async openReviewItem(w: ReviewWhere, item: ReviewItem | null): Promise<void> {
    if (!item) await this.openAt(w.notebook, w.divider, w.page, "");
    else if (item.kind === "text") await this.openAt(w.notebook, w.divider, w.page, item.blockId, focusQuery(item.plain));
    // Zone reconnue : son cadre suffit a focusBlock. Encre libre : le cadre de l'extrait.
    else if (item.kind === "math" || item.kind === "zone") await this.openAt(w.notebook, w.divider, w.page, item.blockId);
    else await this.openAt(w.notebook, w.divider, w.page, item.blockId, undefined, item.box);
    this.reviewBack = this.nav.size;
    toast("Alt+← revient à la révision", "info", 2400, undefined, "nav-back");
  }

  /** Ouvre une page et va au bloc (resultat de recherche, repere) ; `rect` : cadre a montrer. */
  private async openAt(dir: string, divider: string, page: number, blockId: string, query?: string, rect?: Bounds): Promise<void> {
    this.reviewBack = null;
    this.noteJump();
    const tab = await this.openNotebook(dir, divider, page);
    await tab?.view?.focusBlock(page, blockId, query);
    if (rect && tab?.view) markRect(tab.view.root, page, rect);
  }

  /* ---------------- retour arriere ---------------- */

  /** Ou l'on est : l'onglet vise, son intercalaire et sa page. */
  private hereSpot(): NavSpot | null {
    const tab = this.focusedTab();
    const n = tab?.view?.pageNumber ?? 0;
    return tab && n >= 1 ? { notebook: tab.notebook, divider: tab.divider, page: n } : null;
  }

  /** Avant un saut (resultat, repere, lien, liste des pages) : Alt+← y revient. */
  private noteJump(): void {
    const here = this.hereSpot();
    if (!here) return;
    const first = this.nav.size === 0;
    this.nav.push(here);
    if (first) toast("Alt+← (ou le bouton retour de la souris) revient ici", "info", 2600, undefined, "nav-back");
  }

  /** Alt+← ou bouton retour de la souris. */
  private async goBack(): Promise<void> {
    // Venu de la vue Reviser sans autre saut depuis : on y revient.
    if (this.reviewBack !== null && this.screen === "notebook" && this.nav.size === this.reviewBack) {
      this.reviewBack = null;
      await this.showReview();
      return;
    }
    const spot = this.nav.pop(this.screen === "notebook" ? this.hereSpot() : null);
    if (!spot) {
      toast("Rien à reprendre : Alt+← revient après un saut (recherche, repère, lien, liste des pages)", "info", 2400, undefined, "nav-back");
      return;
    }
    try {
      const tab = await this.openNotebook(spot.notebook, spot.divider, spot.page);
      if (tab && tab.divider !== spot.divider) toast(`${dividerLabel(spot.divider)} n'existe plus dans ce cahier`, "warn", 3000);
    } catch (e) {
      toast(`Cet endroit n'existe plus : ${(e as Error).message}`, "warn", 4000);
    }
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

  /** Diagnostic du stylet, depuis le menu « ⋯ » (reglages) ; Retour ramene a la page. */
  private showProbe(): void {
    this.noteAuxFrom();
    this.screen = "probe";
    dismissPageToasts();
    clear(this.main);
    this.paintTabs();
    this.main.append(buildProbe(() => this.leaveAux()));
  }

  /* ---------------- onglets ---------------- */

  /** Onglet du panneau gauche (ou seul panneau). */
  private activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  /**
   * Onglet vise par le clavier, la colonne d'outils, les intercalaires et la
   * calculatrice : en split, le panneau ou l'on a appuye en dernier.
   */
  private focusedTab(): Tab | undefined {
    if (this.splitId && this.focusedId === this.splitId) {
      return this.tabs.find((t) => t.id === this.splitId) ?? this.activeTab();
    }
    return this.activeTab();
  }

  /** L'onglet est a l'ecran (panneau gauche ou droit). */
  private shown(tab: Tab): boolean {
    return tab.id === this.activeId || tab.id === this.splitId;
  }

  /**
   * Montre un onglet : deja a l'ecran, il prend la main ; sinon il remplace
   * l'onglet du panneau vise.
   */
  private place(tab: Tab): void {
    if (!this.shown(tab)) {
      if (this.splitId && this.focusedId === this.splitId) this.splitId = tab.id;
      else this.activeId = tab.id;
    }
    this.focusedId = tab.id;
    tab.used = Date.now();
    this.rememberTab(tab);
  }

  /**
   * Le panneau vise change (appui, focus) : sans reconstruire l'ecran, sinon
   * le trait commence a l'instant serait coupe. La bande d'intercalaires et
   * la colonne d'outils passent a ce panneau.
   */
  private setFocused(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.used = Date.now();
    if (this.focusedId === id || !this.splitId) { this.focusedId = id; return; }
    this.focusedId = id;
    // « Reprendre » rouvre le panneau ou l'on travaillait en dernier.
    this.rememberTab(tab);
    if (this.screen !== "notebook") return;
    for (const t of this.tabs) t.host.classList.toggle("focused", this.shown(t) && t.id === id);
    const bar = this.main.querySelector(".divider-strip");
    void this.repo.listDividerTree(tab.notebook).then((tree) => {
      if (this.focusedId === id && bar?.isConnected) bar.replaceWith(this.buildDividerBar(tab, tree));
    });
    this.paintToolbar();
    this.paintTabs();
  }

  private makeTab(dir: string, meta: NotebookMeta, divider: string): Tab {
    const tab: Tab = {
      id: uuid(), notebook: dir, title: meta.title, color: meta.color,
      divider, view: null, host: el("div", { class: "pane" }), used: Date.now(),
    };
    this.wirePane(tab);
    return tab;
  }

  /** Retient la page vue de l'onglet, sur cette machine. */
  private rememberTab(tab: Tab): void {
    const n = tab.view?.pageNumber ?? 0;
    if (n >= 1) this.positions.record(tab.notebook, tab.divider, n);
  }

  /**
   * Ouvre un cahier. Sans intercalaire (carte du menu), son onglet le plus
   * recent tel quel, ou la ou on l'avait laisse sur cette machine. Avec un
   * intercalaire (Reprendre, resultat, lien), l'onglet qui le tient deja,
   * sinon un onglet du cahier y passe. Rend l'onglet ouvert.
   */
  async openNotebook(dir: string, divider?: string, page?: number): Promise<Tab | undefined> {
    const meta = await this.repo.readMeta(dir);
    const tree = await this.repo.listDividerTree(dir);
    const dividers = flattenTree(tree);
    if (dividers.length === 0) dividers.push(await this.repo.createDivider(dir, "Cours"));
    const wanted = divider && dividers.includes(divider) ? divider : undefined;
    // Intercalaire demande disparu (renomme, a la corbeille) : sa page ne
    // vaut pas pour un autre, on rouvre le cahier la ou on l'avait laisse.
    if (divider && !wanted) page = undefined;
    const mine = this.tabs.filter((t) => t.notebook === dir);

    let tab = wanted ? mine.find((t) => t.divider === wanted) : mostRecent(mine);
    let at = page;
    if (!tab && mine.length) {
      // Le cahier est ouvert sur un autre intercalaire : l'onglet qu'on
      // regarde y passe (ou le plus recent de ce cahier).
      const focused = this.focusedTab();
      tab = focused?.notebook === dir ? focused : mostRecent(mine)!;
      await this.switchDivider(tab, wanted!, page);
      at = undefined;
    }
    if (!tab) {
      // Premier onglet de ce cahier : l'autre PC l'a-t-il ouvert ? Avant le
      // montage, pour qu'une vue en lecture seule ne cree meme pas de page.
      if (!mine.length) await this.enterNotebook(dir);
      // Faute de position, le premier intercalaire qui a des pages (pas un
      // groupe de rangement, qui n'en montrerait aucune).
      const target = wanted ?? this.positions.dividerFor(dir, dividers, meta.lastPosition)
        ?? openableDividers(tree)[0] ?? dividers[0];
      tab = this.makeTab(dir, meta, target);
      this.tabs.push(tab);
      await this.mountView(tab, page ?? this.positions.pageFor(dir, target, meta.lastPosition));
      at = undefined;
    }
    if (at) await tab.view?.goTo(at);
    this.place(tab);
    this.screen = "notebook";
    await this.renderNotebookScreen();
    // « Reprendre » doit exister des l'ouverture, pas au premier changement de page.
    this.rememberTab(tab);
    return tab;
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
      getEraserMode: () => this.eraserMode,
      getColor: () => this.color,
      getWidth: () => this.width,
      touchRole: () => this.touchRole(),
      onRegionDone: () => this.restoreTool(),
      requestRecognition: (key, kind, strokes, auto, partial) => this.enqueue(key, kind, strokes, auto, partial),
      resumeRecognition: (key, kind, strokes, partial) => this.resume(key, kind, strokes, partial),
      cancelRecognition: (key) => this.cancelRecognition(key),
      onDirty: () => this.paintStatus(),
      // Seule la vue du panneau vise pilote l'indicateur de la colonne.
      onPageChange: (n, total) => {
        if (this.focusedTab()?.view === view && this.pageLabelEl) {
          this.pageLabelEl.textContent = pageLabel(n, total);
        }
      },
      openLink: (target, pageId) => void this.followLink(target, pageId),
      links: this.pageLinks,
      // Feuille d'un groupe sans pages : un appui ouvre l'un de ses intercalaires.
      openDivider: (d) => void this.switchDividerAndRender(tab, d),
      onTrashed: (entry) => this.offerRestore(entry),
      rememberPage: (nb, d, n) => this.positions.record(nb, d, n),
      onConflictsChanged: () => this.paintConflictBadges(),
      ...(this.ocr ? { ocr: this.ocr } : {}),
      // Appui sur un calcul ou une courbe de la page : la calculatrice le rouvre.
      editLive: (block, update) => void this.loadCalculator().then((calc) => {
        this.placeCalculator(calc);
        if (block.type === "calc") calc.editCalc(calcSpecOf(block), (c: CalcSpec) => update(c));
        else calc.editGraph(graphSpecOf(block), (g: GraphSpec) => update(g));
      }),
    }, tab.notebook, tab.divider);
    await view.setNotice(this.noticeFor(tab.notebook));
    // Une vue quittee en echec sur ce meme intercalaire : la nouvelle reprend
    // sa file, pour qu'une seule vue ecrive ces pages. Une vue en lecture
    // seule n'ecrit rien : l'ancienne continue seule ses essais.
    for (const o of view.readOnly ? [] : [...this.orphans]) {
      if (o.notebook === tab.notebook && o.divider === tab.divider) {
        this.orphans.delete(o);
        await view.adopt(o);
      }
    }
    tab.view = view;
    view.setRenderMode(this.renderMode);
    await view.load(page);
  }

  /** L'onglet passe a un autre intercalaire, a la page qu'on y avait laissee. */
  private async switchDivider(tab: Tab, divider: string, page?: number): Promise<void> {
    dismissPageToasts();
    await tab.view?.flush();
    // La page quittee est retenue : on y revient en recliquant l'intercalaire.
    this.rememberTab(tab);
    tab.divider = divider;
    // La sous-bande suit l'intercalaire ouvert.
    tab.expanded = undefined;
    const legacy = page == null ? (await this.repo.readMeta(tab.notebook)).lastPosition : undefined;
    await this.mountView(tab, page ?? this.positions.pageFor(tab.notebook, divider, legacy));
    this.rememberTab(tab);
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
    dismissPageToasts();
    // Fermer quand meme : la page continue d'etre retentee et reste signalee.
    if (view?.hasUnsaved) this.orphans.add(view);
    this.dropTab(id);
    if (!this.tabs.length) { await this.showMenu(); return; }
    await this.renderNotebookScreen();
  }

  /** Retire l'onglet de la liste ; le panneau droit prend la place du gauche. */
  private dropTab(id: string): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const [gone] = this.tabs.splice(i, 1);
    // Dernier onglet de ce cahier : l'autre PC ne doit plus le croire ouvert.
    if (!this.tabs.some((t) => t.notebook === gone.notebook)) void this.leaveNotebook(gone.notebook);
    if (this.splitId === id) this.splitId = null;
    if (this.activeId === id) {
      if (this.splitId) { this.activeId = this.splitId; this.splitId = null; }
      else this.activeId = this.tabs[Math.max(0, i - 1)]?.id ?? null;
    }
    if (this.focusedId === id || !this.splitId) this.focusedId = this.activeId;
  }

  private paintTabs(): void {
    this.tabbar.replaceChildren();
    this.tabbar.append(el("button", {
      class: "ghost",
      title: titleOf("Menu", "menu"),
      onclick: () => void this.showMenu(),
    }, "Menu"));

    const focused = this.screen === "notebook" ? this.focusedTab() : undefined;
    for (const tab of this.tabs) {
      const node = el("div", {
        class: `tab${tab === focused ? " active" : this.screen === "notebook" && this.shown(tab) ? " shown" : ""}`,
        draggable: "true",
      },
        el("span", { class: "dot", style: { background: tab.color } }),
        // Le dernier niveau seulement : le chemin complet est dans l'infobulle.
        el("span", { class: "label", title: `${tab.title} · ${dividerLabel(tab.divider)}` },
          `${tab.title} · ${leafName(tab.divider)}`),
        el("button", {
          class: "close",
          title: titleOf("Fermer l'onglet", "closeTab"),
          onclick: (e: Event) => { e.stopPropagation(); void this.closeTab(tab.id); },
        }, "✕"),
      );
      // Un onglet deja a l'ecran prend la main ; un autre remplace celui du
      // panneau vise (le split ne se referme plus en cliquant l'onglet de droite).
      node.addEventListener("click", () => {
        if (this.screen === "notebook" && this.shown(tab)) { this.setFocused(tab.id); return; }
        this.place(tab);
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
    // Le split n'a de sens que sur l'ecran cahier.
    if (this.tabs.length && this.screen === "notebook") {
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
    if (!this.splitId || (this.focusedId !== tab.id && this.focusedId !== this.splitId)) this.focusedId = tab.id;
    this.screen = "notebook";
    this.paintTabs();

    clear(this.main);
    // Vue retiree (matiere renommee) : remontee a la page retenue.
    if (!tab.view) await this.mountView(tab, this.positions.pageFor(tab.notebook, tab.divider));
    const other = this.splitId ? this.tabs.find((t) => t.id === this.splitId) : undefined;
    if (this.splitId && !other) this.splitId = null;
    if (other && !other.view) await this.mountView(other, this.positions.pageFor(other.notebook, other.divider));
    const focused = this.focusedTab() ?? tab;
    const tree = await this.repo.listDividerTree(focused.notebook);
    // Outils a gauche, calculatrice a droite : la hauteur de l'ecran reste
    // a la feuille.
    const tools = this.buildToolbar();
    const calcSide = el("aside", { class: "side-calc closed" });
    const work = el("div", { class: "work" });
    this.main.append(this.buildDividerBar(focused, tree), work);
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
    if (other) panes.append(this.buildPane(other, true));
    work.append(tools, panes, calcSide);
    this.paintStatus();

    // La vue reprend son defilement : un passage par le menu ou un autre
    // onglet ne ramene plus en haut de l'intercalaire.
    for (const t of other ? [tab, other] : [tab]) {
      if (!t.view) continue;
      // Indicateur de zoom du panneau, a cote de la vue (pas dedans : il
      // defilerait avec les pages).
      t.host.append(t.view.root, t.view.zoomChip);
      t.view.attached();
    }
  }

  private buildPane(tab: Tab, isRight: boolean): HTMLElement {
    const pane = tab.host;
    pane.replaceChildren();
    pane.className = `pane${this.splitId && tab.id === this.focusedId ? " focused" : ""}`;
    // Hors split, l'onglet et la bande d'intercalaires disent deja ou l'on
    // est : l'en-tete de panneau ne ferait que prendre de la hauteur.
    if (this.splitId) pane.append(el("div", { class: "pane-head" },
      el("span", { class: "dot", style: { background: tab.color, width: "9px", height: "9px", borderRadius: "50%" } }),
      el("strong", {}, tab.title),
      el("span", { class: "muted" }, dividerLabel(tab.divider)),
      el("div", { class: "spacer" }),
      // Les deux commandes du split, une seule fois, sur le panneau droit.
      isRight
        ? el("button", { class: "ghost", title: titleOf("Permuter les panneaux", "swap"), onclick: () => void this.swapPanes() }, "Permuter")
        : null,
      isRight
        ? el("button", { class: "ghost", title: titleOf("Fermer le panneau droit", "closeSplit"), onclick: () => void this.closeSplit() }, "Fermer le panneau")
        : null,
    ));
    return pane;
  }

  /**
   * Ecouteurs du panneau d'un onglet, poses une seule fois (ils
   * s'accumulaient a chaque rendu) : le panneau touche prend la main, et
   * lacher un onglet sur la moitie droite ouvre le split (section 5).
   */
  private wirePane(tab: Tab): void {
    const pane = tab.host;
    pane.addEventListener("pointerdown", () => this.setFocused(tab.id), true);
    pane.addEventListener("focusin", () => this.setFocused(tab.id));
    const rightHalf = (e: DragEvent) => {
      const r = pane.getBoundingClientRect();
      return tab.id === this.splitId || e.clientX > r.left + r.width / 2;
    };
    pane.addEventListener("dragover", (e) => {
      e.preventDefault();
      // Fichier venu de l'Explorateur : c'est la page qui le prend, pas le split.
      if (e.dataTransfer?.types.includes("Files")) return;
      pane.classList.toggle("drop-target", rightHalf(e));
    });
    pane.addEventListener("dragleave", () => pane.classList.remove("drop-target"));
    pane.addEventListener("drop", (e) => {
      e.preventDefault();
      pane.classList.remove("drop-target");
      if (e.dataTransfer?.types.includes("Files")) { toast("Déposez l'image sur la feuille.", "warn"); return; }
      const id = e.dataTransfer?.getData("text/plain");
      if (!id || !this.tabs.some((t) => t.id === id)) return;
      if (rightHalf(e) && id !== this.activeId) {
        const opening = !this.splitId;
        this.splitId = id;
        this.focusedId = id;
        if (opening) this.foldCalculator();
        void this.renderNotebookScreen();
      } else if (!rightHalf(e)) {
        this.activeId = id;
        if (this.splitId === id) this.splitId = null;
        this.focusedId = id;
        void this.renderNotebookScreen();
      }
    });
  }

  /**
   * Bande d'intercalaires (D4, palier 2) : le premier niveau, puis, quand
   * un groupe est ouvert (E3A, S1), une sous-bande : fil d'Ariane, pages
   * du groupe lui-meme s'il en a, ses intercalaires et « + ». Deux rangees
   * au plus, quel que soit le niveau : la feuille garde sa hauteur.
   * Clavier : Tab, Entree, fleches (← → dans une rangee, ↓ vers la
   * sous-bande, ↑ vers la bande).
   */
  private buildDividerBar(tab: Tab, tree: DividerNode[]): HTMLElement {
    const strip = el("div", { class: "divider-strip", dataset: { notebook: tab.notebook } });
    let open = tab.expanded === undefined ? defaultExpanded(tree, tab.divider) : tab.expanded;
    // Groupe disparu ou vide (renomme dans l'explorateur) : celui par defaut.
    if (open && !findNode(tree, open)?.children.length) open = defaultExpanded(tree, tab.divider);
    if (open && !findNode(tree, open)?.children.length) open = null;

    const addNode = (row: HTMLElement, n: DividerNode, sibs: string[]) => {
      const group = n.children.length > 0;
      const opened = group && !!open && isUnder(open, n.path);
      const active = tab.divider === n.path || (group && isUnder(tab.divider, n.path));
      const node = el("button", {
        class: `divider-tab${active ? " active" : ""}${group ? " group" : ""}${opened ? " open" : ""}`,
        dataset: { divider: n.path, sib: "1", ...(group ? { group: "1" } : {}) },
        "aria-expanded": group ? String(opened) : null,
        title: (group
          ? `Groupe ${n.name} : un appui montre ses intercalaires. `
          : "")
          + "Glisser pour déplacer (au doigt ou au stylet : appui long puis glisser). "
          + "Appui long ou clic droit : ouvrir à droite, renommer, ranger dans un groupe, supprimer",
        onclick: (e: MouseEvent) => {
          if (group) this.toggleGroup(tab, n.path, opened, e.detail === 0);
          else void this.switchDividerAndRender(tab, n.path);
        },
      }, n.name, group ? el("span", { class: "chev", "aria-hidden": "true" }, opened ? "▾" : "▸") : null);
      this.wireDividerDrag(row, node, tab, n.path, sibs);
      row.append(node);
    };

    const top = el("div", { class: "dividers" });
    const topSibs = tree.map((n) => n.path);
    for (const n of tree) addNode(top, n, topSibs);
    top.append(el("button", {
      class: "divider-tab",
      title: titleOf("Nouvel intercalaire", "newDivider"),
      "aria-label": "Nouvel intercalaire",
      onclick: () => void this.newDivider(tab, ""),
    }, "+"));
    strip.append(top);

    if (open) {
      const group = findNode(tree, open)!;
      const sub = el("div", { class: "dividers sub", "aria-label": `Intercalaires de ${dividerLabel(open)}` });
      // Fil d'Ariane : le dernier niveau referme la sous-bande, un autre y remonte.
      for (const g of expandedChain(open)) {
        const last = g === open;
        sub.append(el("button", {
          class: `divider-crumb${last ? " current" : ""}`,
          title: last ? `Refermer ${leafName(g)}` : `Revenir à ${leafName(g)}`,
          onclick: (e: MouseEvent) => this.toggleGroup(tab, g, last, e.detail === 0),
        }, leafName(g), el("span", { class: "chev", "aria-hidden": "true" }, "›")));
      }
      // Le groupe a aussi ses propres pages : elles restent un intercalaire.
      if (group.pages) {
        sub.append(el("button", {
          class: `divider-tab own${tab.divider === open ? " active" : ""}`,
          dataset: { divider: open },
          title: `Pages rangées directement dans ${group.name}`,
          onclick: () => void this.switchDividerAndRender(tab, open!),
        }, `Pages de ${group.name}`));
      }
      const sibs = group.children.map((c) => c.path);
      for (const c of group.children) addNode(sub, c, sibs);
      if (depthOf(open) < MAX_DEPTH) {
        sub.append(el("button", {
          class: "divider-tab",
          title: `Nouvel intercalaire dans ${dividerLabel(open)}`,
          "aria-label": `Nouvel intercalaire dans ${dividerLabel(open)}`,
          onclick: () => void this.newDivider(tab, open!),
        }, "+"));
      }
      strip.append(sub);
    }
    strip.addEventListener("keydown", (e) => this.dividerKeys(e, strip));
    // Pastilles des copies de conflit, une fois la bande a l'ecran.
    queueMicrotask(() => { if (strip.isConnected) this.paintConflictBadges(); });
    return strip;
  }

  /** Fleches dans la bande d'intercalaires : sans souris ni doigt. */
  private dividerKeys(e: KeyboardEvent, strip: HTMLElement): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>("button");
    const row = btn?.parentElement;
    if (!btn || !row || !row.classList.contains("dividers")) return;
    const rows = [...strip.querySelectorAll<HTMLElement>(":scope > .dividers")];
    const items = [...row.querySelectorAll<HTMLElement>(":scope > button")];
    const i = items.indexOf(btn);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowRight") next = items[i + 1];
    else if (e.key === "ArrowLeft") next = items[i - 1];
    else if (e.key === "ArrowDown") {
      const below = rows[rows.indexOf(row) + 1];
      // Groupe ferme : ↓ l'ouvre et donne le focus a son premier intercalaire.
      if (btn.dataset.group && btn.getAttribute("aria-expanded") !== "true") { btn.click(); e.preventDefault(); return; }
      next = below?.querySelector<HTMLElement>(".divider-tab.active, .divider-tab[data-divider]") ?? undefined;
    } else if (e.key === "ArrowUp") {
      const above = rows[rows.indexOf(row) - 1];
      next = above?.querySelector<HTMLElement>(".divider-tab.open, .divider-tab.active") ?? undefined;
    } else return;
    e.preventDefault();
    next?.focus();
  }

  /**
   * Ouvre ou referme la sous-bande d'un groupe, sans changer de page.
   * Au clavier, le premier intercalaire du groupe prend le focus.
   */
  private toggleGroup(tab: Tab, path: string, opened: boolean, keyboard = false): void {
    tab.expanded = opened ? (parentPath(path) || null) : path;
    void this.repo.listDividerTree(tab.notebook).then((tree) => {
      const strip = this.main.querySelector(".divider-strip");
      if (!strip?.isConnected || (this.focusedTab() ?? this.activeTab()) !== tab) return;
      const next = this.buildDividerBar(tab, tree);
      strip.replaceWith(next);
      if (!keyboard) return;
      const target = opened
        ? next.querySelector<HTMLElement>(`[data-divider="${CSS.escape(path)}"]`)
        : next.querySelector<HTMLElement>(".dividers.sub .divider-tab[data-divider]");
      target?.focus();
    });
  }

  /**
   * « + » de la bande ou Ctrl+T : un intercalaire de plus, ouvert aussitot,
   * dans le groupe `parent` ("" = premier niveau). Un nom de groupe
   * facultatif le range dans un nouveau groupe (S1 → Chapitre 1).
   */
  private async newDivider(tab: Tab, parent = ""): Promise<void> {
    if (this.refuseLocked(tab.notebook) || document.querySelector(".backdrop")) return;
    const fields: DialogField[] = [{ name: "name", label: "Nom", value: "" }];
    if (depthOf(parent) + 2 <= MAX_DEPTH) {
      fields.push({
        name: "group", label: "Dans un nouveau groupe (facultatif)", value: "",
        placeholder: "ex. S1 : crée le dossier S1 qui le contient",
      });
    }
    const r = await askFields(parent ? `Nouvel intercalaire dans ${dividerLabel(parent)}` : "Nouvel intercalaire", fields, "Créer");
    if (!r || !r.name?.trim()) return;
    let d: string;
    try {
      const where = r.group?.trim() ? await this.repo.createDivider(tab.notebook, r.group, parent) : parent;
      d = await this.repo.createDivider(tab.notebook, r.name, where);
    } catch (e) {
      toast(`Création impossible : ${(e as Error).message}`, "warn", 5000);
      return;
    }
    await this.switchDividerAndRender(tab, d);
  }

  /**
   * Intercalaire glisse dans la bande pour le changer de place : a la souris
   * des qu'on bouge, au doigt et au stylet apres un appui long (sinon le
   * doigt fait defiler la bande). Appui long sans bouger, ou clic droit : le
   * menu de l'intercalaire, comme avant.
   */
  private wireDividerDrag(bar: HTMLElement, node: HTMLElement, tab: Tab, d: string, dividers: string[]): void {
    const HOLD_MS = 450, SLOP = 8;
    let st: {
      id: number; type: string; x: number; y: number; scroll: number;
      armed: boolean; dragging: boolean; timer: ReturnType<typeof setTimeout> | null;
    } | null = null;
    /** Le clic qui suit un glisser ou un menu ne change pas d'intercalaire. */
    let swallow = false;
    // Seulement les voisins de la meme rangee (meme groupe).
    const tabs = () => [...bar.querySelectorAll<HTMLElement>(":scope > .divider-tab[data-sib]")];
    const from = () => dividers.indexOf(d);
    const target = (x: number) => {
      const centers = tabs().map((t) => { const r = t.getBoundingClientRect(); return r.left + r.width / 2; });
      return dropIndex(centers, from(), x);
    };
    const paintDrop = (x: number) => {
      const to = target(x);
      tabs().forEach((t, i) => {
        t.classList.toggle("drop-before", i === to && to < from());
        t.classList.toggle("drop-after", i === to && to > from());
      });
    };
    const end = () => {
      if (st?.timer) clearTimeout(st.timer);
      st = null;
      node.classList.remove("lifted", "dragging");
      node.style.transform = "";
      for (const t of tabs()) t.classList.remove("drop-before", "drop-after");
    };
    const startDrag = () => {
      if (!st) return;
      st.dragging = true;
      node.classList.add("dragging");
    };

    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      swallow = false;
      st = {
        id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, scroll: bar.scrollLeft,
        armed: false, dragging: false, timer: null,
      };
      // Le geste reste a l'onglet meme s'il en sort (glisser, defiler la bande).
      try { node.setPointerCapture(e.pointerId); } catch { /* pointeur deja parti */ }
      const mine = st;
      st.timer = setTimeout(() => {
        if (st !== mine) return;
        mine.timer = null;
        mine.armed = true;
        node.classList.add("lifted");
      }, HOLD_MS);
    });
    node.addEventListener("pointermove", (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x;
      if (!st.dragging) {
        if (Math.hypot(dx, e.clientY - st.y) <= SLOP) return;
        if (st.type === "mouse" || st.armed) startDrag();
        else {
          // Doigt ou stylet qui bouge avant l'appui long : il fait defiler la bande.
          if (st.timer) clearTimeout(st.timer);
          st.timer = null;
          bar.scrollLeft = st.scroll - dx;
          swallow = true;
          return;
        }
      }
      if (!st.dragging) return;
      node.style.transform = `translateX(${dx + (bar.scrollLeft - st.scroll)}px)`;
      paintDrop(e.clientX);
    });
    node.addEventListener("pointerup", (e) => {
      if (!st || e.pointerId !== st.id) return;
      const { dragging, armed } = st;
      const x = e.clientX;
      const to = dragging ? target(x) : from();
      end();
      if (dragging) {
        swallow = true;
        if (to !== from()) void this.reorderDivider(tab, d, to);
      } else if (armed) {
        // Appui long sans glisser : le menu de l'intercalaire.
        swallow = true;
        void this.dividerMenu(tab, d, dividers);
      }
    });
    node.addEventListener("pointercancel", () => end());
    node.addEventListener("click", (e) => {
      if (!swallow) return;
      swallow = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);
    // Clic droit (souris) : le menu. Le doigt maintenu declenche aussi
    // contextmenu sous Windows : le relachement s'en occupe deja.
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (st && st.type !== "mouse") return;
      end();
      void this.dividerMenu(tab, d, dividers);
    });
  }

  /** Intercalaire glisse a une autre place ; l'ordre est ecrit dans cahier.json. */
  private async reorderDivider(tab: Tab, d: string, index: number): Promise<void> {
    if (this.refuseLocked(tab.notebook)) return;
    const order = moveAmongSiblings(await this.repo.listDividers(tab.notebook), d, index);
    try {
      await this.repo.reorderDividers(tab.notebook, order);
    } catch (e) {
      toast(`Déplacement impossible : ${(e as Error).message}`, "err", 6000);
      return;
    }
    await this.renderNotebookScreen();
  }

  /**
   * Menu d'un intercalaire : a droite, renommer, deplacer parmi ses voisins,
   * ranger dans un groupe ou l'en sortir (D4), supprimer.
   */
  private async dividerMenu(tab: Tab, d: string, dividers: string[]): Promise<void> {
    const i = dividers.indexOf(d);
    const holder = this.tabs.find((t) => t.notebook === tab.notebook && t.divider === d);
    const left = this.activeTab();
    const node = findNode(await this.repo.listDividerTree(tab.notebook), d);
    const isGroup = !!node?.children.length;
    const options: { value: string; label: string }[] = [];
    // Cours a gauche, Exos a droite (section 5) : pas pour l'intercalaire
    // deja a gauche, ni pour celui deja a droite, ni pour un simple groupe.
    if ((!isGroup || node?.pages) && holder?.id !== left?.id && (!holder || holder.id !== this.splitId)) {
      options.push({ value: "right", label: "Ouvrir à droite" });
    }
    options.push({ value: "rename", label: "Renommer" });
    if (i > 0) options.push({ value: "left", label: "Déplacer à gauche" });
    if (i >= 0 && i < dividers.length - 1) options.push({ value: "next", label: "Déplacer à droite" });
    if (isGroup && depthOf(d) < MAX_DEPTH) options.push({ value: "add", label: `Nouvel intercalaire dans ${node!.name}` });
    options.push({ value: "group", label: "Ranger dans un groupe…" });
    if (parentPath(d)) options.push({ value: "out", label: `Sortir de ${leafName(parentPath(d))}` });
    options.push({ value: "delete", label: isGroup ? "Supprimer le groupe" : "Supprimer l'intercalaire" });
    const choice = await pick(dividerLabel(d), options);
    if (choice && choice !== "right" && this.refuseLocked(tab.notebook)) return;
    if (choice === "right") {
      await this.openRight(tab.notebook, d);
    } else if (choice === "rename") {
      const next = await askText(isGroup ? "Renommer le groupe" : "Renommer l'intercalaire", "Nouveau nom", leafName(d));
      if (next) await this.renameDivider(tab, d, next);
    } else if (choice === "left" || choice === "next") {
      await this.moveDivider(tab, d, choice === "left" ? -1 : 1, dividers);
    } else if (choice === "add") {
      await this.newDivider(tab, d);
    } else if (choice === "group") {
      await this.chooseGroupFor(tab, d);
    } else if (choice === "out") {
      await this.moveDividerTo(tab, d, parentPath(parentPath(d)));
    } else if (choice === "delete") {
      const inside = node ? flattenTree(node.children).length : 0;
      const ok = await confirmDialog(
        isGroup ? "Supprimer le groupe" : "Supprimer l'intercalaire",
        `${dividerLabel(d)} et toutes ses pages${inside ? `, avec ${inside} intercalaire${inside > 1 ? "s" : ""} rangé${inside > 1 ? "s" : ""} dedans,` : ""} `
          + "partent à la corbeille (dossier ESEO/.corbeille). "
          + "Le bouton « Annuler » du message qui suit le remet en place.",
        "Supprimer",
      );
      if (ok) await this.deleteDivider(tab, d);
    }
  }

  /** Change l'intercalaire de place parmi ses voisins ; l'ordre est ecrit dans cahier.json. */
  private async moveDivider(tab: Tab, d: string, delta: number, siblings: string[]): Promise<void> {
    const i = siblings.indexOf(d);
    if (i < 0) return;
    const order = moveAmongSiblings(await this.repo.listDividers(tab.notebook), d, i + delta);
    try {
      await this.repo.reorderDividers(tab.notebook, order);
    } catch (e) {
      toast(`Déplacement impossible : ${(e as Error).message}`, "err", 6000);
      return;
    }
    await this.renderNotebookScreen();
  }

  /**
   * « Ranger dans un groupe » : les groupes ou il peut aller (3 niveaux au
   * plus), un nouveau groupe a son niveau, ou le premier niveau.
   */
  private async chooseGroupFor(tab: Tab, d: string): Promise<void> {
    const tree = await this.repo.listDividerTree(tab.notebook);
    const node = findNode(tree, d);
    if (!node) return;
    const height = subtreeHeight(node);
    const options: { value: string; label: string }[] = flattenTree(tree)
      .filter((p) => findNode(tree, p)!.children.length && !moveRefusal(d, p, height))
      .map((p) => ({ value: `g:${p}`, label: dividerLabel(p) }));
    if (depthOf(d) + height <= MAX_DEPTH) options.push({ value: "new", label: "Nouveau groupe…" });
    if (parentPath(d)) options.push({ value: "top", label: "Premier niveau de la matière" });
    if (!options.length) {
      toast(`Aucun groupe possible : au plus ${MAX_DEPTH} niveaux sous la matière`, "warn", 4000);
      return;
    }
    const choice = await pick(`Ranger ${leafName(d)} dans…`, options);
    if (!choice) return;
    if (choice === "top") { await this.moveDividerTo(tab, d, ""); return; }
    if (choice.startsWith("g:")) { await this.moveDividerTo(tab, d, choice.slice(2)); return; }
    const name = await askText("Nouveau groupe", `Nom du groupe qui contiendra ${leafName(d)}`, "");
    if (!name?.trim()) return;
    let group: string;
    try {
      group = await this.repo.createDivider(tab.notebook, name, parentPath(d));
    } catch (e) {
      toast(`Création impossible : ${(e as Error).message}`, "warn", 5000);
      return;
    }
    await this.moveDividerTo(tab, d, group);
  }

  /**
   * Range l'intercalaire (ou le groupe) dans `toParent` : le dossier reel
   * est deplace. Ce qui attend d'etre ecrit l'est d'abord, puis les vues
   * concernees sont remontees sur le nouveau chemin.
   */
  private async moveDividerTo(tab: Tab, d: string, toParent: string): Promise<void> {
    if (this.refuseLocked(tab.notebook)) return;
    if (!(await this.settle(tab.notebook, d, "déplacement annulé", true))) return;
    let applied: string;
    try {
      applied = await this.repo.moveDivider(tab.notebook, d, toParent);
    } catch (e) {
      toast(`Déplacement impossible : ${(e as Error).message}`, "warn", 5000);
      return;
    }
    await this.retarget(tab.notebook, d, applied);
    for (const t of this.tabs) if (t.notebook === tab.notebook) t.expanded = undefined;
    // On voit ou il est arrive.
    tab.expanded = toParent || undefined;
    toast(`${leafName(d)} rangé dans ${toParent ? dividerLabel(toParent) : "le premier niveau"}`, "info", 2500);
    await this.renderNotebookScreen();
  }

  /**
   * Un intercalaire (et tout son contenu) a change de chemin : onglets,
   * vues, positions et historique suivent.
   */
  private async retarget(notebook: string, from: string, to: string): Promise<void> {
    for (const t of this.tabs.filter((x) => x.notebook === notebook)) {
      if (t.expanded) t.expanded = renamePrefix(t.expanded, from, to);
      if (!isUnder(t.divider, from)) continue;
      const next = renamePrefix(t.divider, from, to);
      // Une ecriture tardive de l'ancienne vue va dans le nouveau dossier.
      if (t.view) t.view.divider = next;
      t.divider = next;
      await this.mountView(t, t.view?.pageNumber);
    }
    this.positions.renameDivider(notebook, from, to);
    this.nav.renameDivider(notebook, from, to);
  }

  /**
   * Ouvre un intercalaire dans le panneau droit : l'onglet qui le tient
   * deja, sinon un nouvel onglet. La calculatrice ancree se replie, la
   * feuille de droite a besoin de la place.
   */
  private async openRight(notebook: string, d: string): Promise<void> {
    const left = this.activeTab();
    if (!left) return;
    let tab = this.tabs.find((t) => t.notebook === notebook && t.divider === d);
    if (tab?.id === left.id) return;
    if (!tab) {
      const meta = await this.repo.readMeta(notebook);
      tab = this.makeTab(notebook, meta, d);
      this.tabs.push(tab);
      await this.mountView(tab, this.positions.pageFor(notebook, d, meta.lastPosition));
    }
    if (!this.splitId) this.foldCalculator();
    this.splitId = tab.id;
    this.focusedId = tab.id;
    tab.used = Date.now();
    await this.renderNotebookScreen();
    this.rememberTab(tab);
  }

  /** Split ouvert sur le portable : la calculatrice ancree laisse sa colonne. */
  private foldCalculator(): void {
    if (this.calculator?.isVisible && this.calculator.isDocked) this.calculator.hide();
  }

  /**
   * Renomme le dossier reel. Ce qui attend d'etre ecrit l'est d'abord, puis
   * la vue est remontee sur le nouveau nom : sinon la frappe suivante
   * recreait l'ancien dossier et y partait.
   */
  private async renameDivider(tab: Tab, d: string, next: string): Promise<void> {
    if (!(await this.settle(tab.notebook, d, "renommage annulé", true))) return;
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
      else if (wanted !== leafName(d)) toast("Un intercalaire porte déjà ce nom à cet endroit", "warn");
      return;
    }
    // Tous les onglets sur cet intercalaire ou dans ce groupe (gauche et droite).
    await this.retarget(tab.notebook, d, applied);
    await this.renderNotebookScreen();
  }

  /**
   * L'intercalaire part a la corbeille avec ce qu'on vient d'ecrire : la file
   * est videe sur le disque, puis abandonnee, pour qu'aucune ecriture
   * tardive ne recree le dossier.
   */
  private async deleteDivider(tab: Tab, d: string): Promise<void> {
    for (const v of this.holders(tab.notebook, d, true)) {
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
    const nb = tab.notebook;
    this.positions.dropDivider(nb, d);
    this.nav.drop(nb, d);
    const restTree = await this.repo.listDividerTree(nb);
    // D'abord un intercalaire qui a des pages (pas un simple groupe).
    const rest = [...new Set([...openableDividers(restTree), ...flattenTree(restTree)])];
    for (const t of this.tabs.filter((x) => x.notebook === nb)) {
      if (t.expanded && isUnder(t.expanded, d)) t.expanded = undefined;
    }
    for (const t of this.tabs.filter((x) => x.notebook === nb && isUnder(x.divider, d))) {
      // Un intercalaire qu'aucun autre onglet ne montre ; sinon l'onglet part.
      const free = rest.find((x) => !this.tabs.some((o) => o.notebook === nb && o.divider === x));
      if (free || this.tabs.filter((o) => o.notebook === nb).length === 1) {
        t.divider = free ?? await this.repo.createDivider(nb, "Cours");
        await this.mountView(t, this.positions.pageFor(nb, t.divider));
      } else {
        await t.view?.dispose();
        this.dropTab(t.id);
      }
    }
    if (this.tabs.length) await this.renderNotebookScreen();
    else await this.showMenu();
    this.offerRestore(entry);
  }

  /** Message « Annuler » de 8 s apres une suppression (page, intercalaire, matiere). */
  private offerRestore(entry: TrashEntry): void {
    const what = entry.kind === "notebook" ? `Matière ${entry.dir} mise à la corbeille`
      : entry.page != null
        ? `Page ${entry.page} de ${dividerLabel(entry.divider)} mise à la corbeille`
        : `Intercalaire ${dividerLabel(entry.divider)} mis à la corbeille`;
    // Restaurer passe par le disque, depuis n'importe quel ecran : le
    // message survit au retour au menu.
    toast(what, "info", 8000, { label: "Annuler", run: () => void this.restore(entry) }, `${APP_TOAST}trash-${Date.now()}`);
  }

  private async restore(entry: TrashEntry): Promise<void> {
    if (entry.kind === "notebook") {
      try {
        const name = await this.repo.restoreNotebook(entry);
        toast(`Matière ${name} restaurée`);
      } catch (e) {
        toast(`Restauration impossible : ${(e as Error).message}. La matière reste dans ESEO/.corbeille.`, "err", 8000);
      }
      if (this.screen === "menu") await this.showMenu();
      return;
    }
    const tab = this.tabs.find((t) => t.notebook === entry.dir && t.divider === entry.divider)
      ?? this.tabs.find((t) => t.notebook === entry.dir);
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
        toast(`Page ${n} de ${dividerLabel(entry.divider)} restaurée`);
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
    toast(`Intercalaire ${dividerLabel(name)} restauré`);
    if (!tab || this.screen !== "notebook") return;
    // Un groupe sans pages propres : sa sous-bande s'ouvre, la page reste.
    const node = findNode(await this.repo.listDividerTree(tab.notebook), name);
    if (node && !node.pages) {
      tab.expanded = name;
      await this.renderNotebookScreen();
    } else {
      await this.switchDividerAndRender(tab, name);
    }
  }

  /**
   * Clic sur un intercalaire. Deja ouvert dans un autre onglet : cet onglet
   * prend la place (jamais deux vues sur le meme intercalaire).
   */
  private async switchDividerAndRender(tab: Tab, d: string): Promise<void> {
    if (tab.divider === d) return;
    const holder = this.tabs.find((t) => t !== tab && t.notebook === tab.notebook && t.divider === d);
    if (holder) {
      this.rememberTab(tab);
      this.place(holder);
    } else {
      await this.switchDivider(tab, d);
      this.place(tab);
    }
    await this.renderNotebookScreen();
  }

  /* ---------------- matieres (menu) ---------------- */

  /** Nouvelle matiere ; si elle existe deja, elle s'ouvre telle quelle. */
  private async createNotebook(title: string, color: string): Promise<void> {
    let dir: string;
    try {
      const existing = await this.repo.findDir(title);
      if (existing && await this.repo.isNotebook(existing)) toast(`${existing} existe déjà : la voici`, "info");
      dir = await this.repo.createNotebook(title, color);
      if (!(await this.repo.listDividers(dir)).length) await this.repo.createDivider(dir, "Cours");
    } catch (e) {
      toast(`Création impossible : ${(e as Error).message}`, "err", 6000);
      return;
    }
    await this.openNotebook(dir);
  }

  /**
   * Toutes les vues d'une matiere ont ecrit ? Avant de deplacer ou de
   * supprimer son dossier. Faux (et un message) si une page reste refusee.
   */
  private async settleNotebook(dir: string, cancelled: string): Promise<boolean> {
    const held = this.views().filter((v) => v.notebook === dir);
    for (const v of held) await v.flush();
    if (!held.some((v) => v.hasUnsaved)) return true;
    toast(`Une page n'est pas encore enregistrée : ${cancelled} pour ne rien perdre. Réessaie dans un instant.`, "err", 6000);
    return false;
  }

  /** Renomme une matiere (titre et dossier) ; ses onglets suivent. */
  private async renameNotebook(dir: string, title: string): Promise<void> {
    if (this.refuseLocked(dir)) return;
    if (!(await this.settleNotebook(dir, "renommage annulé"))) return;
    const open = this.tabs.filter((t) => t.notebook === dir);
    let next: string;
    try {
      next = await this.repo.renameNotebook(dir, title);
    } catch (e) {
      toast(`Renommage impossible : ${(e as Error).message}`, "err", 6000);
      return;
    }
    if (next !== dir) {
      // Les vues tenaient l'ancien chemin : elles sont refaites au prochain
      // affichage (rien n'attendait, voir settleNotebook).
      for (const t of open) {
        await t.view?.dispose();
        t.view = null;
        t.notebook = next;
      }
      this.positions.renameNotebook(dir, next);
      this.nav.renameNotebook(dir, next);
      // Le fichier de presence a suivi le dossier ; son etat suit le nom.
      const state = this.present.get(dir);
      if (state) { this.present.delete(dir); this.present.set(next, state); }
    }
    for (const t of open) t.title = title.trim();
    toast(`Matière renommée : ${title.trim()}`);
    if (this.screen === "menu") await this.showMenu();
  }

  private async setNotebookColor(dir: string, color: string): Promise<void> {
    if (this.refuseLocked(dir)) return;
    try {
      await this.repo.setNotebookColor(dir, color);
    } catch (e) {
      toast(`Couleur non enregistrée : ${(e as Error).message}`, "err", 6000);
      return;
    }
    for (const t of this.tabs) if (t.notebook === dir) t.color = color;
    if (this.screen === "menu") await this.showMenu();
  }

  /** Toute la matiere a la corbeille, ses onglets fermes ; « Annuler » la remet. */
  private async deleteNotebook(dir: string): Promise<void> {
    if (this.refuseLocked(dir)) return;
    const title = (await this.repo.readMeta(dir)).title;
    const ok = await confirmDialog(
      "Supprimer la matière",
      `${title} et toutes ses pages partent à la corbeille (dossier ESEO/.corbeille). `
        + "Le bouton « Annuler » du message qui suit la remet en place.",
      "Supprimer",
    );
    if (!ok || !(await this.settleNotebook(dir, "suppression annulée"))) return;
    for (const v of this.views().filter((x) => x.notebook === dir)) v.discard();
    for (const t of this.tabs.filter((x) => x.notebook === dir)) {
      await t.view?.dispose();
      this.dropTab(t.id);
    }
    let entry: TrashEntry;
    try {
      entry = await this.repo.deleteNotebook(dir);
    } catch (e) {
      toast(`Suppression impossible : ${(e as Error).message}`, "err", 6000);
      await this.showMenu();
      return;
    }
    this.nav.drop(dir);
    await this.showMenu();
    this.offerRestore(entry);
  }

  /** « En faire une matiere » : le dossier recoit son cahier.json. */
  private async adoptNotebook(dir: string, title: string, color: string): Promise<void> {
    try {
      await this.repo.adoptNotebook(dir, color, title);
    } catch (e) {
      toast(`Impossible : ${(e as Error).message}`, "err", 6000);
      return;
    }
    toast(`${title} est maintenant une matière`);
    await this.showMenu();
  }

  /**
   * Nettoyage propose par le menu : ces dossiers sans page redeviennent des
   * « Autres dossiers ». Leur cahier.json part a la corbeille, « Annuler »
   * les remet. Une matiere ouverte dans un onglet n'est pas touchee.
   */
  private async unmarkNotebooks(dirs: string[]): Promise<void> {
    const entries: TrashEntry[] = [];
    for (const d of dirs) {
      if (this.tabs.some((t) => t.notebook === d)) continue;
      try { entries.push(await this.repo.unmarkNotebook(d)); } catch { /* fichier deja parti */ }
    }
    await this.showMenu();
    if (!entries.length) return;
    toast(`${entries.length > 1 ? `${entries.length} dossiers rangés` : "Dossier rangé"} dans « Autres dossiers »`,
      "info", 8000, {
        label: "Annuler",
        run: () => void (async () => {
          for (const e of entries) { try { await this.repo.restoreMeta(e); } catch { /* deja remis */ } }
          if (this.screen === "menu") await this.showMenu();
        })(),
      });
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
    const view = () => this.focusedTab()?.view;
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
      toolButton("eraser", "Gomme", "Effacer les traits touchés (Alt+G ; deux fois : trait entier ou précise). "
        + "Le bout gomme du stylet gomme aussi."),
      toolButton("region", "Zone math",
        "Entourer une formule manuscrite pour la convertir (Alt+Z). Une zone, puis retour au stylo ; "
          + "deux fois pour enchaîner plusieurs zones."),
      toolButton("textregion", "Zone texte",
        "Entourer du texte manuscrit pour le convertir (Alt+T). Une zone, puis retour au stylo ; "
          + "deux fois pour enchaîner plusieurs zones."),
      el("button", {
        class: isSelect(this.tool) ? "on" : "",
        title: "Lasso (Alt+A) : entourer des traits, puis les déplacer, les retailler par la poignée, "
          + "les recolorer, Suppr, Ctrl+C / Ctrl+V. Deux fois : insérer de l'espace.",
        onclick: () => this.selectTool(isSelect(this.tool) ? this.tool : "lasso"),
      }, "Lasso"),
    );
    // Options de l'outil : gomme entiere ou precise, lasso ou espace.
    if (this.tool === "eraser") {
      bar.append(el("div", { class: "seg tool-opt" }, ...([
        ["stroke", "Trait entier", "La gomme efface tout le trait touché"],
        ["precise", "Précise", "La gomme coupe le trait : seule la partie frottée part"],
      ] as const).map(([m, label, title]) => el("button", {
        class: this.eraserMode === m ? "on" : "", title, "aria-pressed": String(this.eraserMode === m),
        onclick: () => this.setEraserMode(m),
      }, label))));
    }
    if (isSelect(this.tool)) {
      bar.append(el("div", { class: "seg tool-opt" }, ...([
        ["lasso", "Entourer", "Entourer des traits pour les déplacer, recolorer, copier, supprimer"],
        ["space", "Espace", "Glisser une ligne vers le bas : tout ce qui est dessous descend"],
      ] as const).map(([t, label, title]) => el("button", {
        class: this.tool === t ? "on" : "", title, "aria-pressed": String(this.tool === t),
        onclick: () => this.selectTool(t),
      }, label))));
    }
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
    // Grille de 4 : chaque pastille fait 44 px dans les deux sens (six sur
    // une ligne n'y tenaient qu'a 32 px), la legende finit la seconde ligne.
    const swatches = el("div", { class: "swatches" });
    swatches.append(keep(el("button", {
      class: `swatch${this.color === "normal" ? " on" : ""}`,
      title: "Normal, en noir (Alt+0) : encre et texte tapé",
      "aria-label": "Normal, en noir",
      onclick: () => this.pickColor(null),
    }, el("i", { style: { background: NEUTRAL_INK.ink } }))));
    for (const p of PALETTE) {
      swatches.append(keep(el("button", {
        class: `swatch${this.color === p.key ? " on" : ""}`,
        title: `${p.label} (Alt+${p.shortcut}) : encre et texte tapé`,
        "aria-label": p.label,
        onclick: () => this.pickColor(p.key),
      }, el("i", { style: { background: p.ink } }))));
    }
    // Le sens de la couleur, a l'ecran : au doigt, aucune infobulle.
    swatches.append(el("div", { class: "swatch-legend small muted" },
      el("span", {}, labelOf(this.color)), el("span", {}, `Alt+${shortcutOf(this.color)}`)));
    bar.append(swatches);

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
    // l'indicateur ouvre la liste des pages (comme Ctrl+G).
    const v = view();
    this.pageLabelEl = el("button", {
      class: "page-label ghost",
      title: titleOf("Liste des pages : numéro, date, première ligne", "goto"),
      onclick: () => void this.showPageList(),
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

    // Ruban Maths, repliable ; l'etat est retenu sur cette machine. Ou il
    // va (mathLayout) : sous les outils, a cote (seconde sous-colonne), ou
    // en volet par-dessus la page quand la colonne est trop basse.
    const layout = this.mathLayout();
    const fly = layout === "fly";
    const mathOpen = fly ? this.mathFly : this.settings.mathOpen;
    const maths = el("div", { class: `math-section${fly ? " fly" : ""}${mathOpen ? " open" : ""}` },
      el("button", {
        class: "section-toggle",
        "aria-expanded": String(mathOpen),
        title: mathOpen ? "Replier le ruban Maths" : "Déplier le ruban Maths",
        onclick: () => {
          if (fly) { this.setMathFly(!this.mathFly); return; }
          this.settings.mathOpen = !this.settings.mathOpen;
          saveSettings(this.settings);
          this.paintToolbar();
        },
      }, el("span", {}, "Maths"), el("span", { class: "chevron" }, fly ? (mathOpen ? "◂" : "▸") : mathOpen ? "▾" : "▸")),
      mathOpen ? buildMathBar(() => this.focusedTab()?.view?.activeDoc) : null,
    );

    // Outils a gauche : la hauteur de l'ecran reste a la feuille.
    const twoCols = layout === "side" && mathOpen;
    return el("aside", { class: `side-tools${twoCols ? " two-cols" : ""}` }, bar, maths);
  }

  /**
   * Place du ruban Maths. Sous les outils, il obligeait a faire defiler la
   * colonne en 1366x768. A cote (seconde sous-colonne) quand la feuille
   * garde sa largeur de lecture ; sinon (split, ecran etroit) sous les
   * outils si la hauteur le permet, ou en volet par-dessus la page.
   */
  private mathLayout(): "side" | "below" | "fly" {
    const w = window.innerWidth, h = window.innerHeight;
    if (!this.splitId && w >= 1240 && w > h) return "side";
    return h >= 1000 ? "below" : "fly";
  }

  /**
   * Ruban Maths en volet : ouvert ou ferme (pas retenu, c'est un volet).
   * Echap, le bouton « Maths » ou un appui hors du volet le ferme ; les
   * touches du ruban le laissent ouvert (plusieurs symboles de suite).
   */
  private setMathFly(open: boolean): void {
    if (this.mathFly === open) return;
    this.mathFly = open;
    this.paintToolbar();
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".math-section")) return;
      document.removeEventListener("pointerdown", outside, true);
      if (this.mathFly) this.setMathFly(false);
    };
    document.addEventListener("pointerdown", outside, true);
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
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); backToPage(); }
    };
    const close = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const view = () => this.focusedTab()?.view;
    /** Le clavier revient a la page : ce qu'on tape ensuite n'est pas perdu. */
    const backToPage = () => {
      if (this.screen !== "notebook" || document.querySelector(".backdrop")) return;
      if (!isEditingDoc(document.activeElement)) view()?.focusText();
    };

    // Une action ferme le menu avant de s'executer : un dialogue qui suit
    // ne s'ouvre pas sous lui.
    const action = (label: string, title: string, run: () => void, cls = "") =>
      el("button", { class: `more-item ${cls}`.trim(), title, role: "menuitem", onclick: () => { close(); run(); } }, label);
    // Un reglage aussi : choisi, il s'applique, le menu se ferme et la page
    // reprend le clavier (on choisit un fond, on continue d'ecrire).
    const segment = (name: string, title: string, options: [string, boolean, () => unknown][], titles?: string[]) =>
      el("div", { class: "more-seg", title },
        el("span", { class: "small muted" }, name),
        el("div", { class: `seg${options.length > 3 ? " wrap" : ""}` }, ...options.map(([label, on, run], i) => el("button", {
          class: on ? "on" : "",
          title: titles?.[i],
          "aria-pressed": String(on),
          onclick: async () => {
            close();
            if (!on) await run();
            backToPage();
          },
        }, label))),
      );

    const paint = () => {
      const mode = view()?.mode ?? "pages";
      const calcShown = !!this.calculator?.isVisible;
      // Deux colonnes : les actions, les reglages. Le menu tient dans un
      // ecran de 768 px de haut sans defiler.
      const actions = el("div", { class: "more-col" });
      const settings = el("div", { class: "more-col" });
      panel.replaceChildren(actions, settings);
      actions.append(
        action("Photo du tableau", `Photos redressées et lues, posées dans le texte (${PHOTO_IMPORT_KEYS})`, () => void this.importImage()),
        action("Importer un PDF", titleOf("Sujet de TD, poly, datasheet : pages insérées après la page courante, à annoter", "importPdf"),
          () => void this.importPdf()),
        action(calcShown ? "Fermer la calculatrice" : "Calculatrice", titleOf("Calculatrice", "calc"),
          () => void this.toggleCalculator()),
        action("Insérer une page ici", titleOf("Insérer une page après la page courante", "insertPage"),
          () => void view()?.newPage(true)),
        action("Liste des pages…", titleOf("Toutes les pages : numéro, date, première ligne", "goto"),
          () => void this.showPageList()),
        action("Exporter la page (PDF)", titleOf("La page courante, puis « Enregistrer au format PDF »", "exportPage"),
          () => void view()?.exportPdf("current")),
        action("Exporter l'intercalaire (PDF)", titleOf("Toutes les pages de l'intercalaire", "exportAll"),
          () => void view()?.exportPdf("all")),
        action("Exporter la page (Word)", titleOf("Document Word éditable : titres, listes, équations, encre en images", "exportWord"),
          () => void this.exportWord(view(), "current")),
        action("Exporter l'intercalaire (Word)", titleOf("Toutes les pages dans un document Word, une page par page", "exportWordAll"),
          () => void this.exportWord(view(), "all")),
        el("div", { class: "sep" }),
        action("Raccourcis clavier", "Fiche des raccourcis (F1)", () => showShortcuts()),
        action("Sonde stylet (diagnostic)", "Ce que renvoie l'écran : type de pointeur, pression, points",
          () => this.showProbe()),
        // En bas, loin des autres actions : un appui de travers au stylet
        // ne doit pas tomber dessus.
        el("div", { class: "sep" }),
        action("Supprimer la page", "La page part à la corbeille (ESEO/.corbeille), « Annuler » la remet en place",
          () => void view()?.deleteCurrentPage(), "danger"),
      );
      settings.append(
        segment("Affichage", titleOf("Une page à la fois, ou toutes les pages à la suite", "viewMode"), [
          ["Pages", mode === "pages", () => this.setViewMode("pages")],
          ["Défilement", mode === "scroll", () => this.setViewMode("scroll")],
        ]),
        segment("Fond de page", "Fond de cet intercalaire, sous l'encre ; aussi à l'export PDF, très clair",
          PAPERS.map((p): [string, boolean, () => unknown] =>
            [p.label, (view()?.paper ?? "uni") === p.kind, () => view()?.setPaper(p.kind)]),
          PAPERS.map((p) => p.title)),
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
      );
      place();
    };
    // A droite de la colonne, sans sortir de l'ecran (ni a droite ni en bas).
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const col = anchor.closest(".side-tools")?.getBoundingClientRect();
      const left = (col?.right ?? r.right) + 6;
      panel.style.left = `${Math.round(Math.max(8, Math.min(left, window.innerWidth - panel.offsetWidth - 8)))}px`;
      const h = panel.offsetHeight;
      panel.style.top = `${Math.round(Math.max(8, Math.min(r.top, window.innerHeight - h - 8)))}px`;
    };

    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    paint();
  }

  /**
   * Import de photos prises au telephone (une ou plusieurs) : recadrage,
   * redressement, OCR, un dialogue par photo. Chaque photo validee est
   * posee aussitot dans la page du panneau vise.
   */
  /**
   * Import d'un PDF (priorite 3) dans le panneau vise (ou celui sous le
   * depot) : pages choisies, inserees apres la page courante.
   */
  private async importPdf(file?: File, at?: EventTarget | null): Promise<void> {
    const pane = at instanceof Element ? at.closest(".pages") : null;
    const view = (pane && this.tabs.find((t) => t.view?.root === pane)?.view) || this.focusedTab()?.view;
    if (!view) return;
    if (this.refuseLocked(view.notebook)) return;
    const { importPdf } = await import("./pdf-import");
    await importPdf(this.repo, view, file);
  }

  /**
   * Export Word (.docx) de la page courante ou de tout l'intercalaire.
   * Module charge a la demande : rien au demarrage (batterie, memoire).
   */
  private async exportWord(view: PageView | null | undefined, scope: "current" | "all"): Promise<void> {
    if (!view) return;
    try {
      const [{ exportDividerDocx }, src, meta] = await Promise.all([
        import("./docx-export"), view.docxSources(), this.repo.readMeta(view.notebook).catch(() => null),
      ]);
      await exportDividerDocx({
        repo: this.repo, notebook: view.notebook, notebookTitle: meta?.title || view.notebook,
        divider: view.divider, scope, current: src.current, shown: src.pages,
      });
    } catch (e) {
      toast(`Export Word impossible : ${(e as Error).message ?? e}`, "err", 6000);
    }
  }

  private async importImage(): Promise<void> {
    const view = this.focusedTab()?.view;
    if (!view) return;
    const { importPhotos } = await import("./image-import");
    await importPhotos({
      ...(this.ocr ? { ocr: this.ocr } : {}),
      insert: (r) => view.addImageBlock(r),
    });
  }

  private paintToolbar(): void {
    const old = this.main.querySelector(".side-tools");
    if (!old) return;
    const next = this.buildToolbar();
    old.replaceWith(next);
    next.scrollTop = old.scrollTop;
  }

  private async setViewMode(mode: ViewMode): Promise<void> {
    await this.focusedTab()?.view?.setViewMode(mode);
    this.paintToolbar();
  }

  /**
   * Ctrl+\ ou « Split ». Un autre onglet ouvert va a droite ; sinon le meme
   * cahier, sur Exos, TD ou TP s'il existe, ou l'intercalaire suivant.
   */
  private async toggleSplit(): Promise<void> {
    if (this.splitId) { await this.closeSplit(); return; }
    const left = this.activeTab();
    if (!left || this.screen !== "notebook") return;
    const other = mostRecent(this.tabs.filter((t) => t.id !== left.id));
    if (other) {
      this.foldCalculator();
      this.splitId = other.id;
      this.focusedId = other.id;
      await this.renderNotebookScreen();
      return;
    }
    const d = pickSplitDivider(openableDividers(await this.repo.listDividerTree(left.notebook)), left.divider);
    if (!d) {
      toast("Un seul intercalaire : crée-en un second (+) ou ouvre une autre matière pour le split", "warn", 4000);
      return;
    }
    await this.openRight(left.notebook, d);
  }

  private async closeSplit(): Promise<void> {
    this.splitId = null;
    this.focusedId = this.activeId;
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
  private enqueue(key: string, kind: "math" | "text", strokes: Stroke[], auto = false, partial = false): void {
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
      this.queue.enqueue(jobOf(key, kind, strokes, partial));
    }, auto ? AUTO_DEBOUNCE_MS : SEND_DEBOUNCE_MS));
  }

  /** Bloc reste en attente : en file tout de suite, s'il n'y est pas deja. */
  private resume(key: string, kind: "math" | "text", strokes: Stroke[], partial = false): void {
    if (this.queue.has(key) || this.debounceTimers.has(key)) return;
    this.remember(key, kind);
    this.queue.enqueue(jobOf(key, kind, strokes, partial));
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
    const done = await this.toBlock(key, (block) => applyToBlock(block, result, more));
    if (done && !more) this.forget(key);
  }

  /** Requete refusee par MyScript : le bloc dit « non reconnu, réessayer ». */
  private async onRecoFailed(key: string, message: string): Promise<void> {
    if (this.moreComing(key)) return;
    if (await this.toBlock(key, (block) => markFailed(block, message))) this.forget(key);
  }

  /**
   * Porte un resultat jusqu'a son bloc. D'abord les vues qui tiennent la
   * page en memoire (meme cahier, meme intercalaire, meme bloc) ; sinon UNE
   * seule ecriture disque, passee dans la file de la vue de cet
   * intercalaire s'il y en a une : jamais deux ecritures croisees d'une
   * meme page, qui perdaient les derniers traits.
   */
  private async toBlock(key: string, change: (block: Block) => void): Promise<boolean> {
    const ref = parseBlockKey(key);
    if (!ref) return true;
    // Cahier en lecture seule sur ce PC : rien n'y est ecrit. La cle reste
    // retenue, le bloc repartira quand on y ecrira de nouveau.
    if (this.isLocked(ref.notebook)) return false;
    if (this.applyInViews(ref, change)) return true;
    const holder = this.holders(ref.notebook, ref.divider)[0];
    const write = async () => {
      // La page a pu s'ouvrir entre-temps : la vue la tient, elle ecrira.
      if (this.applyInViews(ref, change)) return;
      try { await updateBlockOnDisk(this.repo, ref, change); } catch { /* page disparue */ }
    };
    const run = holder ? holder.runIo(write) : this.recoIo.then(write, write);
    if (!holder) this.recoIo = run.catch(() => undefined);
    await run;
    return true;
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
      // Fond de page : seules les lignes pas encore lues repartent (reco-3).
      const main = b.type === "ink" && !b.rect;
      const strokes = main ? planIncremental(b).all : b.strokes.filter((st) => st.tool === "pen");
      if (!strokes.length) { this.forget(key); continue; }
      this.resume(key, kind, strokes, main);
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

  /** Ancien bloc `link` : par son id de page s'il l'a, sinon par son chemin. */
  private async followLink(target: string, pageId?: string): Promise<void> {
    // Intercalaire sur un ou plusieurs niveaux (« Elec/E3A/S1/TP 4/0003 », D4).
    const ref = blockLinkRef({ target, label: "", ...(pageId ? { pageId } : {}) });
    if (!ref.pageId && !parsePagePath(ref.path)) { toast("Lien invalide", "warn"); return; }
    await this.followRef(ref);
  }

  /** Pages vues par les liens, depuis le cache de session de Repo.scanDivider. */
  private linkPages(fresh = false): Promise<LinkPage[]> {
    const now = performance.now();
    if (!fresh && this.linkScan && now - this.linkScan.at < 2500) return this.linkScan.pages;
    const pages = collectLinkPages(this.repo).then((p) => p ?? []);
    this.linkScan = { at: now, pages };
    pages.catch(() => { if (this.linkScan?.pages === pages) this.linkScan = null; });
    return pages;
  }

  /** Ce que les pages savent faire de leurs liens (PageViewHost.links). */
  private readonly pageLinks: PageLinks = {
    follow: (link: DocLinkRef) => {
      const ref = parseLinkUrl(link.href, link.hint);
      if (!ref) { toast("Lien invalide", "warn"); return; }
      void this.followRef(ref);
    },
    candidates: async () => linkCandidates(await this.linkPages(true)),
    check: async (links) => {
      const pages = await this.linkPages();
      const byId = indexById(pages);
      return links.map((l) => {
        const ref = parseLinkUrl(l.href, l.hint);
        if (!ref) return "missing";
        if (byId.has(ref.pageId)) return "ok";
        // Pas a la corbeille ici (lecture a la demande, au clic) : grise.
        return "trash";
      });
    },
    backlinks: async (pageId) => backlinksTo(pageId, await this.linkPages()),
    openBacklink: (b) => void this.openAt(b.notebook, b.divider, b.number, ""),
  };

  /**
   * Suit un lien : par l'id de la page (survit aux renumerotations), sinon
   * page a la corbeille (« Restaurer »), sinon par le chemin, sinon rien.
   * La position quittee va dans NavHistory (Alt+← revient).
   */
  private async followRef(ref: LinkRef): Promise<void> {
    let pages = await this.linkPages();
    if (ref.pageId && !indexById(pages).has(ref.pageId)) pages = await this.linkPages(true);
    const byId = indexById(pages);
    const trashed = ref.pageId && !byId.has(ref.pageId) ? await this.repo.findTrashedPage(ref.pageId).catch(() => null) : null;
    const res = resolveLink(ref, byId, { trashed: !!trashed, pathExists: (s) => spotExists(pages, s) });
    if (res.kind === "trash" && trashed) {
      toast(`Page supprimée (${dividerLabel(trashed.divider)} p. ${trashed.page}), elle est dans la corbeille`, "warn", 8000, {
        label: "Restaurer",
        run: () => void this.restore(trashed).then(() => { this.linkScan = null; return this.followRef(ref); }),
      });
      return;
    }
    if (res.kind !== "page") { toast("Lien cassé : la page visée n'existe plus", "warn", 4000); return; }
    const { notebook, divider, number } = res.page;
    if (res.via === "path") toast("Page retrouvée par son ancien numéro : vérifie que c'est la bonne", "info", 3000);
    if (ref.blockId) { await this.openAt(notebook, divider, number, ref.blockId); return; }
    if (ref.heading) {
      const target = pages.find((p) => p.id === ref.pageId);
      const body = target ? await this.repo.readPage(notebook, divider, number).then(
        (p) => p.blocks.find((b) => b.type === "text" && !b.rect)?.id, () => undefined) : undefined;
      await this.openAt(notebook, divider, number, body ?? "", body ? `"${ref.heading.replace(/"/g, "")}"` : undefined);
      return;
    }
    await this.openAt(notebook, divider, number, "");
  }

  /* ---------------- raccourcis ---------------- */

  private onKey(e: KeyboardEvent): void {
    // Echap au menu seulement s'il suit directement un autre Echap.
    const again = this.lastEsc;
    if (!(e.key === "Escape" && e.repeat)) this.lastEsc = false;
    // La calculatrice avait le clavier : son Echap (saisie videe, clavier
    // rendu) ne va jamais au menu, meme sans curseur de page a retrouver.
    const calcKeys = e.key === "Escape" && !!this.calculator?.isVisible
      && !!(document.activeElement as HTMLElement | null)?.closest(".calc");
    if (this.calculator?.handleKey(e)) {
      e.preventDefault();
      // Saisie videe ou clavier rendu a la page : le suivant peut aller au menu.
      if (e.key === "Escape") {
        this.lastEsc = true;
        if (calcKeys && isEditingDoc(document.activeElement)) this.backToCaret();
      }
      return;
    }
    if (calcKeys && this.screen === "notebook" && !document.querySelector(".backdrop")) {
      e.preventDefault();
      this.calculator?.releaseKeys();
      this.backToCaret();
      this.lastEsc = true;
      return;
    }
    if (e.key === "Escape" && this.screen === "notebook" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Touche maintenue : un seul Echap, jamais une rafale jusqu'au menu.
      if (e.repeat) { e.preventDefault(); return; }
      this.onNotebookEscape(e, again);
      return;
    }
    const inDoc = isEditingDoc(e.target);
    const tag = (e.target as HTMLElement)?.tagName;
    const inField = tag === "INPUT" || tag === "TEXTAREA";
    const typing = inDoc || inField;
    // Une fenetre de dialogue (ou le menu « ⋯ ») garde le clavier.
    const dialog = !!document.querySelector(".backdrop");
    const view = this.focusedTab()?.view;

    // Alt+← : retour a l'endroit d'avant un saut, depuis n'importe quel ecran.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "ArrowLeft") {
      e.preventDefault();
      if (!dialog) void this.goBack();
      return;
    }

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

    // Selection au lasso : Suppr l'efface (Echap la lache, onNotebookEscape).
    if (this.screen === "notebook" && view?.hasSelection) {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); view.deleteSelection(); return; }
    }

    // Menu : Entree reprend, des lettres filtrent les matieres, fleches.
    if (this.screen === "menu" && this.menuKeys?.(e)) { e.preventDefault(); return; }

    if (e.key === "Escape" && (this.screen === "search" || this.screen === "flags" || this.screen === "probe" || this.screen === "review")) {
      e.preventDefault();
      this.leaveAux();
      return;
    }
    if (e.key === "Escape" && this.screen !== "menu") { e.preventDefault(); void this.showMenu(); return; }
    if (this.screen !== "notebook") return;

    if (e.key === "PageDown") { e.preventDefault(); void view?.next(); return; }
    if (e.key === "PageUp") { e.preventDefault(); void view?.prev(); return; }

    // Entree ou Espace sur un intercalaire (navigation au clavier) : c'est
    // le bouton qui la prend, pas le texte de la page.
    if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement | null)?.closest?.(".divider-strip button")) return;
    // Taper n'importe ou : le clavier va au texte de la page, sans cliquer
    // ni inserer de zone. La touche continue sa route vers le texte.
    if (!e.altKey && (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace")) {
      view?.focusText();
      if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertLineBreak"); }
    }
  }

  /**
   * Echap sur l'ecran cahier (fiche F1 : « deux fois » pour le menu). Il
   * ferme d'abord ce qui est ouvert, rend le clavier de la calculatrice a la
   * page, quitte le texte ou y revient depuis un bouton ; le menu seulement
   * au second Echap de suite. La calculatrice reste ouverte.
   */
  private onNotebookEscape(e: KeyboardEvent, again: boolean): void {
    const active = document.activeElement as HTMLElement | null;
    const tag = active?.tagName;
    const view = this.focusedTab()?.view;
    const action = escapeAction({
      again,
      // Formule MathLive figee, photo deselectionnee, composition IME : la
      // touche a deja servi, elle ne compte pas pour aller au menu.
      handled: e.defaultPrevented || e.isComposing,
      dialog: !!document.querySelector(".backdrop"),
      popover: this.mathFly,
      calc: !!this.calculator?.isVisible && !!active?.closest(".calc"),
      field: (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && !active?.closest(".text-doc"),
      selection: !!view?.hasSelection,
      inText: isEditingDoc(active),
    });
    if (action === "ignore") return;
    e.preventDefault();
    switch (action) {
      case "close-popover": this.setMathFly(false); break;
      case "release-calc":
        this.calculator?.releaseKeys();
        this.backToCaret();
        break;
      case "leave-field": active?.blur(); view?.focusText(); break;
      case "clear-selection": view?.clearSelection(); break;
      case "menu": void this.showMenu(); return;
      case "leave-text": active?.blur(); break;
      case "to-text": active?.blur(); view?.focusText(); break;
    }
    this.lastEsc = true;
  }

  /**
   * Le clavier rendu par la calculatrice va au curseur que le texte a garde :
   * apres « Envoyer dans la page », derriere le bloc pose (TextDoc.caretAfter),
   * pas la ou il etait a l'ouverture de la calculatrice.
   */
  private backToCaret(): void {
    if (this.screen === "notebook") this.focusedTab()?.view?.focusText();
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
      case "review": void this.showReview({}); return true;
      case "calc": void this.toggleCalculator(); return true;
      case "sendCalc":
        if (!this.calculator) toast("Rien à envoyer : ouvre la calculatrice (Ctrl+L)", "warn");
        else this.calculator.sendLast();
        return true;
      // Dans le texte, Ctrl+Z appartient au texte (son propre historique).
      case "undo": if (ctx.typing) return false; view?.undo(); return true;
      // Copier/coller de l'encre : seulement hors du texte (le texte garde
      // le sien, collage de photo compris) et avec une selection ou un
      // presse-papiers d'encre ; sinon la touche suit son cours.
      case "copy": return !ctx.typing && notebook && !!view?.copySelection();
      case "cut": return !ctx.typing && notebook && !!view?.copySelection(true);
      case "paste":
        if (ctx.typing || !notebook || !view?.paste()) return false;
        if (!isSelect(this.tool)) this.selectTool("lasso");
        return true;
      case "redo": if (ctx.typing) return false; view?.redo(); return true;
      // Toujours pris, meme en pleine frappe : le repere ne touche pas au
      // texte, et le curseur reste ou il etait (D3).
      case "flag":
        if (notebook) {
          view?.addFlag();
          // Ctrl+F reste « Pas compris » (D3) ; qui cherchait la recherche
          // apprend ou elle est.
          appendToToast("flag", "Recherche : Ctrl+K");
        }
        return true;
      case "newDivider": {
        const tab = this.focusedTab();
        // A cote de l'intercalaire ouvert, dans son groupe (D4).
        if (notebook && tab) void this.newDivider(tab, parentPath(tab.divider));
        return true;
      }
      case "convert": this.setAutoConvert(!this.autoConvert); return true;
      case "finger": this.toggleFinger(); return true;
      case "viewMode": {
        const v = this.focusedTab()?.view;
        if (v) void this.setViewMode(v.mode === "scroll" ? "pages" : "scroll")
          .then(() => toast(v.mode === "scroll" ? "Défilement : toutes les pages à la suite" : "Pages : une page à la fois"));
        return true;
      }
      case "newPage": if (notebook) void view?.newPage(); return true;
      case "insertPage": if (notebook) void view?.newPage(true); return true;
      case "goto": if (notebook) void this.showPageList(view, true); return true;
      case "nextPage": if (notebook) void view?.next(); return true;
      case "prevPage": if (notebook) void view?.prev(); return true;
      case "nextDivider": if (notebook) void this.switchDividerBy(1); return true;
      case "prevDivider": if (notebook) void this.switchDividerBy(-1); return true;
      case "exportPage": if (notebook) void view?.exportPdf("current"); return true;
      case "exportAll": if (notebook) void view?.exportPdf("all"); return true;
      case "exportWord": if (notebook) void this.exportWord(view, "current"); return true;
      case "exportWordAll": if (notebook) void this.exportWord(view, "all"); return true;
      case "importPdf": if (notebook) void this.importPdf(); return true;
      case "closeTab": { const t = this.focusedTab(); if (t) void this.closeTab(t.id); return true; }
      case "nextTab": this.cycleTab(1); return true;
      case "prevTab": this.cycleTab(-1); return true;
      case "split": void this.toggleSplit(); return true;
      case "swap": void this.swapPanes(); return true;
      case "closeSplit": void this.closeSplit(); return true;
      case "help": showShortcuts(); return true;
      // Zoom du panneau vise (chaque panneau du split a le sien). Toujours
      // pris : sinon le WebView2 zoomerait toute l'interface.
      case "zoomIn": if (notebook) view?.zoomIn(); return true;
      case "zoomOut": if (notebook) view?.zoomOut(); return true;
      case "zoomReset": if (notebook) view?.setZoom(1); return true;
    }
  }

  /**
   * Ctrl+Tab : le panneau vise passe a l'onglet suivant. L'onglet de
   * l'autre panneau est saute (le prendre refermait le split).
   */
  private cycleTab(delta: number): void {
    const current = this.focusedTab();
    const otherId = this.splitId ? (current?.id === this.splitId ? this.activeId : this.splitId) : null;
    const ring = this.tabs.filter((t) => t.id !== otherId);
    if (!ring.length) return;
    const i = current ? ring.indexOf(current) : -1;
    const next = ring[(i + delta + ring.length) % ring.length];
    if (!next || (next === current && this.screen === "notebook")) return;
    this.place(next);
    void this.renderNotebookScreen();
  }

  /**
   * Liste des pages (un appui sur « p. 4 / 12 », ou Ctrl+G) : numero, date
   * et premiere ligne de chaque page, et un champ pour taper un numero.
   * 30 pages ne coutent plus 30 clics.
   */
  private async showPageList(target?: PageView | null, typeNumber = false): Promise<void> {
    const view = target ?? this.focusedTab()?.view;
    if (!view || this.screen !== "notebook" || document.querySelector(".backdrop")) return;
    // Ce qu'on vient d'ecrire doit apparaitre dans la liste.
    await view.flush();
    const pages = (await this.repo.scanDivider(view.notebook, view.divider)) ?? [];
    const nums = pages.map((p) => p.n);
    const n = await pageListDialog({
      title: dividerLabel(view.divider),
      current: view.pageNumber,
      typeNumber,
      pages: pages.map((p) => ({
        n: p.n, day: dayLabel(p.index?.created), line: p.index?.firstLine ?? "", title: !!p.index?.title, unreadable: !p.index,
      })),
      parse: (input) => parsePageInput(input, nums),
    });
    if (n == null || n === view.pageNumber) return;
    this.noteJump();
    await view.goTo(n);
  }

  /** Ctrl+Maj+Pg↓ / Pg↑ : intercalaire suivant ou precedent du cahier. */
  private async switchDividerBy(delta: number): Promise<void> {
    const tab = this.focusedTab();
    if (!tab) return;
    // Ordre de lecture des intercalaires qui ont des pages, groupes traverses (D4).
    const dividers = openableDividers(await this.repo.listDividerTree(tab.notebook));
    const at = dividers.indexOf(tab.divider);
    const next = at < 0 && delta > 0 ? dividers[0] : dividers[at + delta];
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
      this.focusedTab()?.view?.reconvert();
      // Fonds de page restes en attente hors Auto (ouverts, ou laisses a la
      // derniere fermeture) : ils ne partaient qu'a la reouverture de leur page.
      for (const v of this.views()) v.resumeAll();
      void this.resumeSaved();
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
    const view = this.focusedTab()?.view;
    // Alt+Maj+P : photos du tableau (Alt+P seul = modele Puissance).
    if (isPhotoImportKey(e)) { void this.importImage(); return true; }
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

    // Alt+G deux fois : gomme entiere ou precise. Alt+A deux fois : lasso
    // ou insertion d'espace.
    if (e.code === "KeyG" && this.tool === "eraser") {
      this.setEraserMode(this.eraserMode === "precise" ? "stroke" : "precise");
      return true;
    }
    if (e.code === "KeyA") {
      this.selectTool(this.tool === "lasso" ? "space" : "lasso");
      toast(this.tool === "space" ? "Espace : glisser une ligne vers le bas" : "Lasso : entourer des traits", "info", 1400);
      return true;
    }
    const tools: Record<string, Tool> = {
      KeyE: "pen", KeyH: "highlighter", KeyG: "eraser", KeyZ: "region", KeyT: "textregion",
    };
    const t = tools[e.code];
    if (t) { this.selectTool(t); return true; }
    return false;
  }

  private setEraserMode(m: "stroke" | "precise"): void {
    this.eraserMode = m;
    if (this.tool !== "eraser") this.tool = "eraser";
    this.persist();
    this.paintToolbar();
    toast(m === "precise" ? "Gomme précise : coupe le trait" : "Gomme : trait entier", "info", 1400);
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
    // Quitter le lasso fait tomber la selection (elle ne se deplace qu'avec lui).
    if (!isSelect(t)) for (const v of this.views()) v.clearSelection();
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
    // Une selection au lasso : la couleur va a ses traits, pas au stylo.
    if (this.screen === "notebook" && this.focusedTab()?.view?.recolorSelection(key ?? "normal")) return;
    this.color = key ?? "normal";
    this.textColor = key;
    setTypingColor(key);
    this.persist();
    this.paintToolbar();
  }

  private persist(): void {
    this.settings.textColor = this.textColor;
    // Une zone ponctuelle n'est pas memorisee : on rouvre sur l'outil d'avant.
    // Le lasso non plus : on rouvre sur le stylo.
    const kept = isZone(this.tool) && !this.toolLocked ? this.prevTool : this.tool;
    this.settings.tool = isSelect(kept) ? "pen" : kept;
    this.settings.eraserMode = this.eraserMode;
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
  /** `under` : aussi celles des intercalaires ranges dans ce groupe (D4). */
  private holders(notebook: string, divider: string, under = false): PageView[] {
    return this.views().filter((v) => v.notebook === notebook
      && (under ? isUnder(v.divider, divider) : v.divider === divider));
  }

  /**
   * Avant de renommer ou de renumeroter un intercalaire : tout ce qui
   * l'attend est ecrit. Faux (et un message) si une page reste refusee.
   */
  private async settle(notebook: string, divider: string, cancelled: string, under = false): Promise<boolean> {
    const held = this.holders(notebook, divider, under);
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
    // Texte complet, et sa forme courte pour un ecran etroit (portrait) :
    // la barre reste sur une ligne. La forme complete reste en infobulle.
    const say = (long: string, short: string) => [
      el("span", { class: "lg" }, long), el("span", { class: "sh", title: long }, short),
    ];
    const reco = !q.backendReady
      ? (q.pending
          ? [`${q.pending} en attente, reconnaissance non configurée`, `${q.pending} en attente`]
          : ["reconnaissance non configurée", "reco. off"])
      : q.pending
        ? [`${q.pending} conversion${q.pending > 1 ? "s" : ""} en attente`, `${q.pending} en attente`]
        : ["aucune conversion en attente", "reco. à jour"];
    this.statusbar.replaceChildren(
      el("span", { class: "pill" },
        el("span", { class: `led ${q.online ? "" : "off"}` }),
        q.online ? "en ligne" : "hors ligne",
      ),
      el("span", { class: "pill" },
        el("span", { class: `led ${!q.backendReady && q.pending ? "off" : q.pending ? "wait" : ""}` }),
        // Une file qui n'ira nulle part doit le dire, sinon l'attente est
        // indistinguable d'une conversion qui prend son temps.
        ...say(reco[0], reco[1]),
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
        ...(this.sawPen
          ? say("stylet actif, le doigt navigue", "stylet")
          : this.touchWrites
            ? say("pas de stylet, le doigt écrit", "doigt écrit")
            : say("pas de stylet, le doigt navigue", "doigt navigue")),
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
      el("span", { class: "pill root-label", title: this.rootLabel }, this.rootLabel),
      el("button", {
        class: "ghost small keys-btn",
        title: "Clés de la reconnaissance manuscrite",
        onclick: () => void this.editKeys(),
      }, ...say("Clés MyScript", "Clés")),
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

  /* ---------------- presence OneDrive (section 11) ---------------- */

  /**
   * Ouverture d'un cahier (premier onglet) : si l'autre PC semble l'avoir
   * ouvert, avertissement non bloquant, lecture seule proposee. Sinon, ce PC
   * signale sa presence (fichier `.presence-<PC>.json` du cahier).
   */
  private async enterNotebook(dir: string): Promise<void> {
    if (!this.presence || this.present.has(dir)) return;
    const other = await this.presence.check(dir);
    let readOnly = false;
    if (other) {
      const choice = await chooseDialog(
        "Cahier ouvert sur un autre PC",
        `${other.machine} a ce cahier ouvert (dernier signe ${presenceAgo(other.age)}). `
          + "Si les deux PC écrivent en même temps, OneDrive garde deux versions des pages. "
          + "Ouvrir quand même en lecture seule ?",
        [
          { value: "edit", label: "Modifier quand même" },
          { value: "read", label: "Ouvrir en lecture seule", primary: true },
        ],
      );
      // Echap : la reponse sure, la lecture seule.
      readOnly = choice !== "edit";
    }
    this.present.set(dir, { readOnly, other });
    if (!readOnly) await this.presence.claim(dir);
    this.armPresence();
  }

  /** Plus aucun onglet sur ce cahier : sa presence est retiree. */
  private async leaveNotebook(dir: string): Promise<void> {
    const state = this.present.get(dir);
    this.present.delete(dir);
    if (!this.present.size && this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (state && !state.readOnly) await this.presence?.release(dir);
  }

  /** Fermeture de la fenetre : toutes les presences de ce PC sont retirees. */
  async releaseAll(): Promise<void> {
    for (const [dir, state] of this.present) {
      if (!state.readOnly) await this.presence?.release(dir);
    }
  }

  /** Rafraichit la presence toutes les 5 min, tant qu'un cahier est ouvert. */
  private armPresence(): void {
    if (this.presenceTimer || !this.presence) return;
    this.presenceTimer = setInterval(() => void this.presenceTick(), PRESENCE_CLAIM_MS);
  }

  /**
   * Toutes les 5 min : signe de vie pour les cahiers modifiables, et nouvel
   * examen de l'autre PC (il a pu ouvrir le cahier, ou le refermer).
   */
  private async presenceTick(): Promise<void> {
    if (!this.presence) return;
    for (const [dir, state] of [...this.present]) {
      const other = await this.presence.check(dir);
      if (this.present.get(dir) !== state) continue; // ferme ou change entre-temps
      if (!state.readOnly) await this.presence.claim(dir);
      const before = state.other?.machine ?? null;
      state.other = other;
      // Aussi quand rien ne change : « dernier signe il y a N min » se met a jour.
      if (other || before) await this.applyPresence(dir);
    }
  }

  /** Bandeau des vues d'un cahier, selon sa presence. */
  private noticeFor(dir: string): ViewNotice | null {
    const state = this.present.get(dir);
    if (!state) return null;
    const other = state.other;
    if (state.readOnly) {
      return {
        kind: "lock",
        text: other
          ? `Lecture seule : ${other.machine} a ce cahier ouvert (dernier signe ${presenceAgo(other.age)}). Rien n'est enregistré ici.`
          : "Lecture seule : l'autre PC a refermé ce cahier. Rien n'est enregistré ici tant que tu ne passes pas en écriture.",
        actions: [{ label: other ? "Modifier quand même" : "Modifier maintenant", run: () => void this.setReadOnly(dir, false) }],
      };
    }
    if (other) {
      return {
        kind: "warn",
        text: `${other.machine} a aussi ce cahier ouvert (dernier signe ${presenceAgo(other.age)}) : `
          + "si les deux PC écrivent, OneDrive gardera deux versions des pages.",
        actions: [{ label: "Passer en lecture seule", run: () => void this.setReadOnly(dir, true) }],
      };
    }
    return null;
  }

  /** Le bandeau change sur toutes les vues de ce cahier. */
  private async applyPresence(dir: string): Promise<void> {
    const notice = this.noticeFor(dir);
    for (const t of this.tabs) if (t.notebook === dir) await t.view?.setNotice(notice);
    this.paintStatus();
  }

  /** Bascule lecture seule / ecriture d'un cahier ouvert, depuis son bandeau. */
  private async setReadOnly(dir: string, readOnly: boolean): Promise<void> {
    const state = this.present.get(dir);
    if (!state || state.readOnly === readOnly) return;
    if (readOnly) {
      // Ce qui attend est ecrit d'abord : c'etait du travail fait avant.
      for (const t of this.tabs) {
        if (t.notebook !== dir || !t.view) continue;
        await t.view.flush();
        if (t.view.hasUnsaved) {
          toast("Lecture seule impossible pour l'instant : une page attend encore d'être écrite", "err", 6000);
          return;
        }
      }
    }
    state.readOnly = readOnly;
    if (readOnly) await this.presence?.release(dir);
    else await this.presence?.claim(dir);
    await this.applyPresence(dir);
    toast(readOnly ? "Cahier en lecture seule sur ce PC" : "Cahier modifiable sur ce PC");
  }

  /** Cahier ouvert en lecture seule sur ce PC. */
  private isLocked(dir: string): boolean {
    return !!this.present.get(dir)?.readOnly;
  }

  /** Vrai (et un message) si une action ecrirait dans un cahier en lecture seule. */
  private refuseLocked(dir: string): boolean {
    if (!this.isLocked(dir)) return false;
    toast("Cahier en lecture seule sur ce PC (ouvert sur l'autre PC) : action impossible", "warn", 5000);
    return true;
  }

  /* ---------------- copies de conflit : pastilles ---------------- */

  /**
   * Pastille sur chaque intercalaire qui a des copies de conflit OneDrive.
   * Faite apres coup : la bande s'affiche sans attendre le disque.
   */
  private paintConflictBadges(): void {
    const bar = this.main.querySelector<HTMLElement>(".divider-strip");
    const dir = bar?.dataset.notebook;
    if (!bar || !dir) return;
    void this.repo.countConflicts(dir).then((counts) => {
      if (!bar.isConnected) return;
      for (const node of bar.querySelectorAll<HTMLElement>(".divider-tab[data-divider]")) {
        node.querySelector(".conflict-dot")?.remove();
        // Un groupe compte aussi les copies des intercalaires qu'il contient.
        const path = node.dataset.divider!;
        let n = 0;
        for (const [d, c] of counts) if (node.dataset.group ? isUnder(d, path) : d === path) n += c;
        if (!n) continue;
        node.append(el("span", {
          class: "conflict-dot",
          title: `${n} copie${n > 1 ? "s" : ""} de conflit OneDrive à regarder`,
          "aria-label": `${n} copie${n > 1 ? "s" : ""} de conflit`,
        }, String(n)));
      }
    }, () => undefined);
  }
}

/**
 * Job de reconnaissance. `partial` : envoi par bandes du fond de page, le
 * resultat ne vaut que pour ces traits (RecoResult.scope, bands.ts).
 */
function jobOf(key: string, kind: "math" | "text", strokes: Stroke[], partial: boolean): RecoJob {
  return partial ? { key, kind, strokes, scope: strokes.map((s) => s.id) } : { key, kind, strokes };
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

/** Stockage local de la machine, ou null s'il est indisponible. */
function localStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
}
