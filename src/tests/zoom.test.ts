import { describe, it, expect } from "vitest";
import {
  ZOOM_MIN, ZOOM_MAX, MAX_CANVAS_PX, clampZoom, stepZoom, wheelFactor, pinchOf,
  anchorAt, scrollToAnchor, previewTransform, zoomLabel, inkDensity,
} from "../core/zoom";
import {
  MM, PAPERS, MIN_GAP_PX, SEYES_MARGIN, isPaperKind, paperOf, paperLines, paperDots,
} from "../core/paper";
import { PAGE_W, PAGE_H } from "../core/ink/sheet";

describe("zoom : bornes et paliers", () => {
  it("borne entre 50 % et 300 %", () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(1.734)).toBe(1.73);
  });

  it("un pinch qui finit pres de 100 % retombe sur 100 %", () => {
    expect(clampZoom(1.03)).toBe(1);
    expect(clampZoom(0.97)).toBe(1);
    expect(clampZoom(1.06)).toBe(1.06);
  });

  it("Ctrl+= et Ctrl+- passent d'un palier a l'autre, bornes comprises", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.3, 1)).toBe(1.5);
    expect(stepZoom(1.3, -1)).toBe(1.25);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    // Aller-retour : on retombe sur 100 %.
    expect(stepZoom(stepZoom(1, 1), -1)).toBe(1);
  });

  it("Ctrl+molette : vers le haut grossit, un cran ~ 15 %", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1.1);
    expect(wheelFactor(-100)).toBeLessThan(1.2);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1, 6);
    // Molette en lignes (deltaMode 1) : 3 lignes ~ un cran.
    expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-120), 6);
    // Une rafale enorme reste bornee.
    expect(wheelFactor(-100000)).toBeLessThan(1.6);
  });

  it("pinch : facteur = rapport des ecarts, deplacement du milieu", () => {
    const p = pinchOf([{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 60, y: 110 }, { x: 260, y: 110 }]);
    expect(p.scale).toBeCloseTo(2);
    expect(p.dx).toBeCloseTo(10);
    expect(p.dy).toBeCloseTo(10);
    // Doigts confondus au depart : pas de division par zero.
    expect(pinchOf([{ x: 5, y: 5 }, { x: 5, y: 5 }], [{ x: 0, y: 0 }, { x: 90, y: 0 }]).scale).toBe(1);
  });
});

describe("zoom centre sur le point vise", () => {
  it("le point de page sous les doigts y revient apres le changement d'echelle", () => {
    // Feuille a 100 % (k = 1) dont le coin est en (40, 30) ; pinch en (440, 330).
    const focus = { x: 440, y: 330 };
    const a = anchorAt(focus, { x: 40, y: 30 }, 1);
    expect(a).toEqual({ x: 400, y: 300 });
    // Apres le passage a 200 %, la feuille est en (18, 30) (centree autrement).
    const d = scrollToAnchor(a, { x: 18, y: 30 }, 2, focus);
    // 18 + 800 - dx = 440 ; 30 + 600 - dy = 330.
    expect(d).toEqual({ dx: 378, dy: 300 });
  });

  it("aller-retour 100 % -> 200 % -> 100 % : defilement net nul", () => {
    const focus = { x: 300, y: 200 };
    const a = anchorAt(focus, { x: 50, y: 0 }, 1);
    const d1 = scrollToAnchor(a, { x: 50, y: 0 }, 2, focus);
    // Apres defilement, la feuille a 200 % est decalee de -d1.
    const sheet2 = { x: 50 - d1.dx, y: 0 - d1.dy };
    const a2 = anchorAt(focus, sheet2, 2);
    expect(a2.x).toBeCloseTo(a.x);
    expect(a2.y).toBeCloseTo(a.y);
    const d2 = scrollToAnchor(a2, sheet2, 1, focus);
    expect(d1.dx + d2.dx).toBeCloseTo(0);
    expect(d1.dy + d2.dy).toBeCloseTo(0);
  });

  it("apercu CSS : grossit autour du point vise, dans le repere de l'element", () => {
    const t = previewTransform({ x: 500, y: 400 }, { x: 100, y: 50 }, 1.5, 12, -4);
    expect(t.origin).toBe("400px 350px");
    expect(t.transform).toBe("translate(12px, -4px) scale(1.5)");
  });

  it("libelle de l'indicateur", () => {
    expect(zoomLabel(1.5)).toBe("150 %");
    expect(zoomLabel(0.67)).toBe("67 %");
  });
});

describe("densite du canvas", () => {
  it("a 100 %, la densite de l'ecran (plafonnee a 2)", () => {
    expect(inkDensity(900, 1240, 1.5)).toBe(1.5);
    expect(inkDensity(900, 1240, 3)).toBe(2);
  });

  it("jamais plus de MAX_CANVAS_PX pixels, meme a 300 %", () => {
    const w = 2700, h = 3720;
    const d = inkDensity(w, h, 2, 3);
    expect(w * d * h * d).toBeLessThanOrEqual(MAX_CANVAS_PX * 1.01);
    expect(d).toBeGreaterThan(1);
  });

  it("en defilement, une page loin de l'ecran garde son poids de 100 %", () => {
    const far = inkDensity(1800, 2480, 1.5, 2, false);
    expect(far).toBe(0.75);
    // Meme nombre de pixels qu'a 100 % en densite 1,5.
    expect(1800 * far).toBeCloseTo(900 * 1.5);
    // Zoom reduit : rien ne change.
    expect(inkDensity(450, 620, 1.5, 0.5, false)).toBe(1.5);
  });
});

describe("fonds de page (D12)", () => {
  const whole = { x: 0, y: 0, w: PAGE_W, h: PAGE_H };

  it("six fonds, « uni » par defaut, valeur inconnue lue comme « uni »", () => {
    expect(PAPERS.map((p) => p.kind)).toEqual(["uni", "ligne", "seyes", "quadrille", "millimetre", "points"]);
    expect(paperOf(undefined, "Cours")).toBe("uni");
    expect(paperOf({ Cours: "seyes" }, "Cours")).toBe("seyes");
    expect(paperOf({ Cours: "hexagones" }, "Cours")).toBe("uni");
    expect(paperOf(["seyes"], "0")).toBe("uni");
    expect(isPaperKind("quadrille")).toBe(true);
    expect(isPaperKind("Quadrille")).toBe(false);
  });

  it("uni : rien a peindre", () => {
    expect(paperLines("uni", whole)).toEqual([]);
    expect(paperDots("uni", whole)).toEqual([]);
  });

  it("quadrille : carreaux de 5 mm, une A4 = 42 colonnes", () => {
    const [g] = paperLines("quadrille", whole);
    expect(g.weight).toBe("main");
    expect(g.vertical[0]).toBeCloseTo(5 * MM);
    expect(g.vertical.length).toBe(41); // 5, 10 ... 205 mm (0 et 210 = bords)
    expect(g.vertical[1] - g.vertical[0]).toBeCloseTo(PAGE_W / 42);
  });

  it("seules les lignes de la zone sale sont rendues", () => {
    const [g] = paperLines("quadrille", { x: 100, y: 200, w: 30, h: 30 });
    for (const x of g.vertical) { expect(x).toBeGreaterThanOrEqual(100); expect(x).toBeLessThanOrEqual(130); }
    for (const y of g.horizontal) { expect(y).toBeGreaterThanOrEqual(200); expect(y).toBeLessThanOrEqual(230); }
    expect(g.vertical.length).toBeGreaterThan(0);
  });

  it("seyes : interligne 2 mm sans doubler les lignes de 8 mm, une marge", () => {
    const lines = paperLines("seyes", whole);
    const fine = lines.find((l) => l.weight === "fine")!;
    const main = lines.find((l) => l.weight === "main")!;
    const margin = lines.find((l) => l.weight === "margin")!;
    expect(fine.horizontal[0]).toBeCloseTo(2 * MM);
    for (const y of main.horizontal) expect(fine.horizontal.some((f) => Math.abs(f - y) < 0.01)).toBe(false);
    expect(fine.vertical).toEqual([]);
    expect(margin.vertical).toEqual([SEYES_MARGIN]);
    expect(main.vertical.some((x) => Math.abs(x - SEYES_MARGIN) < 0.01)).toBe(false);
  });

  it("millimetre : trois forces, chaque ligne une seule fois", () => {
    const lines = paperLines("millimetre", whole);
    expect(lines.map((l) => l.weight)).toEqual(["fine", "main", "strong"]);
    const all = lines.flatMap((l) => l.vertical);
    expect(new Set(all.map((x) => x.toFixed(3))).size).toBe(all.length);
    expect(all.length).toBe(209);
  });

  it("selon l'echelle : les millimetres disparaissent quand ils deviennent un gris uniforme", () => {
    // Feuille de 300 px de large (k = 1/3) : 1 mm = 1,4 px.
    const small = paperLines("millimetre", whole, 1 / 3);
    expect(small.map((l) => l.weight)).toEqual(["main", "strong"]);
    expect(MM / 3).toBeLessThan(MIN_GAP_PX);
    // Seyes reduit : l'interligne part, les grands carreaux restent.
    expect(paperLines("seyes", whole, 0.4).map((l) => l.weight)).toEqual(["main", "margin"]);
    // Au zoom, tout reste.
    expect(paperLines("millimetre", whole, 2).length).toBe(3);
  });

  it("ligne : tous les 8 mm, horizontales seules", () => {
    const [l] = paperLines("ligne", whole);
    expect(l.vertical).toEqual([]);
    expect(l.horizontal[0]).toBeCloseTo(8 * MM);
  });

  it("points : un tous les 5 mm, dans la zone", () => {
    const dots = paperDots("points", { x: 0, y: 0, w: 10 * MM + 0.1, h: 5 * MM + 0.1 });
    expect(dots).toHaveLength(2);
    expect(dots[0].x).toBeCloseTo(5 * MM);
  });
});
