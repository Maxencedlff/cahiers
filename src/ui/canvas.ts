import type { InkColor, InkPoint, Stroke, ToolKind } from "../core/types";
import { colorOf } from "../core/palette";
import {
  newStroke, simplify, cachedBounds, strokeHitsCircle, unionBounds, padBounds,
  widthAt, boundsIntersect, roundPoint, HIGHLIGHT_FACTOR, type Bounds,
} from "../core/ink/stroke";
import { PAGE_W, PAGE_H } from "../core/ink/sheet";
import { gestureTool, isPalm } from "../core/ink/pointer";
import { paperLines, paperDots, PAPER_STYLE, DOT_STYLE, type PaperKind } from "../core/paper";
import {
  applyBounds, clampMove, resizeTransform, splitStroke, translation, isIdentity, polygonBounds,
  type Pt, type Transform,
} from "../core/ink/selection";
import { uuid } from "../core/id";

/** Unites de page. Rapport proche d'une feuille A4 en portrait. */
export { PAGE_W, PAGE_H };

export type PointerRole = "write" | "navigate" | "ignore";
export type SurfaceTool = ToolKind | "region" | "textregion" | "lasso" | "space";
export type EraserMode = "stroke" | "precise";

/** Poignee d'angle de la selection : 44 px a l'ecran, a tout zoom (section 3). */
const HANDLE_PX = 44;
/** Marge du cadre de selection autour des traits, en unites de page. */
const SEL_PAD = 6;

/** Rayon de la gomme, en unites de page. */
const ERASER_R = 12;
/** Opacite du surligneur, appliquee une seule fois par trait. */
const HIGHLIGHT_ALPHA = 0.4;

export interface InkSurfaceOptions {
  /** Appele quand un trait est termine. */
  onStrokeEnd: (stroke: Stroke) => void;
  /** Debut d'un geste de gomme : une seule entree d'annulation par geste. */
  onEraseStart?: () => void;
  /**
   * Appele quand la gomme a retire des traits. `split` (gomme precise) :
   * chaque trait touche et ses morceaux restants (nouveaux ids, liste vide
   * si tout est parti).
   */
  onErase: (removedIds: string[], split?: Map<string, Stroke[]>) => void;
  /** Gomme au trait entier ou precise (encre-14), lue au debut du geste. */
  getEraserMode?: () => EraserMode;
  /** Lasso referme : la vue choisit les traits (core/ink/selection.ts). */
  onLasso?: (poly: Pt[]) => void;
  /** Appui hors de la selection avec le lasso : elle tombe. */
  onSelectionCleared?: () => void;
  /** Premier mouvement d'un deplacement, d'un retaillage ou d'un espace. */
  onTransformStart?: () => void;
  /** Fin du geste : la vue applique la transformation aux blocs. */
  onTransform?: (ids: Set<string>, t: Transform, kind: "move" | "resize" | "space") => void;
  /**
   * Insertion d'espace : traits sous la ligne y, et borne du deplacement
   * vers le haut (core/ink/selection.ts strokesBelow, clampSpace).
   */
  spaceBelow?: (y: number) => { ids: Set<string>; clamp: (dy: number) => number };
  /** Zone rectangulaire tracee au lasso "selection math" ou "zone texte". */
  onRegion?: (bounds: Bounds, tool: "region" | "textregion") => void;
  getTool: () => SurfaceTool;
  getColor: () => InkColor;
  getWidth: () => number;
  /**
   * Ce que fait le doigt. Deduit automatiquement quand un stylet a ete vu
   * (il navigue alors), reglable a la main sinon : c'est le chemin de
   * secours de la section 3, pour une machine sans stylet.
   */
  touchRole: () => Exclude<PointerRole, "ignore">;
}

/**
 * Derniere activite du stylet (survol, contact, lever), partagee par toutes
 * les pages. Ecoutee sur la fenetre : la couche texte couvre le canvas, il
 * ne voit donc pas le survol.
 */
let lastPenAt = -Infinity;
let penWatched = false;
function watchPen(): void {
  if (penWatched || typeof window === "undefined") return;
  penWatched = true;
  const note = (e: PointerEvent) => { if (e.pointerType === "pen") lastPenAt = e.timeStamp; };
  for (const t of ["pointerdown", "pointermove", "pointerup"] as const) {
    window.addEventListener(t, note, { capture: true, passive: true });
  }
}

/**
 * Surface d'encre.
 *
 * Deux points sensibles de la specification :
 *  - section 3 : la separation pen / touch / mouse donne le rejet de paume
 *    gratuitement, sans code dedie ;
 *  - section 9 : dirty-rect obligatoire, on ne repeint jamais toute la page
 *    a chaque mouvement de stylet. C'est le premier poste de consommation.
 */
export class InkSurface {
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  /**
   * Traits caches sous un mot tape (rendu propre). Invisibles, mais la gomme
   * les atteint : frotter le mot tape efface son encre, donc le mot.
   */
  private hidden: Stroke[] = [];
  private live: Stroke | null = null;
  private liveLast: InkPoint | null = null;
  private startedAt = 0;
  private dirty: Bounds | null = null;
  private raf = 0;
  private scale = 1;
  private dpr = 1;
  /** Largeur CSS et hauteur logique du dernier dimensionnement. */
  private cssWidth = 0;
  private pageH = PAGE_H;
  private activePointer: number | null = null;
  private activeType = "";
  /**
   * Outil du geste en cours, fige au pointerdown : un Alt+G en plein trait
   * ne change plus l'outil au milieu, et le bout gomme reste une gomme.
   */
  private tool: SurfaceTool | null = null;
  private eraserPos: { x: number; y: number } | null = null;
  /** Apercu de la gomme au survol (stylet ou souris), avant le contact. */
  private hoverPos: { x: number; y: number } | null = null;
  private regionStart: { x: number; y: number } | null = null;
  private regionNow: { x: number; y: number } | null = null;
  /** Gomme precise pour le geste en cours (lue au pointerdown). */
  private precise = false;
  /** Trace du lasso en cours, en unites de page. */
  private lasso: Pt[] | null = null;
  /** Selection affichee (cadre pointille + poignee), bornes sans marge. */
  private selection: { ids: Set<string>; bounds: Bounds } | null = null;
  /**
   * Apercu d'un deplacement : ces traits sont peints transformes, sans
   * toucher au modele avant la fin du geste (une seule entree d'annulation,
   * ids inchanges).
   */
  private preview: { ids: Set<string>; t: Transform } | null = null;
  /** Geste de selection en cours : deplacer, retailler, inserer de l'espace. */
  private drag: {
    kind: "move" | "resize" | "space"; start: Pt; ids: Set<string>; bounds: Bounds;
    started: boolean; clamp?: (dy: number) => number;
  } | null = null;
  private disposed = false;
  /**
   * Couleur de fond peinte dans le canvas.
   *
   * `desynchronized: true` court-circuite le compositeur pour gagner en
   * latence, mais sous WebView2 le canvas perd alors sa transparence et
   * s'affiche en noir. On peint donc le fond de la page nous-memes plutot
   * que de compter dessus : la latence est gardee, la feuille est blanche.
   */
  private paperColor = "#fffffe";
  /**
   * Fond de page (D12) : lignes, carreaux ou points, peints avec le papier
   * sous les traits, dans la seule zone sale.
   */
  private paper: PaperKind = "uni";
  /** Defilement au doigt, pris en charge ici faute de geste natif. */
  private pan: {
    pointerId: number; startX: number; startY: number; startLeft: number; startScroll: number;
  } | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private opts: InkSurfaceOptions,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) throw new Error("Canvas 2D indisponible");
    this.ctx = ctx;
    watchPen();
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
    canvas.addEventListener("pointerleave", this.onUp);
    // Le stylet ne doit jamais declencher le menu contextuel d'un appui long.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onUp);
    // Libere tout de suite la memoire du canvas (4 a 10 Mo par page).
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  setStrokes(strokes: Stroke[], hidden: Stroke[] = []): void {
    this.strokes = strokes;
    this.hidden = hidden;
    this.preview = null;
    this.repaintAll();
  }

  /* ---------------- selection (lasso) ---------------- */

  /** Montre la selection (bornes des traits, sans marge), ou rien. */
  setSelection(ids: Set<string> | null, bounds?: Bounds): void {
    if (this.selection) this.markDirty(this.selectionZone(this.selection.bounds));
    this.selection = ids && ids.size && bounds ? { ids, bounds } : null;
    if (this.selection) this.markDirty(this.selectionZone(this.selection.bounds));
  }

  get hasSelection(): boolean { return this.selection !== null; }

  /** Cadre de selection affiche (marge comprise), apercu du geste applique. */
  selectionFrame(): Bounds | null {
    if (!this.selection) return null;
    const b = this.preview ? applyBounds(this.preview.t, this.selection.bounds) : this.selection.bounds;
    return padBounds(b, SEL_PAD);
  }

  /** Taille de la poignee en unites de page (44 px a l'ecran). */
  private handleUnits(): number {
    const r = this.canvas.getBoundingClientRect();
    const k = r.width > 0 ? r.width / PAGE_W : this.scale || 1;
    return HANDLE_PX / k;
  }

  /** Zone a repeindre pour un cadre : cadre, poignee et epaisseur du trait. */
  private selectionZone(b: Bounds): Bounds {
    return padBounds(b, SEL_PAD + this.handleUnits() / 2 + 4);
  }

  /** Ce que touche un appui : la poignee, le cadre, ou rien. */
  private hitSelection(p: Pt): "resize" | "move" | null {
    const f = this.selectionFrame();
    if (!f) return null;
    const h = this.handleUnits() / 2;
    if (Math.abs(p.x - (f.x + f.w)) <= h && Math.abs(p.y - (f.y + f.h)) <= h) return "resize";
    if (p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) return "move";
    return null;
  }

  /** Abandonne un geste de selection (Echap, page quittee). */
  cancelSelectionGesture(): void {
    if (this.lasso) { this.markDirty(padBounds(polygonBounds(this.lasso), 4)); this.lasso = null; }
    if (this.drag) { this.drag = null; this.preview = null; this.repaintAll(); }
  }

  /** Hauteur logique actuelle du canvas, en unites de page. */
  get height(): number { return this.pageH; }

  /** Densite actuelle (pixels physiques par pixel CSS). */
  get density(): number { return this.dpr; }

  /** Change le fond de page et repeint (une fois, pas a chaque frame). */
  setPaper(kind: PaperKind): void {
    if (kind === this.paper) return;
    this.paper = kind;
    this.repaintAll();
  }

  /**
   * Redimensionne le canvas et redessine. `pageH` = hauteur logique de la
   * feuille : au-dela de l'A4 quand le texte ou l'encre la prolongent. Le
   * canvas couvre toujours toute la feuille, sinon l'encre ecrite dessous
   * n'aurait nulle part ou aller.
   */
  layout(cssWidth: number, pageH = PAGE_H, density?: number): void {
    const declared = getComputedStyle(this.canvas).getPropertyValue("--page-bg").trim();
    if (declared) this.paperColor = declared;
    // `density` : densite imposee (export PDF en densite 3, zoom : voir
    // core/zoom.ts inkDensity), sinon l'ecran.
    this.dpr = density ?? Math.min(window.devicePixelRatio || 1, 2);
    this.cssWidth = cssWidth;
    this.pageH = Math.max(PAGE_H, pageH);
    this.scale = cssWidth / PAGE_W;
    const cssH = Math.round(cssWidth * (this.pageH / PAGE_W));
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.height = `${cssH}px`;
    // Peint tout de suite, fond ET traits : sans cela la feuille reste
    // vide une frame, ce qui se voit a chaque agrandissement.
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = this.paperColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = { x: 0, y: 0, w: PAGE_W, h: this.pageH };
    this.flush();
  }

  /** Comme layout, mais seulement si la taille change (appele souvent). */
  fit(cssWidth: number, pageH: number, density?: number): void {
    const h = Math.max(PAGE_H, pageH);
    const d = density ?? Math.min(window.devicePixelRatio || 1, 2);
    if (cssWidth === this.cssWidth && h === this.pageH && this.dpr === d) return;
    this.layout(cssWidth, h, d);
  }

  /* ---------------- role du pointeur ---------------- */

  /**
   * pen ecrit, touch navigue, mouse fait les deux selon l'outil actif.
   * Tant qu'aucun stylet n'a ete vu, le doigt peut ecrire : c'est le chemin
   * de secours pour une machine sans digitizer.
   */
  roleOf(e: PointerEvent): PointerRole {
    if (e.pointerType === "pen") return "write";
    if (e.pointerType === "mouse") return "write";
    if (e.pointerType === "touch") return this.opts.touchRole();
    return "ignore";
  }

  /**
   * Point de l'ecran -> unites de page. L'echelle est lue sur la taille
   * reellement affichee (getBoundingClientRect) : le stylet tombe sous la
   * pointe a tout zoom, meme pendant l'apercu CSS d'un pinch.
   */
  private toPage(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const k = r.width > 0 ? r.width / PAGE_W : this.scale;
    return {
      x: (e.clientX - r.left) / k,
      y: (e.clientY - r.top) / k,
    };
  }

  /** Le stylet est-il en train d'ecrire (ou de gommer) sur cette page ? */
  private get penWriting(): boolean {
    return this.activePointer !== null && this.activeType === "pen";
  }

  /* ---------------- evenements ---------------- */

  /**
   * Pointeur recu par une couche posee au-dessus (le texte de la page) et
   * rendu a l'encre. La capture bascule sur le canvas : la suite du trait
   * y arrive directement.
   */
  forwardDown(e: PointerEvent): void {
    this.onDown(e);
  }

  private onDown = (e: PointerEvent) => {
    // Le doigt deplace une selection meme quand il navigue : c'est le geste
    // attendu au doigt, et sur le cadre il n'y a rien a faire defiler.
    const grab = this.selection && this.activePointer === null
      && (e.pointerType !== "mouse" || e.button === 0)
      && gestureTool(e, "lasso") !== "eraser"
      && !(e.pointerType === "touch" && isPalm(e.timeStamp, this.penWriting, lastPenAt))
      && (this.opts.getTool() === "lasso" || this.opts.getTool() === "space")
      ? this.hitSelection(this.toPage(e)) : null;
    if (this.roleOf(e) === "navigate" && !grab) {
      // Paume posee pendant ou juste apres un trait : elle ne fait pas
      // defiler la page sous la plume.
      if (!isPalm(e.timeStamp, this.penWriting, lastPenAt)) this.startPan(e);
      return;
    }
    if (this.roleOf(e) !== "write" && !grab) return;
    // Clic droit ou molette : jamais un trait. Le clic droit corrige un mot.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (this.activePointer !== null) return; // un seul pointeur ecrit a la fois
    const tool = gestureTool(e, this.opts.getTool());
    this.tool = tool;
    this.activePointer = e.pointerId;
    this.activeType = e.pointerType;
    if (e.pointerType === "pen") lastPenAt = e.timeStamp;
    // Un defilement au doigt deja lance s'arrete quand le stylet se pose.
    if (this.pan && e.pointerType === "pen") this.stopPan();
    this.capture(e.pointerId);
    e.preventDefault();
    this.clearHover();

    const p = this.toPage(e);

    if (grab && this.selection) {
      this.tool = "lasso";
      this.drag = {
        kind: grab, start: p, ids: this.selection.ids, bounds: this.selection.bounds, started: false,
      };
      return;
    }
    if (tool === "lasso") {
      if (this.selection) { this.opts.onSelectionCleared?.(); this.setSelection(null); }
      this.lasso = [p];
      return;
    }
    if (tool === "space") {
      const below = this.opts.spaceBelow?.(p.y);
      if (this.selection) { this.opts.onSelectionCleared?.(); this.setSelection(null); }
      this.drag = {
        kind: "space", start: p, ids: below?.ids ?? new Set(), bounds: { x: 0, y: p.y, w: PAGE_W, h: 0 },
        started: false, clamp: below?.clamp,
      };
      this.markDirty(this.spaceZone());
      return;
    }
    if (tool === "eraser") {
      this.precise = this.opts.getEraserMode?.() === "precise";
      this.opts.onEraseStart?.();
      this.moveEraser(p);
      this.eraseAt(p);
      return;
    }
    if (tool === "region" || tool === "textregion") {
      this.regionStart = p; this.regionNow = p; return;
    }

    this.startedAt = e.timeStamp;
    const base = this.opts.getWidth();
    const width = tool === "highlighter" ? Math.round(base * HIGHLIGHT_FACTOR * 10) / 10 : base;
    this.live = newStroke(this.opts.getColor(), width, tool);
    this.liveLast = null;
    this.addPoint(e, p);
  };

  private onMove = (e: PointerEvent) => {
    if (this.pan && e.pointerId === this.pan.pointerId) { this.movePan(e); return; }
    if (e.pointerId !== this.activePointer) return;
    const tool = this.tool;
    e.preventDefault();

    if (this.drag) { this.moveDrag(this.toPage(e)); return; }
    if (this.lasso) {
      const p = this.toPage(e);
      const last = this.lasso[this.lasso.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
      this.lasso.push(p);
      // Seul le nouveau segment (et la fermeture vers le depart) est repeint.
      this.markDirty(padBounds(polygonBounds([last, p, this.lasso[0]]), 3));
      return;
    }
    if (tool === "eraser") {
      const p = this.toPage(e);
      this.moveEraser(p);
      this.eraseAt(p);
      return;
    }
    if (tool === "region" || tool === "textregion") {
      const before = this.regionNow;
      this.regionNow = this.toPage(e);
      // Seuls l'ancien et le nouveau rectangle sont repeints, jamais la page.
      if (this.regionStart && before) {
        this.markDirty(unionBounds([
          padBounds(rectOf(this.regionStart, before), 3),
          padBounds(rectOf(this.regionStart, this.regionNow), 3),
        ]));
      }
      return;
    }
    if (!this.live) return;

    // getCoalescedEvents rend les points perdus entre deux frames :
    // sans ca un trait rapide devient un polygone.
    const events = "getCoalescedEvents" in e ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      this.addPoint(ev as PointerEvent, this.toPage(ev as PointerEvent));
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.pan && e.pointerId === this.pan.pointerId) {
      this.stopPan();
      return;
    }
    if (e.type === "pointerleave") this.clearHover();
    if (e.pointerId !== this.activePointer) return;
    const tool = this.tool;
    this.activePointer = null;
    this.activeType = "";
    this.tool = null;
    this.release(e.pointerId);

    if (this.drag) { this.endDrag(); return; }
    if (this.lasso) {
      const poly = this.lasso;
      this.lasso = null;
      this.markDirty(padBounds(polygonBounds(poly), 4));
      const b = polygonBounds(poly);
      if (poly.length >= 3 && (b.w > 4 || b.h > 4)) this.opts.onLasso?.(poly);
      return;
    }
    if (this.regionStart && this.regionNow) {
      const b = rectOf(this.regionStart, this.regionNow);
      this.regionStart = this.regionNow = null;
      this.markDirty(padBounds(b, 3));
      if (b.w > 12 && b.h > 12 && (tool === "region" || tool === "textregion")) {
        this.opts.onRegion?.(b, tool);
      }
      return;
    }
    if (this.eraserPos) {
      this.markDirty(circleBounds(this.eraserPos));
      this.eraserPos = null;
      return;
    }
    if (!this.live) return;

    const stroke = this.live;
    this.live = null;
    this.liveLast = null;
    if (stroke.points.length < 2) {
      // Un point isole reste un point : utile pour un accent ou une virgule.
      if (stroke.points.length === 1) {
        stroke.points.push({ ...stroke.points[0], x: stroke.points[0].x + 0.6 });
      } else {
        return;
      }
    }
    const before = cachedBounds(stroke, 2);
    stroke.points = simplify(stroke.points, 0.55);
    this.strokes.push(stroke);
    // Repeint le trait simplifie : l'aspect apres coup est celui du fichier.
    this.markDirty(before);
    this.opts.onStrokeEnd(stroke);
  };

  /**
   * Survol de la page (relaye par la feuille, car la couche texte couvre le
   * canvas). Avec la gomme, ou le bout gomme du stylet, un cercle montre ou
   * elle va frapper. null : le pointeur a quitte la feuille.
   */
  hover(e: PointerEvent | null): void {
    if (this.activePointer !== null) return;
    if (!e || e.buttons !== 0 && !(e.pointerType === "pen" && (e.buttons & 32))) {
      this.clearHover();
      return;
    }
    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
    const eraser = (e.pointerType === "pen" && (e.buttons & 32) !== 0)
      || this.opts.getTool() === "eraser";
    if (!eraser) { this.clearHover(); return; }
    const p = this.toPage(e);
    if (this.hoverPos) this.markDirty(circleBounds(this.hoverPos));
    this.hoverPos = p;
    this.markDirty(circleBounds(p));
  }

  private clearHover(): void {
    if (!this.hoverPos) return;
    this.markDirty(circleBounds(this.hoverPos));
    this.hoverPos = null;
  }

  /** La gomme avance : l'ancien cercle est efface, pas laisse en trainee. */
  private moveEraser(p: { x: number; y: number }): void {
    if (this.eraserPos) this.markDirty(circleBounds(this.eraserPos));
    this.eraserPos = p;
  }

  /**
   * Le canvas porte `touch-action: none` pour qu'un trait de stylet ne fasse
   * jamais defiler la page. Le doigt perd donc le defilement natif : on le
   * refait ici, sur le conteneur des pages.
   */
  private scroller(): HTMLElement | null {
    return this.canvas.closest(".pages");
  }

  private startPan(e: PointerEvent) {
    const box = this.scroller();
    if (!box) return;
    this.capture(e.pointerId);
    this.pan = {
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      startLeft: box.scrollLeft, startScroll: box.scrollTop,
    };
  }

  /**
   * Un pinch commence (PageView) : le defilement au doigt s'arrete net, et
   * un trait commence au doigt (machine sans stylet) est abandonne : c'etait
   * le premier doigt du pinch, pas de l'ecriture.
   */
  cancelPan(): void {
    this.stopPan();
    if (this.activePointer === null || this.activeType !== "touch") return;
    const id = this.activePointer;
    const live = this.live;
    const zone = live && live.points.length ? cachedBounds(live, 2) : null;
    this.activePointer = null;
    this.activeType = "";
    this.tool = null;
    this.live = null;
    this.liveLast = null;
    this.release(id);
    if (this.eraserPos) { this.markDirty(circleBounds(this.eraserPos)); this.eraserPos = null; }
    if (this.regionStart && this.regionNow) this.markDirty(padBounds(rectOf(this.regionStart, this.regionNow), 3));
    this.regionStart = this.regionNow = null;
    this.cancelSelectionGesture();
    if (zone) this.markDirty(zone);
  }

  /** Zone de l'apercu d'un espace : de la ligne au bas de la feuille. */
  private spaceZone(): Bounds {
    const d = this.drag;
    const y = d ? d.start.y + Math.min(0, this.preview?.t.dy ?? 0) : 0;
    return { x: 0, y: y - 4, w: PAGE_W, h: this.pageH - y + 8 };
  }

  private moveDrag(p: Pt): void {
    const d = this.drag!;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    let t: Transform;
    if (d.kind === "move") {
      const c = clampMove(d.bounds, dx, dy);
      // Pas sous le bas de la feuille non plus (pagination : une A4).
      t = translation(c.dx, Math.min(c.dy, Math.max(0, this.pageH - (d.bounds.y + d.bounds.h))));
    } else if (d.kind === "resize") {
      t = resizeTransform(d.bounds, dx, dy);
    } else {
      t = translation(0, d.clamp ? d.clamp(dy) : Math.max(0, dy));
    }
    if (!d.started) {
      // Un simple appui sur le cadre n'est pas un deplacement.
      if (Math.hypot(dx, dy) < 2) return;
      d.started = true;
      this.opts.onTransformStart?.();
    }
    const before = d.kind === "space" ? this.spaceZone() : this.selectionZone(this.selectionFrame() ?? d.bounds);
    this.preview = { ids: d.ids, t };
    const after = d.kind === "space" ? this.spaceZone() : this.selectionZone(this.selectionFrame() ?? d.bounds);
    this.markDirty(unionBounds([before, after]));
  }

  private endDrag(): void {
    const d = this.drag!;
    if (d.kind === "space") this.markDirty(this.spaceZone());
    this.drag = null;
    const t = this.preview?.t;
    if (!d.started || !t || isIdentity(t)) {
      this.preview = null;
      if (d.kind !== "space") this.markDirty(this.selectionZone(d.bounds));
      return;
    }
    // La vue applique la transformation aux blocs puis repeint (setStrokes
    // efface l'apercu) : une seule ecriture et une seule annulation.
    this.opts.onTransform?.(d.ids, t, d.kind);
  }

  /** Un trait ou une gomme au stylet ou a la souris est en cours. */
  get busyPen(): boolean {
    return this.activePointer !== null && this.activeType !== "touch";
  }

  private stopPan(): void {
    if (!this.pan) return;
    this.release(this.pan.pointerId);
    this.pan = null;
  }

  /** La capture est un confort, pas une condition : elle ne doit rien casser. */
  private capture(pointerId: number): void {
    try { this.canvas.setPointerCapture(pointerId); } catch { /* pointeur deja relache */ }
  }

  private release(pointerId: number): void {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
    } catch { /* deja relache */ }
  }

  private movePan(e: PointerEvent) {
    const box = this.scroller();
    if (!box || !this.pan) return;
    // Le stylet s'est pose pendant le geste : c'etait la paume.
    if (this.penWriting) { this.stopPan(); return; }
    e.preventDefault();
    box.scrollTop = this.pan.startScroll - (e.clientY - this.pan.startY);
    // Feuille zoomee plus large que la vue : le doigt la deplace aussi
    // de cote (sans largeur a defiler, scrollLeft reste a 0).
    box.scrollLeft = this.pan.startLeft - (e.clientX - this.pan.startX);
  }

  private addPoint(e: PointerEvent, p: { x: number; y: number }) {
    if (!this.live) return;
    // Borne en bas : le bas de la feuille (une A4, pagination automatique ;
    // une ancienne page longue garde sa hauteur). Le stylet n'ecrit jamais
    // hors de la feuille, la page ne s'allonge plus sous la main.
    const point = roundPoint({
      x: clamp(p.x, 0, PAGE_W),
      y: clamp(p.y, 0, this.pageH - this.live.width / 2),
      p: e.pressure > 0 ? e.pressure : 0.5,
      t: Math.max(0, e.timeStamp - this.startedAt),
      ...(e.tiltX || e.tiltY ? { tiltX: e.tiltX, tiltY: e.tiltY } : {}),
    });

    const prev = this.liveLast;
    // Sous le demi-pixel, le point n'apporte rien et coute du JSON.
    if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) < 0.4) return;
    this.live.points.push(point);

    if (this.live.tool === "highlighter") {
      // Le surligneur se peint d'un seul chemin, opacite appliquee une fois :
      // on repeint la zone du nouveau segment, trait entier compris.
      if (prev) {
        this.markDirty(padBounds(rectOf(prev, point), this.live.width / 2 + 2));
      }
    } else if (prev) {
      // Trace immediate du seul nouveau segment : aucun repaint global.
      this.drawSegment(this.live, prev, point);
    }
    this.liveLast = point;
  }

  private eraseAt(p: { x: number; y: number }) {
    if (this.precise) { this.cutAt(p); return; }
    const removed: string[] = [];
    const boxes: Bounds[] = [];
    this.strokes = this.strokes.filter((s) => {
      if (strokeHitsCircle(s, p.x, p.y, ERASER_R)) {
        removed.push(s.id);
        boxes.push(cachedBounds(s, 2));
        return false;
      }
      return true;
    });
    this.hidden = this.hidden.filter((s) => {
      if (strokeHitsCircle(s, p.x, p.y, ERASER_R)) { removed.push(s.id); return false; }
      return true;
    });
    if (removed.length) {
      if (boxes.length) this.markDirty(unionBounds(boxes));
      this.opts.onErase(removed);
    }
    this.markDirty(circleBounds(p));
  }

  /**
   * Gomme precise (encre-14) : le trait est coupe par le disque, les
   * morceaux restants prennent sa place avec de nouveaux ids.
   */
  private cutAt(p: { x: number; y: number }) {
    const split = new Map<string, Stroke[]>();
    const boxes: Bounds[] = [];
    const cut = (list: Stroke[]) => list.flatMap((s) => {
      const parts = splitStroke(s, p.x, p.y, ERASER_R, uuid);
      if (!parts) return [s];
      split.set(s.id, parts);
      boxes.push(cachedBounds(s, 2));
      return parts;
    });
    this.strokes = cut(this.strokes);
    this.hidden = cut(this.hidden);
    if (split.size) {
      this.markDirty(unionBounds(boxes));
      this.opts.onErase([...split.keys()], split);
    }
    this.markDirty(circleBounds(p));
  }

  /* ---------------- rendu ---------------- */

  /** Marque une zone a repeindre. Les zones s'accumulent jusqu'a la frame. */
  markDirty(b: Bounds): void {
    this.dirty = this.dirty ? unionBounds([this.dirty, b]) : b;
    this.schedule();
  }

  repaintAll(): void {
    this.markDirty({ x: 0, y: 0, w: PAGE_W, h: this.pageH });
  }

  private schedule() {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  /**
   * Repeint UNIQUEMENT la zone sale. Les traits qui n'y touchent pas ne sont
   * jamais reparcourus (bornes en cache) : sur une page chargee, c'est la
   * difference entre quelques traits et plusieurs milliers de points par frame.
   */
  private flush() {
    const d = this.dirty;
    if (!d || this.disposed) return;
    this.dirty = null;

    const k = this.scale * this.dpr;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const x = Math.max(0, Math.floor(d.x * k) - 2);
    const y = Math.max(0, Math.floor(d.y * k) - 2);
    const w = Math.min(this.canvas.width - x, Math.ceil(d.w * k) + 4);
    const h = Math.min(this.canvas.height - y, Math.ceil(d.h * k) + 4);
    if (w <= 0 || h <= 0) { ctx.restore(); return; }

    // Fond opaque plutot qu'un effacement : voir paperColor.
    ctx.fillStyle = this.paperColor;
    ctx.fillRect(x, y, w, h);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (this.paper !== "uni") this.drawPaper(ctx, x, y, w, h, k);
    ctx.scale(k, k);

    // Surligneurs d'abord, stylos ensuite : le surlignage passe sous
    // l'encre, meme pose apres elle.
    const zone: Bounds = { x: x / k, y: y / k, w: w / k, h: h / k };
    const marks: Stroke[] = [], pens: Stroke[] = [];
    const pv = this.preview;
    const moving: Stroke[] = [];
    for (const s of this.strokes) {
      if (pv && pv.ids.has(s.id)) { moving.push(s); continue; }
      if (boundsIntersect(cachedBounds(s, 1), zone)) (s.tool === "highlighter" ? marks : pens).push(s);
    }
    if (this.live) (this.live.tool === "highlighter" ? marks : pens).push(this.live);
    for (const s of marks) this.drawStroke(ctx, s);
    for (const s of pens) this.drawStroke(ctx, s);
    if (pv && moving.length) {
      // Apercu : les traits deplaces peints transformes, modele intact.
      const t = pv.t;
      ctx.save();
      ctx.translate(t.ox + t.dx, t.oy + t.dy);
      ctx.scale(t.s, t.s);
      ctx.translate(-t.ox, -t.oy);
      for (const s of moving) if (s.tool === "highlighter") this.drawStroke(ctx, s);
      for (const s of moving) if (s.tool !== "highlighter") this.drawStroke(ctx, s);
      ctx.restore();
    }
    this.drawSelection(ctx);

    const circle = this.eraserPos ?? this.hoverPos;
    if (circle) {
      ctx.beginPath();
      ctx.arc(circle.x, circle.y, ERASER_R, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(80,90,110,.7)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (this.regionStart && this.regionNow) {
      const r = rectOf(this.regionStart, this.regionNow);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(37,99,235,.07)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  /** Cadre de selection, trace du lasso, ligne d'insertion d'espace. */
  private drawSelection(ctx: CanvasRenderingContext2D): void {
    const u = 1 / (this.scale || 1); // un pixel CSS, en unites de page
    if (this.lasso && this.lasso.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.lasso[0].x, this.lasso[0].y);
      for (const q of this.lasso) ctx.lineTo(q.x, q.y);
      ctx.closePath();
      ctx.fillStyle = "rgba(37,99,235,.06)";
      ctx.fill();
      ctx.setLineDash([5 * u, 4 * u]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5 * u;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const f = this.drag?.kind === "space" ? null : this.selectionFrame();
    if (f) {
      ctx.setLineDash([6 * u, 4 * u]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5 * u;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
      ctx.setLineDash([]);
      // Poignee bas-droite : 44 px de cible, un rond visible de 18 px.
      ctx.beginPath();
      ctx.arc(f.x + f.w, f.y + f.h, 9 * u, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 2 * u;
      ctx.stroke();
    }
    if (this.drag?.kind === "space") {
      const y0 = this.drag.start.y;
      const dy = this.preview?.t.dy ?? 0;
      if (dy > 0) {
        ctx.fillStyle = "rgba(37,99,235,.07)";
        ctx.fillRect(0, y0, PAGE_W, dy);
      }
      ctx.setLineDash([8 * u, 5 * u]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5 * u;
      ctx.beginPath();
      ctx.moveTo(0, y0); ctx.lineTo(PAGE_W, y0);
      if (dy !== 0) { ctx.moveTo(0, y0 + dy); ctx.lineTo(PAGE_W, y0 + dy); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /**
   * Fond de page dans la zone (x, y, w, h), en pixels du canvas. Les lignes
   * sont calees sur les pixels physiques (nettes, sans flou d'antialias) et
   * gardent une epaisseur fixe a l'ecran : au zoom, les carreaux
   * grandissent, pas l'epaisseur des traits du fond.
   */
  private drawPaper(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, k: number): void {
    // Un pixel de plus de chaque cote : une ligne arrondie sur le bord de la
    // zone repeinte serait sinon effacee sans etre retracee (trou dans la ligne).
    const zone = { x: (x - 1) / k, y: (y - 1) / k, w: (w + 2) / k, h: (h + 2) / k };
    for (const g of paperLines(this.paper, zone, this.scale)) {
      const st = PAPER_STYLE[g.weight];
      const lw = Math.max(1, Math.round(st.width * this.dpr));
      const half = lw % 2 ? 0.5 : 0;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (const v of g.vertical) {
        const px = Math.round(v * k) + half;
        ctx.moveTo(px, y); ctx.lineTo(px, y + h);
      }
      for (const v of g.horizontal) {
        const py = Math.round(v * k) + half;
        ctx.moveTo(x, py); ctx.lineTo(x + w, py);
      }
      ctx.stroke();
    }
    const dots = paperDots(this.paper, zone);
    if (dots.length) {
      const sz = Math.max(1.5, DOT_STYLE.size * this.dpr);
      ctx.fillStyle = DOT_STYLE.color;
      for (const d of dots) ctx.fillRect(Math.round(d.x * k - sz / 2), Math.round(d.y * k - sz / 2), sz, sz);
    }
  }

  /** Trace un seul segment de stylo, sans toucher au reste de la page. */
  private drawSegment(s: Stroke, a: InkPoint, b: InkPoint) {
    const k = this.scale * this.dpr;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colorOf(s.color, s.tool);
    ctx.lineWidth = widthAt(s.width, (a.p + b.p) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    if (s.points.length < 2) return;
    ctx.strokeStyle = colorOf(s.color, s.tool);
    ctx.lineJoin = "round";

    if (s.tool === "highlighter") {
      // Une bande d'un seul chemin, largeur constante, bouts droits :
      // l'opacite s'applique une fois, sans noeuds plus fonces aux jointures.
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.lineCap = "butt";
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    // Un segment par paire de points : l'epaisseur suit la pression.
    ctx.lineCap = "round";
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i];
      ctx.lineWidth = widthAt(s.width, (a.p + b.p) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Zone couverte par le cercle de la gomme. */
function circleBounds(p: { x: number; y: number }): Bounds {
  return { x: p.x - ERASER_R - 2, y: p.y - ERASER_R - 2, w: 2 * ERASER_R + 4, h: 2 * ERASER_R + 4 };
}

export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Bounds {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}
