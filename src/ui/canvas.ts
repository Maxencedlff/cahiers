import type { InkColor, InkPoint, Stroke, ToolKind } from "../core/types";
import { colorOf } from "../core/palette";
import {
  newStroke, simplify, cachedBounds, strokeHitsCircle, unionBounds, padBounds,
  widthAt, boundsIntersect, roundPoint, HIGHLIGHT_FACTOR, type Bounds,
} from "../core/ink/stroke";
import { PAGE_W, PAGE_H } from "../core/ink/sheet";
import { gestureTool, isPalm } from "../core/ink/pointer";

/** Unites de page. Rapport proche d'une feuille A4 en portrait. */
export { PAGE_W, PAGE_H };

export type PointerRole = "write" | "navigate" | "ignore";
export type SurfaceTool = ToolKind | "region" | "textregion";

/** Rayon de la gomme, en unites de page. */
const ERASER_R = 12;
/** Opacite du surligneur, appliquee une seule fois par trait. */
const HIGHLIGHT_ALPHA = 0.4;

export interface InkSurfaceOptions {
  /** Appele quand un trait est termine. */
  onStrokeEnd: (stroke: Stroke) => void;
  /** Debut d'un geste de gomme : une seule entree d'annulation par geste. */
  onEraseStart?: () => void;
  /** Appele quand la gomme a retire des traits. */
  onErase: (removedIds: string[]) => void;
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
  /** Defilement au doigt, pris en charge ici faute de geste natif. */
  private pan: { pointerId: number; startY: number; startScroll: number } | null = null;

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
    this.repaintAll();
  }

  /** Hauteur logique actuelle du canvas, en unites de page. */
  get height(): number { return this.pageH; }

  /**
   * Redimensionne le canvas et redessine. `pageH` = hauteur logique de la
   * feuille : au-dela de l'A4 quand le texte ou l'encre la prolongent. Le
   * canvas couvre toujours toute la feuille, sinon l'encre ecrite dessous
   * n'aurait nulle part ou aller.
   */
  layout(cssWidth: number, pageH = PAGE_H, density?: number): void {
    const declared = getComputedStyle(this.canvas).getPropertyValue("--page-bg").trim();
    if (declared) this.paperColor = declared;
    // `density` : densite imposee (export PDF en densite 3), sinon l'ecran.
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
  fit(cssWidth: number, pageH: number): void {
    const h = Math.max(PAGE_H, pageH);
    if (cssWidth === this.cssWidth && h === this.pageH
        && this.dpr === Math.min(window.devicePixelRatio || 1, 2)) return;
    this.layout(cssWidth, h);
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

  private toPage(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / this.scale,
      y: (e.clientY - r.top) / this.scale,
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
    if (this.roleOf(e) === "navigate") {
      // Paume posee pendant ou juste apres un trait : elle ne fait pas
      // defiler la page sous la plume.
      if (!isPalm(e.timeStamp, this.penWriting, lastPenAt)) this.startPan(e);
      return;
    }
    if (this.roleOf(e) !== "write") return;
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

    if (tool === "eraser") {
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
    this.pan = { pointerId: e.pointerId, startY: e.clientY, startScroll: box.scrollTop };
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
  }

  private addPoint(e: PointerEvent, p: { x: number; y: number }) {
    if (!this.live) return;
    // Pas de borne en bas : la feuille s'allonge sous l'encre (sheetHeight),
    // un trait ecrit sous l'A4 garde ses coordonnees.
    const point = roundPoint({
      x: clamp(p.x, 0, PAGE_W),
      y: Math.max(0, p.y),
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
    ctx.scale(k, k);

    // Surligneurs d'abord, stylos ensuite : le surlignage passe sous
    // l'encre, meme pose apres elle.
    const zone: Bounds = { x: x / k, y: y / k, w: w / k, h: h / k };
    const marks: Stroke[] = [], pens: Stroke[] = [];
    for (const s of this.strokes) {
      if (boundsIntersect(cachedBounds(s, 1), zone)) (s.tool === "highlighter" ? marks : pens).push(s);
    }
    if (this.live) (this.live.tool === "highlighter" ? marks : pens).push(this.live);
    for (const s of marks) this.drawStroke(ctx, s);
    for (const s of pens) this.drawStroke(ctx, s);

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
