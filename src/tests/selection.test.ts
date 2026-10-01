import { describe, it, expect } from "vitest";
import {
  pointInPolygon, strokeInLasso, selectInLasso, selectionBounds, strokesById,
  transformBlocks, translation, clampMove, resizeTransform, recolorStrokes,
  copySelection, pasteClip, strokesBelow, clampSpace, splitStroke, replaceStrokes,
  type Pt,
} from "../core/ink/selection";
import { cachedBounds } from "../core/ink/stroke";
import { PAGE_W } from "../core/ink/sheet";
import type { Block, InkBlock, MathBlock, Stroke } from "../core/types";

let seq = 0;
const nid = () => `n${++seq}`;

function stroke(id: string, points: [number, number][], width = 2): Stroke {
  return { id, color: "normal", width, tool: "pen", points: points.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 10 })) };
}

function line(id: string, x0: number, y0: number, x1: number, y1: number, n = 11): Stroke {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1)]);
  return stroke(id, pts);
}

const square = (x: number, y: number, w: number, h: number): Pt[] =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

function inkBlock(strokes: Stroke[], extra: Partial<InkBlock> = {}): InkBlock {
  return { id: "ink", type: "ink", strokes, recognized: null, mode: "raw", ...extra };
}

describe("point dans polygone", () => {
  it("carre et forme concave", () => {
    const sq = square(0, 0, 10, 10);
    expect(pointInPolygon(5, 5, sq)).toBe(true);
    expect(pointInPolygon(15, 5, sq)).toBe(false);
    // U : le creux n'est pas dedans.
    const u: Pt[] = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 0 },
      { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon(5, 3, u)).toBe(false);
    expect(pointInPolygon(5, 9, u)).toBe(true);
    expect(pointInPolygon(1, 3, u)).toBe(true);
  });
});

describe("selection au lasso", () => {
  it("prend les traits majoritairement dedans", () => {
    const inside = line("a", 10, 10, 90, 10);
    const half = line("b", 50, 50, 140, 50); // 6 points sur 11 dedans (x < 100)
    const out = line("c", 80, 80, 200, 80); // 3 sur 11
    const poly = square(0, 0, 100, 100);
    expect(strokeInLasso(inside, poly)).toBe(true);
    expect(strokeInLasso(half, poly)).toBe(true);
    expect(strokeInLasso(out, poly)).toBe(false);
    expect(strokeInLasso(inside, poly.slice(0, 2))).toBe(false);
  });

  it("une zone reconnue est prise en entier", () => {
    const m1 = line("m1", 10, 10, 40, 10), m2 = line("m2", 300, 10, 340, 10);
    const math: MathBlock = { id: "M", type: "math", mode: "math", strokes: [m1, m2], latex: "x", rect: { x: 0, y: 0, w: 350, h: 20 } };
    const free = line("f", 10, 50, 40, 50);
    const blocks: Block[] = [inkBlock([free]), math];
    const ids = selectInLasso(blocks, square(0, 0, 100, 100));
    expect([...ids].sort()).toEqual(["f", "m1", "m2"]);
    expect(strokesById(blocks, ids).map((s) => s.id)).toEqual(["f", "m1", "m2"]);
  });
});

describe("transformation", () => {
  it("deplacer garde les ids, decale le cadre de zone et la boite des mots", () => {
    const a = line("a", 10, 10, 50, 10), b = line("b", 10, 30, 50, 30), c = line("c", 300, 300, 320, 300);
    const ink = inkBlock([a, b, c], {
      words: [
        { label: "ab", box: { x: 10, y: 5, w: 40, h: 30 }, strokeIds: ["a", "b"] },
        { label: " ", strokeIds: [] },
        { label: "c", box: { x: 300, y: 295, w: 20, h: 10 }, strokeIds: ["c", "a2"] },
      ],
    });
    const zone: MathBlock = { id: "Z", type: "math", mode: "math", strokes: [line("z", 100, 100, 120, 100)], latex: "y", rect: { x: 98, y: 95, w: 24, h: 10 } };
    const blocks: Block[] = [ink, zone];
    transformBlocks(blocks, new Set(["a", "b", "z"]), translation(5, 100));
    expect(ink.strokes.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(ink.strokes[0].points[0]).toMatchObject({ x: 15, y: 110 });
    expect(ink.strokes[2].points[0]).toMatchObject({ x: 300, y: 300 });
    expect(ink.words![0].box).toEqual({ x: 15, y: 105, w: 40, h: 30 });
    expect(zone.rect).toEqual({ x: 103, y: 195, w: 24, h: 10 });
    expect(zone.strokes[0].id).toBe("z");
  });

  it("un mot dont une partie seulement bouge lache les traits partis", () => {
    const a = line("a", 10, 10, 50, 10), b = line("b", 60, 10, 90, 10);
    const ink = inkBlock([a, b], { words: [{ label: "ab", box: { x: 10, y: 5, w: 80, h: 10 }, strokeIds: ["a", "b"] }] });
    transformBlocks([ink], new Set(["b"]), translation(0, 50));
    expect(ink.words![0].strokeIds).toEqual(["a"]);
    expect(ink.words![0].box).toEqual({ x: 10, y: 5, w: 80, h: 10 });
  });

  it("la boite reste sur la feuille", () => {
    const b = { x: 10, y: 20, w: 100, h: 50 };
    expect(clampMove(b, -50, -50)).toEqual({ dx: -10, dy: -20 });
    expect(clampMove(b, PAGE_W, 500)).toEqual({ dx: PAGE_W - 110, dy: 500 });
  });

  it("redimensionnement proportionnel par l'angle, epaisseur comprise", () => {
    const s = line("a", 100, 100, 200, 200);
    const b = selectionBounds([s]);
    const t = resizeTransform(b, b.w, b.h); // tirer d'une diagonale : x2
    expect(t.s).toBeCloseTo(2, 5);
    transformBlocks([inkBlock([s])], new Set(["a"]), t);
    expect(s.width).toBeCloseTo(4, 5);
    const nb = cachedBounds(s);
    expect(nb.x).toBeCloseTo(b.x, 0);
    expect(nb.w).toBeCloseTo(b.w * 2, 0);
    // Jamais au-dela de la largeur de la feuille, jamais reduit a rien.
    expect(resizeTransform(b, 5000, 5000).s).toBeLessThanOrEqual((PAGE_W - b.x) / b.w + 1e-9);
    expect(resizeTransform(b, -5000, -5000).s).toBeGreaterThan(0);
  });

  it("recolorer garde les ids", () => {
    const a = line("a", 0, 0, 10, 0), b = line("b", 0, 10, 10, 10);
    expect(recolorStrokes([inkBlock([a, b])], new Set(["a"]), "theoreme")).toBe(1);
    expect(a.color).toBe("theoreme");
    expect(b.color).toBe("normal");
    expect(a.id).toBe("a");
  });
});

describe("copier / coller", () => {
  it("le collage a de nouveaux ids et suit le decalage ; la copie ne suit plus la page", () => {
    const a = line("a", 10, 10, 50, 10);
    const zone: InkBlock = {
      id: "T", type: "ink", mode: "raw", strokes: [line("t", 100, 100, 140, 100)], recognized: "mot",
      rect: { x: 98, y: 95, w: 44, h: 10 },
      words: [{ label: "mot", box: { x: 100, y: 95, w: 40, h: 10 }, strokeIds: ["t"] }],
    };
    const blocks: Block[] = [inkBlock([a]), zone];
    const clip = copySelection(blocks, new Set(["a", "t"]))!;
    expect(clip.strokes.map((s) => s.id)).toEqual(["a"]);
    expect(clip.zones).toHaveLength(1);
    a.points[0].x = 999; // la page change apres la copie
    const out = pasteClip(clip, 24, 24, nid);
    expect(out.strokes[0].id).not.toBe("a");
    expect(out.strokes[0].points[0]).toMatchObject({ x: 34, y: 34 });
    const z = out.zones[0] as InkBlock;
    expect(z.id).not.toBe("T");
    expect(z.strokes[0].id).not.toBe("t");
    expect(z.words![0].strokeIds).toEqual([z.strokes[0].id]);
    expect(z.rect).toEqual({ x: 122, y: 119, w: 44, h: 10 });
    expect(z.recognized).toBe("mot");
    expect(copySelection(blocks, new Set(["zz"]))).toBeNull();
  });
});

describe("inserer de l'espace", () => {
  it("pousse ce qui est sous la ligne, zone comprise", () => {
    const above = line("up", 10, 100, 300, 100);
    const below = line("down", 10, 300, 300, 300);
    // Grand trait qui commence au-dessus mais dont le centre est dessous.
    const tall = stroke("tall", [[400, 180], [400, 420]]);
    const zone: MathBlock = {
      id: "Z", type: "math", mode: "math", latex: "x",
      strokes: [line("z1", 10, 195, 40, 195), line("z2", 10, 260, 40, 260)], rect: { x: 0, y: 190, w: 50, h: 80 },
    };
    const blocks: Block[] = [inkBlock([above, below, tall]), zone];
    const ids = strokesBelow(blocks, 200);
    expect([...ids].sort()).toEqual(["down", "tall", "z1", "z2"]);
    transformBlocks(blocks, ids, translation(0, 60));
    expect(below.points[0].y).toBe(360);
    expect(above.points[0].y).toBe(100);
    expect(zone.rect!.y).toBe(250);
  });

  it("vers le haut, seulement le blanc sous la ligne", () => {
    const below = line("down", 10, 300, 300, 300);
    const blocks: Block[] = [inkBlock([below])];
    const ids = strokesBelow(blocks, 200);
    expect(clampSpace(blocks, ids, 200, -500)).toBeCloseTo(-(300 - 1 - 200), 5);
    expect(clampSpace(blocks, ids, 200, 40)).toBe(40);
  });
});

describe("gomme precise", () => {
  it("coupe un trait en deux morceaux aux bords du disque, nouveaux ids", () => {
    const s = line("w", 0, 0, 100, 0, 3); // points 0, 50, 100
    s.width = 2;
    const parts = splitStroke(s, 50, 0, 9, nid)!;
    expect(parts).toHaveLength(2);
    // rayon 9 + demi-epaisseur 1 = 10.
    expect(parts[0].points.at(-1)!.x).toBeCloseTo(40, 1);
    expect(parts[1].points[0].x).toBeCloseTo(60, 1);
    expect(parts[0].points[0].x).toBe(0);
    expect(parts[1].points.at(-1)!.x).toBe(100);
    for (const p of parts) {
      expect(p.id).not.toBe("w");
      expect(p.color).toBe(s.color);
      expect(p.width).toBe(s.width);
    }
    // Temps interpole : moitie du chemin entre t=0 et t=10.
    expect(parts[0].points.at(-1)!.t).toBe(8);
  });

  it("segment qui traverse le disque sans point dedans", () => {
    const s = stroke("w", [[0, 0], [100, 0]]);
    const parts = splitStroke(s, 50, 3, 5, nid)!;
    expect(parts).toHaveLength(2);
  });

  it("hors du disque : null ; bout gomme : un seul morceau ; tout gomme : vide", () => {
    const s = line("w", 0, 0, 100, 0);
    expect(splitStroke(s, 50, 50, 10, nid)).toBeNull();
    const end = splitStroke(s, 100, 0, 9, nid)!;
    expect(end).toHaveLength(1);
    expect(end[0].points.at(-1)!.x).toBeCloseTo(90, 1);
    expect(splitStroke(line("p", 0, 0, 5, 0), 2, 0, 20, nid)).toEqual([]);
  });

  it("les morceaux remplacent le trait a sa place, mots et zones suivent", () => {
    const a = line("a", 0, 0, 10, 0), w = line("w", 0, 10, 100, 10), c = line("c", 0, 20, 10, 20);
    const ink = inkBlock([a, w, c], { words: [{ label: "x", box: { x: 0, y: 5, w: 100, h: 10 }, strokeIds: ["w"] }] });
    const m = line("m", 0, 50, 10, 50);
    const math: MathBlock = { id: "M", type: "math", mode: "math", latex: "1", strokes: [m], rect: { x: 0, y: 45, w: 10, h: 10 } };
    const parts = splitStroke(w, 50, 10, 5, nid)!;
    const out = replaceStrokes([ink, math], new Map([["w", parts], ["m", []]]));
    expect(ink.strokes.map((s) => s.id)).toEqual(["a", parts[0].id, parts[1].id, "c"]);
    expect(ink.words![0].strokeIds).toEqual(parts.map((p) => p.id));
    expect(out.wordsTouched).toBe(true);
    expect(out.blocks).toHaveLength(1); // zone math videe : partie
    // Mot dont toute l'encre est gommee : il part aussi.
    replaceStrokes([ink], new Map(ink.strokes.filter((s) => s.id.startsWith("n")).map((s) => [s.id, []])));
    expect(ink.words).toEqual([]);
  });
});
