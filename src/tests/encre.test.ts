import { describe, it, expect, afterEach } from "vitest";
import { newStroke, roundPoint, cachedBounds, strokeBounds, HIGHLIGHT_FACTOR } from "../core/ink/stroke";
import { PAGE_H, INK_MARGIN, inkBottom, sheetHeight, growForStroke, shrinkToInk } from "../core/ink/sheet";
import { gestureTool, isPalm, PALM_DELAY_MS } from "../core/ink/pointer";
import { PageHistory, applyStrokeCommand, type StrokeAdded } from "../core/history";
import { colorOf, labelOf, shortcutOf } from "../core/palette";
import { loadSettings } from "../core/settings";
import type { Block, InkBlock, InkPoint, Page, Stroke } from "../core/types";

function stroke(points: [number, number][], tool: Stroke["tool"] = "pen", width = 2): Stroke {
  const s = newStroke("normal", width, tool);
  s.points = points.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 5 }));
  return s;
}

function page(strokes: Stroke[], height?: number): Page {
  const ink: InkBlock = { id: "ink", type: "ink", strokes, recognized: null, mode: "raw" };
  return { version: 1, id: "p", created: "", modified: "", blocks: [ink], ...(height ? { height } : {}) };
}

describe("feuille plus haute que l'A4", () => {
  it("une page normale garde la hauteur A4", () => {
    expect(sheetHeight(page([stroke([[10, 100], [50, 1200]])]))).toBe(PAGE_H);
  });

  it("un trait sous l'A4 garde ses coordonnees et allonge la feuille", () => {
    const s = stroke([[100, 1450], [200, 1550], [300, 1500]]);
    const p = page([s]);
    expect(inkBottom(p.blocks)).toBe(1551);
    expect(sheetHeight(p)).toBe(1551 + INK_MARGIN);
    // Rien n'est ramene sur le bord bas (l'ancien bug : y = PAGE_H).
    expect(s.points.map((q) => q.y)).toEqual([1450, 1550, 1500]);
  });

  it("le texte tape allonge aussi la feuille", () => {
    expect(sheetHeight(page([]), 1780.4)).toBe(1781);
  });

  it("la hauteur notee dans la page fait foi a la reouverture", () => {
    expect(sheetHeight(page([], 1900))).toBe(1900);
  });

  it("growForStroke note la hauteur seulement sous l'A4", () => {
    const p = page([]);
    expect(growForStroke(p, stroke([[0, 100], [0, 1230]]))).toBe(false);
    expect(p.height).toBeUndefined();
    expect(growForStroke(p, stroke([[0, 1300], [0, 1400]]))).toBe(true);
    expect(p.height).toBe(1401 + INK_MARGIN);
    // Un trait plus haut ne reduit jamais la feuille.
    expect(growForStroke(p, stroke([[0, 1250], [0, 1260]]))).toBe(false);
    expect(p.height).toBe(1401 + INK_MARGIN);
  });
});

describe("outil du geste", () => {
  const pen = (button: number, buttons: number) => ({ pointerType: "pen", button, buttons });

  it("le bout gomme d'un stylet MPP gomme", () => {
    expect(gestureTool(pen(5, 32), "pen")).toBe("eraser");
    expect(gestureTool(pen(0, 32), "highlighter")).toBe("eraser");
  });

  it("le bouton lateral gomme", () => {
    expect(gestureTool(pen(2, 2), "pen")).toBe("eraser");
    // Bouton maintenu pendant le survol, puis contact : buttons = 1 + 2.
    expect(gestureTool(pen(0, 3), "pen")).toBe("eraser");
  });

  it("la pointe garde l'outil choisi, la souris aussi", () => {
    expect(gestureTool(pen(0, 1), "highlighter")).toBe("highlighter");
    expect(gestureTool(pen(0, 1), "region")).toBe("region");
    expect(gestureTool({ pointerType: "mouse", button: 2, buttons: 2 }, "pen")).toBe("pen");
  });
});

describe("rejet de paume", () => {
  it("le doigt est ignore pendant et juste apres le stylet", () => {
    expect(isPalm(1000, true, -Infinity)).toBe(true);
    expect(isPalm(1000, false, 1000 - PALM_DELAY_MS + 1)).toBe(true);
    expect(isPalm(1000, false, 1000 - PALM_DELAY_MS - 1)).toBe(false);
    expect(isPalm(1000, false, -Infinity)).toBe(false);
  });
});

describe("format des points", () => {
  it("arrondit x, y au dixieme, p au centieme, t a la ms", () => {
    const p: InkPoint = { x: 54.038911484533976, y: 107.59240997478105, p: 0.6639291644096375, t: 44.5 };
    expect(roundPoint(p)).toEqual({ x: 54, y: 107.6, p: 0.66, t: 45 });
  });

  it("une pression infime ne devient pas 0 (lu comme sans pression)", () => {
    expect(roundPoint({ x: 0, y: 0, p: 0.002, t: 0 }).p).toBe(0.01);
    expect(roundPoint({ x: 0, y: 0, p: 0, t: 0 }).p).toBe(0);
  });

  it("garde l'inclinaison quand elle existe", () => {
    expect(roundPoint({ x: 0, y: 0, p: 0.5, t: 0, tiltX: 12.4, tiltY: -3.6 }))
      .toEqual({ x: 0, y: 0, p: 0.5, t: 0, tiltX: 12, tiltY: -4 });
  });

  it("une page arrondie et compacte pese bien moins lourd", () => {
    const pts: InkPoint[] = Array.from({ length: 200 }, (_, i) => ({
      x: 54.038911484533976 + i * 0.731, y: 107.59240997478105 + Math.sin(i) * 3.1,
      p: 0.6639291644096375, t: i * 4.9,
    }));
    const before = JSON.stringify(pts, null, 2).length;
    const after = JSON.stringify(pts.map(roundPoint)).length;
    expect(after).toBeLessThan(before / 3);
  });
});

describe("bornes en cache", () => {
  it("suivent un trait qui s'allonge et un trait simplifie", () => {
    const s = stroke([[0, 0], [10, 0]]);
    expect(cachedBounds(s)).toEqual(strokeBounds(s));
    s.points.push({ x: 50, y: 20, p: 0.5, t: 0 });
    expect(cachedBounds(s)).toEqual(strokeBounds(s));
    s.points = [s.points[0], s.points[2]];
    expect(cachedBounds(s)).toEqual(strokeBounds(s));
    expect(cachedBounds(s, 3)).toEqual(strokeBounds(s, 3));
  });

  it("une marge differente ne fausse ni n'evince les bornes", () => {
    const s = stroke([[5, 5], [40, 30]], "pen", 3);
    for (const pad of [1, 2, 0, 1, 2, 0]) expect(cachedBounds(s, pad)).toEqual(strokeBounds(s, pad));
    // Un trait vide reste une boite vide, meme avec une marge.
    const empty = stroke([]);
    expect(cachedBounds(empty, 2)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("hauteur notee qui redescend", () => {
  it("encre gommee sous l'A4 : la page revient a l'A4", () => {
    const low = stroke([[0, 1400], [10, 1500]]);
    const p = page([low]);
    growForStroke(p, low);
    expect(p.height).toBe(1501 + INK_MARGIN);
    (p.blocks[0] as InkBlock).strokes = [];
    expect(shrinkToInk(p)).toBe(true);
    expect(p.height).toBeUndefined();
    expect(sheetHeight(p)).toBe(PAGE_H);
  });

  it("redescend jusqu'a l'encre restante, jamais en dessous", () => {
    const mid = stroke([[0, 1300], [10, 1350]]), low = stroke([[0, 1400], [10, 1600]]);
    const p = page([mid, low]);
    growForStroke(p, low);
    (p.blocks[0] as InkBlock).strokes = [mid];
    expect(shrinkToInk(p)).toBe(true);
    expect(p.height).toBe(1351 + INK_MARGIN);
    // Rien a reduire : aucun changement.
    expect(shrinkToInk(p)).toBe(false);
    expect(shrinkToInk(page([mid]))).toBe(false);
  });
});

describe("annulation par commandes de trait", () => {
  const blocksWith = (...strokes: Stroke[]): Block[] => page(strokes).blocks;

  it("annuler un trait le retire, retablir le remet", () => {
    const a = stroke([[0, 0], [10, 0]]), b = stroke([[0, 20], [10, 20]]);
    const h = new PageHistory();
    let blocks = blocksWith(a);
    const cmd: StrokeAdded = { op: "add", blockId: "ink", stroke: b };
    h.push("p", cmd);
    (blocks[0] as InkBlock).strokes.push(b);
    // L'etat courant n'est pas serialise pour une commande.
    let serialized = 0;
    const current = () => { serialized++; return JSON.stringify(blocks); };
    const e = h.undo("p", current);
    expect(e).toBe(cmd);
    blocks = applyStrokeCommand(blocks, cmd, "undo");
    expect((blocks[0] as InkBlock).strokes.map((s) => s.id)).toEqual([a.id]);
    expect(h.redo("p", current)).toBe(cmd);
    blocks = applyStrokeCommand(blocks, cmd, "redo");
    expect((blocks[0] as InkBlock).strokes.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(serialized).toBe(0);
  });

  it("instantanes et commandes se melangent dans la meme pile", () => {
    const h = new PageHistory();
    const cmd: StrokeAdded = { op: "add", blockId: "ink", stroke: stroke([[0, 0], [1, 1]]) };
    h.push("p", "avant-gomme");
    h.push("p", cmd);
    expect(h.undo("p", () => "x")).toBe(cmd);
    expect(h.undo("p", () => "apres")).toBe("avant-gomme");
    expect(h.redo("p", () => "avant-gomme")).toBe("apres");
    expect(h.redo("p", () => "y")).toBe(cmd);
  });

  it("le trait annule sort aussi des mots reconnus", () => {
    const a = stroke([[0, 0], [10, 0]]), b = stroke([[20, 0], [30, 0]]);
    const blocks = blocksWith(a, b);
    const ink = blocks[0] as InkBlock;
    ink.words = [
      { label: "loi", strokeIds: [a.id], box: { x: 0, y: 0, w: 10, h: 10 } },
      { label: " ", strokeIds: [] },
      { label: "Ohm", strokeIds: [b.id], box: { x: 20, y: 0, w: 10, h: 10 } },
    ];
    ink.recognized = "loi Ohm";
    applyStrokeCommand(blocks, { op: "add", blockId: "ink", stroke: b }, "undo");
    expect(ink.strokes).toEqual([a]);
    expect(ink.recognized).toBe("loi");
  });

  it("retablir recree le bloc d'encre s'il a disparu", () => {
    const s = stroke([[0, 0], [1, 1]]);
    const out = applyStrokeCommand([], { op: "add", blockId: "ink9", stroke: s }, "redo");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "ink9", type: "ink", strokes: [s] });
  });
});

describe("encre neutre et surligneur", () => {
  it("'normal' est noir au stylo, gris au surligneur", () => {
    expect(colorOf("normal")).toBe("#16181d");
    expect(colorOf("normal", "highlighter")).toBe("#9ca3af");
    expect(labelOf("normal")).toBe("Normal");
    expect(shortcutOf("normal")).toBe("0");
  });

  it("les anciennes couleurs restent lues", () => {
    expect(colorOf("definition")).toBe("#2563eb");
    expect(labelOf("theoreme")).toBe("Théorème");
    expect(shortcutOf("perso")).toBe("5");
  });

  it("le surligneur est une bande, pas un trait", () => {
    expect(2.2 * HIGHLIGHT_FACTOR).toBeGreaterThan(14);
  });
});

describe("reglages de l'encre", () => {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  afterEach(() => { store.clear(); delete (globalThis as { localStorage?: unknown }).localStorage; });

  it("encre noire par defaut, le doigt navigue", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    const s = loadSettings();
    expect(s.color).toBe("normal");
    expect(s.textColor).toBeNull();
    expect(s.touchWrites).toBe(false);
  });

  it("anciens reglages : l'encre suit la couleur du texte (une seule pastille)", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    store.set("cahiers.settings.v1", JSON.stringify({ color: "definition", textColor: null }));
    expect(loadSettings().color).toBe("normal");
    store.set("cahiers.settings.v1", JSON.stringify({ color: "definition", textColor: "theoreme", penSeen: true }));
    const s = loadSettings();
    expect(s.color).toBe("theoreme");
    // Ancienne detection du stylet : oubliee, le doigt navigue.
    expect((s as unknown as { penSeen?: boolean }).penSeen).toBeUndefined();
    expect(s.touchWrites).toBe(false);
  });
});
