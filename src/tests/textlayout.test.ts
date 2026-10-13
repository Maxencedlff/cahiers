import { describe, it, expect } from "vitest";
import {
  BASE, BASE_LIFT, FIRST_RULE, LINE, LINE_EM, TEXT_FONT, TEXT_TOP, baselineOf, blockMargins,
  clearOfInk, headingShift, linesToReach, rowAt, rowBottom, snapInline,
} from "../core/textlayout";
import { MM, paperLines } from "../core/paper";
import { PAGE_W } from "../core/ink/sheet";
import { shiftBelow } from "../core/ink/selection";
import type { Block, FlagBlock, InkBlock, MathBlock, PdfBlock, Stroke } from "../core/types";

// Pas de types Node dans le projet (et vitest vide les imports CSS) : le
// fichier est lu par un import dynamique non type.
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(p: URL, enc: string): string };
const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");

function cssPx(re: RegExp): number {
  const m = css.match(re);
  if (!m) throw new Error(`absent de style.css : ${re}`);
  return Number(m[1]);
}

describe("interligne cale sur le fond", () => {
  it("une ligne de texte = 8 mm, le pas du Ligne et du grand carreau Seyes", () => {
    expect(LINE).toBeCloseTo(8 * MM, 9);
    const ligne = paperLines("ligne", { x: 0, y: 0, w: PAGE_W, h: 400 })[0].horizontal;
    expect(ligne[1] - ligne[0]).toBeCloseTo(LINE, 6);
    const seyes = paperLines("seyes", { x: 0, y: 0, w: PAGE_W, h: 400 }).find((l) => l.weight === "main")!.horizontal;
    expect(seyes[1] - seyes[0]).toBeCloseTo(LINE, 6);
  });

  it("chaque ligne de base tombe juste au-dessus d'une ligne du fond, sans decalage cumule", () => {
    const rules = paperLines("ligne", { x: 0, y: 0, w: PAGE_W, h: 2400 })[0].horizontal;
    for (let i = 0; i < 60; i++) {
      const base = baselineOf(i);
      const rule = rules.find((y) => Math.abs(y - base) < LINE / 2)!;
      expect(rule).toBeDefined();
      expect(rule - base).toBeCloseTo(BASE_LIFT, 1);
    }
    expect(baselineOf(0)).toBeCloseTo(FIRST_RULE * LINE - BASE_LIFT, 1);
  });

  it("style.css reprend les memes valeurs (interligne, marge haute, titres)", () => {
    expect(cssPx(/--line:\s*calc\(([\d.]+)px \* var\(--k/)).toBeCloseTo(LINE, 3);
    expect(cssPx(/\.text-doc \{[^}]*padding:\s*calc\(([\d.]+)px/s)).toBeCloseTo(TEXT_TOP, 2);
    expect(cssPx(/font:\s*calc\(([\d.]+)px \* var\(--k, 1\)\) \/ 1\.5 KaTeX_Main/)).toBe(TEXT_FONT);
    expect(cssPx(/\.dl-h1 \{[^}]*top:\s*calc\((-?[\d.]+)px/)).toBeCloseTo(headingShift(1.2, 2) * TEXT_FONT, 1);
    expect(cssPx(/\.dl-h2 \{[^}]*top:\s*calc\((-?[\d.]+)px/)).toBeCloseTo(headingShift(1, 2) * TEXT_FONT, 1);
    expect(cssPx(/\.dl-h3 \{[^}]*top:\s*calc\((-?[\d.]+)px/)).toBeCloseTo(headingShift(1, 1) * TEXT_FONT, 1);
  });

  it("ligne et bas de ligne d'une ordonnee", () => {
    expect(rowAt(TEXT_TOP + 1)).toBe(0);
    expect(rowAt(TEXT_TOP + LINE * 2.5)).toBe(2);
    expect(rowBottom(TEXT_TOP + LINE * 2.5)).toBeCloseTo(TEXT_TOP + 3 * LINE, 6);
  });
});

describe("lignes hautes : un nombre entier de lignes", () => {
  // Boite d'une formule dans le texte : au moins la ligne normale (son
  // interligne interne), plus haute si son contenu deborde.
  const box = (inkAsc: number, inkDesc: number) => ({
    boxAsc: Math.max(BASE / TEXT_FONT, inkAsc + 0.1),
    boxDesc: Math.max(LINE_EM - BASE / TEXT_FONT, inkDesc + 0.1),
  });

  it("une formule basse (V_e = 12 V) garde une seule ligne", () => {
    const b = box(0.75, 0.2);
    const s = snapInline(b.boxAsc, b.boxDesc, 0.75, 0.2);
    expect(s.rows).toBe(1);
    expect(b.boxAsc + s.top + b.boxDesc + s.bottom).toBeCloseTo(LINE_EM, 3);
  });

  it("une fraction en displaystyle prend des lignes entieres, avec de l'air, le moins possible", () => {
    for (const [asc, desc, rows] of [[1.57, 1.03, 2], [1.6, 1.1, 2], [2.4, 1.9, 3], [1.2, 0.3, 2]]) {
      const b = box(asc, desc);
      const s = snapInline(b.boxAsc, b.boxDesc, asc, desc);
      const total = b.boxAsc + s.top + b.boxDesc + s.bottom;
      expect(s.rows).toBe(rows);
      expect(total / LINE_EM).toBeCloseTo(s.rows, 3);
      // Le contenu ne touche jamais la ligne voisine.
      expect(b.boxAsc + s.top).toBeGreaterThanOrEqual(asc + 0.1);
      expect(b.boxDesc + s.bottom).toBeGreaterThanOrEqual(desc + 0.1);
    }
  });

  it("ligne de base gardee sur la grille quand le contenu y tient", () => {
    const b = box(1.2, 0.3);
    const s = snapInline(b.boxAsc, b.boxDesc, 1.2, 0.3);
    const r = ((b.boxAsc + s.top) - BASE / TEXT_FONT) / LINE_EM;
    expect(Math.abs(r - Math.round(r))).toBeCloseTo(0, 3);
  });

  it("deux fractions sur deux lignes consecutives ne se chevauchent pas", () => {
    const b = box(1.57, 1.03);
    const s = snapInline(b.boxAsc, b.boxDesc, 1.57, 1.03);
    // Ligne 1 : de 0 a rows*L ; fraction de base1 - asc a base1 + desc.
    const base1 = b.boxAsc + s.top;
    const bottom1 = base1 + 1.03;
    const base2 = s.rows * LINE_EM + base1;
    expect(base2 - 1.57).toBeGreaterThan(bottom1);
  });

  it("photo, calcul ou courbe : hauteur totale arrondie a des lignes entieres", () => {
    for (const h of [10, LINE, 100, 333.3]) {
      const m = blockMargins(h, LINE);
      const total = m.top + h + m.bottom;
      expect(total / LINE).toBeCloseTo(Math.round(total / LINE), 6);
      expect(m.top).toBeGreaterThan(0);
      expect(m.bottom).toBeGreaterThanOrEqual(0);
    }
  });

  it("photo centree dans ses lignes ; la ligne du curseur qui la suit est comptee dedans", () => {
    for (const h of [10, LINE, 100, 333.3, 480]) {
      const m = blockMargins(h, LINE);
      expect(m.top).toBeCloseTo(m.bottom, 6);
      expect(m.top).toBeGreaterThanOrEqual(0.25 * LINE - 1e-6);
      const g = blockMargins(h, LINE, 0.25, true);
      expect(g.top).toBeCloseTo(m.top, 6);
      // Bloc + ligne fantome = le meme nombre de lignes que le bloc seul.
      expect(g.top + h + g.bottom + LINE).toBeCloseTo(m.top + h + m.bottom, 6);
    }
  });

  it("titres : ligne de base sur la derniere ligne de la grille occupee", () => {
    // Boite de rows lignes : base a rows*L/2 + 0.31*corps ; decalee de headingShift.
    for (const [scale, rows] of [[1.6, 2], [1.3, 2], [1.1, 1]] as const) {
      const base = (rows * LINE) / 2 + 0.31 * TEXT_FONT * scale + headingShift(scale, rows) * TEXT_FONT;
      expect(base).toBeCloseTo((rows - 1) * LINE + BASE, 2);
    }
  });
});

describe("curseur et encre", () => {
  it("clic sous la fin du texte : nombre de lignes vides a ajouter", () => {
    expect(linesToReach(100, 90, 34)).toBe(0);
    expect(linesToReach(100, 116, 34)).toBe(0);
    expect(linesToReach(100, 134, 34)).toBe(1);
    expect(linesToReach(100, 100 + 34 * 7 + 5, 34)).toBe(7);
    expect(linesToReach(0, 1e9, 34)).toBe(400);
  });

  it("ligne vide sur un schema : descend sous l'encre, par lignes entieres", () => {
    const top = TEXT_TOP + 3 * LINE;
    const schema = [{ x: 120, y: top + 5, w: 240, h: 160 }];
    const clear = clearOfInk(schema, top);
    expect(clear).toBeGreaterThanOrEqual(top + 5 + 160 - LINE * 0.3);
    expect((clear - top) / LINE).toBeCloseTo(Math.round((clear - top) / LINE), 6);
    expect(clearOfInk(schema, clear)).toBe(clear);
  });

  it("encre dans la marge, ou qui effleure la ligne : la ligne reste", () => {
    const top = TEXT_TOP + 3 * LINE;
    expect(clearOfInk([{ x: 2, y: top, w: 40, h: 60 }], top)).toBe(top);
    expect(clearOfInk([{ x: PAGE_W - 40, y: top, w: 30, h: 60 }], top)).toBe(top);
    expect(clearOfInk([{ x: 200, y: top + LINE - 3, w: 50, h: 40 }], top)).toBe(top);
    expect(clearOfInk([{ x: 200, y: top - 40, w: 50, h: 43 }], top)).toBe(top);
  });

  it("deux schemas empiles : la ligne passe sous les deux", () => {
    const top = TEXT_TOP;
    const clear = clearOfInk([
      { x: 100, y: top, w: 100, h: 80 },
      { x: 300, y: top + 90, w: 100, h: 80 },
    ], top);
    expect(clear).toBeGreaterThanOrEqual(top + 170 - LINE * 0.3);
  });
});

describe("l'encre suit le texte (shiftBelow)", () => {
  let n = 0;
  const st = (y0: number, y1: number, tool: Stroke["tool"] = "pen", x = 200): Stroke => ({
    id: `s${++n}`, color: "normal", width: 2, tool,
    points: [{ x, y: y0, p: 0.5, t: 0 }, { x: x + 20, y: y1, p: 0.5, t: 10 }],
  });

  it("le texte grandit : l'encre sous la ligne descend, ids gardes, celle au-dessus reste", () => {
    const above = st(100, 120), below = st(300, 400);
    const ink: InkBlock = { id: "i", type: "ink", strokes: [above, below], recognized: null, mode: "raw" };
    const blocks: Block[] = [ink];
    expect(shiftBelow(blocks, 200, LINE)).toBeCloseTo(LINE, 6);
    expect(ink.strokes[0]).toBe(above);
    expect(above.points[0].y).toBe(100);
    expect(below.id).toMatch(/^s/);
    expect(below.points[0].y).toBeCloseTo(300 + LINE, 1);
  });

  it("zone math : cadre et traits ensemble ; repere sous la ligne : suit aussi", () => {
    const zs = [st(300, 320), st(310, 330)];
    const zone: MathBlock = { id: "m", type: "math", strokes: zs, latex: "x", mode: "math", rect: { x: 190, y: 290, w: 60, h: 50 } } as MathBlock;
    const flag: FlagBlock = { id: "f", type: "flag", note: "?", rect: { x: 10, y: 300, w: 20, h: 44 } };
    const flagAbove: FlagBlock = { id: "g", type: "flag", note: "?", rect: { x: 10, y: 50, w: 20, h: 44 } };
    const blocks: Block[] = [zone, flag, flagAbove];
    shiftBelow(blocks, 200, 2 * LINE);
    expect(zone.rect!.y).toBeCloseTo(290 + 2 * LINE, 1);
    expect(zs[1].points[1].y).toBeCloseTo(330 + 2 * LINE, 1);
    expect(flag.rect!.y).toBeCloseTo(300 + 2 * LINE, 1);
    expect(flagAbove.rect!.y).toBe(50);
  });

  it("le texte raccourcit : l'encre remonte, jamais au-dessus de la ligne qui reste", () => {
    const s = st(300, 400);
    const blocks: Block[] = [{ id: "i", type: "ink", strokes: [s], recognized: null, mode: "raw" } as InkBlock];
    expect(shiftBelow(blocks, 250, -LINE)).toBeCloseTo(-LINE, 6);
    expect(s.points[0].y).toBeCloseTo(300 - LINE, 1);
    // Trait qui commence juste sous la ligne : remonte seulement jusqu'a y + dy.
    const t = st(205, 400);
    const b2: Block[] = [{ id: "j", type: "ink", strokes: [t], recognized: null, mode: "raw" } as InkBlock];
    const d = shiftBelow(b2, 200, -3 * LINE);
    expect(t.points[0].y).toBeGreaterThanOrEqual(200 - 3 * LINE - 2);
    expect(d).toBeLessThan(0);
  });

  it("annotations d'un PDF : jamais deplacees sans leur PDF ; rien sous la ligne : 0", () => {
    const a = st(500, 520);
    const pdf = { id: "p", type: "pdf", src: "x.pdf", page: 1, annotations: [a] } as PdfBlock;
    const blocks: Block[] = [pdf];
    expect(shiftBelow(blocks, 100, LINE)).toBe(0);
    expect(a.points[0].y).toBe(500);
  });
});
