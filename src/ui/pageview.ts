import { el, askText, toast, confirmDialog, pick } from "./dom";
import { InkSurface, PAGE_W, PAGE_H, flingScroll, type EraserMode, type SurfaceTool } from "./canvas";
import { VelocityTracker } from "../core/kinetic";
import { isTap } from "../core/ink/pointer";
import { renderTex } from "./tex";
import type { Bounds } from "../core/ink/stroke";
import { cachedBounds, padBounds, strokeBounds, unionBounds } from "../core/ink/stroke";
import { growForStroke, sheetHeight, shrinkToInk } from "../core/ink/sheet";
import type {
  Block, ImageBlock, InkBlock, InkColor, MathBlock, Page, Stroke, TextBlock,
} from "../core/types";
import {
  GRAPH_RATIO, applyCalcSpec, applyGraphSpec, graphWidth, isLiveBlock, liveLabel, orphanLiveIds,
  type CalcSpec, type GraphSpec, type LiveBlock,
} from "../core/liveblock";
import { isFutureVersion } from "../core/types";
import { dayLabel } from "../core/nav";
import { MAX_DEPTH, childPath, depthOf, dividerLabel } from "../core/dividers";
import { uuid, nowIso } from "../core/id";
import type { ConflictCopy, PageVersion, Repo, TrashEntry, WriteOutcome } from "../core/storage/repo";
import { mergeInk } from "../core/sync";
import { commitPull, textComesBack } from "../core/flowguard";
import {
  convertedStrokeIds, dropStrokes, joinWords, layoutWords,
  LINE_HEIGHT, type PlacedWord,
} from "../core/ink/words";
import { blockKey, isPending, type BlockRef } from "../core/ink/recokey";
import {
  AUTO_IDLE_MS, invalidateStrokes, planIncremental, recoStrokes, sendSignature, type RecoInk,
} from "../core/ink/bands";
import { AUTO_DEBOUNCE_MS } from "../core/ink/recognizer";
import { confusionCandidates } from "../core/ink/confusions";
import { askLatex } from "./mathdialog";
import { labelOf, NEUTRAL_INK, PALETTE } from "../core/palette";
import { inkCssColor } from "../core/theme";
import {
  PASTE_STEP, clampMove, clampSpace, copySelection, pasteClip, recolorStrokes, replaceStrokes,
  pickAt, selBarTop, selectInLasso, selectionBounds, shiftBelow, strokesBelow, strokesById, transformBlocks,
  type BarBox, type InkClip, type Pt as InkPt, type Transform,
} from "../core/ink/selection";
import { TextDoc } from "./textdoc";
import { buildBacklinks, type PageLinks } from "./linkpicker";
import { snapLines } from "./linesnap";
import { LINE, TEXT_LEFT, TEXT_RIGHT, TEXT_TOP, clearOfInk, rowAt, rowBottom, type InkBox } from "../core/textlayout";
import { absorbTextBoxes } from "../core/text/doc";
import { flagContext, fold, parseQuery } from "../core/text/find";
import { DEFAULT_FLAG_NOTE } from "../core/storage/search";
import { PageHistory, applyStrokeCommand, restoreBlocks } from "../core/history";
import { planPrint, type Span } from "../core/print";
import type { ImportResult } from "./image-import";
import { FINAL_MAX, JPEG_QUALITY, fitRatio, unreadableMessage } from "../core/image/photo";
import { paperOf, type PaperKind } from "../core/paper";
import {
  ZOOM_MAX, ZOOM_MIN, anchorAt, clampZoom, inkDensity, mid, pinchOf, previewTransform,
  scrollToAnchor, stepZoom, wheelFactor, zoomLabel, type Pt,
} from "../core/zoom";
import { titleOf } from "../core/shortcuts";
import {
  INK_LIMIT, TEXT_LIMIT, composeFlowText, inkExtent, isLongPage, moveFlowBlocks, pageBreaks, planFlow,
  type FlowPlan, type FlowSelection,
} from "../core/paginate";
import { measureRows, rowStart, type MeasuredRows } from "./pagebreak";
import { refreshSuggestions, suggestFor } from "./suggestions";
import { factorSuggest } from "../core/factor";
import { nextStepSuggest } from "../core/calc/nextstep";
import {
  SizeMemo, anchorIndex, anchoredScroll, estimateSize, isFastScroll, measureSize, pageAt, planWindow,
  slotHeight, visibleRange, type SlotSize,
} from "../core/virtual";
import { parseDoc } from "../core/text/doc";
import { emptyPage } from "../core/types";
import { PdfLayer } from "./pdflayer";
import { bytesOfDataUrl } from "./pdf";
import { pdfBlockOf } from "../core/pdf/pdf";

/**
 * Largeur de feuille minimale hors zoom : le texte (21 px a 900 de large)
 * y garde 13 px. En dessous on defile de cote (split etroit).
 */
const READABLE_W = 558;

export type ViewMode = "pages" | "scroll";
export type RenderMode = "ink" | "clean";

export interface PageViewHost {
  repo: Repo;
  /** false quand aucun moteur de reconnaissance n'est configure. */
  recognitionReady: () => boolean;
  /** Convertir l'ecriture au fil de la plume, sans entourer de zone. */
  autoConvert: () => boolean;
  getTool: () => SurfaceTool;
  /** Gomme au trait entier ou precise (encre-14). */
  getEraserMode?: () => EraserMode;
  getColor: () => InkColor;
  getWidth: () => number;
  touchRole: () => "write" | "navigate";
  /**
   * Une zone math ou texte vient d'etre tracee. Les outils de zone sont
   * ponctuels : l'appli remet l'outil d'avant, le trait suivant ecrit.
   */
  onRegionDone?: () => void;
  /**
   * Le lasso est ephemere (lot stylet) : apres une action de sa barre ou un
   * appui a cote de la selection, l'appli rend le stylo.
   */
  onSelectionDone?: () => void;
  /**
   * Demande la reconnaissance d'un bloc math ou texte manuscrit, apres la
   * pause d'ecriture. `auto` = conversion au fil de la plume (pause plus
   * longue, D14).
   */
  requestRecognition: (
    key: string, kind: "math" | "text", strokes: Stroke[], auto?: boolean, partial?: boolean,
  ) => void;
  /**
   * Remet en file un bloc reste « en attente » (page rouverte apres une
   * fermeture de l'appli, cles saisies), sans pause ni message. Ne fait
   * rien si ce bloc attend deja ou part en ce moment.
   */
  resumeRecognition: (key: string, kind: "math" | "text", strokes: Stroke[], partial?: boolean) => void;
  /** Retire la demande en attente d'un bloc. Vrai s'il y en avait une. */
  cancelRecognition: (key: string) => boolean;
  onDirty: () => void;
  /** La page en vue a change (navigation, defilement, ajout, suppression). */
  onPageChange?: (n: number, total: number) => void;
  /** Ancien bloc `link` : chemin lisible, et id de la page s'il l'a (rech-10). */
  openLink: (target: string, pageId?: string) => void;
  /** Liens du texte tape : suivre, selecteur `[[`, pages grisees, retroliens. */
  links?: PageLinks;
  /** Ouvre un intercalaire de la meme matiere (sous-dossier d'un groupe, D4). */
  openDivider?: (divider: string) => void;
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
  /**
   * Appui sur un bloc vivant (calcul, courbe) : la calculatrice le rouvre,
   * preremplie. `update` le recalcule et le redessine sur place ; false si
   * le bloc n'est plus dans la page.
   */
  editLive?: (block: LiveBlock, update: (spec: CalcSpec | GraphSpec) => boolean) => void;
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

/**
 * Presse-papiers de l'encre, commun a toutes les vues : on copie un schema
 * de la page 4 et on le colle dans l'intercalaire Exos ou dans un autre
 * cahier. `pageId` + `pastes` : des collages successifs sur la page
 * d'origine se decalent, au lieu de s'empiler exactement sur l'original.
 */
let inkClip: { clip: InkClip; pageId: string; pastes: number } | null = null;

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
  /** Hauteur du texte a la derniere mise a l'echelle (unites de page). */
  textH?: number;
  /**
   * Bas de la ligne du curseur juste avant la derniere frappe (unites de
   * page) : si le texte grandit, l'encre situee dessous le suit (followText).
   */
  preEdit?: { y: number; t: number };
  /** Lignes ajoutees par l'appli (clic sous le texte, saut de l'encre) : l'encre ne bouge pas. */
  noPush?: boolean;
  /*
   * Pagination automatique (core/paginate.ts, PageView.flow*).
   */
  /** Photos, polices et blocs charges : avant, aucun debordement n'est traite (mesures fausses). */
  settled?: boolean;
  /** Ancienne page plus haute qu'une A4 : affichee telle quelle, reperes de saut, « Répartir ». */
  long?: boolean;
  /** Derniere action de l'utilisateur sur la page (ms) : un debordement qui la suit se traite. */
  editedAt?: number;
  /** Texte avant la derniere frappe et curseur (annuler la frappe qui a fait deborder). */
  prevText?: { content: string; caret: number | null; t: number };
  /** Curseur (caracteres) note avant la derniere frappe. */
  preCaret?: number | null;
  /** Dernier decalage de l'encre par le texte (followText), annule avec la frappe. */
  lastShift?: { y: number; d: number; t: number };
  /** Reperes de saut de page (feuille plus haute qu'une A4). */
  breaks?: HTMLElement;
}

/** Marqueur du curseur qui suit le texte sur la page suivante (jamais ecrit). */
const CARET_MARK = "";
/** Une action plus ancienne ne fait plus deborder la page d'elle-meme (ms). */
const FLOW_EDIT_MS = 3000;

/**
 * Debordement qu'on peut annuler (Ctrl+Z juste apres) : la page d'avant
 * retrouve son texte d'avant la frappe, la page d'apres son contenu (ou
 * part a la corbeille si elle a ete creee pour l'occasion).
 */
interface FlowUndo {
  fromId: string;
  /** Blocs de la page d'avant au moment du debordement (JSON). */
  fromBlocks: string;
  /** Texte d'avant la frappe, et son curseur. */
  fromText: string | null;
  fromCaret: number | null;
  shift?: { y: number; d: number };
  toId: string;
  /** Blocs de la page d'apres avant le debordement ; null : creee par lui. */
  toBlocks: string | null;
  /** Compteur des modifications au moment du debordement (toute autre action l'invalide). */
  seq: number;
}

/** Une frappe plus ancienne ne decide plus de ce que l'encre suit (ms). */
const PRE_EDIT_MS = 2000;

/**
 * Emplacement d'une page en mode defilement virtualise (donnees-12,
 * core/virtual.ts). La page est montee (`loaded`, vrai DOM : texte, canvas,
 * blocs) pres de l'ecran ; ailleurs, un emplacement vide (`ph`) de la meme
 * hauteur la remplace, avec son numero.
 */
interface Slot {
  number: number;
  /** Emplacement vide, dans la vue tant que la page n'est pas montee. */
  ph: HTMLElement;
  loaded: LoadedPage | null;
  /** Page illisible : la feuille d'erreur tient la place. */
  broken: HTMLElement | null;
  /** Lecture en cours (montage). */
  loading: boolean;
  size: SlotSize;
}

/**
 * Hauteurs des pages vues pendant la seance (unites de page), par cahier,
 * intercalaire et numero : une ancienne page longue revue n'est plus
 * estimee a une A4. Commune aux vues (split, onglets rouverts).
 */
const sizeMemo = new SizeMemo();

/**
 * Photo copiee ou coupee (Ctrl+C / Ctrl+X sur la photo), partagee par les
 * vues (split) : le presse-papiers systeme ne porte qu'un marqueur, le
 * bloc et l'intercalaire d'ou il vient restent ici.
 */
let photoClip: { block: ImageBlock; notebook: string; divider: string; marker: string } | null = null;

/**
 * Vue d'un intercalaire. La page reste l'unite de base dans les deux modes
 * (section 5) : en defilement les pages sont simplement empilees, separees
 * par un trait discret, et gardent leur numero.
 */
export class PageView {
  readonly root: HTMLElement;
  private list: LoadedPage[] = [];
  private viewMode: ViewMode = "scroll";
  private renderMode: RenderMode = "ink";
  private current = 1;
  /** Nombre de pages de l'intercalaire, lu au dernier rendu. */
  private total = 0;
  /** Annulation par page, par id : un numero change a chaque suppression. */
  private history = new PageHistory();
  /** Derniere page modifiee, que suit Ctrl+Z en mode defilement. */
  private lastEditedId: string | null = null;
  /** Selection au lasso (une page a la fois) et sa barre d'actions. */
  private sel: { loaded: LoadedPage; ids: Set<string> } | null = null;
  private selBar: HTMLElement | null = null;
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
  /** Fond de page de l'intercalaire (D12), lu dans cahier.json. */
  private paperKind: PaperKind = "uni";
  /** Pages de PDF importees, peintes en fond des feuilles (src/ui/pdflayer.ts). */
  /** Texte d'une page de PDF en train d'etre remis (pdfPageFull). */
  private pdfReverting = false;
  private pdfLayer = new PdfLayer({
    key: (src) => `${this.notebook}/${this.divider}/${src}`,
    read: async (src) => bytesOfDataUrl(await this.host.repo.readAsset(this.notebook, this.divider, src)),
  });
  /**
   * Zoom de la vue (lot 11), propre a chaque panneau, en memoire seulement.
   * Il multiplie la largeur affichee des feuilles ; les traits restent en
   * unites de page, le zoom ne touche jamais aux donnees.
   */
  private zoom = 1;
  /** Indicateur « 150 % », pose par l'appli a cote de la vue ; un appui = 100 %. */
  readonly zoomChip: HTMLButtonElement;
  /**
   * Geste de zoom en cours (pinch ou Ctrl+molette) : apercu en transformation
   * CSS seulement, aucun re-rendu de l'encre avant le lacher (batterie).
   */
  private gesture: {
    focus: Pt;
    /** Point de page vise, sur la feuille sous le point de depart. */
    anchor: { page: LoadedPage; at: Pt } | null;
    boxes: { node: HTMLElement; x: number; y: number }[];
    scale: number; dx: number; dy: number;
  } | null = null;
  private previewRaf = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  /** Doigts poses sur la vue ; deux = pinch. */
  private touches = new Map<number, Pt>();
  private pinch: { ids: [number, number]; start: [Pt, Pt] } | null = null;
  /** Defilement au doigt hors de la feuille (marges, bandeaux, numeros). */
  private rootPan: {
    id: number; x: number; y: number; left: number; top: number; moved: boolean; tracker: VelocityTracker;
  } | null = null;
  /*
   * Defilement virtualise (donnees-12) : un emplacement par page, dans
   * l'ordre ; `this.list` ne tient que les pages montees.
   */
  private slots: Slot[] = [];
  /** Largeur des feuilles au dernier relayout (px), pour monter une page a la bonne taille. */
  private sheetWidth = 0;
  /** Derniere page A4 mesuree : estimation des pages pas encore vues. */
  private typical: SlotSize | null = null;
  private windowRaf = 0;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Premiere page a l'ecran a l'image precedente (defilement rapide). */
  private lastFirst: number | null = null;
  /**
   * Compteur des acces disque qui changent une page hors de la vue
   * (debordement, resultat de reconnaissance ecrit par l'appli) : une page
   * lue avant est relue, jamais montee perimee.
   */
  private diskEpoch = 0;

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
    // Defilement virtualise : pages montees et demontees a l'image suivante.
    this.root.addEventListener("scroll", () => this.scheduleWindow(), { passive: true });
    this.zoomChip = el("button", {
      class: "zoom-chip",
      title: titleOf("Revenir à 100 %", "zoomReset"),
      onclick: () => this.setZoom(1),
    });
    this.zoomChip.style.display = "none";
    this.watchZoomGestures();
    // Retour sur la fenetre : pages changees sur le disque relues (R1).
    window.addEventListener("focus", this.onWindowBack);
    document.addEventListener("visibilitychange", this.onWindowBack);
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
    // Defilement par defaut ; « Pages » seulement si choisi pour cet intercalaire.
    this.viewMode = meta.viewMode?.[this.divider] ?? "scroll";
    this.paperKind = paperOf(meta.paper, this.divider);
    // Couleur du cahier : titres principaux du texte tape (style.css, --nb).
    if (meta.color) this.root.style.setProperty("--nb", meta.color);
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
      // Page montee ou simple emplacement (defilement virtualise).
      const node = this.nodeOf(r.page);
      if (node) this.root.scrollTop += node.getBoundingClientRect().top - this.root.getBoundingClientRect().top;
    } else {
      this.root.scrollTop = r.top;
    }
    this.savedScroll = this.root.scrollTop;
    this.scheduleWindow();
  }

  /**
   * La vue quitte l'ecran. Ce qui attend d'etre ecrit l'est avant de rendre
   * la main : la vue suivante relit le disque et doit y trouver la derniere
   * frappe. Une ecriture en echec continue d'etre retentee.
   */
  async dispose(): Promise<void> {
    this.resizeObserver.disconnect();
    window.removeEventListener("focus", this.onWindowBack);
    document.removeEventListener("visibilitychange", this.onWindowBack);
    if (this.externalTimer) { clearTimeout(this.externalTimer); this.externalTimer = null; }
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
    this.clearSelection();
    for (const p of this.list) this.releasePage(p);
    this.list = [];
    this.slots = [];
    this.lastFirst = null;
  }

  /**
   * Libere une page quittee (changement de page, rendu, demontage en
   * defilement) : ecouteurs, observateur, canvas, fond PDF. Ce qu'elle
   * contenait est deja ecrit ou attend dans la file (pendingSave).
   */
  private releasePage(p: LoadedPage): void {
    p.dead = true;
    p.ro?.disconnect();
    p.doc.dispose();
    this.pdfLayer.drop(p);
    p.surface?.dispose();
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
    // Defilement : un emplacement par page, seules celles pres de l'ecran
    // sont lues et construites (donnees-12). 100 pages coutaient 2,9 s.
    if (this.viewMode === "scroll") {
      await this.renderSlots(nums, gen);
      return;
    }
    const visible = nums.filter((n) => n === this.current);

    for (const n of visible) {
      let page: Page;
      try {
        page = await this.host.repo.readPage(this.notebook, this.divider, n);
      } catch (e) {
        if (gen !== this.renderGen) return;
        // Jamais d'ecran gris muet : on dit ce qui se passe. Rien n'est
        // ecrit sous ce numero tant que la page reste illisible.
        this.root.append(this.unreadableSheet(n, e, nums));
        toast(`Page ${n} de ${dividerLabel(this.divider)} illisible : ${errorText(e)}`, "err", 6000);
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
      el("div", { class: "page-num" }, `${dividerLabel(this.divider)} p. ${n}`),
    );
  }

  /**
   * A la place des pages d'un groupe qui n'a que des sous-dossiers : ses
   * intercalaires (un appui les ouvre, D4), et de quoi y ecrire quand meme.
   * Au-dela de MAX_DEPTH niveaux, les sous-dossiers sont seulement nommes.
   */
  private folderSheet(subs: string[]): HTMLElement {
    const open = depthOf(this.divider) < MAX_DEPTH && !!this.host.openDivider;
    const name = dividerLabel(this.divider);
    return el("div", { class: "page-wrap folder-wrap" },
      el("div", { class: "sheet folder-sheet" },
        el("h2", {}, subs.length ? (open ? "Groupe d'intercalaires" : "Dossier rangé en sous-dossiers") : "Aucune page"),
        subs.length
          ? el("p", {}, `${name} contient ${subs.length > 1 ? `${subs.length} sous-dossiers` : "un sous-dossier"}. `
              + (open
                ? `${subs.length > 1 ? "Choisis l'un d'eux" : "Ouvre-le"} ci-dessous ou dans la bande d'intercalaires. Aucune page n'est créée ici d'office : ton rangement reste intact.`
                : `Cahiers lit ${MAX_DEPTH} niveaux sous la matière : ces sous-dossiers ne sont pas lus, et aucune page n'y est créée d'office.`))
          : el("p", {}, "Cet intercalaire est vide."),
        subs.length
          ? (open
            ? el("div", { class: "folder-open" }, ...subs.map((d) => el("button", {
                onclick: () => this.host.openDivider?.(childPath(this.divider, d)),
              }, d)))
            : el("ul", { class: "folder-list" }, ...subs.map((d) => el("li", {}, d))))
          : null,
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

  /* ---------------- defilement virtualise (donnees-12, core/virtual.ts) ---------------- */

  /**
   * Defilement : un emplacement par page, a sa hauteur (mesuree ou estimee).
   * Seules la page courante et ses voisines sont lues et construites ici ;
   * les autres le sont en approchant de l'ecran (updateWindow).
   */
  private async renderSlots(nums: number[], gen: number): Promise<void> {
    for (const n of nums) {
      const s: Slot = {
        number: n, ph: this.placeholder(n), loaded: null, broken: null, loading: false,
        size: estimateSize(sizeMemo.get(this.memoKey(n)), this.typical),
      };
      if (this.slots.length) this.root.append(el("div", { class: "page-sep" }));
      this.slots.push(s);
      this.root.append(s.ph);
    }
    this.relayout();
    // Export : les pages sont montees une a une par exportPdf.
    if (this.exporting) return;
    const i = Math.max(0, this.slotIndex(this.current));
    if (this.root.isConnected && this.root.clientHeight) this.scrollToSlot(i);
    await this.fillWindow(gen, i);
  }

  /** Emplacement vide d'une page pas montee : feuille blanche et numero, meme hauteur. */
  private placeholder(n: number): HTMLElement {
    return el("div", { class: "page-wrap page-slot", dataset: { page: String(n) } },
      el("div", { class: "sheet slot-sheet" }),
      el("div", { class: "page-num" }, `${dividerLabel(this.divider)} p. ${n}`));
  }

  /** Numero d'un emplacement vide (apres une renumerotation). */
  private labelSlot(s: Slot): void {
    s.ph.dataset.page = String(s.number);
    const num = s.ph.lastElementChild;
    if (num) num.textContent = `${dividerLabel(this.divider)} p. ${s.number}`;
  }

  private memoKey(n: number): string {
    return `${this.notebook}\u0000${this.divider}\u0000${n}`;
  }

  /** Echelle des feuilles (largeur / PAGE_W) au dernier relayout. */
  private get sheetK(): number {
    return (this.sheetWidth || PAGE_W) / PAGE_W;
  }

  private slotIndex(n: number): number {
    return this.slots.findIndex((s) => s.number === n);
  }

  /** Element a l'ecran pour cet emplacement : la page, sa feuille d'erreur, ou l'emplacement vide. */
  private slotNode(s: Slot): HTMLElement {
    return s.loaded?.wrap ?? s.broken ?? s.ph;
  }

  /** Element d'une page dans la vue (monte ou non), pour y amener le defilement. */
  private nodeOf(n: number): HTMLElement | null {
    const s = this.slots.find((x) => x.number === n);
    if (s) return this.slotNode(s);
    return this.list.find((p) => p.number === n)?.wrap ?? null;
  }

  private boxOf(i: number): { top: number; bottom: number } {
    const r = this.slotNode(this.slots[i]).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }

  /** Amene le haut d'une page en haut de la vue (sans animation). */
  private scrollToSlot(i: number): void {
    const node = this.slotNode(this.slots[i]);
    this.root.scrollTop += node.getBoundingClientRect().top - this.root.getBoundingClientRect().top;
  }

  /**
   * Amene une page a l'ecran. `smooth` : anime seulement si elle est proche
   * (deux ecrans) ; plus loin, on y saute, sans construire tout le chemin.
   * Vrai si le defilement est anime (il n'est pas fini au retour).
   */
  private revealPage(n: number, smooth = false): boolean {
    const node = this.nodeOf(n);
    if (!node) return false;
    const view = this.root.getBoundingClientRect();
    const d = node.getBoundingClientRect().top - view.top;
    const anim = smooth && Math.abs(d) <= 2 * view.height;
    if (anim) this.root.scrollTo({ top: this.root.scrollTop + d, behavior: "smooth" });
    else this.root.scrollTop += d;
    this.scheduleWindow();
    return anim;
  }

  /**
   * Va a la page `n` en defilement et attend qu'elle soit construite
   * (recherche, lien, repere : on mesure ensuite dans la page).
   */
  private async ensureMounted(n: number): Promise<void> {
    if (this.viewMode !== "scroll" || !this.slots.length) return;
    const i = this.slotIndex(n);
    if (i < 0) return;
    if (this.root.isConnected && this.root.clientHeight) this.scrollToSlot(i);
    await this.fillWindow(this.renderGen, i);
  }

  /**
   * Pages a monter et a demonter pour l'ecran actuel. Vue detachee (menu,
   * autre onglet) : autour de l'emplacement `around`.
   */
  private windowPlan(around?: number): ReturnType<typeof planWindow> | null {
    const count = this.slots.length;
    if (!count) return null;
    let vis: [number, number] | null = null;
    const view = this.root.getBoundingClientRect();
    if (this.root.isConnected && view.height > 0) {
      vis = visibleRange(count, (i) => this.boxOf(i), view.top, view.bottom);
    }
    if (!vis) {
      const c = around ?? Math.max(0, this.slotIndex(this.current));
      vis = [c, c];
    }
    const mounted: number[] = [];
    this.slots.forEach((s, i) => { if (s.loaded) mounted.push(i); });
    return planWindow(count, vis, mounted, (i) => this.isPinned(this.slots[i]));
  }

  /** Monte tout de suite les pages a l'ecran et leurs voisines (rendu, saut). */
  private async fillWindow(gen: number, around?: number): Promise<void> {
    const plan = this.windowPlan(around);
    if (!plan) return;
    await Promise.all(plan.mount.map((i) => this.mountSlot(this.slots[i], gen)));
    this.scheduleWindow();
  }

  /** Revoit les pages montees a l'image suivante (defilement, zoom, fin d'ecriture). */
  private scheduleWindow(): void {
    if (this.windowRaf || this.viewMode !== "scroll" || !this.slots.length) return;
    this.windowRaf = requestAnimationFrame(() => {
      this.windowRaf = 0;
      this.updateWindow();
    });
  }

  private retryWindow(ms: number): void {
    if (this.windowTimer) return;
    this.windowTimer = setTimeout(() => { this.windowTimer = null; this.scheduleWindow(); }, ms);
  }

  /**
   * Monte ce qui approche de l'ecran, demonte ce qui s'en eloigne. Rien
   * pendant un debordement (pages en cours d'ecriture), un geste de zoom
   * (apercu en transformation) ou un export. Defilement rapide : on attend
   * l'arret, sans construire les pages qui ne font que passer.
   */
  private updateWindow(): void {
    if (this.viewMode !== "scroll" || !this.slots.length || this.exporting || this.gesture || this.peek) return;
    if (!this.root.isConnected) return;
    if (this.flowing) { this.retryWindow(200); return; }
    const view = this.root.getBoundingClientRect();
    if (!view.height) return;
    const vis = visibleRange(this.slots.length, (i) => this.boxOf(i), view.top, view.bottom);
    if (!vis) return;
    const fast = isFastScroll(this.lastFirst, vis[0]);
    this.lastFirst = vis[0];
    if (fast) { this.retryWindow(120); return; }
    const plan = this.windowPlan();
    if (!plan) return;
    if (plan.unmount.length) {
      this.anchored(() => { for (const i of plan.unmount) this.unmountSlot(this.slots[i]); });
    }
    const gen = this.renderGen;
    for (const i of plan.mount) void this.mountSlot(this.slots[i], gen);
  }

  /**
   * Une page qu'on ne demonte pas : elle a le clavier, une ecriture en
   * attente (on l'ecrit d'abord), la selection au lasso, un trait en cours
   * ou une formule ouverte.
   */
  private isPinned(s: Slot): boolean {
    const p = s.loaded;
    if (!p) return false;
    if (this.pendingSave.has(p.page.id) || this.sel?.loaded === p) return true;
    if (p.surface?.busyPen || p.doc.editingFormula) return true;
    const a = document.activeElement;
    return !!a && a !== document.body && p.wrap.contains(a);
  }

  /**
   * Lit et construit la page d'un emplacement. Une ecriture hors vue
   * pendant la lecture (debordement, resultat de reconnaissance ecrit par
   * l'appli) : la page est relue, jamais montee perimee.
   */
  private async mountSlot(s: Slot, gen: number): Promise<LoadedPage | null> {
    if (s.loaded) return s.loaded;
    if (s.broken || s.loading) return null;
    s.loading = true;
    let page: Page | null = null;
    try {
      for (let tries = 0; tries < 40; tries++) {
        const epoch = this.diskEpoch;
        try {
          page = await this.host.repo.readPage(this.notebook, this.divider, s.number);
        } catch (e) {
          if (gen !== this.renderGen || !this.slots.includes(s)) return null;
          if (epoch !== this.diskEpoch || this.flowing) { await new Promise((r) => setTimeout(r, 60)); continue; }
          // Jamais d'ecran gris muet : on dit ce qui se passe. Rien n'est
          // ecrit sous ce numero tant que la page reste illisible.
          const broken = this.unreadableSheet(s.number, e, this.slots.map((x) => x.number));
          this.anchored(() => { s.ph.replaceWith(broken); s.broken = broken; });
          toast(`Page ${s.number} de ${dividerLabel(this.divider)} illisible : ${errorText(e)}`, "err", 6000);
          return null;
        }
        if (gen !== this.renderGen || !this.slots.includes(s)) return null;
        if (epoch === this.diskEpoch && !this.flowing) break;
        page = null;
        await new Promise((r) => setTimeout(r, 60));
      }
    } finally {
      s.loading = false;
    }
    if (!page || s.loaded) return s.loaded;
    // Page dont l'ecriture a echoue : la version en attente, pas celle du disque.
    const waiting = this.pendingSave.get(page.id);
    if (waiting) page = waiting.page;
    const loaded = this.buildPage(s.number, page);
    if (waiting) this.pendingSave.set(page.id, loaded);
    this.anchored(() => {
      s.ph.replaceWith(loaded.wrap);
      s.loaded = loaded;
      // this.list reste dans l'ordre des pages.
      const after = this.list.findIndex((p) => p.number > loaded.number);
      this.list.splice(after < 0 ? this.list.length : after, 0, loaded);
      this.layoutPage(loaded);
    });
    this.noteSize(s);
    return loaded;
  }

  /** Demonte une page loin de l'ecran : son emplacement vide reprend sa hauteur mesuree. */
  private unmountSlot(s: Slot): void {
    const p = s.loaded;
    if (!p) return;
    this.noteSize(s);
    if (p.number > 0) s.number = p.number;
    this.labelSlot(s);
    this.sizeSlot(s);
    p.wrap.replaceWith(s.ph);
    s.loaded = null;
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
    this.releasePage(p);
  }

  /** Retire l'emplacement d'une page supprimee (et la page si elle est montee). */
  private dropSlot(n: number): void {
    const i = this.slotIndex(n);
    if (i < 0) return;
    const s = this.slots[i];
    const node = this.slotNode(s);
    const sep = i > 0 ? node.previousElementSibling : node.nextElementSibling;
    if (sep?.classList.contains("page-sep")) sep.remove();
    node.remove();
    if (s.loaded) {
      const j = this.list.indexOf(s.loaded);
      if (j >= 0) this.list.splice(j, 1);
      this.releasePage(s.loaded);
    }
    this.slots.splice(i, 1);
  }

  /** Hauteur reelle d'une page montee, retenue pour son emplacement et la seance. */
  private noteSize(s: Slot): void {
    const p = s.loaded;
    if (!p || !p.wrap.isConnected) return;
    const sheetPx = p.sheet.offsetHeight, wrapPx = p.wrap.offsetHeight;
    if (!sheetPx || !wrapPx) return;
    s.size = measureSize(sheetPx, wrapPx, this.sheetK);
    sizeMemo.set(this.memoKey(p.number || s.number), s.size.sheet);
    // Page A4 ordinaire (ni bandeau ni retroliens) : modele des pages pas encore vues.
    const plain = !p.long && !p.notes.childElementCount && p.wrap.childElementCount <= 3
      && !isLongPage(p.surface?.height ?? 0);
    if (!plain) return;
    const before = this.typical;
    this.typical = s.size;
    const k = this.sheetK;
    if (!before || Math.abs(slotHeight(before, k) - slotHeight(s.size, k)) >= 1) {
      // Premiere mesure : les estimations suivent, sans saut a l'ecran.
      this.anchored(() => {
        for (const x of this.slots) {
          if (x.size.measured) continue;
          x.size = estimateSize(sizeMemo.get(this.memoKey(x.number)), this.typical);
          if (!x.loaded) this.sizeSlot(x);
        }
      });
    }
  }

  /** Hauteur de l'emplacement vide, a l'echelle des feuilles. */
  private sizeSlot(s: Slot): void {
    s.ph.style.height = `${slotHeight(s.size, this.sheetK)}px`;
    s.ph.style.maxWidth = this.wrapMax;
    s.ph.style.width = this.wrapW;
  }

  /**
   * Garde a la meme place a l'ecran la page lue pendant que `change`
   * monte, demonte ou retaille des emplacements (au-dessus d'elle surtout).
   */
  private anchored(change: () => void): void {
    if (this.viewMode !== "scroll" || this.exporting || !this.root.isConnected || !this.slots.length) {
      change();
      return;
    }
    const view = this.root.getBoundingClientRect();
    const a = anchorIndex(this.slots.length, (i) => this.boxOf(i), view.top);
    const anchor = a >= 0 ? this.slots[a] : null;
    const before = anchor ? this.slotNode(anchor).getBoundingClientRect().top : 0;
    change();
    if (!anchor || !this.slots.includes(anchor)) return;
    const after = this.slotNode(anchor).getBoundingClientRect().top;
    if (Math.abs(after - before) >= 0.5) this.root.scrollTop = anchoredScroll(this.root.scrollTop, before, after);
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
    // Calculs et courbes retires du texte a la seance precedente (✕, le
    // bloc restait pour « Annuler ») : oublies.
    const orphans = new Set(orphanLiveIds(page.blocks, this.bodyText(page)?.content ?? ""));
    if (orphans.size) page.blocks = page.blocks.filter((b) => !orphans.has(b.id));
    // Encre gommee sous l'A4 lors d'une seance precedente : la page se
    // rouvre a la taille de l'encre restante. Pas pendant la seance, ou la
    // feuille se replierait sous la gomme avant qu'on reecrive a la place.
    shrinkToInk(page);
    const canvas = el("canvas");
    const overlay = el("div", { class: "overlay" });
    const imageOf = (id: string) =>
      page.blocks.find((b): b is ImageBlock => b.type === "image" && b.id === id);
    const liveOf = (id: string) =>
      page.blocks.find((b): b is LiveBlock => isLiveBlock(b) && b.id === id && !b.rect);
    const doc = new TextDoc(this.bodyText(page)?.content ?? "", (content) => {
      this.setBodyText(loaded, content);
    }, {
      lookup: (id) => {
        const b = imageOf(id);
        if (!b) return null;
        return {
          url: this.host.repo.readAsset(this.notebook, this.divider, b.src),
          width: b.width ?? Math.min(PAGE_W - TEXT_LEFT - TEXT_RIGHT, 640),
          ocr: b.ocr,
          original: !!b.original,
          side: !!b.side,
          ...(b.height ? { height: b.height } : {}),
          ...(b.align ? { align: b.align } : {}),
          ...(b.x ? { x: b.x } : {}),
        };
      },
      placed: (id, place) => {
        const b = imageOf(id);
        if (!b) return;
        if (place.align) b.align = place.align; else delete b.align;
        if (!place.align && place.x) b.x = place.x; else delete b.x;
        this.queueSave(loaded);
      },
      clip: (id) => {
        const b = imageOf(id);
        if (!b) return null;
        const marker = `[photo Cahiers ${uuid()}]`;
        photoClip = { block: JSON.parse(JSON.stringify(b)) as ImageBlock, notebook: this.notebook, divider: this.divider, marker };
        return marker;
      },
      pasteClip: (marker) => this.pastePhoto(loaded, marker),
      sided: (id, side) => {
        const b = imageOf(id);
        if (!b) return;
        if (side) b.side = true; else delete b.side;
        this.fitSheet(loaded);
        this.queueSave(loaded);
      },
      recrop: (id) => void this.recropImage(loaded, id),
      resized: (id, width, height) => {
        const b = imageOf(id) ?? liveOf(id);
        if (!b || b.type === "calc") return;
        b.width = width;
        if (b.type === "image" && height !== undefined) {
          if (height === null) delete b.height; else b.height = height;
        }
        // Courbe retaillee : redessinee a sa nouvelle largeur (texte net).
        if (b.type === "graph") loaded.doc.refreshLive(id);
        // Hauteur de la feuille et place laissee a cote d'une photo calee.
        this.fitSheet(loaded);
        this.queueSave(loaded);
      },
      addFile: (file) => this.addImageFile(loaded, file),
      live: (id) => {
        const b = liveOf(id);
        if (!b) return null;
        const { node, ready } = this.renderLive(b);
        return {
          node, ready,
          label: liveLabel(b),
          ...(b.type === "graph" ? { width: graphWidth(b, PAGE_W) } : {}),
        };
      },
      openLive: (id) => this.openLive(loaded, id),
    }, this.host.links && { ...this.host.links, pageId: () => page.id });
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
        ? `${dividerLabel(this.divider)} · copie de la p. ${n} venue de ${copy.label}`
        : `${dividerLabel(this.divider)} p. ${n}${day ? ` · ${day}` : ""}`),
    );
    // Retroliens (« Mentionné dans… »), calcules a la volee depuis l'index.
    const links = this.host.links;
    if (links && !copy) {
      void links.backlinks(page.id).then((list) => {
        if (list.length) wrap.append(buildBacklinks(list, links.openBacklink));
      }, () => undefined);
    }

    const loaded: LoadedPage = {
      number: n, page, surface: null, wrap, overlay, sheet, doc, ro: null, readOnly, notes,
      ...(copy ? { copy: copy.file } : {}),
    };
    // Formules deja ecrites reproposees en grise (core/suggest.ts), pas sur une copie ou en lecture seule.
    if (!copy && !readOnly) {
      // Factorisation (« 3p + 4p = p( » -> « 3 + 4) », core/factor.ts), puis
      // l'etape suivante derriere un « = » (core/calc/nextstep.ts), puis le cahier.
      doc.suggester = (line, prev) => (loaded.readOnly || this.readOnly ? null
        : factorSuggest(line) ?? nextStepSuggest(line, prev) ?? suggestFor(this.host.repo, this.notebook, this.divider, line));
      refreshSuggestions(this.host.repo, this.notebook);
    }
    this.paintNotes(loaded);

    const surface = new InkSurface(canvas, {
      getTool: this.host.getTool,
      getColor: this.host.getColor,
      getWidth: this.host.getWidth,
      touchRole: this.host.touchRole,
      onStrokeEnd: (s) => this.onStrokeEnd(loaded, s),
      onEraseStart: () => { loaded.eraseNoted = false; },
      onErase: (ids, split) => (split ? this.onCut(loaded, split) : this.onErase(loaded, ids)),
      getEraserMode: this.host.getEraserMode,
      onLasso: (poly) => this.onLasso(loaded, poly),
      onSelectionCleared: () => this.clearSelection(),
      onTransformStart: () => { this.pushUndo(loaded); this.selBar?.remove(); },
      onTransform: (ids, t, kind) => this.applyTransform(loaded, ids, t, kind),
      spaceBelow: (y) => {
        const ids = strokesBelow(loaded.page.blocks, y);
        return { ids, clamp: (dy: number) => clampSpace(loaded.page.blocks, ids, y, dy) };
      },
      // L'outil du geste, fige au pointerdown : pas celui du moment.
      onRegion: (b, tool) => {
        this.host.onRegionDone?.();
        void this.onRegion(loaded, b, tool === "textregion" ? "text" : "math");
      },
      onTap: (_p, e) => this.onTapAt(loaded, e),
      onLongPress: (p, e) => this.onLongPressAt(loaded, p, e),
      onDismiss: () => this.host.onSelectionDone?.(),
    });
    loaded.surface = surface;
    surface.setPaper(this.paperKind);
    this.routePointers(loaded);
    // Une photo qui finit de charger allonge le texte : la feuille suit.
    // Une photo posee juste avant (collee, deposee) peut faire deborder la
    // page en finissant de charger (flowSoon).
    loaded.ro = new ResizeObserver(() => { this.fitSheet(loaded); this.flowSoon(loaded); });
    loaded.ro.observe(doc.root);
    void this.settle(loaded);
    // Polices KaTeX arrivees apres le premier affichage : formules recalees.
    void document.fonts?.ready.then(() => {
      if (!loaded.dead && snapLines(doc.root, true)) this.fitSheet(loaded);
    });
    this.paintStrokes(loaded);
    this.watchWordTaps(loaded);
    this.paintOverlay(loaded);
    if ((migrated || orphans.size) && !readOnly) this.queueSave(loaded);
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
      // Fond de page : seules les lignes pas encore lues repartent (reco-3).
      const main = b.type === "ink" && !b.rect;
      const strokes = main ? planIncremental(b).all : recoStrokes(b.strokes);
      if (!strokes.length) continue;
      this.host.resumeRecognition(this.keyOf(loaded, b.id), kindOf(b), strokes, main);
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
    // Texte d'avant : Ctrl+Z juste apres un debordement le rend (flowUndo).
    if (!this.flowing) {
      loaded.prevText = { content: body.content, caret: loaded.preCaret ?? null, t: performance.now() };
      this.editSeq++;
    }
    body.content = content;
    loaded.lastEdit = "text";
    this.lastGestureId = loaded.page.id;
    const before = loaded.textH;
    this.fitSheet(loaded);
    if (before !== undefined && loaded.textH !== undefined && !loaded.noPush) this.followText(loaded, loaded.textH - before);
    this.queueSave(loaded);
    this.maybeFlow(loaded);
  }

  /**
   * Le texte a grandi (ou raccourci) de dy sous la ligne de la derniere
   * frappe : l'encre et les reperes situes dessous suivent, comme un dessin
   * ancre dans un traitement de texte. Le texte ne recouvre jamais un
   * schema pose plus bas, et un schema glisse entre deux paragraphes reste
   * entre eux. Pas d'entree d'annulation : Ctrl+Z du texte la defait.
   */
  private followText(loaded: LoadedPage, dy: number): void {
    const pre = loaded.preEdit;
    if (Math.abs(dy) < 2 || !pre || performance.now() - pre.t > PRE_EDIT_MS || loaded.readOnly) return;
    const d = shiftBelow(loaded.page.blocks, pre.y, dy);
    if (!d) return;
    loaded.lastShift = { y: pre.y, d, t: performance.now() };
    this.fitSheet(loaded);
    this.paintStrokes(loaded);
    this.paintOverlay(loaded);
  }

  /** Note la ligne du curseur avant une frappe (followText). */
  private notePreEdit(loaded: LoadedPage): void {
    loaded.editedAt = performance.now();
    const row = loaded.doc.caretRow();
    if (!row) return;
    const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    const top = loaded.sheet.getBoundingClientRect().top;
    loaded.preEdit = { y: rowBottom(((row.top + row.bottom) / 2 - top) / k), t: performance.now() };
    loaded.preCaret = loaded.doc.caretOffset();
  }

  /**
   * Frappe sur une ligne vide posee sur de l'encre (schema dessine sous la
   * derniere ligne, puis on tape) : la ligne descend d'abord sous l'encre,
   * par lignes entieres. Le texte ne se pose jamais sur un dessin.
   */
  private skipInk(loaded: LoadedPage): void {
    if (loaded.readOnly || !loaded.doc.caretLineEmpty()) return;
    const row = loaded.doc.caretRow();
    if (!row) return;
    const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    const sheetTop = loaded.sheet.getBoundingClientRect().top;
    const top = TEXT_TOP + rowAt(((row.top + row.bottom) / 2 - sheetTop) / k) * LINE;
    const boxes: InkBox[] = [];
    for (const b of loaded.page.blocks) {
      if (b.type !== "ink" && b.type !== "math") continue;
      for (const st of b.strokes) {
        // Le surligneur se pose sur le texte : il n'est pas un obstacle.
        if (st.tool !== "pen" || !st.points.length) continue;
        boxes.push(cachedBounds(st));
      }
    }
    const clear = clearOfInk(boxes, top);
    if (clear <= top + 0.5) return;
    loaded.noPush = true;
    try {
      loaded.doc.padBeforeCaret(sheetTop + (clear + LINE / 2) * k - 1);
    } finally {
      loaded.noPush = false;
    }
  }

  /**
   * La couche texte couvre la page et passe devant l'encre. La souris y
   * place le curseur ; le stylet et le doigt sont rendus au canvas, sinon
   * on ne pourrait plus ecrire ni defiler sur une page qui contient du texte.
   * Un appui court du stylet ou du doigt n'est pas un trait : le canvas le
   * rend (onTapAt) et le curseur se pose la (lot stylet). Les outils autres
   * que le stylo (gomme, surligneur, zones) gardent la souris pour l'encre.
   */
  private routePointers(loaded: LoadedPage): void {
    loaded.doc.root.addEventListener("pointerdown", (e) => {
      // Photo dans le texte : le stylet ecrit dessus comme sur un PDF ; le
      // doigt sur une photo non selectionnee fait defiler. Deplacer ou
      // retailler : photo selectionnee (appui long, souris, barre).
      const fig = (e.target as Element).closest?.(".doc-img");
      if (fig) {
        if (fig.classList.contains("selected") || (e.target as Element).closest(".doc-img-bar")) return;
        if (e.pointerType === "pen" || (e.pointerType === "touch" && this.host.touchRole() === "navigate")) {
          if (e.pointerType === "pen") e.preventDefault();
          loaded.surface?.forwardDown(e);
        }
        return;
      }
      const tool = this.host.getTool();
      const toInk = e.pointerType === "pen" || e.pointerType === "touch"
        || (e.pointerType === "mouse" && e.button === 0 && tool !== "pen");
      if (!toInk) {
        loaded.lastEdit = "text";
        this.lastGestureId = loaded.page.id;
        // Clic sous la fin du texte : le curseur se pose a cette hauteur
        // (lignes vides ajoutees), comme dans OneNote, au lieu de repartir
        // a la fin du texte.
        if (e.button === 0 && !e.shiftKey && e.target === loaded.doc.root && !loaded.readOnly) {
          const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
          loaded.noPush = true;
          try {
            if (loaded.doc.caretBelowEnd(e.clientY, LINE * k)) e.preventDefault();
          } finally {
            loaded.noPush = false;
          }
        }
        return;
      }
      e.preventDefault();
      loaded.surface?.forwardDown(e);
    });
    // Avant une frappe : une ligne vide posee sur de l'encre descend sous
    // elle, puis la ligne du curseur est notee (l'encre dessous suivra le
    // texte s'il grandit). En capture : avant TextDoc.
    const typing = (e: KeyboardEvent) =>
      e.key.length === 1 && !e.metaKey && (e.ctrlKey === e.altKey); // AltGr = Ctrl+Alt
    loaded.doc.root.addEventListener("keydown", (e) => {
      if (loaded.readOnly || e.isComposing) return;
      // Ctrl+Z juste apres un debordement : il est annule d'un coup (lignes rendues).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        const u = this.flowUndoFor(loaded.page.id);
        if (u) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void this.undoFlow(u);
          return;
        }
      }
      if (e.target === loaded.doc.root && typing(e)) this.skipInk(loaded);
      this.notePreEdit(loaded);
      // Comme Word : Suppr a la fin d'une page fait remonter sa suite,
      // Retour arriere au debut d'une page de suite la recolle a la precedente.
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (plain && e.target === loaded.doc.root && !loaded.doc.editingFormula) {
        if (e.key === "Delete" && this.caretSide(loaded, "after")) {
          setTimeout(() => void this.pullNext(loaded), 0);
        } else if (e.key === "Backspace" && loaded.page.continues && this.caretSide(loaded, "before")) {
          const prev = this.list.find((x) => x.number === loaded.number - 1 && !x.dead && !x.copy);
          if (prev?.page.id === loaded.page.continues) {
            e.preventDefault();
            void this.pullNext(prev, true);
          }
        }
      }
    }, { capture: true });
    loaded.doc.root.addEventListener("paste", (e) => {
      if (loaded.readOnly || e.target !== loaded.doc.root) return;
      this.skipInk(loaded);
      this.notePreEdit(loaded);
    }, { capture: true });
    // Survol relaye au canvas (apercu de la gomme, point du stylo) : la
    // couche texte le couvre. Stylet au-dessus de la feuille : plus de I de
    // texte, le point peint sous la pointe le remplace ; la souris garde le I.
    loaded.sheet.addEventListener("pointermove", (e) => {
      const tool = this.host.getTool();
      const dot = e.pointerType === "pen" && e.buttons === 0 && (tool === "pen" || tool === "highlighter")
        && !(e.target as Element).closest?.(".lasso-bar, .doc-img-bar, .doc-img.selected, .doc-link");
      loaded.sheet.classList.toggle("pen-hover", dot);
      loaded.surface?.hover(e);
    });
    loaded.sheet.addEventListener("pointerleave", () => {
      loaded.sheet.classList.remove("pen-hover");
      loaded.surface?.hover(null);
    });
  }

  /** Photo ou bloc vivant du texte sous un point de l'ecran. */
  private figAt(loaded: LoadedPage, x: number, y: number): HTMLElement | null {
    for (const n of document.elementsFromPoint(x, y)) {
      const fig = (n as Element).closest?.(".doc-img");
      if (fig instanceof HTMLElement && loaded.doc.root.contains(fig)) return fig;
    }
    return null;
  }

  /**
   * Appui court du stylet ou du doigt (jamais de l'encre) : sur du texte,
   * le curseur se pose a cet endroit et la frappe s'y insere ; sur un bloc
   * vivant, la calculatrice le rouvre (le doigt passe deja par TextDoc).
   */
  private onTapAt(loaded: LoadedPage, e: PointerEvent): void {
    const fig = this.figAt(loaded, e.clientX, e.clientY);
    if (fig) {
      if (e.pointerType === "pen" && fig.dataset.live) loaded.doc.tapFigure(fig);
      return;
    }
    if (this.placeCaretAt(loaded, e.clientX, e.clientY)) {
      loaded.lastEdit = "text";
      this.lastGestureId = loaded.page.id;
    }
  }

  /**
   * Curseur du texte sous un point de l'ecran (caretPositionFromPoint, ou
   * caretRangeFromPoint), seulement si le point tombe sur une ligne de
   * texte : un appui dans le blanc ne fait rien. Vrai si le curseur est pose.
   */
  private placeCaretAt(loaded: LoadedPage, x: number, y: number): boolean {
    const root = loaded.doc.root;
    const d = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let range: Range | null = null;
    const pos = d.caretPositionFromPoint?.(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    } else {
      range = document.caretRangeFromPoint?.(x, y) ?? null;
    }
    if (!range || !root.contains(range.startContainer)) return false;
    range.collapse(true);
    // Dans une formule, un lien ou une photo (non editables) : juste apres.
    const host = (range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element : range.startContainer.parentElement)
      ?.closest(".eq, .doc-link, .doc-img");
    if (host && host !== root && root.contains(host)) { range.setStartAfter(host); range.collapse(true); }
    // Le point doit etre sur la ligne trouvee (a 4 px pres) : sinon c'est du blanc.
    let box = range.getBoundingClientRect();
    if (!box.height) {
      const probe = range.cloneRange();
      const n = probe.startContainer;
      if (n.nodeType === Node.TEXT_NODE && probe.startOffset < (n.textContent ?? "").length) {
        probe.setEnd(n, probe.startOffset + 1);
      } else if (n.nodeType === Node.TEXT_NODE && probe.startOffset > 0) {
        probe.setStart(n, probe.startOffset - 1);
      }
      box = probe.getBoundingClientRect();
    }
    if (!box.height || y < box.top - 4 || y > box.bottom + 4) return false;
    root.focus({ preventScroll: true });
    const sel = document.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /**
   * Appui long immobile (stylet ou doigt) : la photo sous le point se
   * selectionne (deplacer, retailler) ; sinon le mot manuscrit ou les
   * traits sous le point (core/ink/selection.ts pickAt). Faux : rien.
   */
  private onLongPressAt(loaded: LoadedPage, p: InkPt, e: { clientX: number; clientY: number }): boolean {
    const fig = this.figAt(loaded, e.clientX, e.clientY);
    if (fig) {
      if (loaded.readOnly || this.readOnly) return false;
      loaded.doc.selectImage(fig);
      return true;
    }
    if (loaded.readOnly || this.readOnly) return false;
    const ids = pickAt(loaded.page.blocks, p.x, p.y);
    if (!ids.size) return false;
    this.select(loaded, ids);
    const a = document.activeElement as HTMLElement | null;
    if (a && loaded.wrap.contains(a)) a.blur();
    return true;
  }

  /**
   * Anciennes photos posees par-dessus la page : elles cachaient le texte et
   * ne bougeaient pas. Chacune rejoint le texte avant la ligne qui passait
   * sous son bord haut. De la plus basse a la plus haute, pour qu'une photo
   * rangee ne decale pas la position des suivantes.
   */
  private adoptFloatingImages(loaded: LoadedPage): void {
    // Anciens calculs et courbes flottants aussi : ils recouvraient le texte.
    const floating = loaded.page.blocks
      .filter((b): b is ImageBlock | LiveBlock => (b.type === "image" || isLiveBlock(b)) && !!b.rect)
      .sort((a, b) => b.rect!.y - a.rect!.y);
    if (!floating.length) return;
    const sheet = loaded.sheet.getBoundingClientRect();
    const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    // La couche des blocs gene le reperage du texte sous le point : on la
    // retire le temps de la mesure.
    loaded.overlay.style.display = "none";
    for (const b of floating) {
      const r = b.rect!;
      if (b.type === "image") b.width = Math.max(120, Math.min(PAGE_W - TEXT_LEFT - TEXT_RIGHT, Math.round(r.w)));
      if (b.type === "graph") b.width = graphWidth(b, PAGE_W);
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
    // Formules et blocs cales sur la grille des lignes avant la mesure.
    snapLines(root);
    const minH = root.style.minHeight;
    root.style.minHeight = "0px";
    const textPx = root.scrollHeight;
    root.style.minHeight = minH;
    let textH = textPx / k;
    // Sous l'A4, rien que du vide (curseur invisible apres une photo, marge
    // de calage) : pas de quoi couper, la feuille reste une A4.
    if (textH > PAGE_H) {
      let bottom = 0;
      for (const it of measureRows(root, loaded.sheet.getBoundingClientRect().top, k).items) {
        const [n] = it.start();
        if (n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").replace(/\u200b/g, "").trim()) continue;
        bottom = Math.max(bottom, it.bottom);
      }
      const pad = (parseFloat(getComputedStyle(root).paddingBottom) || 0) / k;
      textH = Math.min(textH, bottom + pad);
    }
    if (textPx) loaded.textH = textH;
    const h = sheetHeight(loaded.page, textH);
    loaded.sheet.style.minHeight = `${Math.round(h * k)}px`;
    this.paintBreaks(loaded, h, k);
    const d = density ?? this.densityOf(loaded, width, h * k);
    if (force) loaded.surface?.layout(width, h, d);
    else loaded.surface?.fit(width, h, d);
    this.syncPhotoInk(loaded);
    // Page de PDF en fond : rendue a la taille du canvas (pas pendant l'export, qui l'attend lui-meme).
    if (!this.exporting) this.pdfLayer.sync(loaded, this.viewMode === "scroll" ? this.root : null);
  }

  /**
   * Calques d'encre des photos du texte (lot stylet) : un canvas
   * transparent par photo, ou InkSurface repeint l'encre posee dessus (la
   * photo, dans la couche texte, cacherait celle du canvas de la page).
   */
  private syncPhotoInk(loaded: LoadedPage): void {
    const surface = loaded.surface;
    if (!surface) return;
    const figs = Array.from(loaded.doc.root.querySelectorAll<HTMLElement>(".doc-img"));
    surface.setPhotoLayers(figs.map((fig) => {
      let c = fig.querySelector<HTMLCanvasElement>(":scope > canvas.img-ink");
      if (!c) {
        c = el("canvas", { class: "img-ink", "aria-hidden": "true" }) as HTMLCanvasElement;
        c.width = 0;
        c.height = 0;
        fig.append(c);
      }
      return { canvas: c, frame: fig };
    }));
  }

  /* ---------------- pagination automatique (core/paginate.ts) ---------------- */

  /** Compteur des modifications : un debordement ne s'annule que s'il est la derniere. */
  private editSeq = 0;
  /** Un debordement en cours (lecture, creation de page) : un seul a la fois. */
  private flowing = false;
  /** Pages a revoir quand le debordement en cours sera fini. */
  private flowAgain = new Set<LoadedPage>();
  /** Touches tapees pendant un debordement (ecriture disque) : rejouees a la fin. */
  private flowKeys: { key: string; shift: boolean }[] | null = null;
  private flowUndo: FlowUndo | null = null;
  /** Pages creees par « Répartir sur plusieurs pages » en cours (pour l'annuler). */
  private splitLog: string[] | null = null;
  private flowRaf = 0;
  private flowSoonSet = new Set<LoadedPage>();

  /**
   * Reperes de saut de page en pointille, tous les A4, sur une feuille plus
   * haute (ancienne page longue, ou contenu qui ne se coupe pas).
   */
  private paintBreaks(loaded: LoadedPage, h: number, k: number): void {
    const ys = pageBreaks(h);
    if (!ys.length) {
      loaded.breaks?.remove();
      loaded.breaks = undefined;
      return;
    }
    if (!loaded.breaks) {
      loaded.breaks = el("div", { class: "page-breaks", "aria-hidden": "true" });
      loaded.sheet.append(loaded.breaks);
    }
    loaded.breaks.replaceChildren(...ys.map((y, i) => {
      const b = el("div", { class: "page-break" }, el("span", {}, `fin de la feuille A4 ${i + 1}`));
      b.style.top = `${Math.round(y * k)}px`;
      return b;
    }));
  }

  /**
   * La page a fini de charger (photos decodees, polices KaTeX) : ses mesures
   * sont justes. Une page de suite (creee par un debordement) qui deborde
   * continue sur la suivante ; toute autre page plus haute qu'une A4 est une
   * ancienne page longue : jamais decoupee d'office (risque de perte),
   * affichee telle quelle avec ses reperes et « Répartir sur plusieurs pages ».
   */
  private async settle(loaded: LoadedPage): Promise<void> {
    await Promise.all([loaded.doc.imagesReady(), document.fonts?.ready]).catch(() => undefined);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (loaded.dead || loaded.settled) return;
    // Vue pas encore a l'ecran : relayout() relancera la mesure.
    if (!loaded.sheet.isConnected || !loaded.sheet.clientWidth) return;
    loaded.settled = true;
    this.fitSheet(loaded);
    if (!isLongPage(loaded.surface?.height ?? 0)) return;
    // « Répartir » en cours : il coupe lui-meme, page apres page.
    if (this.splitLog) return;
    if (loaded.page.continues) {
      this.maybeFlow(loaded, "settle");
      if (this.flowing || !isLongPage(loaded.surface?.height ?? 0)) return;
    }
    loaded.long = true;
    this.autoSplit(loaded);
  }

  /** Pages longues deja reparties d'office pendant cette session (jamais deux fois). */
  private autoSplitDone = new Set<string>();
  private autoSplitBusy = false;

  /**
   * Toute page plus haute qu'une A4 est repartie d'office sur plusieurs
   * pages : aucune page ne garde une taille differente des autres. Une page
   * en lecture seule (copie de conflit, version future) reste telle quelle.
   */
  private autoSplit(loaded: LoadedPage, tries = 0): void {
    if (loaded.dead || loaded.readOnly || this.readOnly || loaded.copy || this.peek || this.exporting) return;
    if (isFutureVersion(loaded.page) || this.autoSplitDone.has(loaded.page.id)) return;
    if (this.autoSplitBusy || this.flowing) { setTimeout(() => this.autoSplit(loaded, tries), 300); return; }
    this.autoSplitBusy = true;
    this.autoSplitDone.add(loaded.page.id);
    void (async () => {
      let ok = false;
      try {
        ok = await this.splitLongPage(loaded);
      } finally {
        this.autoSplitBusy = false;
      }
      // Ecriture en cours (OneDrive, antivirus) : nouvel essai un peu plus tard.
      if (!ok && tries < 10) {
        this.autoSplitDone.delete(loaded.page.id);
        setTimeout(() => this.autoSplit(loaded, tries + 1), 2000);
      }
    })();
  }

  /** Apres un redimensionnement ou une image chargee : debordement verifie a la prochaine image. */
  private flowSoon(loaded: LoadedPage): void {
    if (!loaded.settled || loaded.long || this.flowing) return;
    this.flowSoonSet.add(loaded);
    if (this.flowRaf) return;
    this.flowRaf = requestAnimationFrame(() => {
      this.flowRaf = 0;
      const pages = [...this.flowSoonSet];
      this.flowSoonSet.clear();
      for (const p of pages) this.maybeFlow(p);
    });
  }

  /**
   * Le contenu de la page depasse-t-il le bas de l'A4 ? Si oui, ce qui
   * deborde part en tete de la page suivante (flowOut). Seulement apres une
   * action de l'utilisateur sur la page (FLOW_EDIT_MS), sur une page de
   * suite, ou sur demande (`why`) : jamais d'office a l'ouverture.
   */
  private maybeFlow(loaded: LoadedPage, why?: "settle" | "force"): void {
    if (this.flowing) { if (!loaded.dead) this.flowAgain.add(loaded); return; }
    if (loaded.dead || loaded.readOnly || this.readOnly || this.exporting || this.peek || loaded.copy) return;
    if (!loaded.settled || loaded.doc.editingFormula) return;
    if (why !== "force") {
      if (loaded.long) return;
      const recent = loaded.editedAt !== undefined && performance.now() - loaded.editedAt < FLOW_EDIT_MS;
      if (!recent && !(why === "settle" && loaded.page.continues)) return;
    }
    const width = loaded.sheet.clientWidth;
    if (!width) return;
    const k = width / PAGE_W;
    // Test rapide a chaque frappe : bas du texte (marge du bas retiree) et encre.
    const pad = (parseFloat(getComputedStyle(loaded.doc.root).paddingBottom) || 0) / k;
    if ((loaded.textH ?? 0) - pad <= TEXT_LIMIT + 0.5 && inkExtent(loaded.page.blocks) <= INK_LIMIT + 0.5) return;
    // Page d'un PDF : elle ne deborde jamais (la suite du sujet est la page d'apres).
    if (pdfBlockOf(loaded.page)) { this.pdfPageFull(loaded); return; }
    const m = measureRows(loaded.doc.root, loaded.sheet.getBoundingClientRect().top, k);
    const plan = planFlow(m.rows, loaded.page.blocks);
    if (!plan) return;
    void this.flowOut(loaded, plan, m);
  }

  /**
   * Rien que du blanc (lignes vides) apres le curseur ("after") ou avant
   * ("before") dans le texte de la page, selection vide.
   */
  private caretSide(loaded: LoadedPage, side: "after" | "before"): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return false;
    const at = sel.getRangeAt(0);
    const root = loaded.doc.root;
    if (!root.contains(at.startContainer)) return false;
    const r = document.createRange();
    r.selectNodeContents(root);
    if (side === "after") r.setStart(at.startContainer, at.startOffset);
    else r.setEnd(at.startContainer, at.startOffset);
    if (r.cloneContents().querySelector(".eq, .doc-img, math-field")) return false;
    return !r.toString().replace(/[\s\u200b]/g, "");
  }

  /**
   * Remonte la page de suite (creee par un debordement, `continues`) dans
   * `from` : ses lignes, photos, encre et reperes passent a la fin de
   * `from`, la page part a la corbeille, puis le debordement habituel
   * recoupe au bon endroit. Le blanc laisse en bas d'une page (lignes
   * effacees) se remplit ainsi, comme dans Word. Les lignes vides du bas de
   * `from` partent avant. Rend vrai si une page a ete remontee.
   */
  async pullNext(from: LoadedPage, caretAtJoin = false): Promise<boolean> {
    if (this.flowing || from.dead || from.readOnly || this.readOnly || from.copy || this.peek || !from.settled) return false;
    if (from.doc.editingFormula || pdfBlockOf(from.page)) return false;
    const n = from.number + 1;
    if (n > this.total) return false;
    const shownNext = this.list.find((p) => p.number === n && !p.dead && !p.copy) ?? null;
    if (shownNext && (shownNext.readOnly || shownNext.page.continues !== from.page.id)) return false;
    await this.flush();
    if (this.flowing || from.dead) return false;
    this.flowing = true;
    this.diskEpoch++;
    this.holdKeys();
    let pulled = false;
    // Contenu de `from` avant la remontee : rendu tel quel si son ecriture echoue (R3).
    const origBlocks = JSON.stringify(from.page.blocks);
    const origHeight = from.page.height;
    const undoPull = (): void => {
      from.page.blocks = JSON.parse(origBlocks) as Block[];
      if (origHeight === undefined) delete from.page.height;
      else from.page.height = origHeight;
      this.setFlowText(from, this.bodyText(from.page)?.content ?? "");
      this.repaintFlowed(from);
    };
    let committed = false;
    try {
      const next: Page | null = shownNext?.page
        ?? await this.serial(() => this.host.repo.readPage(this.notebook, this.divider, n)).catch(() => null);
      if (!next || next.continues !== from.page.id || isFutureVersion(next) || pdfBlockOf(next)) return false;
      // Bas reellement occupe de `from` : texte sans ses lignes vides finales, encre.
      const mine = (this.bodyText(from.page)?.content ?? "").replace(/(?:\n[ \t\u200b]*)+$/, "");
      this.setFlowText(from, mine);
      this.fitSheet(from);
      const k = (from.sheet.clientWidth || PAGE_W) / PAGE_W;
      let textBottom = 0;
      for (const it of measureRows(from.doc.root, from.sheet.getBoundingClientRect().top, k).items) {
        const [nd] = it.start();
        if (nd.nodeType === Node.TEXT_NODE && !(nd.textContent ?? "").replace(/\u200b/g, "").trim()) continue;
        textBottom = Math.max(textBottom, it.bottom);
      }
      const rows = (y: number) => (y > TEXT_TOP + 0.5 ? rowAt(y - 0.5) + 1 : 0);
      const textRows = rows(textBottom);
      const used = Math.max(textRows, rows(inkExtent(from.page.blocks)));
      // La suite : sans ses lignes vides de tete si rien n'est cale dessus.
      let theirs = this.bodyText(next)?.content ?? "";
      const strokes = next.blocks.flatMap((b) => (b.type === "ink" || b.type === "math" ? b.strokes.map((x) => x.id) : []));
      const placed = next.blocks.filter((b) => b.type !== "text" && "rect" in b && b.rect);
      if (!strokes.length && !placed.length) theirs = theirs.replace(/^(?:[ \t\u200b]*\n)+/, "");
      const joint = mine ? "\n".repeat(used - textRows) + "\n" : "\n".repeat(used);
      const text = mine + (caretAtJoin ? CARET_MARK : "") + joint + theirs;
      const mainInk = next.blocks.find((b) => b.type === "ink" && !("rect" in b && b.rect));
      // Sur une copie : la page de suite reste intacte en memoire si la remontee est defaite.
      moveFlowBlocks(structuredClone(next), from.page, {
        strokeIds: mainInk && mainInk.type === "ink" ? mainInk.strokes.map((x) => x.id) : [],
        zoneIds: placed.filter((b) => b.type !== "flag").map((b) => b.id),
        flagIds: placed.filter((b) => b.type === "flag").map((b) => b.id),
        // Photos et blocs vivants du texte (et photos orphelines : rien ne se perd).
        blockIds: next.blocks.filter((b) => b.type !== "text" && b.type !== "ink" && !("rect" in b && b.rect)).map((b) => b.id),
      }, used * LINE, 0, uuid);
      const nextId = next.id;
      // R3 : `from`, avec la suite dedans, est ecrite AVANT que la suite parte
      // a la corbeille (ESEO/.corbeille) ; si l'ecriture echoue, on defait tout.
      setPageText(from.page, text.split(CARET_MARK).join(""));
      const done = await commitPull({
        writeFrom: () => this.serial(async () => {
          const out = await this.host.repo.writePage(this.notebook, this.divider, from.number, from.page);
          if (out.kind === "merged" || (out.kind === "written" && out.n === from.number)) {
            this.pendingSave.delete(from.page.id);
            if (out.kind === "merged") setTimeout(() => void this.afterExternal([[from, out]]), 0);
            return;
          }
          setTimeout(() => void this.afterExternal([[from, out]]), 0);
          throw new Error("la page a changé sur le disque pendant la remontée");
        }),
        trashNext: () => this.serial(async () => {
          await this.host.repo.deletePage(this.notebook, this.divider, n);
          this.dropSlot(n);
          for (const p of [...this.list, ...this.pendingSave.values()].filter((x) => x.page.id === nextId)) {
            p.dead = true;
            p.number = 0;
            this.pendingSave.delete(p.page.id);
            this.history.drop(p.page.id);
          }
          this.shiftNumbers(n + 1, -1);
        }),
        revert: undoPull,
      });
      committed = true;
      if (done.result === "reverted") {
        toast(`Page suivante non remontée : ${errorText(done.error)}. Rien n'a bougé.`, "err", 6000);
        return false;
      }
      if (done.result === "kept-both") {
        // La suite est dans `from` (ecrite) ET toujours sur le disque : en double, rien de perdu.
        this.setFlowText(from, text);
        from.prevText = undefined;
        from.lastShift = undefined;
        this.flowUndo = null;
        this.repaintFlowed(from);
        toast(`La page suivante n'a pas pu aller à la corbeille (${errorText(done.error)}) : `
          + "son contenu est maintenant en double, rien n'est perdu.", "warn", 8000);
        return false;
      }
      this.total--;
      if (shownNext && this.list.includes(shownNext)) {
        this.releasePage(shownNext);
        const sep = shownNext.wrap.previousElementSibling;
        if (sep?.classList.contains("page-sep")) sep.remove();
        shownNext.wrap.remove();
        this.list.splice(this.list.indexOf(shownNext), 1);
      }
      // La page d'apres suivait la page remontee : elle suit maintenant `from`.
      if (n <= this.total) {
        const after = this.list.find((p) => p.number === n && !p.dead && !p.copy);
        if (after?.page.continues === nextId) { after.page.continues = from.page.id; this.queueSave(after); }
        else if (!after) {
          const pg = await this.serial(() => this.host.repo.readPage(this.notebook, this.divider, n)).catch(() => null);
          if (pg?.continues === nextId) {
            pg.continues = from.page.id;
            await this.serial(() => this.host.repo.writePage(this.notebook, this.divider, n, pg));
          }
        }
      }
      this.setFlowText(from, text);
      // Le « texte d'avant la frappe » de `from` date d'avant la remontee : le
      // debordement qui suit l'aurait pris pour son annulation, et Ctrl+Z
      // aurait rendu `from` sans la suite remontee (perte du 13/10, la page
      // n'etait plus qu'en corbeille). Plus de retour en arriere par-dessus.
      from.prevText = undefined;
      from.lastShift = undefined;
      this.flowUndo = null;
      this.repaintFlowed(from);
      this.queueSave(from);
      this.host.onPageChange?.(this.current, this.total);
      this.host.onDirty();
      pulled = true;
    } catch (e) {
      // Rien n'est encore sur le disque : `from` retrouve son contenu d'avant.
      if (!committed && !from.dead) undoPull();
      toast(`Page suivante impossible à remonter : ${errorText(e)}`, "err", 6000);
    } finally {
      this.flowing = false;
      this.releaseKeys();
    }
    if (!pulled) return false;
    // Photos chargees, mesures justes : ce qui depasse repart sur la page suivante.
    await from.doc.imagesReady().catch(() => undefined);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (from.dead) return true;
    this.fitSheet(from);
    from.editedAt = performance.now();
    this.maybeFlow(from, "force");
    return true;
  }

  /**
   * « Tasser les pages » : depuis la page courante, chaque page remonte ses
   * suites tant qu'il reste de la place. Les pages ajoutees a la main (sans
   * `continues`) ne bougent jamais.
   */
  async compactPages(): Promise<void> {
    if (this.locked()) return;
    const start = this.current;
    let n = start, pulled = 0, guard = 0;
    while (n <= this.total && guard++ < 200) {
      if (this.viewMode === "pages") await this.goTo(n, false);
      else this.revealPage(n);
      await new Promise((r) => setTimeout(r, 60));
      const p = this.list.find((x) => x.number === n && !x.dead && !x.copy);
      if (!p) { n++; continue; }
      if (!p.settled) await this.settle(p);
      if (await this.pullNext(p)) {
        pulled++;
        // Le debordement qui suit peut prendre un moment.
        for (let i = 0; i < 50 && this.flowing; i++) await new Promise((r) => setTimeout(r, 40));
      }
      n++;
    }
    if (this.viewMode === "pages") await this.goTo(start);
    toast(pulled ? `Pages tassées : ${pulled} suite${pulled > 1 ? "s" : ""} remontée${pulled > 1 ? "s" : ""}` : "Rien à tasser : aucune page de suite n'a de place libre avant elle.");
  }

  /** Touches retenues pendant un debordement asynchrone (rejouees ensuite). */
  private onFlowKey = (e: KeyboardEvent): void => {
    if (!this.flowKeys || e.isComposing) return;
    const altGr = e.ctrlKey && e.altKey;
    if ((e.ctrlKey || e.altKey || e.metaKey) && !altGr) return;
    if (e.key.length !== 1 && !["Enter", "Backspace", "Delete", "Tab"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.flowKeys.push({ key: e.key, shift: e.shiftKey });
  };

  private onFlowInput = (e: InputEvent): void => {
    if (!this.flowKeys || !e.inputType.startsWith("insert")) return;
    e.preventDefault();
    if (e.data) for (const ch of e.data) this.flowKeys.push({ key: ch, shift: false });
  };

  private holdKeys(): void {
    if (this.flowKeys) return;
    this.flowKeys = [];
    window.addEventListener("keydown", this.onFlowKey, { capture: true });
    window.addEventListener("beforeinput", this.onFlowInput as EventListener, { capture: true });
  }

  /** Fin du debordement : les touches retenues partent la ou est le curseur. */
  private releaseKeys(): void {
    const keys = this.flowKeys ?? [];
    this.flowKeys = null;
    window.removeEventListener("keydown", this.onFlowKey, { capture: true });
    window.removeEventListener("beforeinput", this.onFlowInput as EventListener, { capture: true });
    while (keys.length) {
      if (this.flowing) { this.holdKeys(); this.flowKeys!.push(...keys); return; }
      const k = keys.shift()!;
      const target = document.activeElement?.closest?.(".text-doc");
      if (!(target instanceof HTMLElement)) continue;
      const ev = new KeyboardEvent("keydown", { key: k.key, shiftKey: k.shift, bubbles: true, cancelable: true });
      if (!target.dispatchEvent(ev)) continue;
      if (k.key.length === 1) document.execCommand("insertText", false, k.key);
      else if (k.key === "Backspace") document.execCommand("delete");
      else if (k.key === "Delete") document.execCommand("forwardDelete");
    }
  }

  /** Coupe le texte de la page au debut de la rangee `at` (l'encre ne suit pas : c'est voulu). */
  private cutText(from: LoadedPage, at: Range | null): { tail: string; caret: boolean } {
    if (!at) return { tail: "", caret: false };
    from.noPush = true;
    try {
      return from.doc.splitOff(at, CARET_MARK);
    } finally {
      from.noPush = false;
    }
  }

  /** Texte d'une page affichee remplace (pagination) ; le curseur va au marqueur s'il y est. */
  private setFlowText(p: LoadedPage, text: string): void {
    p.noPush = true;
    try {
      p.doc.setContent(text);
      if (text.includes(CARET_MARK)) p.doc.takeMarker(CARET_MARK);
      this.setBodyText(p, p.doc.content);
    } finally {
      p.noPush = false;
    }
  }

  /** Repeint une page dont la pagination a deplace le contenu. */
  private repaintFlowed(p: LoadedPage): void {
    this.history.drop(p.page.id);
    // Ancienne hauteur notee (encre sous l'A4, partie avec la suite) : oubliee.
    shrinkToInk(p.page);
    this.fitSheet(p);
    this.paintStrokes(p);
    this.paintOverlay(p);
  }

  /** Numero de page affiche sous la feuille (apres une renumerotation). */
  private relabel(p: LoadedPage): void {
    p.wrap.dataset.page = String(p.number);
    const num = p.wrap.querySelector(":scope > .page-num");
    if (!num || p.copy) return;
    const day = dayLabel(p.page.created);
    num.textContent = `${dividerLabel(this.divider)} p. ${p.number}${day ? ` · ${day}` : ""}`;
  }

  /** Page creee par la pagination, posee juste sous `after` (mode defilement). */
  private insertLoaded(after: LoadedPage, n: number, page: Page): LoadedPage {
    const p = this.buildPage(n, page);
    this.list.splice(this.list.indexOf(after) + 1, 0, p);
    after.wrap.after(el("div", { class: "page-sep" }), p.wrap);
    p.wrap.style.maxWidth = after.wrap.style.maxWidth;
    p.wrap.style.width = after.wrap.style.width;
    p.sheet.style.setProperty("--k", after.sheet.style.getPropertyValue("--k"));
    this.fitSheet(p, true);
    this.paintOverlay(p);
    for (const q of this.list) this.relabel(q);
    // Defilement virtualise : la page creee a son emplacement, juste apres.
    const at = this.slots.findIndex((s) => s.loaded === after);
    if (at >= 0) {
      this.slots.splice(at + 1, 0, {
        number: n, ph: this.placeholder(n), loaded: p, broken: null, loading: false,
        size: estimateSize(undefined, this.typical),
      });
      for (const s of this.slots) if (!s.loaded) this.labelSlot(s);
    }
    return p;
  }

  /**
   * Debordement : ce qui passe sous le bas de la page `from` (plan) part en
   * tete de la page suivante. Si celle-ci a ete creee par un debordement de
   * `from` (continues), le flux y continue ; sinon une page neuve est
   * inseree juste apres (renumerotation), jamais de fusion dans une page
   * deja ecrite. Jamais de perte : la page d'arrivee est ecrite (ou tenue en
   * memoire avec `from`) avant que `from` ne perde quoi que ce soit.
   * Rend la page d'arrivee si elle est affichee.
   */
  private async flowOut(from: LoadedPage, plan: FlowPlan, m: MeasuredRows): Promise<LoadedPage | null> {
    this.flowing = true;
    // Une page lue pendant le debordement est relue avant d'etre montee.
    this.diskEpoch++;
    const now = performance.now();
    const prev = from.prevText && now - from.prevText.t < FLOW_EDIT_MS ? from.prevText : null;
    const shift = from.lastShift && now - from.lastShift.t < FLOW_EDIT_MS ? from.lastShift : null;
    const undo: FlowUndo = {
      fromId: from.page.id,
      fromBlocks: JSON.stringify(from.page.blocks),
      fromText: prev?.content ?? null,
      fromCaret: prev?.caret ?? null,
      ...(shift ? { shift: { y: shift.y, d: shift.d } } : {}),
      toId: "", toBlocks: null, seq: 0,
    };
    let shown: LoadedPage | null = null;
    let caretTo: { pageId: string; content: string } | null = null;
    try {
      const at = plan.firstRow < m.rows.length ? rowStart(from.doc.root, m, m.rows[plan.firstRow]) : null;
      // Lignes vides seules sous la coupe : elles ne passent pas a la page
      // suivante (sauf celle du curseur : Entree en bas de page y va).
      const blank = !!at && !/\S/.test(from.doc.tailFrom(at)) && !from.doc.caretFrom(at);
      const textOf = (tail: string) => (blank ? "" : tail);
      const preview = at ? textOf(from.doc.tailFrom(at)) : "";
      const sel: FlowSelection = {
        strokeIds: plan.strokeIds, zoneIds: plan.zoneIds, flagIds: plan.flagIds, blockIds: imageIdsOf(preview),
      };
      if (!preview && !sel.strokeIds.length && !sel.zoneIds.length && !sel.flagIds.length) {
        // Rien a deplacer : les lignes vides finales sont retirees, la page garde sa taille.
        if (at) {
          const before = from.doc.content;
          this.cutText(from, at);
          if (from.doc.content === before) this.flowAgain.delete(from);
        }
        return null;
      }
      const n = from.number + 1;
      // Page suivante : affichee, en file d'ecriture, ou sur le disque.
      const shownNext = this.list.find((p) => p.number === n && !p.dead && !p.copy) ?? null;
      let nextPage: Page | null = shownNext?.page
        ?? [...this.pendingSave.values()].find((p) => p.number === n)?.page ?? null;
      if (!nextPage && n <= this.total) {
        this.holdKeys();
        nextPage = await this.serial(() => this.host.repo.readPage(this.notebook, this.divider, n)).catch(() => null);
      }
      // Comme Word : ce qui deborde passe en tete de la page suivante (son
      // contenu descend, et deborde a son tour), au lieu d'inserer une page
      // presque vide. Nouvelle page seulement en fin d'intercalaire, ou si la
      // suivante est en lecture seule ou une page de PDF.
      const isFlow = !!nextPage && !isFutureVersion(nextPage) && !shownNext?.readOnly && !shownNext?.copy
        && !pdfBlockOf(nextPage);

      if (isFlow && shownNext) {
        // Page de suite affichee (defilement) : tout se passe en memoire.
        undo.toId = shownNext.page.id;
        undo.toBlocks = JSON.stringify(shownNext.page.blocks);
        const tail = textOf(this.cutText(from, at).tail);
        const existing = this.bodyText(shownNext.page)?.content ?? "";
        const c = composeFlowText(tail, plan.lead, existing, plan.textLines, plan.inkLines);
        moveFlowBlocks(from.page, shownNext.page, { ...sel, blockIds: imageIdsOf(tail) }, plan.dy, c.shift, uuid);
        this.setFlowText(shownNext, c.text);
        // Elle deborde peut-etre a son tour : revue apres celui-ci.
        shownNext.editedAt = performance.now();
        this.flowAgain.add(shownNext);
        this.repaintFlowed(shownNext);
        this.repaintFlowed(from);
        // La page d'arrivee part la premiere sur le disque.
        this.pendingSave.delete(from.page.id);
        this.queueSave(shownNext);
        this.queueSave(from);
        shown = shownNext;
      } else {
        // Page d'arrivee preparee sur une copie, ecrite AVANT de toucher a `from`.
        this.holdKeys();
        const target: Page = isFlow ? structuredClone(nextPage!) : { ...emptyPage(uuid(), nowIso()), continues: from.page.id };
        // La copie s'ecrit comme la page lue : meme garde contre un changement sur le disque.
        if (isFlow) this.host.repo.shareBase(nextPage!, target);
        undo.toId = target.id;
        undo.toBlocks = isFlow ? JSON.stringify(nextPage!.blocks) : null;
        const existing = isFlow ? this.bodyText(target)?.content ?? "" : "";
        const compose = (tail: string) => composeFlowText(tail, plan.lead, existing, plan.textLines, isFlow ? plan.inkLines : 0);
        const c = compose(preview);
        moveFlowBlocks(structuredClone(from.page), target, sel, plan.dy, c.shift, uuid);
        setPageText(target, c.text);
        // Ce qui attend d'etre ecrit part avant (la page d'avant garde encore tout).
        await this.flush();
        let num = n;
        if (isFlow) {
          this.pendingSave.delete(target.id);
          await this.serial(() => this.host.repo.writePage(this.notebook, this.divider, n, target));
        } else {
          num = await this.serial(async () => {
            const made = await this.host.repo.createPage(this.notebook, this.divider, n, target);
            this.shiftNumbers(made, +1);
            return made;
          });
          this.total++;
          this.splitLog?.push(target.id);
        }
        if (from.dead) return null;
        // Maintenant seulement, `from` perd ce qui est parti.
        const cut = this.cutText(from, at);
        const tail = textOf(cut.tail), caret = cut.caret && !blank;
        moveFlowBlocks(from.page, emptyPage("x", ""), sel, 0, 0, uuid);
        this.repaintFlowed(from);
        this.queueSave(from);
        const clean = tail.split(CARET_MARK).join("");
        if (clean !== preview) {
          // Le texte a change pendant l'ecriture (formule mise en forme) : on reprend la derniere version.
          setPageText(target, compose(clean).text);
          this.pendingSave.set(target.id, { number: num, page: target, dead: true } as LoadedPage);
        }
        if (caret) caretTo = { pageId: target.id, content: compose(tail).text };
        if (!isFlow && this.viewMode === "scroll" && this.list.includes(from)) {
          shown = this.insertLoaded(from, num, target);
        }
        this.host.onPageChange?.(this.current, this.total);
        this.host.onDirty();
        // Mode pages : le curseur suit le texte, la vue passe a la page suivante.
        if (caretTo && this.viewMode === "pages") {
          this.flowing = false;
          await this.goTo(num);
          this.flowing = true;
          shown = this.list.find((p) => p.page.id === target.id) ?? null;
        }
      }
      if (caretTo && shown && shown.page.id === caretTo.pageId) {
        // Le texte affiche est celui sans marqueur : on y pose le curseur.
        shown.noPush = true;
        try {
          shown.doc.setContent(caretTo.content);
          shown.doc.takeMarker(CARET_MARK);
        } finally {
          shown.noPush = false;
        }
      }
      undo.seq = this.editSeq;
      this.flowUndo = undo;
      return shown;
    } catch (e) {
      toast(`Page suivante impossible à écrire : ${errorText(e)}. La page reste plus longue pour l'instant.`, "err", 6000);
      return null;
    } finally {
      this.flowing = false;
      this.releaseKeys();
      const again = [...this.flowAgain];
      this.flowAgain.clear();
      if (shown && !again.includes(shown)) again.push(shown);
      for (const p of again) if (p.settled) this.maybeFlow(p, p.page.continues ? "settle" : undefined);
      this.scheduleWindow();
    }
  }

  /** Ctrl+Z juste apres un debordement : est-ce lui qu'on annule ? */
  private flowUndoFor(pageId?: string): FlowUndo | null {
    const u = this.flowUndo;
    if (!u || u.seq !== this.editSeq || this.flowing) return null;
    if (pageId && pageId !== u.fromId && pageId !== u.toId) return null;
    return u;
  }

  /**
   * Annule le dernier debordement : la page d'avant retrouve son texte
   * d'avant la frappe (et son encre), la page d'apres son contenu, ou part
   * a la corbeille si le debordement l'avait creee.
   */
  private async undoFlow(u: FlowUndo): Promise<void> {
    this.flowUndo = null;
    if (this.locked()) return;
    this.flowing = true;
    this.diskEpoch++;
    this.holdKeys();
    try {
      await this.flush();
      const from = this.list.find((p) => p.page.id === u.fromId && !p.dead) ?? null;
      const fromNum = from?.number ?? (await this.findPageNumber(u.fromId));
      if (fromNum === null) return;
      const toNum = fromNum + 1;
      const toShown = this.list.find((p) => p.page.id === u.toId && !p.dead) ?? null;
      // Page d'apres : contenu d'avant, ou corbeille si le debordement l'a creee.
      if (u.toBlocks === null) {
        const check = toShown?.page ?? (await this.serial(() => this.host.repo.readPage(this.notebook, this.divider, toNum)).catch(() => null));
        // Garde-fou : la page creee ne part a la corbeille que si son texte
        // revient bien dans `from` ; sinon on n'annule rien (jamais de perte).
        const toText = check ? this.bodyText(check)?.content ?? "" : "";
        // Ce qu'on vient de taper (un bout d'au plus 10 caracteres d'affilee) n'y est pas encore.
        if (check?.id === u.toId && u.fromText !== null && !textComesBack(toText, u.fromText)) {
          toast("Annulation du passage à la page suivante impossible sans perdre du texte : rien n'a été changé", "warn", 6000);
          return;
        }
        if (check?.id === u.toId) {
          await this.serial(async () => {
            await this.host.repo.deletePage(this.notebook, this.divider, toNum);
            // Defilement virtualise : son emplacement part avec elle (montee ou non).
            this.dropSlot(toNum);
            for (const p of [...this.list, ...this.pendingSave.values()].filter((x) => x.page.id === u.toId)) {
              p.dead = true;
              p.number = 0;
              this.pendingSave.delete(p.page.id);
              this.history.drop(p.page.id);
            }
            this.shiftNumbers(toNum + 1, -1);
          });
          this.total--;
          if (toShown && this.list.includes(toShown)) {
            this.releasePage(toShown);
            const sep = toShown.wrap.previousElementSibling;
            if (sep?.classList.contains("page-sep")) sep.remove();
            toShown.wrap.remove();
            this.list.splice(this.list.indexOf(toShown), 1);
          }
        }
      } else if (toShown) {
        toShown.page.blocks = JSON.parse(u.toBlocks) as Block[];
        this.setFlowText(toShown, this.bodyText(toShown.page)?.content ?? "");
        this.repaintFlowed(toShown);
        this.queueSave(toShown);
      } else {
        const page = await this.serial(() => this.host.repo.readPage(this.notebook, this.divider, toNum)).catch(() => null);
        if (page?.id === u.toId) {
          page.blocks = JSON.parse(u.toBlocks) as Block[];
          await this.serial(() => this.host.repo.writePage(this.notebook, this.divider, toNum, page));
        }
      }
      // Page d'avant : blocs du moment du debordement, texte d'avant la frappe.
      const restore = (page: Page) => {
        page.blocks = JSON.parse(u.fromBlocks) as Block[];
        const body = this.bodyText(page);
        if (u.fromText !== null) {
          if (body) body.content = u.fromText;
          if (u.shift) shiftBelow(page.blocks, u.shift.y + u.shift.d, -u.shift.d);
        }
      };
      if (this.viewMode === "pages" && this.current !== fromNum) {
        const page = await this.serial(() => this.host.repo.readPage(this.notebook, this.divider, fromNum)).catch(() => null);
        if (page?.id === u.fromId) {
          restore(page);
          await this.serial(() => this.host.repo.writePage(this.notebook, this.divider, fromNum, page));
        }
        this.flowing = false;
        await this.goTo(fromNum);
        this.flowing = true;
      } else if (from) {
        restore(from.page);
        this.setFlowText(from, this.bodyText(from.page)?.content ?? "");
        this.repaintFlowed(from);
        this.queueSave(from);
      }
      const back = this.list.find((p) => p.page.id === u.fromId && !p.dead);
      if (back) {
        // Pas de nouveau debordement d'office : la page reprend a la prochaine frappe.
        back.editedAt = undefined;
        if (u.fromCaret !== null) back.doc.setCaretOffset(u.fromCaret);
        else back.doc.focus();
      }
      for (const p of this.list) this.relabel(p);
      this.host.onPageChange?.(this.current, this.total);
      this.host.onDirty();
    } catch (e) {
      toast(`Annulation impossible : ${errorText(e)}`, "err", 6000);
    } finally {
      this.flowing = false;
      this.releaseKeys();
      this.scheduleWindow();
    }
  }

  /** Numero d'une page de l'intercalaire d'apres son id (lecture du disque). */
  private async findPageNumber(id: string): Promise<number | null> {
    const shown = this.list.find((p) => p.page.id === id && !p.dead);
    if (shown) return shown.number;
    const nums = await this.host.repo.listPageNumbers(this.notebook, this.divider);
    for (const n of nums) {
      const page = await this.host.repo.readPage(this.notebook, this.divider, n).catch(() => null);
      if (page?.id === id) return n;
    }
    return null;
  }

  /**
   * « Répartir sur plusieurs pages » d'une ancienne page longue : ce qui est
   * sous chaque fin de feuille A4 part sur des pages inserees juste apres.
   * Explicite, et annulable (toast « Annuler » : la page longue revient, les
   * pages creees partent a la corbeille).
   */
  private async splitLongPage(loaded: LoadedPage): Promise<boolean> {
    if (loaded.dead || loaded.readOnly || this.readOnly || this.flowing) return false;
    await this.flush();
    if (this.hasUnsaved) return false;
    const pageId = loaded.page.id;
    const wasPages = this.viewMode === "pages";
    this.splitLog = [];
    try {
      // En mode pages, la suite doit etre affichee pour se couper a son tour.
      if (wasPages) {
        this.viewMode = "scroll";
        await this.render();
      }
      const first = this.list.find((p) => p.page.id === pageId);
      if (!first) return false;
      for (const p of this.list) p.long = p.page.id === pageId ? false : p.long;
      first.settled = true;
      first.editedAt = performance.now();
      this.paintNotes(first);
      let cur: LoadedPage | null = first;
      for (let guard = 0; cur && guard < 60; guard++) {
        while (this.flowing) await new Promise((r) => setTimeout(r, 30));
        await cur.doc.imagesReady().catch(() => undefined);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        cur.settled = true;
        cur.long = false;
        this.fitSheet(cur);
        const k = (cur.sheet.clientWidth || PAGE_W) / PAGE_W;
        const m = measureRows(cur.doc.root, cur.sheet.getBoundingClientRect().top, k);
        const plan = planFlow(m.rows, cur.page.blocks);
        if (!plan) break;
        cur = await this.flowOut(cur, plan, m);
      }
    } finally {
      const made = this.splitLog ?? [];
      this.splitLog = null;
      if (wasPages) {
        this.viewMode = "pages";
        await this.render();
      }
      if (made.length) toast(`Page plus longue qu'une A4 : répartie sur ${made.length + 1} pages`, "info", 6000);
    }
    return true;
  }

  /** Zoom en vigueur : 100 % pendant un export PDF (feuilles A4). */
  private get effectiveZoom(): number {
    return this.exporting ? 1 : this.zoom;
  }

  /**
   * Densite du canvas d'une page (core/zoom.ts) : celle de l'ecran a 100 %,
   * plafonnee au zoom ; en defilement, une page loin de l'ecran garde le
   * poids qu'elle avait a 100 % et redevient nette en revenant (onScroll).
   */
  private densityOf(p: LoadedPage, cssW: number, cssH: number): number {
    return inkDensity(cssW, cssH, window.devicePixelRatio || 1, this.effectiveZoom, this.isNear(p));
  }

  /** Page a l'ecran, ou a moins d'un ecran de distance. */
  private isNear(p: LoadedPage): boolean {
    if (this.viewMode === "pages" || this.effectiveZoom <= 1) return true;
    const view = this.root.getBoundingClientRect();
    if (!view.height) return true;
    const r = p.wrap.getBoundingClientRect();
    return r.bottom > view.top - view.height && r.top < view.bottom + view.height;
  }

  /** Apres un defilement au zoom : densite revue page par page, sans relire le texte. */
  private refreshDensity(): void {
    if (this.effectiveZoom <= 1 || this.viewMode !== "scroll") return;
    for (const p of this.list) {
      const s = p.surface;
      if (!s) continue;
      const width = p.sheet.clientWidth || PAGE_W;
      s.fit(width, s.height, this.densityOf(p, width, s.height * width / PAGE_W));
    }
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
      if (e.pointerType === "touch" || e.pointerType === "pen") down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
    });
    loaded.sheet.addEventListener("pointerup", (e) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId) return;
      // Stylet : un vrai appui court (le trait commence sur un mot n'en est pas un).
      if (e.pointerType === "pen" && !isTap(Math.hypot(e.clientX - d.x, e.clientY - d.y), e.timeStamp - d.t)) return;
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
    // Jamais sous READABLE_W (texte a 13 px) : un panneau de split etroit
    // fait defiler la feuille de cote plutot que de la rendre illisible.
    const avail = this.root.clientWidth - 36;
    const base = Math.min(900, Math.max(READABLE_W, avail));
    // Zoom : la feuille est simplement plus large (ou plus etroite). Texte,
    // blocs et canvas suivent --k ; au-dela de la vue, on defile de cote.
    const z = this.effectiveZoom;
    const width = Math.round(base * z);
    this.sheetWidth = width;
    this.wrapMax = `${width}px`;
    this.wrapW = z > 1 || width > avail ? `${width}px` : "";
    for (const p of this.list) this.layoutPage(p);
    // Defilement virtualise : les emplacements vides suivent la largeur (zoom).
    for (const s of this.slots) if (!s.loaded) this.sizeSlot(s);
    // Le cadre est sur le canvas (unites de page), la barre en pixels : elle suit.
    if (this.sel) this.paintSelBar();
    this.scheduleWindow();
  }

  /** Largeur de feuille du dernier relayout (styles de .page-wrap). */
  private wrapMax = "";
  private wrapW = "";

  /** Met une page a la largeur des feuilles (relayout, page montee en defilement). */
  private layoutPage(p: LoadedPage): void {
    p.wrap.style.maxWidth = this.wrapMax;
    p.wrap.style.width = this.wrapW;
    p.sheet.style.height = "";
    p.sheet.style.setProperty("--k", String(this.sheetK));
    this.fitSheet(p, true);
    // Il faut la page reellement a l'ecran pour savoir quelle ligne passe
    // sous chaque ancienne photo : c'est le cas au premier relayout visible.
    if (this.root.isConnected && this.root.clientWidth > 0) this.adoptFloatingImages(p);
    this.paintOverlay(p);
    // Pagination : une page construite hors ecran se mesure maintenant.
    if (!p.settled && this.root.isConnected) void this.settle(p);
  }

  /** Repere la page en vue pour que "derniere position" reste juste. */
  private onScroll(): void {
    this.refreshDensity();
    // Pages de PDF : rendues en approchant de l'ecran, liberees en s'eloignant.
    if (this.viewMode === "scroll" && !this.exporting) this.pdfLayer.syncAll(this.list, this.root);
    if (this.viewMode !== "scroll" || (!this.list.length && !this.slots.length)) return;
    // Position de chaque page par rapport au haut de la vue. offsetTop se
    // mesurait depuis le body (la vue n'est pas positionnee) : les barres du
    // haut s'y ajoutaient et l'indicateur restait une page en retard.
    const top = this.root.getBoundingClientRect().top + 80;
    let best: number;
    if (this.slots.length) {
      // Toutes les pages, montees ou non (emplacements virtualises).
      best = this.slots[pageAt(this.slots.length, (i) => this.boxOf(i), top)].number;
    } else {
      best = this.list[0].number;
      for (const p of this.list) {
        if (p.wrap.getBoundingClientRect().top <= top) best = p.number;
      }
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
    this.editSeq++;
    this.lastEditedId = loaded.page.id;
    ink.strokes.push(stroke);
    loaded.lastEdit = "ink";
    loaded.lastInk = strokeBounds(stroke);
    this.lastGestureId = loaded.page.id;
    // Pagination : une page A4 ne s'allonge plus (le stylet s'arrete au bord) ;
    // seule une ancienne page longue garde ce comportement.
    if (loaded.long && growForStroke(loaded.page, stroke)) this.fitSheet(loaded);
    this.queueSave(loaded);
    // Un surlignage ne part pas a la reconnaissance.
    if (stroke.tool === "pen" && this.host.autoConvert()) {
      this.scheduleAutoConvert(loaded, { current: strokeBounds(stroke) });
    }
  }

  /** Conversion par bandes : dernier envoi demande et pause longue, par page. */
  private autoState = new WeakMap<LoadedPage, { sig: string; idle: ReturnType<typeof setTimeout> | null }>();

  /**
   * Conversion au fil de la plume (section 4). L'envoi part au lever du
   * stylet plus une pause, jamais en flux continu : sans cela on paierait
   * une requete par trait et la batterie avec.
   */
  private scheduleAutoConvert(loaded: LoadedPage, opts: { current?: Bounds; full?: boolean } = {}): void {
    const ink = this.mainInk(loaded.page) as RecoInk;
    // Ancienne transcription pleine page reprise au clavier : ne pas l'ecraser.
    // En mot a mot, les corrections sont reportees mot par mot (carryEdits).
    if (ink.editedByHand && !ink.words) return;
    // Par bandes de lignes (reco-3, bands.ts) : seules les lignes touchees
    // depuis la derniere lecture partent, jamais les mots deja lus. Apres
    // un trait, la ligne en cours attend qu'on la quitte ou une pause
    // longue : une requete par ligne au lieu d'une par hesitation.
    const plan = planIncremental(ink, opts);
    let state = this.autoState.get(loaded);
    if (!state) { state = { sig: "", idle: null }; this.autoState.set(loaded, state); }
    if (state.idle) { clearTimeout(state.idle); state.idle = null; }
    if (!plan.all.length) {
      // Plus rien a lire (gomme, zone tracee) : un envoi deja parti fixera
      // l'etat a son retour.
      if (ink.pending) { ink.pending = false; this.paintOverlay(loaded); }
      return;
    }
    ink.pending = true;
    delete ink.recoError;
    this.paintOverlay(loaded);
    const send = (strokes: Stroke[]) => {
      state!.sig = sendSignature(strokes);
      // Seule l'ecriture part chez MyScript : un surlignage la perturbe.
      this.host.requestRecognition(this.keyOf(loaded, ink.id), "text", strokes, true, true);
    };
    if (!opts.current) { send(plan.all); return; }
    // Meme envoi que le precedent (encore en route) : pas de doublon.
    if (plan.now.length && sendSignature(plan.now) !== state.sig) send(plan.now);
    state.idle = setTimeout(() => {
      state!.idle = null;
      const all = planIncremental(this.mainInk(loaded.page) as RecoInk).all;
      if (all.length && sendSignature(all) !== state!.sig) send(all);
    }, Math.max(0, AUTO_IDLE_MS - AUTO_DEBOUNCE_MS));
  }

  /** Relance la conversion de la page, meme apres une correction clavier. */
  reconvert(): void {
    const loaded = this.activePage();
    if (!loaded) return;
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return; }
    const ink = this.mainInk(loaded.page);
    if (!ink.strokes.some((s) => s.tool === "pen")) { toast("Rien à convertir sur cette page", "warn"); return; }
    ink.editedByHand = false;
    this.scheduleAutoConvert(loaded, { full: true });
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
            // Mot ampute : a relire (bands.ts), il reste affiche d'ici la.
            invalidateStrokes(b as RecoInk, set);
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
   * Gomme precise (encre-14) : les traits touches sont remplaces par leurs
   * morceaux, a leur place. Une entree d'annulation par geste, comme la
   * gomme entiere.
   */
  private onCut(loaded: LoadedPage, split: Map<string, Stroke[]>): void {
    if (!loaded.eraseNoted) { this.pushUndo(loaded); loaded.eraseNoted = true; }
    const r = replaceStrokes(loaded.page.blocks, split);
    loaded.page.blocks = r.blocks;
    // Les morceaux ont des ids neufs : le mot coupe est a relire.
    if (r.wordsTouched) {
      const main = loaded.page.blocks.find((b): b is InkBlock => b.type === "ink" && !b.rect);
      if (main) invalidateStrokes(main as RecoInk, [...split.values()].flat().map((st) => st.id));
    }
    if (this.sel?.loaded === loaded && [...split.keys()].some((id) => this.sel!.ids.has(id))) this.clearSelection();
    this.paintOverlay(loaded);
    this.queueSave(loaded);
    if (r.wordsTouched && this.host.autoConvert()) this.scheduleAutoConvert(loaded);
  }

  /* ---------------- selection au lasso (encre-13) ---------------- */

  private canEdit(loaded: LoadedPage): boolean {
    if (!loaded.readOnly && !this.readOnly) return true;
    this.warnedReadOnly = false;
    this.warnReadOnly();
    return false;
  }

  /** Lasso referme : les traits majoritairement dedans sont pris. */
  private onLasso(loaded: LoadedPage, poly: InkPt[]): void {
    if (!this.canEdit(loaded)) return;
    const ids = selectInLasso(loaded.page.blocks, poly);
    if (!ids.size) { toast("Aucun trait entouré", "info", 1500); return; }
    this.select(loaded, ids);
    // Le clavier va a la selection (Suppr, Ctrl+C), pas au texte.
    const a = document.activeElement as HTMLElement | null;
    if (a && loaded.wrap.contains(a)) a.blur();
  }

  private select(loaded: LoadedPage, ids: Set<string>): void {
    if (this.sel && this.sel.loaded !== loaded) this.sel.loaded.surface?.setSelection(null);
    const strokes = strokesById(loaded.page.blocks, ids);
    if (!strokes.length) { this.clearSelection(); return; }
    // Seuls les traits encore presents restent pris (annulation, gomme).
    const kept = new Set(strokes.map((st) => st.id));
    this.sel = { loaded, ids: kept };
    loaded.surface?.setSelection(kept, selectionBounds(strokes));
    this.paintSelBar();
  }

  get hasSelection(): boolean { return this.sel !== null; }

  /** Echap, changement d'outil ou de page : plus rien n'est selectionne. */
  clearSelection(): void {
    const s = this.sel;
    this.sel = null;
    this.selBar?.remove();
    this.selBar = null;
    s?.loaded.surface?.cancelSelectionGesture();
    s?.loaded.surface?.setSelection(null);
  }

  /**
   * Barre d'actions au-dessus du cadre : couleurs de la palette, conversion
   * en texte ou en formule, copier, supprimer. Boutons de 44 px, utilisables
   * au doigt. Le lasso est ephemere : chaque action rend le stylo.
   */
  private paintSelBar(): void {
    this.selBar?.remove();
    this.selBar = null;
    const s = this.sel;
    const f = s?.loaded.surface?.selectionFrame();
    if (!s || !f) return;
    const k = (s.loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    const stop = (e: Event) => { e.stopPropagation(); };
    const btn = (label: string, title: string, run: () => void, cls = "") => {
      const b = el("button", { class: cls, title, "aria-label": title, onclick: (e: Event) => { e.stopPropagation(); run(); } }, label);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      return b;
    };
    const done = () => this.host.onSelectionDone?.();
    const swatch = (key: InkColor, ink: string, label: string) => {
      const b = btn("", `Passer en ${label}`, () => { this.recolorSelection(key); done(); }, "swatch");
      b.append(el("i", { style: { background: ink } }));
      return b;
    };
    const bar = el("div", { class: "lasso-bar" },
      swatch("normal", NEUTRAL_INK.ink, NEUTRAL_INK.label),
      ...PALETTE.map((p) => swatch(p.key, p.ink, p.label)),
      btn("En texte", "Convertir la sélection en texte (l'encre est gardée)", () => this.convertSelection("text")),
      btn("En formule", "Convertir la sélection en formule (l'encre est gardée)", () => this.convertSelection("math")),
      btn("Copier", "Copier (Ctrl+C), puis Ctrl+V sur n'importe quelle page", () => { this.copySelection(); done(); }),
      btn("Supprimer", "Supprimer (Suppr)", () => { this.deleteSelection(); done(); }, "danger"),
    );
    bar.addEventListener("pointerdown", stop);
    s.loaded.sheet.append(bar);
    const w = bar.offsetWidth || 420, h = bar.offsetHeight || 52;
    const sheetW = s.loaded.sheet.clientWidth;
    const left = Math.max(4, Math.min(f.x * k, sheetW - w - 4));
    const top = selBarTop(this.textLines(s.loaded), {
      left, width: w, height: h, frameTop: f.y * k, frameBottom: (f.y + f.h) * k,
      sheetHeight: s.loaded.sheet.clientHeight || Infinity,
    });
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
    this.selBar = bar;
  }

  /** Lignes du texte tape (rectangles en pixels relatifs a la feuille). */
  private textLines(loaded: LoadedPage): BarBox[] {
    const r = document.createRange();
    r.selectNodeContents(loaded.doc.root);
    const sheet = loaded.sheet.getBoundingClientRect();
    return Array.from(r.getClientRects())
      .filter((b) => b.width > 1 && b.height > 1)
      .map((b) => ({ top: b.top - sheet.top, bottom: b.bottom - sheet.top, left: b.left - sheet.left, right: b.right - sheet.left }));
  }

  /**
   * « En texte » / « En formule » de la barre du lasso : le chemin de
   * conversion par zone (onRegion) avec les bornes de la selection. L'encre
   * d'origine est gardee dans le bloc, comme pour une zone tracee.
   */
  private convertSelection(kind: "text" | "math"): void {
    const s = this.sel;
    if (!s || !this.canEdit(s.loaded)) return;
    const strokes = strokesById(s.loaded.page.blocks, s.ids);
    if (!strokes.length) return;
    const b = padBounds(selectionBounds(strokes), 2);
    this.clearSelection();
    this.host.onSelectionDone?.();
    void this.onRegion(s.loaded, b, kind);
  }

  /**
   * Fin d'un deplacement, d'un retaillage ou d'un espace : la transformation
   * passe dans les blocs (ids gardes), la feuille s'allonge si besoin.
   */
  private applyTransform(loaded: LoadedPage, ids: Set<string>, t: Transform, kind: "move" | "resize" | "space"): void {
    // Deplacer ou retailler au lasso change la ligne des traits : leurs mots
    // sont a relire. Un espace insere decale des lignes entieres, sans les
    // changer.
    const main = loaded.page.blocks.find((b): b is InkBlock => b.type === "ink" && !b.rect);
    const stale = kind !== "space" && !!main && invalidateStrokes(main as RecoInk, ids);
    transformBlocks(loaded.page.blocks, ids, t);
    // Page A4 (pagination) : la feuille ne s'allonge plus, l'encre poussee
    // sous le bas (insertion d'espace) passe a la page suivante (maybeFlow).
    if (loaded.long) for (const st of strokesById(loaded.page.blocks, ids)) growForStroke(loaded.page, st);
    loaded.lastEdit = "ink";
    this.lastGestureId = loaded.page.id;
    this.fitSheet(loaded);
    this.paintStrokes(loaded);
    this.paintOverlay(loaded);
    this.queueSave(loaded);
    if (stale && this.host.autoConvert()) this.scheduleAutoConvert(loaded);
    if (kind === "space") { this.maybeFlow(loaded); return; }
    this.select(loaded, ids);
  }

  /** Recolore la selection (palette semantique). Faux sans selection. */
  recolorSelection(color: InkColor): boolean {
    const s = this.sel;
    if (!s) return false;
    if (!this.canEdit(s.loaded)) return true;
    this.pushUndo(s.loaded);
    recolorStrokes(s.loaded.page.blocks, s.ids, color);
    this.paintStrokes(s.loaded);
    s.loaded.surface?.setSelection(s.ids, selectionBounds(strokesById(s.loaded.page.blocks, s.ids)));
    this.queueSave(s.loaded);
    toast(`Sélection en ${labelOf(color)}`, "info", 1200);
    return true;
  }

  /** Suppr : comme la gomme, une seule entree d'annulation. */
  deleteSelection(): boolean {
    const s = this.sel;
    if (!s) return false;
    if (!this.canEdit(s.loaded)) return true;
    this.clearSelection();
    s.loaded.eraseNoted = false;
    this.onErase(s.loaded, [...s.ids]);
    this.paintStrokes(s.loaded);
    return true;
  }

  /** Ctrl+C / Ctrl+X. Faux sans selection (la touche reste au texte). */
  copySelection(cut = false): boolean {
    const s = this.sel;
    if (!s) return false;
    const clip = copySelection(s.loaded.page.blocks, s.ids);
    if (!clip) return false;
    inkClip = { clip, pageId: s.loaded.page.id, pastes: 0 };
    if (cut) this.deleteSelection();
    else toast("Copié : Ctrl+V sur n'importe quelle page", "info", 1500);
    return true;
  }

  /** Il y a de l'encre a coller. */
  static get canPaste(): boolean { return inkClip !== null; }

  /**
   * Ctrl+V : l'encre copiee arrive sur la page en vue, avec de nouveaux
   * ids, et devient la selection (on la place aussitot). Sur la page
   * d'origine, chaque collage se decale un peu.
   */
  paste(): boolean {
    const c = inkClip;
    const loaded = this.sel?.loaded ?? this.activePage();
    if (!c || !loaded) return false;
    if (!this.canEdit(loaded)) return true;
    const same = loaded.page.id === c.pageId;
    const step = same ? (c.pastes + 1) * PASTE_STEP : 0;
    const d = clampMove(c.clip.bounds, step, step);
    if (same) c.pastes++;
    this.pushUndo(loaded);
    const out = pasteClip(c.clip, d.dx, d.dy, uuid);
    const ink = this.mainInk(loaded.page);
    ink.strokes.push(...out.strokes);
    loaded.page.blocks.push(...out.zones);
    const ids = new Set<string>();
    for (const st of [...out.strokes, ...out.zones.flatMap((z) => z.strokes)]) {
      ids.add(st.id);
      growForStroke(loaded.page, st);
    }
    loaded.lastEdit = "ink";
    this.lastGestureId = loaded.page.id;
    this.fitSheet(loaded);
    this.paintStrokes(loaded);
    this.paintOverlay(loaded);
    this.queueSave(loaded);
    // Une zone collee en attente de lecture repart a la reconnaissance.
    for (const z of out.zones) {
      if (!z.pending) continue;
      const pens = recoStrokes(z.strokes);
      if (pens.length) this.host.requestRecognition(this.keyOf(loaded, z.id), kindOf(z), pens);
    }
    if (out.strokes.some((st) => st.tool === "pen") && this.host.autoConvert()) this.scheduleAutoConvert(loaded);
    this.select(loaded, ids);
    return true;
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
      // Un mot dont une partie seulement part dans la zone est a relire.
      invalidateStrokes(ink as RecoInk, ids);
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

    const box = unionBounds(inside.map((s) => strokeBounds(s, 4)));
    const id = uuid();
    // Une zone math donne un bloc math et du LaTeX ; une zone texte donne un
    // bloc d'encre dont le texte reconnu vit dans `recognized` (section 4).
    const block: Block = kind === "math"
      ? { id, type: "math", mode: "math", strokes: inside, latex: null, pending: true, rect: box }
      : { id, type: "ink", mode: "raw", strokes: inside, recognized: null, pending: true, rect: box };
    loaded.page.blocks.push(block);
    // Traits repeints APRES l'ajout du bloc : peints avant, ils n'etaient
    // plus dans le fond de page ni encore dans la zone, et l'encre de la
    // zone disparaissait jusqu'au prochain trait (sans cles MyScript, elle
    // restait invisible sous le cadre « clés MyScript manquantes »).
    this.paintStrokes(loaded);
    this.paintOverlay(loaded);
    this.queueSave(loaded);

    // Appuis isoles d'1 ou 2 points : jamais envoyes (lus « . »).
    const send = recoStrokes(inside);
    this.host.requestRecognition(this.keyOf(loaded, id), kind, send.length ? send : inside);
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
    // Une page lue avant cette ecriture n'est pas montee (defilement virtualise).
    this.diskEpoch++;
    return this.serial(fn);
  }

  /** Relance un bloc refuse par la reconnaissance. */
  private retryRecognition(loaded: LoadedPage, block: MathBlock | InkBlock): void {
    const strokes = recoStrokes(block.strokes);
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
      case "calc":
      case "graph": {
        // Pose dans le texte : c'est TextDoc qui l'affiche. Un ancien bloc
        // flottant (rect) y est range au premier affichage (adoptFloatingImages).
        if (!block.rect) return null;
        return place(el("div", { class: "block-box" }, this.renderLive(block).node), block.rect);
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
          el("button", { class: "ghost", onclick: () => this.host.openLink(block.target, block.pageId) },
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
      .map((st) => [st.id, inkCssColor(st.color)]));
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
        color: p.word.strokeIds.map((id) => pens.get(id)).find(Boolean) ?? inkCssColor("normal"),
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

  /* ---------------- blocs vivants (calculatrice) ---------------- */

  /**
   * Rendu d'un bloc vivant : formule relue par le moteur (toLatex) pour un
   * calcul, trace gradue pour une courbe (meme rendu et meme fenetre que
   * l'onglet Courbes, drawPlot). Le trace est fait en unites de page (x2) :
   * il suit le zoom comme le texte. mathjs est charge a la demande.
   */
  private renderLive(b: LiveBlock): { node: HTMLElement; ready: Promise<void> } {
    if (b.type === "calc") {
      const node = el("span", { class: "live-calc" }, `${b.expr} = ${b.result ?? ""}`);
      const ready = import("../core/calc/live").then(({ calcTex }) => {
        node.replaceChildren(renderTex(calcTex(b.expr, b.result)));
        if (b.angle === "DEG") node.append(el("span", { class: "live-tag", title: "Calculé en degrés" }, "DEG"));
      }).catch(() => undefined);
      return { node, ready };
    }
    const W = graphWidth(b, PAGE_W), H = Math.round(W * GRAPH_RATIO);
    const title = el("div", { class: "live-graph-title" }, `y = ${b.fn}`);
    const canvas = el("canvas");
    canvas.width = W * 2;
    canvas.height = H * 2;
    const node = el("div", { class: "live-graph" }, title, canvas);
    const ready = Promise.all([import("../core/calc/plot"), import("./plotdraw"), import("../core/calc/live")])
      .then(([plot, draw, live]) => {
        title.replaceChildren(renderTex(live.graphTex(b.fn)));
        if (b.angle === "DEG") title.append(el("span", { class: "live-tag", title: "x en degrés" }, "DEG"));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(2, 0, 0, 2, 0, 0);
        const p = plot.samplePlot(b.fn, b.domain[0], b.domain[1], 500, "x", b.angle, !!b.logX);
        if (!p.ok || !p.samples) {
          ctx.fillStyle = "#a51b1b";
          ctx.font = "16px system-ui, sans-serif";
          ctx.fillText(p.message ?? "expression invalide", 10, 24);
          return;
        }
        const win = plot.plotWindow(p.samples, b.range);
        draw.drawPlot(ctx, W, H, p.samples, { from: b.domain[0], to: b.domain[1], ...win }, { font: 14, line: 2.2, logX: !!b.logX });
      }).catch(() => undefined);
    return { node, ready };
  }

  /** La page ecrite qui porte ce bloc (la vue a pu la reconstruire depuis l'appui). */
  private holderOf(loaded: LoadedPage, id: string): { at: LoadedPage; block: LiveBlock } | null {
    const pages = [loaded, ...this.list.filter((p) => p.page.id === loaded.page.id && p !== loaded)];
    for (const at of pages) {
      if (at.dead || at.copy) continue;
      const block = at.page.blocks.find((b): b is LiveBlock => isLiveBlock(b) && b.id === id);
      if (block && at.doc.root.querySelector(`.doc-img[data-id="${CSS.escape(id)}"]`)) return { at, block };
    }
    return null;
  }

  /** Appui sur un calcul ou une courbe : la calculatrice le rouvre (section 2). */
  private openLive(loaded: LoadedPage, id: string): void {
    const found = this.holderOf(loaded, id);
    if (!found || !this.host.editLive) return;
    if (found.at.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return; }
    this.host.editLive(found.block, (spec) => this.updateLive(loaded, id, spec));
  }

  /** « Mettre à jour » : le bloc recalcule et se redessine a sa place. */
  private updateLive(loaded: LoadedPage, id: string, spec: CalcSpec | GraphSpec): boolean {
    const found = this.holderOf(loaded, id);
    if (!found) { toast("Ce bloc n'est plus dans la page : envoie-le à nouveau", "warn", 5000); return false; }
    const { at, block } = found;
    if (at.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return false; }
    const changed = block.type === "calc" && "expr" in spec ? applyCalcSpec(block, spec)
      : block.type === "graph" && "fn" in spec ? applyGraphSpec(block, spec) : false;
    if (!changed) return true;
    at.doc.refreshLive(id);
    this.fitSheet(at);
    this.queueSave(at);
    return true;
  }

  /**
   * Calcul ou courbe envoye par la calculatrice : dans la page en vue, au
   * curseur du texte s'il y en a un, sinon sous le dernier contenu (texte
   * et encre). Dans le texte, il ne recouvre jamais rien.
   */
  insertLive(block: LiveBlock): boolean {
    const loaded = this.activePage();
    if (!loaded) return false;
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return false; }
    loaded.page.blocks.push(block);
    const atCaret = loaded.doc.hasCaret();
    // Au curseur : l'encre sous sa ligne suit le texte ; en fin de texte,
    // belowInk descend le bloc sous l'encre, qui ne bouge pas.
    if (atCaret) this.notePreEdit(loaded);
    loaded.noPush = !atCaret;
    let fig: HTMLElement;
    try {
      fig = loaded.doc.insertLive(block.id, atCaret);
      if (!atCaret) this.belowInk(loaded, fig);
    } finally {
      loaded.noPush = false;
    }
    this.fitSheet(loaded);
    fig.scrollIntoView({ block: "nearest" });
    toast(block.type === "graph" ? "Courbe posée dans la page : un appui la rouvre" : "Calcul posé dans la page : un appui le rouvre");
    return true;
  }

  /**
   * Resultat des onglets Matrices, Résoudre, Littéral : une formule du texte
   * (KaTeX, editable comme les autres), au curseur ou sous le dernier contenu.
   */
  insertFormula(latex: string): boolean {
    const loaded = this.activePage();
    if (!loaded) return false;
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return false; }
    const atCaret = loaded.doc.hasCaret();
    if (atCaret) this.notePreEdit(loaded);
    loaded.noPush = !atCaret;
    let eq: HTMLElement;
    try {
      eq = loaded.doc.insertFormula(latex, atCaret);
      if (!atCaret) this.belowInk(loaded, eq);
    } finally {
      loaded.noPush = false;
    }
    this.fitSheet(loaded);
    eq.scrollIntoView({ block: "nearest" });
    toast("Résultat posé dans la page");
    return true;
  }

  /**
   * Morceau de texte (format de la page : phrases, $formules$, lignes) pose
   * au curseur, sinon a la fin : le detail d'une resolution de la calculatrice.
   */
  insertDoc(md: string): boolean {
    const loaded = this.activePage();
    if (!loaded) return false;
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return false; }
    const atCaret = loaded.doc.hasCaret();
    if (atCaret) this.notePreEdit(loaded);
    loaded.noPush = !atCaret;
    try {
      loaded.doc.insertDoc(md, atCaret);
    } finally {
      loaded.noPush = false;
    }
    this.fitSheet(loaded);
    toast("Détail posé dans la page");
    return true;
  }

  /** Pose en fin de texte : descendu sous l'encre la plus basse, s'il y en a dessous. */
  private belowInk(loaded: LoadedPage, node: HTMLElement): void {
    let bottom = 0;
    for (const b of loaded.page.blocks) {
      if (b.type === "flag") continue;
      if (b.rect) bottom = Math.max(bottom, b.rect.y + b.rect.h);
      const strokes = b.type === "ink" || b.type === "math" ? b.strokes : [];
      for (const st of strokes) {
        const sb = strokeBounds(st);
        bottom = Math.max(bottom, sb.y + sb.h);
      }
    }
    if (!bottom) return;
    const k = (loaded.sheet.clientWidth || PAGE_W) / PAGE_W;
    loaded.doc.pushBelow(node, loaded.sheet.getBoundingClientRect().top + (bottom + 12) * k);
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
   * Ctrl+V d'une photo copiee ou coupee (DocImages.clip) : nouveau bloc dans
   * cette page. Autre intercalaire : la photo et son original sont copies
   * dans ses assets/ (un intercalaire ne lit jamais les fichiers d'un autre).
   */
  private async pastePhoto(loaded: LoadedPage, marker: string): Promise<string | null> {
    const clip = photoClip;
    if (!clip || clip.marker !== marker) { toast("Cette photo n'est plus dans le presse-papiers : copie-la à nouveau.", "warn"); return null; }
    if (loaded.readOnly || this.readOnly) { this.warnedReadOnly = false; this.warnReadOnly(); return null; }
    const block: ImageBlock = { ...JSON.parse(JSON.stringify(clip.block)) as ImageBlock, id: uuid() };
    if (clip.notebook !== this.notebook || clip.divider !== this.divider) {
      const copy = async (src: string) => {
        const url = await this.host.repo.readAsset(clip.notebook, clip.divider, src);
        return this.host.repo.writeAsset(this.notebook, this.divider, src.split("/").pop() ?? src, url);
      };
      try {
        block.src = await copy(block.src);
      } catch (e) {
        toast(`Photo non collée : ${(e as Error).message}`, "err", 6000);
        return null;
      }
      if (block.original) {
        try { block.original = await copy(block.original); } catch { delete block.original; delete block.quad; }
      }
    }
    // Calee a cote d'une autre la-bas : seule sur sa ligne ici.
    delete block.side;
    loaded.page.blocks.push(block);
    return block.id;
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
      // Pleine largeur du texte au plus, centree.
      id, type: "image", align: "center", ...fields, width: Math.max(120, Math.min(PAGE_W - TEXT_LEFT - TEXT_RIGHT, result.width)),
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
      id, type: "image", align: "center", ...fields, width: Math.round(Math.max(120, Math.min(PAGE_W - TEXT_LEFT - TEXT_RIGHT, width))),
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
      else if (scroll) {
        // Page proche : defilement anime ; lointaine (Ctrl+G) : saut, puis la
        // page est construite avant de rendre la main (defilement virtualise).
        if (!this.revealPage(n, true)) await this.fillWindow(this.renderGen, this.slotIndex(n));
      }
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
    this.revealPage(this.current);
  }

  /** Decale les numeros des pages en memoire (affichees ou en file d'ecriture). */
  private shiftNumbers(from: number, delta: number): void {
    const all = new Set<LoadedPage>([...this.list, ...this.pendingSave.values()]);
    for (const p of all) if (p.number >= from) p.number += delta;
    // Emplacements du defilement virtualise (pages montees ou non).
    for (const s of this.slots) {
      if (s.number < from) continue;
      s.number += delta;
      if (!s.loaded) this.labelSlot(s);
    }
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
   * Import d'un PDF (src/ui/pdf-import.ts) : les pages arrivent apres la page
   * courante, dans l'ordre, les suivantes sont renumerotees. Rend le numero
   * de la premiere, ou null (lecture seule, page pas encore ecrite).
   */
  async insertPages(pages: Page[]): Promise<number | null> {
    if (this.locked() || !pages.length) return null;
    if (!(await this.readyToRenumber("import"))) return null;
    const first = this.current + 1;
    await this.serial(async () => {
      for (let i = 0; i < pages.length; i++) {
        const made = await this.host.repo.createPage(this.notebook, this.divider, first + i, pages[i]);
        this.shiftNumbers(made, +1);
      }
    });
    this.current = first;
    this.host.rememberPage?.(this.notebook, this.divider, first);
    await this.render();
    this.revealCurrent();
    this.host.onDirty();
    return first;
  }

  /**
   * Texte tape qui deborde d'une page de PDF : la page ne deborde jamais (la
   * suite du sujet est sur la page d'apres). La derniere frappe est defaite
   * et on dit pourquoi ; l'encre est deja bornee au bas de la feuille.
   */
  private pdfPageFull(loaded: LoadedPage): void {
    // Le texte remis passe par setBodyText, qui revient ici : une seule fois.
    if (this.pdfReverting) return;
    const prev = loaded.prevText;
    const recent = loaded.editedAt !== undefined && performance.now() - loaded.editedAt < FLOW_EDIT_MS;
    if (prev && recent && prev.content !== (this.bodyText(loaded.page)?.content ?? "")) {
      this.pdfReverting = true;
      try {
        this.setFlowText(loaded, prev.content);
        if (prev.caret !== null) loaded.doc.setCaretOffset(prev.caret);
      } finally {
        this.pdfReverting = false;
      }
      loaded.prevText = undefined;
      this.fitSheet(loaded);
      this.queueSave(loaded);
    }
    loaded.editedAt = undefined;
    toast("Page du PDF pleine : le texte tapé s'arrête au bas de la feuille. "
      + "Pour continuer, insère une page après (Ctrl+Maj+N).", "warn", 4000, undefined, "pdf-full");
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
      `La page ${n} de ${dividerLabel(this.divider)} part à la corbeille et les suivantes sont renumérotées. `
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
    if (mode === "scroll") this.revealPage(this.current);
  }

  get paper(): PaperKind { return this.paperKind; }

  /**
   * Fond de page de l'intercalaire (D12) : repeint les pages affichees, sans
   * les relire, et le retient dans cahier.json (sauf en lecture seule).
   */
  async setPaper(kind: PaperKind): Promise<void> {
    this.paperKind = kind;
    for (const p of this.list) p.surface?.setPaper(kind);
    if (!this.readOnly) await this.host.repo.setPaper(this.notebook, this.divider, kind);
  }

  /* ---------------- zoom (lot 11) ---------------- */

  get zoomLevel(): number { return this.zoom; }

  zoomIn(): void { this.setZoom(stepZoom(this.zoom, 1)); }
  zoomOut(): void { this.setZoom(stepZoom(this.zoom, -1)); }

  /**
   * Change le zoom en gardant sous `focus` (point de l'ecran ; le centre de
   * la vue par defaut) le meme point de la page. Le rendu net de l'encre se
   * fait ici, une fois.
   */
  setZoom(z: number, focus?: Pt, anchor?: { page: LoadedPage; at: Pt } | null): void {
    const next = clampZoom(z);
    const view = this.root.getBoundingClientRect();
    const target = focus ?? { x: view.left + view.width / 2, y: view.top + Math.min(view.height / 2, 300) };
    const a = anchor === undefined ? this.anchorUnder(target) : anchor;
    if (next !== this.zoom) {
      this.zoom = next;
      this.relayout();
      if (a && this.list.includes(a.page)) {
        const r = a.page.sheet.getBoundingClientRect();
        const d = scrollToAnchor(a.at, { x: r.left, y: r.top }, r.width / PAGE_W, target);
        this.root.scrollLeft += d.dx;
        this.root.scrollTop += d.dy;
      }
      this.refreshDensity();
    }
    this.paintZoomChip();
  }

  private paintZoomChip(): void {
    this.zoomChip.textContent = zoomLabel(this.zoom);
    this.zoomChip.style.display = this.zoom === 1 ? "none" : "";
  }

  /** Feuille sous un point de l'ecran (la plus proche en hauteur) et le point de page vise. */
  private anchorUnder(pt: Pt): { page: LoadedPage; at: Pt } | null {
    let best: LoadedPage | null = null;
    let bestD = Infinity;
    for (const p of this.list) {
      const r = p.sheet.getBoundingClientRect();
      const d = pt.y < r.top ? r.top - pt.y : pt.y > r.bottom ? pt.y - r.bottom : 0;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return null;
    const r = best.sheet.getBoundingClientRect();
    if (!r.width) return null;
    return { page: best, at: anchorAt(pt, { x: r.left, y: r.top }, r.width / PAGE_W) };
  }

  /** Debut d'un geste : position de chaque element de la vue, sans transformation. */
  private beginGesture(focus: Pt): void {
    if (this.gesture) return;
    const boxes: { node: HTMLElement; x: number; y: number }[] = [];
    for (const c of Array.from(this.root.children) as HTMLElement[]) {
      const r = c.getBoundingClientRect();
      boxes.push({ node: c, x: r.left, y: r.top });
    }
    this.gesture = { focus, anchor: this.anchorUnder(focus), boxes, scale: 1, dx: 0, dy: 0 };
  }

  /** Apercu du geste, a la frame : transformation CSS, l'encre n'est pas repeinte. */
  private previewGesture(scale: number, dx: number, dy: number): void {
    const g = this.gesture;
    if (!g) return;
    // Bornes 50-300 % des l'apercu : la feuille ne grossit pas au-dela de
    // ce qu'elle sera au lacher.
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * scale));
    g.scale = z / this.zoom; g.dx = dx; g.dy = dy;
    if (this.previewRaf) return;
    this.previewRaf = requestAnimationFrame(() => {
      this.previewRaf = 0;
      const cur = this.gesture;
      if (!cur) return;
      for (const b of cur.boxes) {
        const t = previewTransform(cur.focus, b, cur.scale, cur.dx, cur.dy);
        b.node.style.transformOrigin = t.origin;
        b.node.style.transform = t.transform;
      }
    });
  }

  /** Fin du geste : transformations retirees, zoom applique et rendu net, dans la meme frame. */
  private endGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (this.previewRaf) { cancelAnimationFrame(this.previewRaf); this.previewRaf = 0; }
    for (const b of g.boxes) { b.node.style.transform = ""; b.node.style.transformOrigin = ""; }
    const target = { x: g.focus.x + g.dx, y: g.focus.y + g.dy };
    const z = clampZoom(this.zoom * g.scale);
    if (z === this.zoom) {
      // Zoom inchange (petit pinch) : le deplacement des doigts reste un defilement.
      this.root.scrollLeft -= g.dx;
      this.root.scrollTop -= g.dy;
      return;
    }
    this.setZoom(z, target, g.anchor);
  }

  /**
   * Pinch a deux doigts, Ctrl+molette (et pinch du pave tactile, que
   * Windows envoie comme Ctrl+molette), defilement au doigt hors des
   * feuilles. Les doigts sont lus en capture, avant la feuille : le second
   * doigt n'arrive jamais au canvas (pas de defilement parasite).
   */
  private watchZoomGestures(): void {
    const root = this.root;
    root.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      // Sinon le WebView2 zoomerait toute l'interface.
      e.preventDefault();
      if (!this.list.length) return;
      if (!this.gesture) this.beginGesture({ x: e.clientX, y: e.clientY });
      const g = this.gesture!;
      this.previewGesture(g.scale * wheelFactor(e.deltaY, e.deltaMode), 0, 0);
      if (this.wheelTimer) clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => { this.wheelTimer = null; this.endGesture(); }, 220);
    }, { passive: false });

    const pt = (e: PointerEvent): Pt => ({ x: e.clientX, y: e.clientY });
    const capture = (id: number) => { try { root.setPointerCapture(id); } catch { /* deja relache */ } };
    root.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      this.touches.set(e.pointerId, pt(e));
      if (this.pinch) { e.stopPropagation(); e.preventDefault(); return; }
      if (this.touches.size !== 2 || !this.list.length) return;
      // Stylet ou souris en train d'ecrire : pas de pinch. Un trait commence
      // au doigt (sans stylet) est abandonne par cancelPan.
      if (this.list.some((p) => p.surface?.busyPen)) return;
      const ids = [...this.touches.keys()] as [number, number];
      const start: [Pt, Pt] = [this.touches.get(ids[0])!, this.touches.get(ids[1])!];
      this.pinch = { ids, start };
      for (const p of this.list) p.surface?.cancelPan();
      this.rootPan = null;
      for (const id of ids) capture(id);
      this.beginGesture(mid(start));
      e.stopPropagation();
      e.preventDefault();
    }, { capture: true });
    root.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "touch" || !this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, pt(e));
      const pinch = this.pinch;
      if (!pinch) return;
      e.stopPropagation();
      e.preventDefault();
      if (!pinch.ids.includes(e.pointerId)) return;
      const now: [Pt, Pt] = [this.touches.get(pinch.ids[0])!, this.touches.get(pinch.ids[1])!];
      const p = pinchOf(pinch.start, now);
      this.previewGesture(p.scale, p.dx, p.dy);
    }, { capture: true });
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      this.touches.delete(e.pointerId);
      const pinch = this.pinch;
      if (!pinch) return;
      e.stopPropagation();
      if (!pinch.ids.includes(e.pointerId)) return;
      this.pinch = null;
      this.endGesture();
    };
    root.addEventListener("pointerup", up, { capture: true });
    root.addEventListener("pointercancel", up, { capture: true });

    // Un doigt hors des feuilles (marges, bandeaux, numeros) : la vue n'a
    // plus de geste natif (touch-action: none, sinon le WebView2 zoomerait
    // toute l'interface au pinch), on defile donc ici. La capture ne vient
    // qu'apres 8 px : un appui sur un bouton reste un clic.
    root.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || this.pinch) return;
      if ((e.target as Element).closest?.("canvas, .text-doc")) return;
      const tracker = new VelocityTracker();
      tracker.add(e.timeStamp, e.clientX, e.clientY);
      this.rootPan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: root.scrollLeft, top: root.scrollTop, moved: false, tracker };
    });
    root.addEventListener("pointermove", (e) => {
      const pan = this.rootPan;
      if (!pan || pan.id !== e.pointerId) return;
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      pan.tracker.add(e.timeStamp, e.clientX, e.clientY);
      if (!pan.moved) {
        if (Math.hypot(dx, dy) < 8) return;
        pan.moved = true;
        capture(e.pointerId);
      }
      root.scrollLeft = pan.left - dx;
      root.scrollTop = pan.top - dy;
    });
    // Doigt lache en mouvement : la page continue sur sa lancee (core/kinetic.ts).
    const panEnd = (e: PointerEvent) => {
      const pan = this.rootPan;
      if (pan?.id !== e.pointerId) return;
      this.rootPan = null;
      if (!pan.moved || e.type !== "pointerup") return;
      const v = pan.tracker.velocity(e.timeStamp);
      flingScroll(root, -v.vx, -v.vy);
    };
    root.addEventListener("pointerup", panEnd);
    root.addEventListener("pointercancel", panEnd);
  }

  /**
   * Export Word (src/ui/docx-export.ts) : ce qui attend est ecrit, puis les
   * pages en memoire de la vue, avec leur texte a l'ecran (mesure des
   * lignes). Les autres pages sont relues sur le disque par l'export.
   */
  async docxSources(): Promise<{ current: number; pages: { number: number; page: Page; root: HTMLElement; sheet: HTMLElement }[] }> {
    await this.flush();
    const shown = this.list.filter((p) => !p.dead && !p.copy);
    await Promise.all(shown.map((p) => p.doc.imagesReady().catch(() => undefined)));
    return { current: this.current, pages: shown.map((p) => ({ number: p.number, page: p.page, root: p.doc.root, sheet: p.sheet })) };
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
    host.style.setProperty("--nb", this.root.style.getPropertyValue("--nb"));
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
      const ready = async (root: ParentNode, pages: LoadedPage[]) => {
        await Promise.all(pages.map((p) => p.doc.imagesReady()));
        await Promise.all([...root.querySelectorAll("img")].map((img) =>
          img.src ? img.decode().catch(() => undefined) : undefined));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      };
      if (Math.max(this.list.length, this.slots.length) > 3) toast("Préparation du PDF…", "info", 2000);
      if (this.slots.length) {
        // Defilement virtualise : chaque page est montee, mise en feuilles,
        // puis demontee aussitot. 100 pages ne sont jamais en memoire ensemble.
        const gen = this.renderGen;
        for (const s of [...this.slots]) {
          const p = await this.mountSlot(s, gen);
          if (gen !== this.renderGen) break;
          if (!p) continue;
          await ready(p.wrap, [p]);
          const sheets = await this.printSheets(p, urls);
          p.wrap.after(...sheets);
          this.unmountSlot(s);
        }
      } else {
        await ready(this.root, this.list);
        // Chaque page devient une ou plusieurs feuilles A4 imprimees a part
        // (clones), l'encre rendue en densite 3 et decoupee par feuille.
        for (const p of this.list) {
          const sheets = await this.printSheets(p, urls);
          p.wrap.after(...sheets);
        }
      }
      for (const p of this.list) p.wrap.classList.add("print-src");
      document.title = scope === "current"
        ? `${this.notebook} - ${this.divider.replace(/\//g, " - ")} p. ${prevPage}`
        : `${this.notebook} - ${this.divider.replace(/\//g, " - ")}`;
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
      if (prevMode === "scroll") this.revealPage(prevPage);
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
    // Page paginee (A4) : une feuille, jamais coupee ; ancienne page longue :
    // decoupage d'avant (core/print.ts).
    const plan = planPrint(H, numH, hard, soft, !p.long && !isLongPage(p.surface?.height ?? 0));

    // Encre en densite 3, le temps de copier les tranches, puis retour a
    // la densite de l'ecran (une page en densite 3 pese ~30 Mo).
    const canvas = sheet.querySelector("canvas");
    this.fitSheet(p, true, 3);
    // Page de PDF : rendue en densite 3 avant la copie des tranches.
    await this.pdfLayer.ensure(p);
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
    // Rendu en densite 3 rendu tout de suite (100 pages d'un poly a l'export).
    this.pdfLayer.drop(p);

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
    // Defilement virtualise : la page lointaine est construite d'abord.
    await this.ensureMounted(pageNumber);
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
    // Page de PDF : le mot cherche, retrouve dans le texte du document.
    let pdfBox: Bounds | null = null;
    if (block?.type === "pdf") {
      pdfBox = await this.pdfLayer.locate(loaded.page, terms);
      if (!pdfBox) { loaded.wrap.scrollIntoView({ block: "start" }); return; }
    }
    if (block?.type === "text" && !block.rect && terms.length && loaded.doc.revealText(terms)) return;
    let rect = pdfBox ?? block?.rect;
    // Mot manuscrit reconnu : son cadre sur la page.
    if (!rect && block?.type === "ink" && terms.length) {
      rect = block.words?.find((w) => w.box && terms.some((t) => fold(w.label).text.includes(t)))?.box;
    }
    // Sans bloc (lien vers une page) : le haut de la page, pas son milieu.
    if (!rect) { loaded.wrap.scrollIntoView({ block: blockId ? "center" : "start" }); return; }
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
    this.editSeq++;
    loaded.editedAt = performance.now();
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
    const flow = dir === "undo" ? this.flowUndoFor() : null;
    if (flow) { void this.undoFlow(flow); return; }
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
      if (dir === "redo") { if (loaded.long) growForStroke(loaded.page, entry.stroke); }
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
    // La selection suit ses traits (deplacement annule) ; partie avec eux sinon.
    if (this.sel?.loaded === loaded) this.select(loaded, this.sel.ids);
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
      const external: [LoadedPage, WriteOutcome][] = [];
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        try {
          const out = await this.host.repo.writePage(this.notebook, this.divider, p.number, p.page);
          if (out.kind !== "written" || out.n !== p.number) external.push([p, out]);
        } catch (e) {
          error = errorText(e);
          // R4 : au premier echec on s'arrete. Cette page et les suivantes
          // repartent en tete de file, dans leur ordre (la page d'arrivee
          // d'un debordement avant celle d'avant) ; une frappe arrivee
          // pendant l'ecriture garde sa version, plus recente.
          const newer = new Map(this.pendingSave);
          this.pendingSave.clear();
          for (const q of pending.slice(i)) this.pendingSave.set(q.page.id, newer.get(q.page.id) ?? q);
          for (const [id, q] of newer) if (!this.pendingSave.has(id)) this.pendingSave.set(id, q);
          break;
        }
      }
      // Fichiers changes ailleurs : la vue se met a jour hors de la file d'E/S.
      if (external.length) setTimeout(() => void this.afterExternal(external), 0);
      const before = this.saveError;
      this.saveError = error;
      if (error) {
        if (!before) toast(`Écriture impossible : ${error}. Nouvel essai dans 3 s.`, "err", 6000);
        if (!this.saveTimer) this.saveTimer = setTimeout(() => void this.flush(), 3000);
      } else if (before) {
        toast("Enregistrement rétabli");
      }
      this.host.onDirty();
      // Pages ecrites : celles loin de l'ecran peuvent maintenant etre demontees.
      this.scheduleWindow();
    });
  }

  get hasUnsaved(): boolean { return this.pendingSave.size > 0; }

  /* ---------------- changements faits ailleurs (OneDrive, autre PC) ---------------- */

  /**
   * Suite d'ecritures qui ont trouve le fichier change sur le disque (R1,
   * Repo.writePage) : l'encre venue d'ailleurs rejoint la page, ou la page
   * est relue (sa version a nous est dans une copie de conflit). Jamais
   * appele depuis la file d'E/S (render et flush y passent).
   */
  private async afterExternal(list: [LoadedPage, WriteOutcome][]): Promise<void> {
    let rerender = false;
    let copies = false;
    for (const [p, out] of list) {
      const label = `Page ${out.n}`;
      if (out.n !== p.number && !p.dead) rerender = true;
      if (out.kind === "merged") {
        if (!p.dead && out.added) {
          const r = mergeInk(p.page, out.disk);
          if (r.added) {
            p.page.blocks = r.blocks;
            if (r.height != null) p.page.height = r.height;
            this.fitSheet(p);
            this.paintStrokes(p);
            this.paintOverlay(p);
            this.resumePending(p);
          }
        }
        if (out.added) toast(`${label} modifiée sur l'autre PC : son encre a rejoint la tienne, rien n'est perdu.`, "info", 7000);
      } else if (out.kind === "replaced") {
        if (!p.dead) await this.reloadPage(p);
        toast(`${label} modifiée sur l'autre PC : sa version est gardée et ton encre y est ajoutée.`, "info", 8000);
      } else if (out.kind === "conflict") {
        copies = true;
        if (!out.page) rerender = true;
        else if (!p.dead) await this.reloadPage(p);
        toast(`${label} modifiée ailleurs pendant que tu écrivais : ta version est gardée dans la copie `
          + `${out.copy} (bandeau « Autre version » de la page), la page montre celle du disque.`, "warn", 12000);
      }
    }
    if (rerender) {
      await this.render();
    } else if (copies) {
      this.conflicts = await this.host.repo.listConflicts(this.notebook, this.divider).catch(() => this.conflicts);
      for (const p of this.list) if (!p.dead) this.paintNotes(p);
      this.paintViewNotes();
    }
    if (copies) this.host.onConflictsChanged?.();
  }

  /**
   * Relit une page du disque a la place de celle affichee. Ce qui a ete
   * modifie depuis la derniere ecriture (rare : une frappe pendant
   * l'ecriture) part d'abord dans une copie de conflit : rien ne se perd.
   */
  private async reloadPage(p: LoadedPage): Promise<void> {
    if (p.dead) return;
    if (this.pendingSave.has(p.page.id)) {
      this.pendingSave.delete(p.page.id);
      await this.serial(() => this.host.repo.writeConflictCopy(this.notebook, this.divider, p.number, p.page))
        .catch((e) => toast(`Copie de conflit impossible : ${errorText(e)}`, "err", 8000));
    }
    this.history.drop(p.page.id);
    if (this.sel?.loaded === p) this.clearSelection();
    if (this.viewMode === "pages") {
      await this.render();
      return;
    }
    const s = this.slots.find((x) => x.loaded === p);
    if (!s) return;
    this.diskEpoch++;
    this.unmountSlot(s);
    await this.mountSlot(s, this.renderGen);
  }

  /** Retour sur la fenetre (focus, onglet visible) : pages changees ailleurs relues. */
  private onWindowBack = (): void => {
    if (document.visibilityState === "hidden") return;
    if (this.externalTimer) clearTimeout(this.externalTimer);
    this.externalTimer = setTimeout(() => { this.externalTimer = null; void this.checkExternal(); }, 300);
  };
  private externalTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Pages montees sans modification en attente dont le fichier a change sur
   * le disque (OneDrive a pose la version de l'autre PC) : relues. Une page
   * en cours d'ecriture (trait, formule, ecriture en file) n'est pas touchee :
   * son ecriture verra le changement et fusionnera (R1).
   */
  async checkExternal(): Promise<number> {
    if (this.flowing || this.peek || !this.root.isConnected) return 0;
    const changed: LoadedPage[] = [];
    for (const p of [...this.list]) {
      if (p.dead || p.copy || this.pendingSave.has(p.page.id)) continue;
      if (p.surface?.busyPen || p.doc.editingFormula) continue;
      try {
        if (await this.host.repo.diskChanged(this.notebook, this.divider, p.number, p.page)) changed.push(p);
      } catch { /* fichier tenu : au prochain retour */ }
    }
    let done = 0;
    for (const p of changed) {
      if (p.dead || this.pendingSave.has(p.page.id) || this.flowing) continue;
      await this.reloadPage(p);
      done++;
    }
    if (done) {
      this.conflicts = await this.host.repo.listConflicts(this.notebook, this.divider).catch(() => this.conflicts);
      for (const p of this.list) if (!p.dead) this.paintNotes(p);
      this.paintViewNotes();
      toast(done > 1
        ? `${done} pages modifiées ailleurs (OneDrive) : relues.`
        : `Page ${changed[0].number} modifiée ailleurs (OneDrive) : relue.`, "info", 5000);
    }
    return done;
  }

  /* ---------------- versions de la page ---------------- */

  /** Page visee par « Versions de la page… » : la page courante. */
  private versionTarget(): LoadedPage | null {
    return this.list.find((p) => p.number === this.current && !p.dead && !p.copy) ?? null;
  }

  /**
   * Versions gardees de la page courante (la plus recente d'abord), ou null
   * sans page. API pour src/ui/versions.ts.
   */
  async listVersions(): Promise<{ page: number; versions: PageVersion[] } | null> {
    const p = this.versionTarget();
    if (!p) return null;
    return { page: p.number, versions: await this.host.repo.listVersions(this.notebook, p.page.id) };
  }

  /**
   * Restaure une version de la page courante : sa version actuelle est
   * d'abord ecrite puis gardee dans les versions, rien n'est perdu.
   */
  async restoreVersion(file: string): Promise<boolean> {
    if (this.locked()) return false;
    const p = this.versionTarget();
    if (!p) return false;
    if (p.readOnly) { toast("Page en lecture seule : restauration impossible ici", "warn", 6000); return false; }
    await this.flush();
    if (this.pendingSave.has(p.page.id)) {
      toast("La page attend encore d'être écrite : restauration reportée", "err", 6000);
      return false;
    }
    try {
      const { outcome } = await this.serial(() =>
        this.host.repo.restoreVersion(this.notebook, this.divider, p.number, p.page, file));
      await this.reloadPage(p);
      if (outcome.kind === "conflict") {
        toast(`La page avait changé sur le disque : la version restaurée est dans la copie ${outcome.copy}.`, "warn", 9000);
      } else {
        toast("Version restaurée. La page d'avant est gardée dans les versions.", "info", 6000);
      }
      return true;
    } catch (e) {
      toast(`Restauration impossible : ${errorText(e)}`, "err", 6000);
      return false;
    }
  }

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

/** Photos, calculs et courbes poses dans un texte (jeton img:). */
function imageIdsOf(text: string): string[] {
  return parseDoc(text).flatMap((t) => (t.kind === "image" ? [t.id] : []));
}

/** Texte tape d'une page qui n'est pas affichee (pagination). */
function setPageText(page: Page, text: string): void {
  let body = page.blocks.find((b): b is TextBlock => b.type === "text" && !b.rect);
  if (!body) {
    if (!text) return;
    body = { id: uuid(), type: "text", content: "" };
    page.blocks.push(body);
  }
  body.content = text;
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

