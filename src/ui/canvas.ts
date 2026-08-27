import type { ColorKey, InkPoint, Stroke, ToolKind } from "../core/types";
import { colorOf } from "../core/palette";
import {
  newStroke, simplify, strokeBounds, strokeHitsCircle, unionBounds,
  widthAt, boundsIntersect, type Bounds,
} from "../core/ink/stroke";

/** Unites de page. Rapport proche d'une feuille A4 en portrait. */
export const PAGE_W = 900;
export const PAGE_H = 1240;

export type PointerRole = "write" | "navigate" | "ignore";

export interface InkSurfaceOptions {
  /** Appele quand un trait est termine. */
  onStrokeEnd: (stroke: Stroke) => void;
  /** Appele quand la gomme a retire des traits. */
  onErase: (removedIds: string[]) => void;
  /** Zone rectangulaire tracee au lasso "selection math". */
  onRegion?: (bounds: Bounds) => void;
  getTool: () => ToolKind | "region";
  getColor: () => ColorKey;
  getWidth: () => number;
  /** Vrai quand un stylet a deja ete vu : le doigt ne dessine plus. */
  penSeen: () => boolean;
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
  private live: Stroke | null = null;
  private liveLast: InkPoint | null = null;
  private startedAt = 0;
  private dirty: Bounds | null = null;
  private raf = 0;
  private scale = 1;
  private dpr = 1;
  private activePointer: number | null = null;
  private eraserPos: { x: number; y: number } | null = null;
  private regionStart: { x: number; y: number } | null = null;
  private regionNow: { x: number; y: number } | null = null;
  private disposed = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private opts: InkSurfaceOptions,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) throw new Error("Canvas 2D indisponible");
    this.ctx = ctx;
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
  }

  setStrokes(strokes: Stroke[]): void {
    this.strokes = strokes;
    this.repaintAll();
  }

  /** Redimensionne le canvas et redessine. Appele au resize du conteneur. */
  layout(cssWidth: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scale = cssWidth / PAGE_W;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssWidth * (PAGE_H / PAGE_W) * this.dpr);
    this.canvas.style.height = `${Math.round(cssWidth * (PAGE_H / PAGE_W))}px`;
    this.repaintAll();
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
    if (e.pointerType === "touch") return this.opts.penSeen() ? "navigate" : "write";
    return "ignore";
  }

  private toPage(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / this.scale,
      y: (e.clientY - r.top) / this.scale,
    };
  }

  /* ---------------- evenements ---------------- */

  private onDown = (e: PointerEvent) => {
    if (this.roleOf(e) !== "write") return;
    if (this.activePointer !== null) return; // un seul pointeur ecrit a la fois
    const tool = this.opts.getTool();
    this.activePointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();

    const p = this.toPage(e);

    if (tool === "eraser") { this.eraserPos = p; this.eraseAt(p); return; }
    if (tool === "region") { this.regionStart = p; this.regionNow = p; return; }

    this.startedAt = e.timeStamp;
    this.live = newStroke(this.opts.getColor(), this.opts.getWidth(), tool);
    this.liveLast = null;
    this.addPoint(e, p);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    const tool = this.opts.getTool();
    e.preventDefault();

    if (tool === "eraser") {
      const p = this.toPage(e);
      this.eraserPos = p;
      this.eraseAt(p);
      return;
    }
    if (tool === "region") {
      this.regionNow = this.toPage(e);
      this.markDirty({ x: 0, y: 0, w: PAGE_W, h: PAGE_H });
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
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }

    if (this.regionStart && this.regionNow) {
      const b = rectOf(this.regionStart, this.regionNow);
      this.regionStart = this.regionNow = null;
      this.markDirty({ x: 0, y: 0, w: PAGE_W, h: PAGE_H });
      if (b.w > 12 && b.h > 12) this.opts.onRegion?.(b);
      return;
    }
    if (this.eraserPos) {
      this.eraserPos = null;
      this.markDirty({ x: 0, y: 0, w: PAGE_W, h: PAGE_H });
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
    stroke.points = simplify(stroke.points, 0.55);
    this.strokes.push(stroke);
    this.opts.onStrokeEnd(stroke);
  };

  private addPoint(e: PointerEvent, p: { x: number; y: number }) {
    if (!this.live) return;
    const point: InkPoint = {
      x: clamp(p.x, 0, PAGE_W),
      y: clamp(p.y, 0, PAGE_H),
      p: e.pressure > 0 ? e.pressure : 0.5,
      t: Math.max(0, e.timeStamp - this.startedAt),
    };
    if (e.tiltX || e.tiltY) { point.tiltX = e.tiltX; point.tiltY = e.tiltY; }

    const prev = this.liveLast;
    // Sous le demi-pixel, le point n'apporte rien et coute du JSON.
    if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) < 0.4) return;
    this.live.points.push(point);

    // Trace immediate du seul nouveau segment : aucun repaint global.
    if (prev) this.drawSegment(this.live, prev, point);
    this.liveLast = point;
  }

  private eraseAt(p: { x: number; y: number }) {
    const radius = 12;
    const removed: string[] = [];
    const boxes: Bounds[] = [];
    this.strokes = this.strokes.filter((s) => {
      if (strokeHitsCircle(s, p.x, p.y, radius)) {
        removed.push(s.id);
        boxes.push(strokeBounds(s, 2));
        return false;
      }
      return true;
    });
    if (removed.length) {
      this.markDirty(unionBounds(boxes));
      this.opts.onErase(removed);
    }
    this.markDirty({ x: p.x - radius - 2, y: p.y - radius - 2, w: 2 * radius + 4, h: 2 * radius + 4 });
  }

  /* ---------------- rendu ---------------- */

  /** Marque une zone a repeindre. Les zones s'accumulent jusqu'a la frame. */
  markDirty(b: Bounds): void {
    this.dirty = this.dirty ? unionBounds([this.dirty, b]) : b;
    this.schedule();
  }

  repaintAll(): void {
    this.markDirty({ x: 0, y: 0, w: PAGE_W, h: PAGE_H });
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
   * jamais reparcourus : sur une page chargee, c'est la difference entre
   * quelques traits et plusieurs milliers de points par frame.
   */
  private flush() {
    const d = this.dirty;
    if (!d) return;
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

    ctx.clearRect(x, y, w, h);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.scale(k, k);

    const zone: Bounds = { x: x / k, y: y / k, w: w / k, h: h / k };
    for (const s of this.strokes) {
      if (boundsIntersect(strokeBounds(s, 1), zone)) this.drawStroke(ctx, s);
    }
    if (this.live) this.drawStroke(ctx, this.live);

    if (this.eraserPos) {
      ctx.beginPath();
      ctx.arc(this.eraserPos.x, this.eraserPos.y, 12, 0, Math.PI * 2);
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

  /** Trace un seul segment, sans toucher au reste de la page. */
  private drawSegment(s: Stroke, a: InkPoint, b: InkPoint) {
    const k = this.scale * this.dpr;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colorOf(s.color, s.tool);
    ctx.globalAlpha = s.tool === "highlighter" ? 0.4 : 1;
    ctx.lineWidth = widthAt(s.width, (a.p + b.p) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    if (s.points.length < 2) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colorOf(s.color, s.tool);
    ctx.globalAlpha = s.tool === "highlighter" ? 0.4 : 1;

    // Un segment par paire de points : l'epaisseur suit la pression.
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i];
      ctx.lineWidth = widthAt(s.width, (a.p + b.p) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Bounds {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}
