import { openVersions } from "./versions";
import {
  el, clear, toast, dismissToast, askText, askFields, confirmDialog, chooseDialog, onLongPress,
  dismissPageToasts, APP_TOAST, contextMenu, closeMenus, sheetDialog, type DialogField, type MenuEntry,
} from "./dom";
import { buildMenu, buildFlagsView, notebookMenu, newNotebook, cleanupSection } from "./menu";
import {
  buildNotebookSidebar, buildHomeSidebar, focusPageList, notebookSquare, type SidebarPage, type HomeEntry,
} from "./sidebar";
import { openSpotlight, spotlightOpen } from "./spotlight";
import { buildProbe } from "./probe";
import { buildReviewView, markRect, type ReviewState, type ReviewWhere } from "./review";
import { REVIEW_COLORS, focusQuery, type ReviewItem } from "../core/review";
import type { Bounds } from "../core/ink/stroke";
import { PageView, type ViewMode, type RenderMode, type ViewNotice } from "./pageview";
import { buildFormulaPanel, MATH_TEMPLATES } from "./mathbar";
import { insertMathTemplate, isEditingDoc, lastCalcSource, setAutoMath, setSpellcheck, setTypingColor } from "./textdoc";
import type { Calculator } from "./calculator/index";
import { PALETTE, NEUTRAL_INK, labelOf } from "../core/palette";
import type { ColorKey, InkColor, ToolKind } from "../core/types";
import { uuid } from "../core/id";
import { calcSpecOf, graphSpecOf, type CalcSpec, type GraphSpec } from "../core/liveblock";
import { Repo, safeName, type TrashEntry, type NotebookSummary } from "../core/storage/repo";
import { Positions } from "../core/position";
import { NavHistory, dayLabel, pickSplitDivider, type NavSpot } from "../core/nav";
import {
  MAX_DEPTH, depthOf, dividerLabel, findNode, flattenTree,
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
  ctrlCommand, escapeAction, isReloadKey, keyLabel, keysOf, pageLabel, titleOf, type Command,
} from "../core/shortcuts";
import { showShortcuts } from "./help";
import { icon, widthIcon, type IconName } from "./icons";
import { applyAppearance, installTooltips, onSystemThemeChange } from "./tooltip";
import { retoneSurfaces } from "./canvas";
import {
  mathPanelMode, sidebarMode, calcPlacement, PHONE_MAX, type MathPanelMode, type SidebarMode,
} from "../core/chrome";
import { statusSummary } from "../core/status";
import { inkDisplayColor, nextThemePref, SHEET_TONES, THEME_PREFS, type SheetPref, type ThemePref } from "../core/theme";
import type { Presence } from "../platform";
import { PRESENCE_CLAIM_MS, presenceAgo, type OtherPresence } from "../core/sync";

type Screen = "menu" | "notebook" | "flags" | "probe" | "review";
type Tool = ToolKind | "region" | "textregion" | "lasso" | "space";
/** Lasso et insertion d'espace : la selection n'existe qu'avec eux. */
const isSelect = (t: Tool): t is "lasso" | "space" => t === "lasso" || t === "space";

const isZone = (t: Tool): t is "region" | "textregion" => t === "region" || t === "textregion";

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
  /**
   * Le doigt ecrit (option « Écrire au doigt (sans stylet) ») ; par defaut
   * il navigue : defilement avec inertie, pinch-zoom, appui = curseur,
   * appui long = selection (lot stylet).
   */
  private touchWrites = false;
  /** Outil d'avant le lasso : le lasso est ephemere, on y revient. */
  private beforeLasso: Tool = "pen";
  private renderMode: RenderMode = "ink";
  /** Convertir l'ecriture au fil de la plume plutot qu'a la demande. */
  private autoConvert = false;

  private root = el("div", { class: "app" });
  /** Barre du haut (52 px) : barre laterale, pages, titre, actions. */
  private tabbar = el("header", { class: "topbar" });
  /** Onglets, seulement a partir de deux cahiers ouverts. */
  private tabrow = el("div", { class: "tabrow", role: "tablist", hidden: true });
  private main = el("div", { class: "notebook", style: { flex: "1", minHeight: "0", display: "flex", flexDirection: "column" } });
  /** Barre laterale (cahier ou accueil), et le voile de la surimpression. */
  private sideHost = el("div", { class: "side-host" });
  private scrim = el("div", { class: "scrim", "aria-hidden": "true" });
  /** Surimpression ouverte (tablette, telephone) ; sur grand ecran, settings.sidebar. */
  private overlayOpen = false;
  /** Groupes deplies a la main, par matiere (barre laterale). */
  private expandedGroups = new Map<string, Set<string>>();
  /** Pages lues par intercalaire (« matiere\0intercalaire ») : barre laterale et titre. */
  private pageRows = new Map<string, SidebarPage[]>();
  /** Matieres de l'accueil, pour la barre laterale hors du cahier. */
  private homeData: { notebooks: NotebookSummary[]; flagCount: number } | null = null;
  /**
   * Indicateur d'etat compact (barre du haut, a droite) : point vert, ou
   * orange/rouge et un texte court s'il y a un probleme ; detail au survol
   * ou a l'appui (core/status.ts). Remplace l'ancienne barre d'etat.
   */
  private statusBtn = el("button", { class: "status-btn", "data-tip-side": "bottom" });
  private queueState: QueueState;
  /** Mode de la barre laterale au dernier redimensionnement. */
  private lastSideMode: SidebarMode = sidebarMode(typeof window !== "undefined" ? window.innerWidth : 1366);
  /** Indicateur « p. 4 / 12 » de chaque panneau, mis a jour sur place. */
  private pageLabels = new WeakMap<PageView, HTMLElement>();
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
    this.touchWrites = this.settings.touchWrites;
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

    const content = el("div", { class: "content" }, this.tabbar, this.tabrow, this.main);
    this.root.append(el("div", { class: "shell" }, this.sideHost, this.scrim, content));
    this.scrim.addEventListener("pointerdown", () => this.closeOverlay());
    this.statusBtn.addEventListener("click", () => this.openStatusPanel());
    // Apparence : theme du chrome et teinte de la feuille, retenus ici.
    applyAppearance(this.root, this.settings.theme, this.settings.sheet);
    onSystemThemeChange(() => { if (this.settings.theme === "system") this.applyLook(); });
    installTooltips();
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
        // Barre laterale : a cote, en surimpression ou en pile selon la largeur.
        const mode = this.sideMode();
        if (mode !== this.lastSideMode) { this.lastSideMode = mode; this.overlayOpen = false; }
        closeMenus();
        this.paintShell();
        this.paintTopbar();
        if (this.calculator) this.placeCalculator(this.calculator);
        if (this.screen === "notebook") { this.paintToolbar(); this.paintMath(); }
      }, 160);
    });
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
   * Le stylet ecrit, le doigt navigue (section 3) ; « Écrire au doigt (sans
   * stylet) » est une simple option, pour une machine sans stylet.
   */
  private touchRole(): "write" | "navigate" {
    return this.touchWrites ? "write" : "navigate";
  }

  /** Option « Écrire au doigt (sans stylet) » (a placer dans les Réglages). */
  get fingerWrites(): boolean { return this.touchWrites; }

  /** Change l'option « Écrire au doigt (sans stylet) », retenue sur la machine. */
  setFingerWrites(on: boolean): void {
    if (this.touchWrites === on) return;
    this.touchWrites = on;
    this.settings.touchWrites = on;
    saveSettings(this.settings);
    this.paintToolbar();
    this.paintStatus();
    toast(on ? "Le doigt écrit (sans stylet)" : "Le doigt fait défiler la page");
  }

  /**
   * Lasso ephemere : apres une action de sa barre ou un appui a cote de la
   * selection, l'outil d'avant revient (le stylo, en general).
   */
  private endLasso(): void {
    if (this.tool !== "lasso") return;
    this.tool = this.beforeLasso;
    this.persist();
    this.paintToolbar();
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
            // Flottante, elle ne reserve pas de panneau.
            this.calcSlot?.side.classList.toggle("closed", !visible || !this.calculator?.isDocked);
            const b = this.tabbar.querySelector(".calc-btn");
            b?.classList.toggle("on", visible);
            b?.setAttribute("aria-pressed", String(visible));
          },
          // « Détacher » / « Ancrer » de son en-tete : retenu sur la machine.
          onDetach: (detached) => {
            this.settings.calcDetached = detached;
            saveSettings(this.settings);
            if (this.calculator) this.placeCalculator(this.calculator);
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
          // Resoudre : la redaction complete (phrases et formules) au curseur.
          onSendDetail: (lines) => { this.focusedTab()?.view?.insertDoc(lines.join("\n")); },
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
    // Le panneau pousse la page : la palette et le volet suivent.
    this.placeCalculator(calc);
    this.paintMath();
  }

  /**
   * Pose la calculatrice sur l'ecran cahier (core/chrome.ts, calcPlacement) :
   * panneau a droite qui pousse la page (inspecteur), fenetre flottante si
   * on l'a detachee ou si la page n'aurait plus sa largeur, bandeau du bas
   * au telephone. Hors cahier, elle reste ou elle est.
   */
  private placeCalculator(calc: Calculator): void {
    const slot = this.calcSlot;
    if (this.screen !== "notebook" || !slot || !slot.side.isConnected) return;
    const where = calcPlacement({
      width: window.innerWidth, stage: slot.work.clientWidth || window.innerWidth, detached: this.settings.calcDetached,
    });
    if (where === "panel") {
      if (!calc.isIn(slot.side)) calc.dock(slot.side);
    } else if (!calc.isIn(slot.work) || calc.isDocked) {
      calc.setMinTop(this.tabbar.getBoundingClientRect().bottom + 8);
      calc.float(slot.work);
      // Ouverte, elle est ramenee dans l'ecran (show la recale).
      if (calc.isVisible) calc.show();
    }
    calc.root.classList.toggle("sheet", where === "sheet");
    // Flottante, elle ne recouvre jamais la barre du haut.
    calc.setMinTop(where === "float" ? this.tabbar.getBoundingClientRect().bottom + 8 : 8);
    calc.setDetachable(where !== "sheet", where === "float" && this.settings.calcDetached);
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
    this.paintMath();
    await this.flushAll();
    const menu = await buildMenu(this.menuHost());
    // Un autre ecran a pu s'ouvrir pendant la lecture du disque.
    if (this.screen !== "menu") return;
    clear(this.main);
    this.menuKeys = menu.onKey;
    this.homeData = { notebooks: menu.notebooks, flagCount: menu.flagCount };
    this.main.append(menu.root);
    this.paintChrome();
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

  /**
   * Recherche facon Spotlight (Ctrl+F, Ctrl+K) : panneau par-dessus l'ecran,
   * rien n'est remplace. Lancee depuis un cahier, elle part dans cette
   * matiere (jeton retirable).
   */
  private async showSearch(): Promise<void> {
    if (spotlightOpen()) return;
    const tab = this.screen === "notebook" ? this.focusedTab() : undefined;
    this.closeOverlay();
    // Ce qu'on vient d'ecrire doit etre trouve.
    await this.flushAll();
    openSpotlight({
      repo: this.repo,
      initial: this.lastQuery,
      onQuery: (q) => { this.lastQuery = q; },
      scope: tab ? { dir: tab.notebook, title: tab.title, color: tab.color } : undefined,
      search: (q, opts) => searchAll(this.repo, q, opts),
      openAt: (dir, divider, page, blockId, query) => void this.openAt(dir, divider, page, blockId, query),
    });
  }

  private async showFlags(notebook?: string): Promise<void> {
    this.noteAuxFrom();
    this.screen = "flags";
    this.mathFly = false;
    this.paintMath();
    dismissPageToasts();
    // Les reperes poses a l'instant doivent etre sur le disque pour etre listes.
    await this.flushAll();
    const view = await buildFlagsView(this.menuHost(), notebook);
    if (this.screen !== "flags") return;
    clear(this.main);
    this.paintChrome();
    this.main.append(view);
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
    this.mathFly = false;
    this.paintMath();
    dismissPageToasts();
    await this.flushAll();
    clear(this.main);
    this.paintChrome();
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
    this.mathFly = false;
    this.paintMath();
    dismissPageToasts();
    clear(this.main);
    this.paintChrome();
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
    this.paintToolbar();
    this.paintChrome();
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
      onSelectionDone: () => this.endLasso(),
      requestRecognition: (key, kind, strokes, auto, partial) => this.enqueue(key, kind, strokes, auto, partial),
      resumeRecognition: (key, kind, strokes, partial) => this.resume(key, kind, strokes, partial),
      cancelRecognition: (key) => this.cancelRecognition(key),
      onDirty: () => { this.paintStatus(); this.refreshSidebarSoon(); },
      // Chaque panneau a son indicateur de page ; la barre laterale et le
      // titre suivent le panneau vise.
      onPageChange: (n, total) => this.onViewPage(view, n, total),
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

  /* ---------------- coque : barre laterale, barre du haut, onglets ---------------- */

  /** Barre laterale a cote de la page, en surimpression ou en pile (telephone). */
  private sideMode(): SidebarMode {
    return sidebarMode(window.innerWidth);
  }

  /** La barre laterale est a l'ecran. */
  private sidebarShown(): boolean {
    return this.sideMode() === "docked" ? this.settings.sidebar : this.overlayOpen;
  }

  /** Bouton de la barre du haut, Ctrl+Maj+S ; en surimpression, elle se referme seule. */
  private toggleSidebar(open = !this.sidebarShown()): void {
    if (this.sideMode() === "docked") {
      this.settings.sidebar = open;
      saveSettings(this.settings);
    } else this.overlayOpen = open;
    this.paintShell();
    this.paintTopbar();
    if (open) void this.paintSidebar();
    // La feuille change de largeur : la calculatrice peut changer de place.
    if (this.calculator) this.placeCalculator(this.calculator);
  }

  /** Classes de la coque : mode et ouverture de la barre laterale. */
  private paintShell(): void {
    const mode = this.sideMode();
    const r = this.root;
    r.classList.toggle("sb-docked", mode === "docked");
    r.classList.toggle("sb-overlay", mode === "overlay");
    r.classList.toggle("sb-stack", mode === "stack");
    r.classList.toggle("sb-open", this.sidebarShown());
    r.dataset.screen = this.screen;
  }

  /** Tout le chrome : coque, barre du haut, onglets, barre laterale. */
  private paintChrome(): void {
    this.paintShell();
    this.paintTopbar();
    this.paintTabRow();
    void this.paintSidebar();
  }

  /** Nombre de pages par intercalaire (listing des dossiers, sans lire les pages). */
  private async dividerCounts(notebook: string, tree: DividerNode[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    await Promise.all(openableDividers(tree).map(async (d) => {
      try { out.set(d, (await this.repo.listPageNumbers(notebook, d)).length); } catch { /* dossier parti */ }
    }));
    return out;
  }

  /** Pages d'un intercalaire pour la barre laterale (cache de session de scanDivider). */
  private async loadPageRows(notebook: string, divider: string): Promise<SidebarPage[] | null> {
    const pages = await this.repo.scanDivider(notebook, divider).catch(() => null);
    if (!pages) return null;
    const rows = pages.map((p): SidebarPage => ({
      n: p.n, title: p.index?.title || p.index?.firstLine || "", day: dayLabel(p.index?.created || p.index?.modified),
      heading: !!p.index?.title, flags: p.index?.flags.length ?? 0, ...(p.index ? {} : { unreadable: true }),
    }));
    this.pageRows.set(`${notebook}\u0000${divider}`, rows);
    return rows;
  }

  /** Titre de la page en vue, pour la barre du haut (jamais de LaTeX brut). */
  private pageTitleOf(tab: Tab | undefined): string {
    const v = tab?.view;
    if (!tab || !v || v.pageNumber < 1) return "";
    const row = this.pageRows.get(`${tab.notebook}\u0000${tab.divider}`)?.find((r) => r.n === v.pageNumber);
    return row?.title || `Page ${v.pageNumber}`;
  }

  private sideSeq = 0;

  /**
   * Barre laterale du cahier vise (intercalaires, pages de l'intercalaire
   * ouvert) ou de l'accueil. Posee aussitot avec ce qu'on sait, puis
   * refaite si la lecture des pages apporte du nouveau.
   */
  private async paintSidebar(): Promise<void> {
    const seq = ++this.sideSeq;
    if (this.screen === "notebook") {
      const tab = this.focusedTab();
      if (!tab) return;
      const tree = await this.repo.listDividerTree(tab.notebook).catch(() => [] as DividerNode[]);
      const counts = await this.dividerCounts(tab.notebook, tree);
      if (seq !== this.sideSeq) return;
      const key = `${tab.notebook}\u0000${tab.divider}`;
      const cached = this.pageRows.get(key) ?? null;
      this.mountSidebar(this.notebookSidebar(tab, tree, counts, cached));
      const fresh = await this.loadPageRows(tab.notebook, tab.divider);
      if (seq !== this.sideSeq) return;
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) this.mountSidebar(this.notebookSidebar(tab, tree, counts, fresh));
      this.paintTopbar();
      return;
    }
    const data = this.homeData ?? await this.loadHomeData();
    if (seq !== this.sideSeq) return;
    const active: HomeEntry = this.screen === "menu" ? "recent" : this.screen === "flags" ? "flags" : this.screen === "review" ? "review" : null;
    this.mountSidebar(buildHomeSidebar({
      active, flagCount: data.flagCount,
      notebooks: data.notebooks.map((n) => ({ dir: n.dir, title: n.meta.title, color: n.meta.color, pages: n.pageCount })),
    }, {
      search: () => void this.showSearch(),
      recent: () => { this.closeOverlay(); void this.showMenu(); },
      flags: () => { this.closeOverlay(); void this.showFlags(); },
      review: () => { this.closeOverlay(); void this.showReview({ notebook: null }); },
      openNotebook: (dir) => { this.closeOverlay(); void this.openNotebook(dir); },
      notebookMenu: (dir, at) => {
        const nb = data.notebooks.find((n) => n.dir === dir);
        if (nb) notebookMenu(this.menuHost(), dir, nb.meta.title, nb.meta.color, data.notebooks.map((n) => n.meta.color), at);
      },
      newNotebook: () => void newNotebook(this.menuHost(), data.notebooks.map((n) => n.meta.color)),
      settings: () => { this.closeOverlay(); void this.openSettings(); },
    }));
  }

  /** Liste des matieres pour la barre laterale hors de l'accueil. */
  private async loadHomeData(): Promise<{ notebooks: NotebookSummary[]; flagCount: number }> {
    const { notebooks } = await this.repo.listRoot();
    this.homeData = { notebooks, flagCount: notebooks.reduce((a, n) => a + n.flagCount, 0) };
    return this.homeData;
  }

  /** Remplace la barre laterale, sans perdre son defilement ni le clavier. */
  private mountSidebar(next: HTMLElement): void {
    const old = this.sideHost.firstElementChild as HTMLElement | null;
    const scroll = old?.querySelector(".sb-list")?.scrollTop ?? 0;
    const active = document.activeElement as HTMLElement | null;
    const had = !!old && !!active && old.contains(active);
    const n = had ? active!.dataset.n : undefined;
    const d = had ? active!.dataset.divider : undefined;
    this.sideHost.replaceChildren(next);
    const list = next.querySelector(".sb-list");
    if (list) list.scrollTop = scroll;
    if (had) {
      const target = n ? next.querySelector<HTMLElement>(`.sb-page[data-n="${n}"]`)
        : d ? next.querySelector<HTMLElement>(`.sb-div[data-divider="${CSS.escape(d)}"]`) : null;
      target?.focus({ preventScroll: true });
    }
    if (this.screen === "notebook") this.paintConflictBadges();
  }

  private notebookSidebar(tab: Tab, tree: DividerNode[], counts: Map<string, number>, pages: SidebarPage[] | null): HTMLElement {
    const expanded = this.expandedGroups.get(tab.notebook) ?? new Set<string>();
    return buildNotebookSidebar({
      notebook: tab.notebook, title: tab.title, color: tab.color, tree, divider: tab.divider,
      expanded, counts, pages, current: tab.view?.pageNumber ?? 0,
    }, {
      home: () => { this.closeOverlay(); void this.showMenu(); },
      search: () => void this.showSearch(),
      switchNotebook: (anchor) => void this.openNotebookSwitcher(anchor),
      openDivider: (d) => void this.switchDividerAndRender(tab, d),
      toggleGroup: (path) => this.toggleGroup(tab, path),
      dividerMenu: (d, at) => void this.dividerMenu(tab, d, at),
      reorder: (d, index) => void this.reorderDivider(tab, d, index),
      openPage: (n) => void this.openPageFromList(tab, n),
      pageMenu: (n, at) => this.pageMenu(tab, n, at),
      newPage: () => void tab.view?.newPage().then(() => this.refreshSidebarSoon(0)),
      newDivider: () => void this.newDivider(tab, parentPath(tab.divider)),
      leave: () => { this.closeOverlay(); tab.view?.focusText(); },
    });
  }

  /** Surimpression (tablette, telephone) : refermee apres un choix. */
  private closeOverlay(): void {
    if (this.sideMode() === "docked" || !this.overlayOpen) return;
    this.overlayOpen = false;
    this.paintShell();
    this.paintTopbar();
  }

  /** Page choisie dans la barre laterale : Alt+← revient d'ou l'on etait. */
  private async openPageFromList(tab: Tab, n: number): Promise<void> {
    this.closeOverlay();
    if (!tab.view) return;
    if (n !== tab.view.pageNumber) {
      this.noteJump();
      await tab.view.goTo(n);
    }
    if (this.sideMode() !== "docked") tab.view.focusText();
  }

  /** Menu d'une page de la barre laterale : ouvrir, inserer apres, supprimer. */
  private pageMenu(tab: Tab, n: number, at: { x: number; y: number }): void {
    const view = tab.view;
    if (!view) return;
    contextMenu(at, [
      { label: "Ouvrir", icon: "fileText", run: () => void this.openPageFromList(tab, n) },
      {
        label: "Insérer une page après", icon: "filePlus", keys: keysOf("insertPage"),
        run: () => void view.goTo(n).then(() => view.newPage(true)).then(() => this.refreshSidebarSoon(0)),
      },
      "sep",
      {
        label: "Supprimer la page…", icon: "trash", danger: true,
        run: () => void view.goTo(n).then(() => view.deleteCurrentPage()).then(() => this.refreshSidebarSoon(0)),
      },
    ], { label: `Page ${n}` });
  }

  private sideTimer: ReturnType<typeof setTimeout> | null = null;

  /** Titres et pages changent en ecrivant : la barre laterale suit, sans s'agiter. */
  private refreshSidebarSoon(ms = 2500): void {
    if (this.sideTimer) clearTimeout(this.sideTimer);
    this.sideTimer = setTimeout(() => {
      this.sideTimer = null;
      if (this.screen === "notebook" && this.sidebarShown()) void this.paintSidebar();
      else if (this.screen === "notebook") void this.refreshTitle();
    }, ms);
  }

  /** Barre laterale fermee : seul le titre de la barre du haut est relu. */
  private async refreshTitle(): Promise<void> {
    const tab = this.focusedTab();
    if (!tab) return;
    await this.loadPageRows(tab.notebook, tab.divider);
    this.paintTopbar();
  }

  /** La vue change de page : indicateur, ligne courante de la barre laterale, titre. */
  private onViewPage(view: PageView, n: number, total: number): void {
    const label = this.pageLabels.get(view);
    if (label) label.textContent = pageLabel(n, total);
    const tab = this.tabs.find((t) => t.view === view);
    if (!tab || tab !== this.focusedTab() || this.screen !== "notebook") return;
    const side = this.sideHost.querySelector(".nb-side");
    for (const r of side?.querySelectorAll<HTMLElement>(".sb-page[data-n]") ?? []) {
      const on = Number(r.dataset.n) === n;
      r.classList.toggle("current", on);
      if (on) r.setAttribute("aria-current", "page"); else r.removeAttribute("aria-current");
    }
    const rows = this.pageRows.get(`${tab.notebook}\u0000${tab.divider}`);
    if (rows && total > 0 && rows.length !== total) this.refreshSidebarSoon(300);
    this.paintTopbar();
  }

  /**
   * Barre du haut, une seule (52 px). Cahier : barre laterale, page
   * precedente et suivante, intercalaire en gras et titre de la page en
   * gris ; a droite Pas compris, Formules, Calculatrice, Partager, ⋯.
   * Accueil : le titre de l'ecran. L'indicateur d'etat n'apparait qu'en
   * cas de probleme.
   */
  private paintTopbar(): void {
    const bar = this.tabbar;
    bar.replaceChildren();
    const notebook = this.screen === "notebook";
    const compact = window.innerWidth < PHONE_MAX;
    const shown = this.sidebarShown();
    if (notebook || !shown || this.sideMode() !== "docked") {
      bar.append(this.iconButton("sidebar", shown ? "Masquer la barre latérale" : "Afficher la barre latérale", keysOf("sidebar"),
        () => this.toggleSidebar(), { side: "bottom", cls: `sidebar-btn${shown && this.sideMode() === "docked" ? " on" : ""}` }));
    }
    if (notebook) {
      const tab = this.focusedTab();
      const view = tab?.view;
      bar.append(
        this.iconButton("chevronLeft", "Page précédente", keysOf("prevPage"), () => void view?.prev(), { side: "bottom", keep: true }),
        this.iconButton("chevronRight", "Page suivante", keysOf("nextPage"), () => void view?.next(), { side: "bottom", keep: true }),
      );
      const title = this.pageTitleOf(tab);
      bar.append(el("button", {
        class: "tb-title", "data-tip": "Liste des pages", "data-keys": keysOf("goto"), "data-tip-side": "bottom",
        onclick: () => void this.focusPageList(),
      }, el("strong", {}, tab ? leafName(tab.divider) : ""), title ? el("span", { class: "tb-sub" }, title) : null));
      bar.append(el("div", { class: "spacer" }), this.statusBtn);
      if (!compact) {
        const mathOpen = this.mathFly || this.settings.mathPinned;
        const calcOpen = !!this.calculator?.isVisible;
        bar.append(
          this.iconButton("flag", "Pas compris", keysOf("flag"), () => view?.addFlag(), {
            cls: "flag-btn", keep: true, side: "bottom", tip: "Pas compris : repère sur la page",
          }),
          this.iconButton("sigma", "Formules", keysOf("maths"), () => this.toggleMaths(), {
            cls: `maths-btn${mathOpen ? " on" : ""}`, keep: true, side: "bottom", pressed: mathOpen,
          }),
          this.iconButton("calculator", "Calculatrice", keysOf("calc"), () => void this.toggleCalculator(), {
            cls: `calc-btn${calcOpen ? " on" : ""}`, keep: true, side: "bottom", pressed: calcOpen,
          }),
          this.iconButton("share", "Partager", keysOf("exportPage"), () => this.openShare(), {
            cls: "share-btn", side: "bottom", tip: "Partager : PDF ou Word, la page ou l'intercalaire",
          }),
        );
      }
      bar.append(this.iconButton("more", "Plus", "", (e) => this.openMoreMenu(e.currentTarget as HTMLElement), {
        cls: "more-btn", side: "bottom", tip: "Page : insérer, photo, PDF, fond, affichage, réglages",
      }));
      return;
    }
    const titles: Record<Screen, string> = {
      menu: "Récents", flags: "Pas compris", review: "Réviser", probe: "Sonde stylet", notebook: "",
    };
    bar.append(el("h1", { class: "tb-screen" }, titles[this.screen]), el("div", { class: "spacer" }), this.statusBtn);
    if (compact) {
      bar.append(this.iconButton("search", "Rechercher", keysOf("search"), () => void this.showSearch(), { side: "bottom" }));
    }
    if (this.screen === "menu") {
      bar.append(this.iconButton("plus", "Nouvelle matière", "", () => {
        void newNotebook(this.menuHost(), this.homeData?.notebooks.map((n) => n.meta.color) ?? []);
      }, { side: "bottom" }));
    }
    if (this.tabs.length && !compact) {
      bar.append(el("button", { class: "tb-back", onclick: () => void this.backToWork() },
        "Retour au cahier", el("kbd", {}, keysOf("menu"))));
    }
  }

  /**
   * Onglets, seulement a partir de deux cahiers ouverts : un par cahier et
   * intercalaire. Glisser un onglet sur la moitie droite ouvre le split.
   */
  private paintTabRow(): void {
    const row = this.tabrow;
    row.replaceChildren();
    const notebook = this.screen === "notebook";
    row.hidden = !(notebook && this.tabs.length > 1);
    if (row.hidden) return;
    const focused = this.focusedTab();
    for (const tab of this.tabs) {
      const active = tab === focused;
      const node = el("div", {
        class: `tab${active ? " active" : this.shown(tab) ? " shown" : ""}`,
        draggable: "true", role: "tab", "aria-selected": String(active),
      },
        notebookSquare(tab.color, 9),
        el("span", { class: "label", title: `${tab.title} · ${dividerLabel(tab.divider)}` },
          `${tab.title} · ${leafName(tab.divider)}`),
        el("button", {
          class: "close", "aria-label": "Fermer l'onglet", title: titleOf("Fermer l'onglet", "closeTab"),
          onclick: (e: Event) => { e.stopPropagation(); void this.closeTab(tab.id); },
        }, icon("close", 14)),
      );
      node.addEventListener("click", () => {
        if (this.shown(tab)) { this.setFocused(tab.id); return; }
        this.place(tab);
        void this.renderNotebookScreen();
      });
      node.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", tab.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.append(node);
    }
  }

  /**
   * Bouton icone du chrome : nom dans l'aria-label (lecteur d'ecran, tests),
   * infobulle nom + raccourci a la souris (tooltip.ts), 44 px au doigt.
   */
  private iconButton(
    name: IconName, label: string, keys: string, run: (e: MouseEvent) => void,
    o: { cls?: string; side?: "right" | "bottom" | "top"; tip?: string; keep?: boolean; pressed?: boolean } = {},
  ): HTMLButtonElement {
    const b = el("button", {
      class: `icon-btn ${o.cls ?? ""}`.trim(),
      "aria-label": label,
      "data-tip": o.tip ?? label,
      "data-tip-side": o.side ?? "bottom",
      ...(keys ? { "data-keys": keys } : {}),
      ...(o.pressed != null ? { "aria-pressed": String(o.pressed) } : {}),
      onclick: (e: MouseEvent) => run(e),
    }, icon(name, 20));
    if (o.keep) keepFocus(b);
    return b;
  }

  /** Bascule de matiere (en-tete de la barre laterale), sans repasser par l'accueil. */
  private async openNotebookSwitcher(anchor: HTMLElement): Promise<void> {
    const dirs = await this.repo.listNotebookDirs();
    const metas = await Promise.all(dirs.map(async (dir) => {
      try { const m = await this.repo.readMeta(dir); return { dir, title: m.title || dir, color: m.color }; }
      catch { return { dir, title: dir, color: "#94a3b8" }; }
    }));
    const current = this.focusedTab()?.notebook;
    contextMenu(anchor, [
      { label: "Accueil", icon: "home", keys: keysOf("menu"), run: () => { this.closeOverlay(); void this.showMenu(); } },
      "sep",
      ...metas.map((m) => ({
        label: m.title, swatch: m.color, checked: m.dir === current ? true : undefined,
        run: () => { if (m.dir !== current) { this.closeOverlay(); void this.openNotebook(m.dir); } },
      })),
    ], { label: "Matières" });
  }

  /* ---------------- ecran cahier ---------------- */

  private async renderNotebookScreen(): Promise<void> {
    const tab = this.activeTab();
    if (!tab) { await this.showMenu(); return; }
    if (this.splitId === tab.id) this.splitId = null;
    if (!this.splitId || (this.focusedId !== tab.id && this.focusedId !== this.splitId)) this.focusedId = tab.id;
    this.screen = "notebook";
    this.menuKeys = null;

    clear(this.main);
    // Vue retiree (matiere renommee) : remontee a la page retenue.
    if (!tab.view) await this.mountView(tab, this.positions.pageFor(tab.notebook, tab.divider));
    const other = this.splitId ? this.tabs.find((t) => t.id === this.splitId) : undefined;
    if (this.splitId && !other) this.splitId = null;
    if (other && !other.view) await this.mountView(other, this.positions.pageFor(other.notebook, other.divider));
    this.paintChrome();
    // La page au centre, la calculatrice en panneau a droite (inspecteur) :
    // elle pousse la page sans la couvrir.
    const inspector = el("aside", { class: "inspector closed", "aria-label": "Calculatrice" });
    const stage = el("div", { class: "stage" });
    const work = el("div", { class: "work" }, stage, inspector);
    this.main.append(work);
    this.calcSlot = { side: inspector, work };
    // Fermee par defaut (D6) : mathjs n'est charge qu'au premier Ctrl+L.
    if (this.settings.calcOpen || this.calculator) {
      void this.loadCalculator().then((calc) => {
        if (this.calcSlot?.side !== inspector) return;
        this.placeCalculator(calc);
        if (this.settings.calcOpen && !calc.isVisible) calc.show();
      });
    }

    const panes = el("div", { class: "panes" });
    panes.append(this.buildPane(tab, false));
    if (other) panes.append(this.buildPane(other, true));
    stage.append(panes, this.buildPalette());
    this.paintMath();
    this.paintStatus();

    // La vue reprend son defilement : un passage par l'accueil ou un autre
    // onglet ne ramene plus en haut de l'intercalaire.
    for (const t of other ? [tab, other] : [tab]) {
      if (!t.view) continue;
      t.host.append(t.view.root, this.buildPagePill(t.view));
      t.view.attached();
    }
  }

  /**
   * Indicateur de page du panneau, en bas a droite (hors de la zone
   * d'ecriture centrale) : « p. 4 / 12 » (liste des pages dans la barre
   * laterale, Ctrl+G) et le zoom quand il n'est pas a 100 %.
   */
  private buildPagePill(view: PageView): HTMLElement {
    const label = el("button", {
      class: "page-label",
      "aria-label": "Liste des pages",
      "data-tip": "Liste des pages", "data-keys": keysOf("goto"), "data-tip-side": "top",
      onclick: () => { this.focusView(view); void this.focusPageList(); },
    }, pageLabel(view.pageNumber, view.pageCount));
    this.pageLabels.set(view, label);
    return el("div", { class: "page-pill", role: "group", "aria-label": "Page" }, keepFocus(label), view.zoomChip);
  }

  /** Un bouton d'un panneau du split le vise d'abord (outils, clavier). */
  private focusView(view: PageView): void {
    const tab = this.tabs.find((t) => t.view === view);
    if (tab) this.setFocused(tab.id);
  }

  private buildPane(tab: Tab, isRight: boolean): HTMLElement {
    const pane = tab.host;
    pane.replaceChildren();
    pane.className = `pane${this.splitId && tab.id === this.focusedId ? " focused" : ""}`;
    // En split, un petit en-tete par panneau dit ce qu'il montre.
    if (this.splitId) pane.append(el("div", { class: "pane-head" },
      notebookSquare(tab.color, 9),
      el("strong", {}, tab.title),
      el("span", { class: "muted" }, `› ${dividerLabel(tab.divider)}`),
      el("div", { class: "spacer" }),
      // Les deux commandes du split, une seule fois, sur le panneau droit.
      isRight ? this.iconButton("swap", "Permuter les panneaux", keysOf("swap"), () => void this.swapPanes(), { side: "bottom", cls: "small-icon" }) : null,
      isRight ? this.iconButton("close", "Fermer le panneau droit", keysOf("closeSplit"), () => void this.closeSplit(), { side: "bottom", cls: "small-icon" }) : null,
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

  /** Groupe d'intercalaires deplie ou replie dans la barre laterale, sans changer de page. */
  private toggleGroup(tab: Tab, path: string): void {
    const set = this.expandedGroups.get(tab.notebook) ?? new Set<string>();
    this.expandedGroups.set(tab.notebook, set);
    const open = !set.has(`!${path}`) && (set.has(path) || isUnder(tab.divider, path));
    if (open) {
      set.delete(path);
      // Replier le groupe de l'intercalaire ouvert : on le marque replie
      // explicitement (sinon il resterait ouvert parce qu'il le contient).
      if (isUnder(tab.divider, path)) set.add(`!${path}`);
    } else {
      set.add(path);
      set.delete(`!${path}`);
    }
    void this.paintSidebar();
  }

  /**
   * « + Intercalaire » ou Ctrl+T : un intercalaire de plus, ouvert aussitot,
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
   * Menu d'un intercalaire (clic droit, appui long) : ouvrir a droite,
   * renommer, ranger dans un groupe ou l'en sortir (D4), supprimer.
   * L'ordre se change en glissant la ligne.
   */
  private async dividerMenu(tab: Tab, d: string, at: { x: number; y: number }): Promise<void> {
    const holder = this.tabs.find((t) => t.notebook === tab.notebook && t.divider === d);
    const left = this.activeTab();
    const tree = await this.repo.listDividerTree(tab.notebook);
    const node = findNode(tree, d);
    if (!node) return;
    const isGroup = node.children.length > 0;
    const locked = () => this.refuseLocked(tab.notebook);
    const entries: MenuEntry[] = [];
    // Cours a gauche, Exos a droite (section 5) : pas pour l'intercalaire
    // deja a gauche, ni pour celui deja a droite, ni pour un simple groupe.
    if ((!isGroup || node.pages) && holder?.id !== left?.id && (!holder || holder.id !== this.splitId)) {
      entries.push({ label: "Ouvrir à droite", icon: "split", run: () => void this.openRight(tab.notebook, d) });
    }
    entries.push({
      label: "Renommer…", icon: "rename", run: () => void (async () => {
        if (locked()) return;
        const next = await askText(isGroup ? "Renommer le groupe" : "Renommer l'intercalaire", "Nouveau nom", leafName(d));
        if (next) await this.renameDivider(tab, d, next);
      })(),
    });
    if (isGroup && depthOf(d) < MAX_DEPTH) {
      entries.push({ label: `Nouvel intercalaire dans ${node.name}…`, icon: "plus", run: () => { if (!locked()) void this.newDivider(tab, d); } });
    }
    // Ranger : les groupes ou il peut aller (3 niveaux au plus), un nouveau groupe, le premier niveau.
    const height = subtreeHeight(node);
    const groups: MenuEntry[] = flattenTree(tree)
      .filter((p) => findNode(tree, p)!.children.length && !moveRefusal(d, p, height))
      .map((p) => ({ label: dividerLabel(p), icon: "folder" as const, run: () => { if (!locked()) void this.moveDividerTo(tab, d, p); } }));
    if (depthOf(d) + height <= MAX_DEPTH) {
      groups.push({ label: "Nouveau groupe…", icon: "plus", run: () => void this.newGroupFor(tab, d) });
    }
    if (parentPath(d)) groups.push({ label: "Premier niveau de la matière", icon: "folderIn", run: () => { if (!locked()) void this.moveDividerTo(tab, d, ""); } });
    entries.push(groups.length
      ? { label: "Ranger dans un groupe", icon: "folderIn", sub: groups }
      : { label: `Aucun groupe possible (${MAX_DEPTH} niveaux au plus)`, icon: "folderIn", disabled: true });
    if (parentPath(d)) {
      entries.push({ label: `Sortir de ${leafName(parentPath(d))}`, icon: "folder", run: () => { if (!locked()) void this.moveDividerTo(tab, d, parentPath(parentPath(d))); } });
    }
    entries.push("sep", {
      label: isGroup ? "Supprimer le groupe…" : "Supprimer l'intercalaire…", icon: "trash", danger: true,
      run: () => void (async () => {
        if (locked()) return;
        const inside = flattenTree(node.children).length;
        const ok = await confirmDialog(
          isGroup ? "Supprimer le groupe" : "Supprimer l'intercalaire",
          `${dividerLabel(d)} et toutes ses pages${inside ? `, avec ${inside} intercalaire${inside > 1 ? "s" : ""} rangé${inside > 1 ? "s" : ""} dedans,` : ""} `
            + "partent à la corbeille (dossier ESEO/.corbeille). "
            + "Le bouton « Annuler » du message qui suit le remet en place.",
          "Supprimer",
        );
        if (ok) await this.deleteDivider(tab, d);
      })(),
    });
    contextMenu(at, entries, { label: dividerLabel(d) });
  }

  /** « Ranger dans un groupe › Nouveau groupe… » : le groupe est cree a son niveau. */
  private async newGroupFor(tab: Tab, d: string): Promise<void> {
    if (this.refuseLocked(tab.notebook)) return;
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
    // On voit ou il est arrive : son groupe est deplie.
    if (toParent) this.expandGroup(tab.notebook, toParent);
    toast(`${leafName(d)} rangé dans ${toParent ? dividerLabel(toParent) : "le premier niveau"}`, "info", 2500);
    await this.renderNotebookScreen();
  }

  /**
   * Un intercalaire (et tout son contenu) a change de chemin : onglets,
   * vues, positions et historique suivent.
   */
  private async retarget(notebook: string, from: string, to: string): Promise<void> {
    const set = this.expandedGroups.get(notebook);
    if (set) this.expandedGroups.set(notebook, new Set([...set].map((g) => (g.startsWith("!")
      ? `!${renamePrefix(g.slice(1), from, to)}` : renamePrefix(g, from, to)))));
    for (const k of [...this.pageRows.keys()]) if (k.startsWith(`${notebook}\u0000`)) this.pageRows.delete(k);
    for (const t of this.tabs.filter((x) => x.notebook === notebook)) {
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
    const groups = this.expandedGroups.get(nb);
    if (groups) for (const g of [...groups]) if (isUnder(g.replace(/^!/, ""), d)) groups.delete(g);
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
    // Un groupe sans pages propres : il se deplie, la page reste.
    const node = findNode(await this.repo.listDividerTree(tab.notebook), name);
    if (node && !node.pages) {
      this.expandGroup(tab.notebook, name);
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
   * Palette d'outils flottante, en bas au centre de la zone des pages
   * (capsule floutee, ombre) : Stylo, Surligneur, Gomme, Lasso | les six
   * couleurs (palette semantique fermee, section 8) | Annuler, Retablir.
   * Sous-choix au second appui sur l'outil actif ou a l'appui long :
   * epaisseur du stylo, gomme precise, lasso ou espace. Etroite (telephone,
   * split), les six pastilles se replient en un bouton.
   */
  private buildPalette(): HTMLElement {
    const pal = el("div", { class: "palette", role: "toolbar", "aria-label": "Outils" });
    const view = () => this.focusedTab()?.view;

    const optionList = (anchor: HTMLElement, label: string, options: {
      on: boolean; name: IconName | null; text: string; hint: string; run: () => void; node?: Node;
    }[]) => {
      const list = el("div", { class: "fly-list", role: "menu", "aria-label": label },
        el("div", { class: "fly-title" }, label),
        ...options.map((o) => keepFocus(el("button", {
          class: `fly-item${o.on ? " on" : ""}`, role: "menuitemradio", "aria-checked": String(o.on),
          onclick: () => { this.closeFlyout(); o.run(); },
        }, o.node ?? (o.name ? icon(o.name, 20) : null), el("span", { class: "fly-text" },
          el("span", {}, o.text), o.hint ? el("span", { class: "fly-hint" }, o.hint) : null)))));
      this.openFlyout(anchor, list, { side: "top", label });
    };

    const widths: [string, number][] = [["Fin", 1.4], ["Moyen", 2.2], ["Épais", 3.6]];
    const widthSub = (a: HTMLElement) => optionList(a, "Épaisseur du stylo", widths.map(([label, w]) => ({
      on: this.width === w, name: null, node: widthIcon(w, 22), text: label, hint: "",
      run: () => { this.width = w; this.persist(); this.paintToolbar(); },
    })));
    const eraserSub = (a: HTMLElement) => optionList(a, "Gomme", [
      { on: this.eraserMode === "stroke", name: "eraser", text: "Trait entier", hint: "Efface tout le trait touché", run: () => this.setEraserMode("stroke") },
      { on: this.eraserMode === "precise", name: "eraser", text: "Précise", hint: "Coupe le trait : seule la partie frottée part", run: () => this.setEraserMode("precise") },
    ]);
    const lassoSub = (a: HTMLElement) => optionList(a, "Sélection", [
      { on: this.tool === "lasso", name: "lasso", text: "Entourer", hint: "Déplacer, retailler, recolorer, copier", run: () => this.selectTool("lasso") },
      { on: this.tool === "space", name: "space", text: "Insérer de l'espace", hint: "Glisser une ligne : tout ce qui est dessous descend", run: () => this.selectTool("space") },
    ]);

    const tool = (id: Tool, name: IconName, label: string, keys: string, sub?: (anchor: HTMLElement) => void) => {
      const active = id === this.tool || (id === "lasso" && isSelect(this.tool));
      const b = this.iconButton(name, label, keyLabel(keys), () => {
        // Outil deja actif et sous-choix : le second appui ouvre le volet.
        if (active && sub) { sub(b); return; }
        this.selectTool(id);
      }, { cls: `tool${active ? " on" : ""}${sub ? " has-sub" : ""}`, pressed: active, keep: true, side: "top" });
      b.dataset.tool = id;
      if (sub) {
        // Appui long : le volet, l'outil choisi au passage.
        onLongPress(b, () => {
          if (!active) this.selectTool(id);
          const now = this.main.querySelector<HTMLElement>(`.palette [data-tool="${id}"]`) ?? b;
          sub(now);
        });
      }
      return b;
    };

    pal.append(
      tool("pen", "pen", `Stylo (${widths.find(([, w]) => w === this.width)?.[0] ?? "Moyen"})`, "Alt+E", widthSub),
      tool("highlighter", "highlighter", "Surligneur", "Alt+H"),
      tool("eraser", "eraser", this.eraserMode === "precise" ? "Gomme précise" : "Gomme", "Alt+G", eraserSub),
      tool("lasso", this.tool === "space" ? "space" : "lasso", this.tool === "space" ? "Espace" : "Lasso", "Alt+A", lassoSub),
    );
    // aria-label stables pour les tests et les lecteurs d'ecran.
    pal.querySelector('[data-tool="pen"]')?.setAttribute("aria-label", "Stylo");
    pal.querySelector('[data-tool="lasso"]')?.setAttribute("aria-label", "Lasso");
    pal.querySelector('[data-tool="eraser"]')?.setAttribute("aria-label", "Gomme");
    // Zone math/texte (Alt+Z, Alt+T) en cours : dit, et un appui la quitte.
    if (isZone(this.tool)) {
      pal.append(keepFocus(el("button", {
        class: "zone-chip", "aria-label": "Quitter la zone",
        title: this.toolLocked ? "Zone verrouillée : plusieurs zones de suite" : "Zone ponctuelle : la suivante revient au stylo",
        onclick: () => { this.toolLocked = false; this.tool = this.prevTool; this.persist(); this.paintToolbar(); },
      }, this.tool === "region" ? "Zone math" : "Zone texte", icon("close", 14))));
    }
    pal.append(el("div", { class: "pal-sep", role: "separator" }));

    // Palette fermee a 5 couleurs a semantique fixe (section 8), plus l'encre
    // neutre noire ; elle vaut pour l'encre ET le texte tape.
    const colors: { key: ColorKey | null; label: string; ink: string; keys: string }[] = [
      { key: null, label: `${NEUTRAL_INK.label}`, ink: NEUTRAL_INK.ink, keys: `Alt+${NEUTRAL_INK.shortcut}` },
      ...PALETTE.map((p) => ({ key: p.key as ColorKey | null, label: p.label, ink: p.ink, keys: `Alt+${p.shortcut}` })),
    ];
    // Pastilles telles que l'encre s'affiche (feuille sombre : noir montre clair).
    const sheet = this.root.dataset.sheet;
    const shown = (c: { key: ColorKey | null; ink: string }) =>
      sheet === "dark" ? inkDisplayColor(c.key ?? "normal", "pen", "dark") : c.ink;
    const all = el("div", { class: "sw-all", role: "radiogroup", "aria-label": "Couleur" });
    for (const c of colors) {
      const on = (c.key ?? "normal") === this.color;
      all.append(keepFocus(el("button", {
        class: `sw${on ? " on" : ""}`, role: "radio", "aria-checked": String(on),
        "aria-label": c.key ? c.label : "Normal, en noir", "data-tip": c.label, "data-keys": keyLabel(c.keys), "data-tip-side": "top",
        dataset: { color: c.key ?? "normal" },
        onclick: () => this.pickColor(c.key),
      }, el("i", { style: { background: shown(c) } }))));
    }
    const activeInk = colors.find((c) => (c.key ?? "normal") === this.color) ?? colors[0];
    const one: HTMLButtonElement = keepFocus(el("button", {
      class: "sw sw-one", "aria-haspopup": "menu", "aria-label": `Couleur : ${labelOf(this.color)}`,
      "data-tip": `Couleur : ${labelOf(this.color)}`, "data-tip-side": "top",
      onclick: () => optionList(one, "Couleur de l'encre et du texte", colors.map((c) => ({
        on: (c.key ?? "normal") === this.color, name: null, node: el("i", { class: "swatch-dot", style: { background: shown(c) } }),
        text: c.key ? c.label : "Normal", hint: keyLabel(c.keys), run: () => this.pickColor(c.key),
      }))),
    }, el("i", { style: { background: shown(activeInk) } })));
    one.dataset.color = this.color;
    pal.append(all, one, el("div", { class: "pal-sep", role: "separator" }),
      this.iconButton("undo", "Annuler", keysOf("undo"), () => view()?.undo(), { keep: true, side: "top" }),
      this.iconButton("redo", "Rétablir", keysOf("redo"), () => view()?.redo(), { keep: true, side: "top" }),
    );
    return pal;
  }

  /** Volet des formules, selon l'etat (core/chrome.ts). */
  private mathMode(): MathPanelMode {
    return mathPanelMode({ open: this.mathFly, pinned: this.settings.mathPinned });
  }

  /** Bouton Σ ou Ctrl+Maj+M : ouvre le volet des formules, ou le ferme. */
  private toggleMaths(): void {
    if (this.mathMode() !== "closed") {
      if (this.settings.mathPinned) { this.settings.mathPinned = false; saveSettings(this.settings); }
      this.setMathFly(false);
      this.paintMath();
      return;
    }
    this.setMathFly(true);
  }

  /** Epingle le volet (il reste ouvert), retenu sur cette machine. */
  private setMathPinned(pinned: boolean): void {
    this.settings.mathPinned = pinned;
    saveSettings(this.settings);
    this.mathFly = true;
    if (!pinned) this.watchMathOutside();
    this.paintMath();
  }

  /**
   * Volet ouvert ou ferme (pas retenu). Echap, le bouton Σ ou un appui hors
   * du volet le ferme ; ses touches le laissent ouvert (plusieurs symboles).
   */
  private setMathFly(open: boolean): void {
    if (this.mathFly === open) return;
    this.mathFly = open;
    this.paintMath();
    if (open) this.watchMathOutside();
  }

  private watchMathOutside(): void {
    const outside = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".math-pop, .maths-btn")) return;
      document.removeEventListener("pointerdown", outside, true);
      if (this.mathFly && !this.settings.mathPinned) this.setMathFly(false);
    };
    document.addEventListener("pointerdown", outside, true);
  }

  /**
   * Volet des formules : popover ancre sous Σ, sections titrees (Structures,
   * Grec, Relations, Ensembles). Il evite la ligne en cours : si le curseur
   * du texte est dessous, il passe en bas a droite de la zone des pages.
   */
  private paintMath(): void {
    document.querySelector(".math-pop")?.remove();
    const mode = this.mathMode();
    const btn = this.tabbar.querySelector<HTMLElement>(".maths-btn");
    btn?.classList.toggle("on", mode !== "closed");
    btn?.setAttribute("aria-pressed", String(mode !== "closed"));
    if (mode === "closed" || this.screen !== "notebook") return;
    const pinned = this.settings.mathPinned;
    const pop = el("section", { class: "math-pop", "aria-label": "Formules" },
      el("header", { class: "math-head" },
        el("span", { class: "math-title" }, "Formules"),
        el("div", { class: "spacer" }),
        this.iconButton("pin", pinned ? "Ne plus épingler" : "Épingler", "", () => this.setMathPinned(!pinned), {
          cls: `small-icon${pinned ? " on" : ""}`, keep: true, pressed: pinned, side: "bottom",
          tip: pinned ? "Ne plus épingler : le volet se refermera seul" : "Épingler : le volet reste ouvert",
        }),
        this.iconButton("close", "Fermer", keysOf("maths"), () => this.toggleMaths(), { cls: "small-icon", keep: true, side: "bottom" }),
      ),
      buildFormulaPanel(() => this.focusedTab()?.view?.activeDoc),
    );
    document.body.append(pop);
    const W = window.innerWidth, H = window.innerHeight;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const a = (btn ?? this.tabbar).getBoundingClientRect();
    let x = Math.max(8, Math.min(a.right - w, W - w - 8));
    let y = this.tabbar.getBoundingClientRect().bottom + 6;
    // La ligne en cours ne doit pas passer sous le volet.
    const caret = caretRect();
    if (caret && caret.bottom > y && caret.top < y + h && caret.right > x && caret.left < x + w) {
      const stage = this.main.querySelector(".stage")?.getBoundingClientRect();
      const below = (stage?.bottom ?? H) - h - 84;
      if (below > caret.bottom + 8) y = below;
      else x = Math.max(8, (stage?.left ?? 0) + 8);
    }
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(Math.max(8, Math.min(y, H - h - 8)))}px`;
  }

  /* ---------------- volets du chrome ---------------- */

  /** Volet ouvert (epaisseur, gomme, couleur, etat...) et sa fermeture. */
  private flyout: { node: HTMLElement; close: () => void } | null = null;

  private closeFlyout(): void {
    this.flyout?.close();
  }

  /**
   * Petit volet ancre a un bouton du chrome : au-dessus de la palette, ou
   * sous la barre du haut. Un appui a cote, Echap ou un choix le ferme ; le
   * clavier reste ou il etait (les boutons ne prennent pas le focus).
   */
  private openFlyout(anchor: HTMLElement, content: HTMLElement, o: { side: "right" | "bottom" | "top"; label: string; cls?: string }): void {
    const same = this.flyout?.node.dataset.label === o.label;
    this.closeFlyout();
    // Second appui sur le bouton qui l'a ouvert : il se referme seulement.
    if (same) return;
    const node = el("div", { class: `flyout ${o.side} ${o.cls ?? ""}`.trim(), dataset: { label: o.label } }, content);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (node.contains(t)) return;
      close();
      // L'appui sur le bouton d'origine ne doit pas le rouvrir aussitot.
      if (anchor.contains(t)) { e.stopPropagation(); e.preventDefault(); swallowClick(anchor); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      close();
    };
    const close = () => {
      node.remove();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      anchor.classList.remove("open");
      if (this.flyout?.node === node) this.flyout = null;
    };
    document.body.append(node);
    anchor.classList.add("open");
    const r = anchor.getBoundingClientRect();
    const w = node.offsetWidth, h = node.offsetHeight;
    let x: number, y: number;
    if (o.side === "bottom") { x = r.right - w; y = r.bottom + 6; }
    else if (o.side === "top") { x = r.left + r.width / 2 - w / 2; y = r.top - h - 10; }
    else { x = r.right + 8; y = r.top - 6; }
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    this.flyout = { node, close };
  }

  /**
   * Menu ⋯ de la page : insérer, photo, PDF, fond de page, affichage,
   * split, versions de la page (si le module existe), réglages ; « Supprimer
   * la page » en rouge, a part. Au telephone, il reprend aussi les boutons
   * de la barre du haut (Pas compris, Formules, Calculatrice, Partager).
   */
  private openMoreMenu(anchor: HTMLElement): void {
    const view = this.focusedTab()?.view;
    if (!view) return;
    const compact = window.innerWidth < PHONE_MAX;
    const mode = view.mode;
    const entries: MenuEntry[] = [];
    if (compact) {
      entries.push(
        { label: "Pas compris", icon: "flag", keys: keysOf("flag"), run: () => view.addFlag() },
        { label: "Formules", icon: "sigma", keys: keysOf("maths"), run: () => this.toggleMaths() },
        { label: "Calculatrice", icon: "calculator", keys: keysOf("calc"), run: () => void this.toggleCalculator() },
        { label: "Partager…", icon: "share", run: () => this.openShare() },
        "sep",
      );
    }
    entries.push(
      { label: "Insérer une page après", icon: "filePlus", keys: keysOf("insertPage"), run: () => void view.newPage(true).then(() => this.refreshSidebarSoon(0)) },
      { label: "Nouvelle page à la fin", icon: "plus", keys: keysOf("newPage"), run: () => void view.newPage().then(() => this.refreshSidebarSoon(0)) },
      { label: "Photo du tableau…", icon: "camera", keys: keyLabel(PHOTO_IMPORT_KEYS), run: () => void this.importImage() },
      { label: "Importer un PDF…", icon: "fileUp", keys: keysOf("importPdf"), run: () => void this.importPdf() },
      "sep",
      {
        label: "Fond de page", icon: "grid", sub: PAPERS.map((p) => ({
          label: p.label, checked: (view.paper ?? "uni") === p.kind ? true : undefined,
          run: () => void view.setPaper(p.kind).then(() => this.backToPage()),
        })),
      },
      {
        label: "Affichage", icon: "rows", sub: [
          { label: "Pages : une à la fois", checked: mode === "pages" ? true : undefined, keys: keysOf("viewMode"), run: () => void this.setViewMode("pages") },
          { label: "Défilement : toutes à la suite", checked: mode === "scroll" ? true : undefined, run: () => void this.setViewMode("scroll") },
        ],
      },
      this.splitId
        ? { label: "Fermer le panneau droit", icon: "split", keys: keysOf("closeSplit"), run: () => void this.closeSplit() }
        : { label: "Diviser l'écran", icon: "split", keys: keysOf("split"), run: () => void this.toggleSplit() },
    );
    entries.push({ label: "Versions de la page…", icon: "history", run: () => void openVersions(view) });
    entries.push(
      "sep",
      { label: "Réglages…", icon: "settings", keys: keysOf("settings"), run: () => void this.openSettings() },
      { label: "Raccourcis clavier", icon: "keyboard", keys: "F1", run: () => showShortcuts() },
      "sep",
      { label: "Supprimer la page…", icon: "trash", danger: true, run: () => void view.deleteCurrentPage().then(() => this.refreshSidebarSoon(0)) },
    );
    contextMenu(anchor, entries, { label: "Page", align: "end" });
  }

  /** Le clavier revient a la page apres un choix de menu. */
  private backToPage(): void {
    if (this.screen !== "notebook" || document.querySelector(".backdrop")) return;
    if (!isEditingDoc(document.activeElement)) this.focusedTab()?.view?.focusText();
  }

  /**
   * Partager : un seul dialogue, PDF ou Word, la page ou tout
   * l'intercalaire (dernier choix retenu sur la machine). Ctrl+P / Ctrl+E
   * restent les raccourcis directs.
   */
  private openShare(): void {
    const view = this.focusedTab()?.view;
    if (!view || document.querySelector(".backdrop")) return;
    const saved = readJson<{ format: "pdf" | "word"; scope: "current" | "all" }>(SHARE_KEY) ?? { format: "pdf", scope: "current" };
    let format = saved.format === "word" ? "word" : "pdf";
    let scope: "current" | "all" = saved.scope === "all" ? "all" : "current";
    const body = el("div", { class: "share-body" });
    const go = el("button", { class: "primary" }, "Exporter");
    const paint = () => {
      body.replaceChildren(
        settingRow("Format", segmented([
          ["PDF", format === "pdf", () => { format = "pdf"; paint(); }],
          ["Word (.docx)", format === "word", () => { format = "word"; paint(); }],
        ]), format === "pdf" ? "Feuilles A4, encre et texte tels quels" : "Titres, listes, équations Word éditables, encre en images"),
        settingRow("Contenu", segmented([
          [`Cette page (p. ${view.pageNumber})`, scope === "current", () => { scope = "current"; paint(); }],
          [`Tout l'intercalaire (${view.pageCount} p.)`, scope === "all", () => { scope = "all"; paint(); }],
        ]), dividerLabel(view.divider)),
      );
    };
    paint();
    const dlg = sheetDialog("Partager", body, { cls: "share-dialog", footer: [go] });
    go.addEventListener("click", () => {
      writeJson(SHARE_KEY, { format, scope });
      dlg.close();
      if (format === "pdf") void view.exportPdf(scope);
      else void this.exportWord(view, scope);
    });
    go.focus();
  }

  /**
   * Reglages (Ctrl+, / Cmd+,) : apparence, ecriture, reconnaissance,
   * diagnostic, dossiers. Chaque choix s'applique tout de suite.
   */
  private async openSettings(): Promise<void> {
    if (document.querySelector(".settings-dialog")) return;
    const body = el("div", { class: "settings-body" });
    const paint = () => {
      const q = this.queueState;
      body.replaceChildren(
        el("h3", { class: "set-h" }, "Apparence"),
        settingRow("Thème", segmented(THEME_PREFS.map(({ pref, label }) =>
          [label, this.settings.theme === pref, () => { this.setTheme(pref); paint(); }] as SegChoice)),
          "Système suit le réglage de l'ordinateur"),
        settingRow("Feuille", segmented(SHEET_TONES.map(({ tone, label }) =>
          [label, this.settings.sheet === tone, () => { this.setSheet(tone); paint(); }] as SegChoice)),
          "À l'écran seulement : l'export PDF et Word reste blanc, encre noire"),
        el("h3", { class: "set-h" }, "Écriture"),
        settingRow("Conversion", segmented([
          ["Au fil de la plume", this.autoConvert, () => { this.setAutoConvert(true); paint(); }],
          ["Sur zone", !this.autoConvert, () => { this.setAutoConvert(false); paint(); }],
        ]), `Ce que la reconnaissance transforme en texte et en formules (${keysOf("convert")})`),
        settingRow("Écriture convertie", segmented([
          ["Encre", this.renderMode === "ink", () => { this.setRenderMode("ink"); paint(); }],
          ["Texte", this.renderMode === "clean", () => { this.setRenderMode("clean"); paint(); }],
        ]), "Montrer l'encre telle qu'écrite, ou le rendu converti"),
        settingRow("Formules tapées", segmented([
          ["Auto", this.settings.autoMath, () => { this.setTypedMath(true); paint(); }],
          ["Non", !this.settings.autoMath, () => { this.setTypedMath(false); paint(); }],
        ]), "Vs = Vz - Vbe, a/b, beta… mises en forme pendant la frappe"),
        settingRow("Orthographe", segmented([
          ["Oui", this.settings.spellcheck, () => { this.setSpelling(true); paint(); }],
          ["Non", !this.settings.spellcheck, () => { this.setSpelling(false); paint(); }],
        ]), "Souligner les fautes dans le texte tapé"),
        settingRow("Écrire au doigt (sans stylet)", segmented([
          ["Oui", this.touchRole() === "write", () => { this.setFingerWrites(true); paint(); }],
          ["Non", this.touchRole() !== "write", () => { this.setFingerWrites(false); paint(); }],
        ]), "Par défaut le doigt navigue et le stylet écrit ; « Oui » pour une machine sans stylet"),
        el("h3", { class: "set-h" }, "Reconnaissance manuscrite"),
        settingRow("Clés MyScript", el("button", {
          class: q.backendReady ? "" : "primary", onclick: () => { void this.editKeys().then(() => paint()); },
        }, icon("key", 18), q.backendReady ? "Modifier les clés…" : "Saisir les clés…"),
        q.backendReady ? "Configurées : la conversion est active" : "Non configurées : l'encre est gardée, rien n'est converti"),
        el("h3", { class: "set-h" }, "Diagnostic"),
        settingRow("Sonde stylet", el("button", {
          onclick: () => { dlg.close(); this.showProbe(); },
        }, "Ouvrir la sonde"), "Ce que renvoie l'écran : type de pointeur, pression, points"),
        settingRow("Raccourcis clavier", el("button", { onclick: () => showShortcuts() }, "Afficher", el("kbd", {}, "F1")), ""),
        el("div", { class: "set-root", title: this.rootLabel }, el("span", { class: "muted" }, "Dossier des cahiers : "), this.rootLabel),
      );
    };
    paint();
    const dlg = sheetDialog("Réglages", body, { cls: "settings-dialog" });
    // Dossiers sans page affiches comme matieres : proposes ici, jamais d'office.
    const nbs = this.homeData?.notebooks ?? (await this.loadHomeData()).notebooks;
    const clean = await cleanupSection(this.menuHost(), nbs);
    if (clean && body.isConnected) body.append(el("h3", { class: "set-h" }, "Dossiers"), clean);
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
    const old = this.main.querySelector(".palette");
    if (!old) return;
    // Le volet d'un bouton de la palette ne survit pas a la palette.
    if (this.flyout && old.contains(document.querySelector(".palette .open"))) this.closeFlyout();
    old.replaceWith(this.buildPalette());
  }

  /** Groupe deplie dans la barre laterale (intercalaire range, restaure). */
  private expandGroup(notebook: string, path: string): void {
    const set = this.expandedGroups.get(notebook) ?? new Set<string>();
    set.add(path);
    set.delete(`!${path}`);
    this.expandedGroups.set(notebook, set);
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
    // Une fenetre de dialogue, la recherche ou un menu garde le clavier.
    const dialog = !!document.querySelector(".backdrop, .spot-backdrop, .ctx-menu");
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

    if (e.key === "Escape" && (this.screen === "flags" || this.screen === "probe" || this.screen === "review")) {
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
    // Entree, Espace, fleches ou chiffres sur un bouton du chrome (barre
    // laterale, onglets, palette) : c'est le bouton qui les prend.
    if ((e.target as HTMLElement | null)?.closest?.(".sidebar, .tabrow, .topbar, .palette")
      && (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow") || /^[0-9]$/.test(e.key))) return;
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
      // Ruban Maths en volet (pas epingle) : Echap le ferme.
      popover: this.mathFly && !this.settings.mathPinned,
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
      case "settings": void this.openSettings(); return true;
      case "sidebar": this.toggleSidebar(); return true;
      case "review": void this.showReview({}); return true;
      case "calc": void this.toggleCalculator(); return true;
      case "solveCalc": {
        const src = lastCalcSource();
        if (!src) { toast("Place le curseur sur une ligne de calcul (ou dans une formule)", "warn"); return true; }
        void this.loadCalculator().then((calc) => { this.placeCalculator(calc); calc.solveText(src); this.placeCalculator(calc); });
        return true;
      }
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
        if (notebook) view?.addFlag();
        return true;
      case "newDivider": {
        const tab = this.focusedTab();
        // A cote de l'intercalaire ouvert, dans son groupe (D4).
        if (notebook && tab) void this.newDivider(tab, parentPath(tab.divider));
        return true;
      }
      case "convert": this.setAutoConvert(!this.autoConvert); return true;
      case "viewMode": {
        const v = this.focusedTab()?.view;
        if (v) void this.setViewMode(v.mode === "scroll" ? "pages" : "scroll")
          .then(() => toast(v.mode === "scroll" ? "Défilement : toutes les pages à la suite" : "Pages : une page à la fois"));
        return true;
      }
      case "newPage": if (notebook) void view?.newPage(); return true;
      case "insertPage": if (notebook) void view?.newPage(true); return true;
      case "goto": if (notebook) void this.focusPageList(); return true;
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
      case "maths": if (notebook) this.toggleMaths(); return true;
      case "theme": {
        const next = nextThemePref(this.settings.theme);
        this.setTheme(next);
        toast(`Thème : ${THEME_PREFS.find((t) => t.pref === next)?.label}`, "info", 1400, undefined, "theme");
        return true;
      }
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
   * Liste des pages (Ctrl+G, un appui sur « p. 4 / 12 » ou sur le titre) :
   * celle de la barre laterale, ouverte au besoin, le clavier sur la page
   * courante. Fleches, Entree ; un numero tape y va ; Echap rend la page.
   */
  private async focusPageList(): Promise<void> {
    if (this.screen !== "notebook" || document.querySelector(".backdrop")) return;
    if (!this.sidebarShown()) {
      if (this.sideMode() === "docked") { this.settings.sidebar = true; saveSettings(this.settings); }
      else this.overlayOpen = true;
      this.paintShell();
      this.paintTopbar();
      if (this.calculator) this.placeCalculator(this.calculator);
    }
    await this.focusedTab()?.view?.flush();
    await this.paintSidebar();
    focusPageList(this.sideHost.querySelector(".nb-side"));
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

  /** Raccourcis Alt. Renvoie true si la touche a ete prise. */
  private onAltKey(e: KeyboardEvent, inDoc: boolean): boolean {
    const view = this.focusedTab()?.view;
    // Alt+Maj+P : photos du tableau (Alt+P seul = modele Puissance).
    if (isPhotoImportKey(e)) { void this.importImage(); return true; }
    // Alt+= : nouvelle formule, comme l'equation de Word.
    if ((e.key === "=" || e.code === "Equal") && !e.shiftKey) {
      if (!inDoc) view?.focusText();
      insertMathTemplate("", view?.activeDoc);
      return true;
    }
    // e.code (touche physique) : sur Mac, Option+lettre donne un autre caractere.
    const k = /^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase() ?? e.key.toLowerCase();
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
      if (t === "lasso" && (this.tool === "pen" || this.tool === "highlighter")) this.beforeLasso = this.tool;
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

  /** Etat a montrer : la vue visee dit si son cahier est en lecture seule. */
  private statusNow() {
    const q = this.queueState;
    const tab = this.screen === "notebook" ? this.focusedTab() : undefined;
    return statusSummary({
      online: q.online,
      backendReady: q.backendReady,
      pending: q.pending,
      keysBlocked: q.blocked === "keys",
      lastError: q.lastError ?? null,
      saving: this.hasUnsaved,
      saveError: this.unsavedError,
      readOnly: !!tab && this.isLocked(tab.notebook),
      usage: this.usage.count,
      quota: MONTHLY_QUOTA,
      touchWrites: this.touchWrites,
    });
  }

  /**
   * Indicateur d'etat : un point vert quand tout va bien ; orange ou rouge
   * avec un texte court (« Non enregistré », « Hors ligne ») s'il y a un
   * probleme. Une ecriture en echec reste affichee en rouge tant qu'elle
   * n'a pas abouti : on ne doit pas fermer l'appli en la croyant enregistree.
   */
  private paintStatus(): void {
    const st = this.statusNow();
    const b = this.statusBtn;
    b.className = `status-btn ${st.level}`;
    // Rien a l'ecran quand tout va bien : la pastille n'apparait qu'en cas de probleme.
    b.hidden = st.level === "ok";
    b.setAttribute("aria-label", `État : ${st.title}`);
    b.dataset.tip = `${st.title} : détail`;
    b.dataset.tipSide = "bottom";
    b.replaceChildren(el("span", { class: "led", "aria-hidden": "true" }));
    if (st.short) b.append(el("span", { class: "status-text" }, st.short));
    // Volet ouvert : il suit l'etat en direct.
    if (this.flyout?.node.dataset.label === "État") this.fillStatusPanel(this.flyout.node.firstElementChild as HTMLElement);
  }

  /** Detail de l'etat, ouvert d'un appui sur l'indicateur. */
  private openStatusPanel(): void {
    const panel = el("div", { class: "status-panel", role: "dialog", "aria-label": "État" });
    this.fillStatusPanel(panel);
    this.openFlyout(this.statusBtn, panel, { side: "bottom", label: "État" });
  }

  private fillStatusPanel(panel: HTMLElement): void {
    const st = this.statusNow();
    const q = this.queueState;
    panel.replaceChildren(
      el("div", { class: "fly-title" }, st.level === "ok" ? "Tout va bien" : st.title),
      el("dl", { class: "status-lines" }, ...st.lines.flatMap((l) => [
        el("dt", {}, el("span", { class: `led ${l.level}`, "aria-hidden": "true" }), l.label),
        el("dd", {}, l.text),
      ])),
      el("div", { class: "status-root", title: this.rootLabel }, el("span", { class: "muted" }, "Dossier : "), this.rootLabel),
      el("div", { class: "status-actions" },
        el("button", {
          class: q.blocked === "keys" ? "primary" : "",
          onclick: () => { this.closeFlyout(); void this.editKeys(); },
        }, icon("key", 18), "Clés MyScript"),
      ),
    );
  }

  /* ---------------- apparence ---------------- */

  /** Theme et teinte appliques ; les feuilles deja peintes se repeignent. */
  private applyLook(): void {
    applyAppearance(this.root, this.settings.theme, this.settings.sheet);
    retoneSurfaces();
  }

  private setTheme(pref: ThemePref): void {
    this.settings.theme = pref;
    saveSettings(this.settings);
    this.applyLook();
  }

  private setSheet(tone: SheetPref): void {
    this.settings.sheet = tone;
    saveSettings(this.settings);
    this.applyLook();
    this.paintToolbar();
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
    const bar = this.sideHost.querySelector<HTMLElement>(".nb-side");
    const dir = this.focusedTab()?.notebook;
    if (!bar || !dir || this.screen !== "notebook") return;
    void this.repo.countConflicts(dir).then((counts) => {
      if (!bar.isConnected) return;
      for (const node of bar.querySelectorAll<HTMLElement>(".sb-div[data-divider]")) {
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
/**
 * Bouton du chrome qui ne prend pas le focus a la souris : la selection et
 * le curseur du texte restent, on continue de taper aussitot. Le clavier
 * (Tab) l'atteint toujours.
 */
function keepFocus<T extends HTMLElement>(b: T): T {
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") e.preventDefault(); });
  return b;
}

/** Avale le clic qui suit (l'appui a deja ferme le volet de ce bouton). */
function swallowClick(node: HTMLElement): void {
  const eat = (e: Event) => { e.stopImmediatePropagation(); e.preventDefault(); };
  node.addEventListener("click", eat, { capture: true, once: true });
  setTimeout(() => node.removeEventListener("click", eat, { capture: true }), 600);
}

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

/* ---------------- petits elements des dialogues ---------------- */

type SegChoice = [string, boolean, () => void];

/** Choix segmente (deux ou trois options), l'actif en surbrillance. */
function segmented(choices: SegChoice[]): HTMLElement {
  return el("div", { class: `seg${choices.length > 4 ? " wrap" : ""}`, role: "group" },
    ...choices.map(([label, on, run]) => el("button", {
      class: on ? "on" : "", "aria-pressed": String(on), onclick: () => { if (!on) run(); },
    }, label)));
}

/** Ligne de reglage : libelle et aide a gauche, controle a droite. */
function settingRow(label: string, control: HTMLElement, hint: string): HTMLElement {
  return el("div", { class: "set-row" },
    el("div", { class: "set-label" }, el("span", {}, label), hint ? el("span", { class: "set-hint" }, hint) : null),
    el("div", { class: "set-control" }, control));
}

/** Rectangle du curseur du texte de la page, s'il y en a un a l'ecran. */
function caretRect(): DOMRect | null {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return null;
  const node = sel.anchorNode;
  const host = node instanceof Element ? node : node?.parentElement;
  if (!host?.closest(".text-doc")) return null;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return r.width || r.height ? r : null;
}

/** Dernier choix du dialogue Partager, sur cette machine. */
const SHARE_KEY = "cahiers.share.v1";

