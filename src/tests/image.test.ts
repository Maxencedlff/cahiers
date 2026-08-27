import { describe, it, expect, beforeAll } from "vitest";
import {
  homography, applyHomography, targetSize, defaultQuad, dewarp, binarize,
  type Quad,
} from "../core/image/dewarp";

/** Node n'a pas ImageData : on en fournit le strict necessaire. */
class FakeImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

beforeAll(() => {
  (globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData;
});

const rect = (w: number, h: number): Quad => [
  { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
];

describe("homographie", () => {
  it("l'identite laisse les points en place", () => {
    const q = rect(100, 60);
    const h = homography(q, q)!;
    expect(h).not.toBeNull();
    const p = applyHomography(h, { x: 42, y: 17 });
    expect(p.x).toBeCloseTo(42, 6);
    expect(p.y).toBeCloseTo(17, 6);
  });

  it("envoie chaque coin sur sa cible", () => {
    const src: Quad = [
      { x: 12, y: 8 }, { x: 190, y: 30 }, { x: 175, y: 140 }, { x: 20, y: 120 },
    ];
    const dst = rect(200, 100);
    const h = homography(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h, src[i]);
      expect(p.x).toBeCloseTo(dst[i].x, 4);
      expect(p.y).toBeCloseTo(dst[i].y, 4);
    }
  });

  it("refuse un quadrilatere degenere", () => {
    const flat: Quad = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ];
    expect(homography(flat, rect(10, 10))).toBeNull();
  });

  it("deduit la taille redressee des plus grands cotes", () => {
    const q: Quad = [
      { x: 0, y: 0 }, { x: 200, y: 10 }, { x: 190, y: 110 }, { x: 5, y: 100 },
    ];
    const s = targetSize(q);
    expect(s.width).toBeGreaterThanOrEqual(185);
    expect(s.height).toBeGreaterThanOrEqual(100);
  });

  it("propose des coins par defaut a l'interieur de l'image", () => {
    const q = defaultQuad(1000, 800);
    expect(q[0].x).toBeGreaterThan(0);
    expect(q[2].x).toBeLessThan(1000);
    expect(q[2].y).toBeLessThan(800);
  });
});

describe("redressement", () => {
  it("remet un carre de travers a l'endroit", () => {
    // Photo 100x100 blanche avec un carre noir en perspective.
    const src = new FakeImageData(100, 100) as unknown as ImageData;
    src.data.fill(255);
    const quad: Quad = [
      { x: 20, y: 10 }, { x: 80, y: 20 }, { x: 75, y: 85 }, { x: 15, y: 75 },
    ];
    // On noircit l'interieur du quadrilatere.
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        if (inside(quad, x, y)) {
          const o = (y * 100 + x) * 4;
          src.data[o] = src.data[o + 1] = src.data[o + 2] = 0;
        }
      }
    }
    const out = dewarp(src, quad, { width: 40, height: 40 })!;
    expect(out).not.toBeNull();
    // Le centre du resultat doit etre noir : le carre remplit maintenant le cadre.
    const c = ((20 * 40) + 20) * 4;
    expect(out.data[c]).toBeLessThan(60);
  });

  it("rend du blanc hors de la photo", () => {
    const src = new FakeImageData(50, 50) as unknown as ImageData;
    src.data.fill(0);
    // Un quadrilatere qui sort largement de l'image.
    const quad: Quad = [
      { x: -200, y: -200 }, { x: -100, y: -200 }, { x: -100, y: -100 }, { x: -200, y: -100 },
    ];
    const out = dewarp(src, quad, { width: 10, height: 10 })!;
    expect(out.data[0]).toBe(255);
  });
});

describe("binarisation", () => {
  it("separe le texte du fond malgre un eclairage inegal", () => {
    const w = 60, h = 40;
    const img = new FakeImageData(w, h) as unknown as ImageData;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Fond en degrade : sombre a gauche, clair a droite.
        const fond = 90 + (x / w) * 150;
        // Un trait plus sombre que son voisinage, au milieu.
        const trait = y > 18 && y < 22 ? 60 : 0;
        const v = fond - trait;
        const o = (y * w + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    const out = binarize(img, 8, 8);
    const at = (x: number, y: number) => out.data[(y * w + x) * 4];
    // Le trait ressort en noir des deux cotes, malgre la difference d'eclairage.
    expect(at(10, 20)).toBe(0);
    expect(at(50, 20)).toBe(0);
    // Le fond reste blanc partout.
    expect(at(10, 5)).toBe(255);
    expect(at(50, 5)).toBe(255);
  });
});

/** Test de point dans un quadrilatere convexe, pour fabriquer l'image d'essai. */
function inside(q: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    const s = Math.sign(cross);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
