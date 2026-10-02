import { niceTicks, tickLabel, type Sample } from "../core/calc/plot";

/**
 * Trace d'une courbe : grille, axes gradues, etiquettes, courbe coupee aux
 * asymptotes. Partage par l'onglet Courbes de la calculatrice et par les
 * blocs courbe de la page : meme fenetre, meme lecture.
 */

export interface PlotFrame {
  from: number; to: number; yMin: number; yMax: number; w: number; h: number;
  X: (x: number) => number;
  Y: (y: number) => number;
  /** Ordonnee de l'axe des x a l'ecran, null s'il est hors fenetre. */
  axisY: number | null;
}

export function drawPlot(
  ctx: CanvasRenderingContext2D, w: number, h: number, samples: Sample[],
  win: { from: number; to: number; yMin: number; yMax: number },
  opts: { font?: number; line?: number } = {},
): PlotFrame {
  const { from, to, yMin, yMax } = win;
  const font = opts.font ?? 10;
  const X = (x: number) => ((x - from) / (to - from)) * w;
  const Y = (y: number) => h - ((y - yMin) / (yMax - yMin)) * h;

  // Grille et graduations rondes, etiquetees.
  const xt = niceTicks(from, to, Math.max(4, Math.floor(w / (font * 5))));
  const yt = niceTicks(yMin, yMax, Math.max(3, Math.floor(h / (font * 4))));
  ctx.strokeStyle = "#eceff4"; ctx.lineWidth = 1;
  for (const t of xt.ticks) { const gx = X(t); ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
  for (const t of yt.ticks) { const gy = Y(t); ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
  ctx.strokeStyle = "#9aa3b2"; ctx.lineWidth = 1.2;
  const axisY = 0 >= yMin && 0 <= yMax ? Y(0) : null;
  const axisX = 0 >= from && 0 <= to ? X(0) : null;
  if (axisY !== null) { ctx.beginPath(); ctx.moveTo(0, axisY); ctx.lineTo(w, axisY); ctx.stroke(); }
  if (axisX !== null) { ctx.beginPath(); ctx.moveTo(axisX, 0); ctx.lineTo(axisX, h); ctx.stroke(); }
  ctx.fillStyle = "#6b7487"; ctx.font = `${font}px system-ui, sans-serif`;
  const labelY = Math.min(h - 0.3 * font, Math.max(1.1 * font, (axisY ?? h) + 1.1 * font));
  ctx.textAlign = "center";
  for (const t of xt.ticks) {
    if (t === 0 && axisX !== null) continue;
    const gx = X(t);
    if (gx < font || gx > w - font) continue;
    ctx.fillText(tickLabel(t, xt.step), gx, labelY);
  }
  ctx.textAlign = "left";
  const labelX = Math.min(w - 4 * font, Math.max(0.3 * font, (axisX ?? 0) + 0.3 * font));
  for (const t of yt.ticks) {
    const gy = Y(t);
    if (gy < 0.8 * font || gy > h - 0.4 * font) continue;
    ctx.fillText(tickLabel(t, yt.step), labelX, gy - 0.2 * font);
  }

  // Courbe : le trait est coupe sur une asymptote (saut hors fenetre).
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  ctx.strokeStyle = "#2563eb"; ctx.lineWidth = opts.line ?? 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let prev: { py: number; out: boolean } | null = null;
  for (const s of samples) {
    if (s.y === null) { prev = null; continue; }
    const px = X(s.x), py = Y(s.y);
    const out = py < -h || py > 2 * h;
    const cy = Math.max(-h, Math.min(2 * h, py));
    if (!prev || ((out || prev.out) && Math.abs(cy - prev.py) > h)) ctx.moveTo(px, cy);
    else ctx.lineTo(px, cy);
    prev = { py: cy, out };
  }
  ctx.stroke();
  ctx.restore();
  return { from, to, yMin, yMax, w, h, X, Y, axisY };
}
