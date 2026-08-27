/**
 * Redressement de perspective (section 6, priorite 2).
 *
 * Une photo de tableau prise de travers est illisible et, surtout, l'OCR
 * echoue dessus. On calcule l'homographie qui envoie les quatre coins
 * designes par l'utilisateur sur un rectangle, et on la rend au pixel.
 */

export interface Point2 { x: number; y: number }
/** Coins dans l'ordre : haut-gauche, haut-droit, bas-droit, bas-gauche. */
export type Quad = [Point2, Point2, Point2, Point2];

/** Matrice 3x3 en ligne : [a, b, c, d, e, f, g, h, i]. */
export type Homography = number[];

/**
 * Homographie envoyant `src` sur `dst`, par resolution d'un systeme 8x8
 * (elimination de Gauss avec pivot partiel).
 */
export function homography(src: Quad, dst: Quad): Homography | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve8(A, b);
  return h ? [...h, 1] : null;
}

function solve8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null; // quadrilatere degenere
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  // Gauss-Jordan complet : la matrice est diagonale, la solution se lit.
  return m.map((row, i) => row[n] / row[i]);
}

export function applyHomography(h: Homography, p: Point2): Point2 {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** Dimensions du rectangle redresse : on garde les plus grands cotes. */
export function targetSize(quad: Quad): { width: number; height: number } {
  const d = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.round(Math.max(d(quad[0], quad[1]), d(quad[3], quad[2])));
  const height = Math.round(Math.max(d(quad[0], quad[3]), d(quad[1], quad[2])));
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Redresse `source` selon `quad`. Echantillonnage inverse : pour chaque pixel
 * de sortie on va chercher sa couleur dans la photo, ce qui evite les trous.
 */
export function dewarp(
  source: ImageData, quad: Quad, size = targetSize(quad),
): ImageData | null {
  const dst: Quad = [
    { x: 0, y: 0 },
    { x: size.width - 1, y: 0 },
    { x: size.width - 1, y: size.height - 1 },
    { x: 0, y: size.height - 1 },
  ];
  // On inverse le sens : de la sortie vers la photo.
  const h = homography(dst, quad);
  if (!h) return null;

  const out = new ImageData(size.width, size.height);
  const sw = source.width, sh = source.height;

  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const p = applyHomography(h, { x, y });
      const o = (y * size.width + x) * 4;
      if (p.x < 0 || p.y < 0 || p.x >= sw - 1 || p.y >= sh - 1) {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
        out.data[o + 3] = 255;
        continue;
      }
      bilinear(source, p.x, p.y, out.data, o);
    }
  }
  return out;
}

function bilinear(src: ImageData, fx: number, fy: number, out: Uint8ClampedArray, o: number): void {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const dx = fx - x0, dy = fy - y0;
  const w = src.width;
  const i00 = (y0 * w + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + w * 4;
  const i11 = i01 + 4;
  for (let c = 0; c < 4; c++) {
    const top = src.data[i00 + c] * (1 - dx) + src.data[i10 + c] * dx;
    const bottom = src.data[i01 + c] * (1 - dx) + src.data[i11 + c] * dx;
    out[o + c] = top * (1 - dy) + bottom * dy;
  }
}

/**
 * Passage en niveaux de gris avec seuil adaptatif local.
 * Une photo de tableau blanc est grise et inegalement eclairee : l'OCR marche
 * beaucoup mieux sur du noir et blanc franc, et l'image pese dix fois moins.
 */
export function binarize(img: ImageData, radius = 12, bias = 8): ImageData {
  const { width: w, height: h, data } = img;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  // Image integrale : la moyenne locale devient quatre lectures par pixel.
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const area = (x0: number, y0: number, x1: number, y1: number) =>
    sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0];

  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const mean = area(x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
      const v = gray[y * w + x] < mean - bias ? 0 : 255;
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Coins par defaut : toute l'image, a ajuster ensuite au doigt. */
export function defaultQuad(width: number, height: number, inset = 0.06): Quad {
  const dx = width * inset, dy = height * inset;
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ];
}
