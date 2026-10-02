import { describe, it, expect } from "vitest";
import type { Block, CalcBlock, GraphBlock } from "../core/types";
import {
  isInTextBlock, orphanLiveIds, applyCalcSpec, applyGraphSpec, graphSpecOf, calcSpecOf, graphWidth, GRAPH_WIDTH,
} from "../core/liveblock";
import { restoreBlocks } from "../core/history";
import { indexPage } from "../core/storage/search";
import { calcTex, resultTex, exprTex, graphTex } from "../core/calc/live";
import { samplePlot, rootsInWindow, valueTable, extremaInWindow, plotWindow, readRange, isRange } from "../core/calc/plot";
import { CalcEngine, angleScope } from "../core/calc/engine";
import { ctrlCommand, SHORTCUTS } from "../core/shortcuts";
import type { Page } from "../core/types";

/**
 * Blocs vivants calc et graph (lot 9 : calc-blocs-morts, manque-blocs-vivants,
 * calc-fenetre-courbe partie M, envoi dans la page).
 */

const calc = (over: Partial<CalcBlock> = {}): CalcBlock => ({ id: "c1", type: "calc", expr: "7*6", result: "42", ...over });
const graph = (over: Partial<GraphBlock> = {}): GraphBlock => ({ id: "g1", type: "graph", fn: "sin(x)", domain: [-8, 8], ...over });

describe("blocs vivants dans le texte", () => {
  it("calc et graph sans rect vivent dans le texte, comme les photos", () => {
    expect(isInTextBlock(calc())).toBe(true);
    expect(isInTextBlock(graph())).toBe(true);
    expect(isInTextBlock(graph({ rect: { x: 0, y: 0, w: 10, h: 10 } }))).toBe(false);
    expect(isInTextBlock({ id: "i", type: "ink", strokes: [], recognized: null, mode: "raw" })).toBe(false);
  });

  it("un calcul retire du texte est oublie a l'ouverture, pas celui qui y est", () => {
    const blocks: Block[] = [
      { id: "t", type: "text", content: "avant ![](img:c1) apres" },
      calc(), graph(), graph({ id: "g2", rect: { x: 0, y: 0, w: 1, h: 1 } }),
      { id: "p", type: "image", src: "assets/p.png", ocr: null },
    ];
    expect(orphanLiveIds(blocks, "avant ![](img:c1) apres")).toEqual(["g1"]);
  });

  it("Ctrl+Z de l'encre ne touche ni aux calculs ni aux courbes du texte", () => {
    const now: Block[] = [calc({ result: "43" }), { id: "i", type: "ink", strokes: [], recognized: null, mode: "raw" }];
    const snap: Block[] = [calc({ result: "42" })];
    const out = restoreBlocks(now, snap);
    expect(out.filter((b) => b.type === "calc")).toHaveLength(1);
    expect((out.find((b) => b.type === "calc") as CalcBlock).result).toBe("43");
    expect(out.some((b) => b.type === "ink")).toBe(false);
  });

  it("la recherche ignore un calcul retire du texte", () => {
    const page = (content: string): Page => ({
      version: 1, id: "p", created: "", modified: "",
      blocks: [{ id: "t", type: "text", content }, calc({ expr: "fcoupure*2", result: "4" })],
    });
    expect(indexPage(page("x ![](img:c1)")).blocks.some((b) => b.id === "c1")).toBe(true);
    expect(indexPage(page("x")).blocks.some((b) => b.id === "c1")).toBe(false);
  });
});

describe("mise a jour sur place", () => {
  it("calc : expression, resultat et mode d'angle (RAD jamais ecrit)", () => {
    const b = calc();
    expect(applyCalcSpec(b, { expr: "sin(30)", result: "0.5", angle: "DEG" })).toBe(true);
    expect(b).toMatchObject({ expr: "sin(30)", result: "0.5", angle: "DEG" });
    expect(applyCalcSpec(b, { expr: "sin(30)", result: "0.5", angle: "DEG" })).toBe(false);
    applyCalcSpec(b, { expr: "1+1", result: "2", angle: "RAD" });
    expect("angle" in b).toBe(false);
    expect(calcSpecOf(calc({ result: 42 }))).toEqual({ expr: "7*6", result: "42", angle: "RAD" });
  });

  it("graph : fenetre ymin/ymax optionnelle, retiree en auto", () => {
    const b = graph();
    expect(applyGraphSpec(b, { fn: "x^2", domain: [-2, 2], range: [-1, 5], angle: "RAD" })).toBe(true);
    expect(b.range).toEqual([-1, 5]);
    applyGraphSpec(b, { fn: "x^2", domain: [-2, 2], angle: "RAD" });
    expect("range" in b).toBe(false);
    // Ancien fichier avec une fenetre inversee : ignoree.
    expect(graphSpecOf(graph({ range: [5, 1] })).range).toBeUndefined();
    expect(graphSpecOf(graph({ range: [1, 5], angle: "DEG" }))).toMatchObject({ range: [1, 5], angle: "DEG" });
  });

  it("largeur d'une courbe : defaut, ancien rect, bornee a la page", () => {
    expect(graphWidth(graph(), 900)).toBe(GRAPH_WIDTH);
    expect(graphWidth(graph({ rect: { x: 80, y: 0, w: 420, h: 200 } }), 900)).toBe(420);
    expect(graphWidth(graph({ width: 5000 }), 900)).toBe(772);
    expect(graphWidth(graph({ width: 10 }), 900)).toBe(240);
  });
});

describe("rendu LaTeX des blocs (toLatex, jamais le texte brut)", () => {
  it("7*6 et sqrt(2) relus par le moteur", () => {
    expect(calcTex("7*6", "42")).toBe("7\\cdot6 = 42");
    expect(exprTex("sqrt(2)")).toContain("\\sqrt{2}");
    expect(exprTex("sqrt(2)")).not.toContain("sqrt(");
  });
  it("prefixes d'ingenieur et virgule decimale", () => {
    const tex = calcTex("1/(2*pi*2,2k*10n)", "7234.31559568");
    expect(tex).toContain("\\frac");
    expect(tex).toContain("\\pi");
    expect(tex).toContain("7234{,}31559568");
    expect(tex).not.toContain("2,2k");
  });
  it("resultats : exposant, complexe, texte", () => {
    expect(resultTex("1.5e-12")).toBe("1{,}5 \\cdot 10^{-12}");
    expect(resultTex("-3")).toBe("-3");
    expect(resultTex("2 + 3i")).toContain("i");
    expect(resultTex("f(x) définie")).toContain("\\text{");
    expect(resultTex(null)).toBe("");
  });
  it("titre d'une courbe", () => {
    expect(graphTex("y = sin(x)*x/2")).toMatch(/^y = .*\\sin/);
  });
});

describe("courbes en degres (l'onglet Courbes suit le mode DEG)", () => {
  it("sin(x) en DEG vaut 1 a x = 90", () => {
    const p = samplePlot("sin(x)", 0, 180, 3, "x", "DEG");
    expect(p.samples![1].y).toBeCloseTo(1, 12);
    const r = samplePlot("sin(x)", 0, 180, 3, "x");
    expect(r.samples![1].y).toBeCloseTo(Math.sin(90), 12);
  });
  it("racines, tableau et extremums en DEG", () => {
    const roots = rootsInWindow("sin(x)", -200, 200, "x", "DEG");
    expect(roots.map((r) => Math.round(r))).toEqual([-180, 0, 180]);
    expect(Number(valueTable("cos(x)", 60, 60, 1, "x", "DEG")[0].y)).toBeCloseTo(0.5, 6);
    const ext = extremaInWindow("sin(x)", 0, 360, "x", 800, "DEG");
    expect(ext.map((e) => [e.kind, Math.round(e.x)])).toEqual([["max", 90], ["min", 270]]);
  });
  it("angleScope : rien en RAD, meme trigonometrie que le calcul en DEG", () => {
    expect(angleScope("RAD")).toEqual({});
    const e = new CalcEngine();
    e.angleMode = "DEG";
    const r = e.evaluate("asin(1)");
    expect(r.ok && Number(r.raw)).toBeCloseTo(90, 12);
    expect(Object.keys(angleScope("DEG"))).toContain("sin");
    expect(Object.keys(angleScope("DEG"))).not.toContain("__add");
  });
});

describe("fenetre verticale ymin/ymax", () => {
  it("fenetre fixee a la main, sinon auto", () => {
    const s = samplePlot("x+100", -8, 8, 200).samples!;
    expect(plotWindow(s, [0, 50])).toEqual({ yMin: 0, yMax: 50 });
    const auto = plotWindow(s, undefined);
    expect(auto.yMin).toBeLessThan(93);
    expect(auto.yMax).toBeGreaterThan(107);
    expect(plotWindow(s, [5, 1])).toEqual(auto);
    expect(isRange([1, 2])).toBe(true);
    expect(isRange([2, 2])).toBe(false);
  });
  it("lecture des champs", () => {
    expect(readRange(null, null, true, true)).toEqual({});
    expect(readRange(-1, 5, false, false)).toEqual({ range: [-1, 5] });
    expect(readRange(-1, null, false, true).error).toBeTruthy();
    expect(readRange(5, 1, false, false).error).toBeTruthy();
  });
});

describe("raccourci d'envoi", () => {
  it("Ctrl+Maj+L envoie, Ctrl+L ouvre toujours la calculatrice", () => {
    const k = (shift: boolean) => ({ key: shift ? "L" : "l", ctrlKey: true, shiftKey: shift, altKey: false, metaKey: false });
    expect(ctrlCommand(k(true))).toBe("sendCalc");
    expect(ctrlCommand(k(false))).toBe("calc");
    expect(SHORTCUTS.filter((s) => s.keys === "Ctrl+Maj+L")).toHaveLength(1);
  });
});
