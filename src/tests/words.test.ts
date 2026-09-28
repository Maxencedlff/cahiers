import { describe, it, expect } from "vitest";
import {
  wordsFromJiix, carryEdits, joinWords, convertedStrokeIds, dropStrokes, layoutWords, mmToUnits,
} from "../core/ink/words";
import { buildBatchBody, parseJiix } from "../core/ink/recognizer";
import { newStroke } from "../core/ink/stroke";
import type { InkWord, Stroke } from "../core/types";

/** Trait horizontal de x0 a x1, a la hauteur y. */
function bar(x0: number, x1: number, y: number): Stroke {
  const s = newStroke("definition", 2, "pen");
  s.points = [{ x: x0, y, p: 0.5, t: 0 }, { x: x1, y, p: 0.5, t: 10 }];
  return s;
}

/** Boite JIIX en millimetres a partir d'une boite en unites de page. */
function mm(x: number, y: number, w: number, h: number) {
  const k = 25.4 / 96;
  return { x: x * k, y: y * k, width: w * k, height: h * k };
}

const measure = (t: string, f: number) => t.length * f * 0.5;

describe("conversion mot a mot", () => {
  it("convertit les millimetres du JIIX en unites de page", () => {
    expect(mmToUnits(25.4)).toBeCloseTo(96);
  });

  it("rattache chaque trait au mot ecrit a cet endroit", () => {
    const a = bar(100, 180, 200), b = bar(110, 170, 210), c = bar(300, 380, 205);
    const words = wordsFromJiix({
      label: "le cours",
      words: [
        { label: "le", "bounding-box": mm(95, 180, 90, 40), candidates: ["le", "la"] },
        { label: " " },
        { label: "cours", "bounding-box": mm(295, 185, 90, 40) },
      ],
    }, [a, b, c]);
    expect(words.map((w) => w.label)).toEqual(["le", " ", "cours"]);
    expect(words[0].strokeIds).toEqual([a.id, b.id]);
    expect(words[2].strokeIds).toEqual([c.id]);
    expect(words[0].candidates).toEqual(["la"]);
    expect(words[0].box!.x).toBeCloseTo(95);
    expect(words[1].box).toBeUndefined();
  });

  it("un trait hors de toute boite (point sur un i) va au mot le plus proche", () => {
    const dot = bar(186, 188, 170);
    const words = wordsFromJiix({
      words: [{ label: "si", "bounding-box": mm(100, 180, 80, 40) },
              { label: " " },
              { label: "loin", "bounding-box": mm(600, 180, 80, 40) }],
    }, [dot]);
    expect(words[0].strokeIds).toEqual([dot.id]);
  });

  it("parseJiix fournit les mots quand le JIIX porte des boites", () => {
    const s = bar(100, 180, 200);
    const r = parseJiix("text", { label: "mot", words: [{ label: "mot", "bounding-box": mm(95, 180, 90, 40) }] }, [s]);
    expect(r.value).toBe("mot");
    expect(r.words?.[0].strokeIds).toEqual([s.id]);
    // Sans boites (ancienne reponse), pas de mots : l'affichage d'avant reste.
    expect(parseJiix("text", { label: "mot", words: [{ label: "mot" }] }).words).toBeUndefined();
  });

  it("demande les boites sur l'encre d'origine pour le texte", () => {
    const t = buildBatchBody("text", [bar(0, 10, 0)]) as any;
    expect(t.configuration.export.jiix["bounding-box"]).toBe(true);
    // DIGITAL_EDIT remet le texte en page : les boites ne tomberaient plus sur l'encre.
    expect(t.conversionState).toBeUndefined();
    const m = buildBatchBody("math", [bar(0, 10, 0)]) as any;
    expect(m.conversionState).toBe("DIGITAL_EDIT");
  });

  it("garde une correction a la main quand la page est reconvertie", () => {
    const before: InkWord[] = [
      { label: "Rieman", box: { x: 0, y: 0, w: 50, h: 20 }, strokeIds: ["a", "b"], edited: true },
    ];
    // L'utilisateur a ecrit un mot de plus : le moteur relit toute la page.
    const next: InkWord[] = [
      { label: "Kieman", box: { x: 0, y: 0, w: 50, h: 20 }, strokeIds: ["a", "b"], candidates: ["Rieman"] },
      { label: " ", strokeIds: [] },
      { label: "suite", box: { x: 80, y: 0, w: 50, h: 20 }, strokeIds: ["c"] },
    ];
    const out = carryEdits(before, next);
    expect(out[0].label).toBe("Rieman");
    expect(out[0].edited).toBe(true);
    expect(out[2].label).toBe("suite");
  });

  it("recompose la transcription avec espaces et retours a la ligne", () => {
    const w = (label: string): InkWord => ({ label, box: { x: 0, y: 0, w: 1, h: 1 }, strokeIds: ["x"] });
    const sep = (label: string): InkWord => ({ label, strokeIds: [] });
    expect(joinWords([w("serie"), sep(" "), w("entiere"), sep("\n"), w("rayon")]))
      .toBe("serie entiere\nrayon");
  });

  it("ne cache que les traits deja convertis", () => {
    const ids = convertedStrokeIds([
      { label: "mot", box: { x: 0, y: 0, w: 1, h: 1 }, strokeIds: ["a", "b"] },
      { label: " ", strokeIds: [] },
    ]);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("gommer toute l'encre d'un mot fait disparaitre le mot", () => {
    const words: InkWord[] = [
      { label: "un", box: { x: 0, y: 0, w: 1, h: 1 }, strokeIds: ["a"] },
      { label: " ", strokeIds: [] },
      { label: "deux", box: { x: 5, y: 0, w: 1, h: 1 }, strokeIds: ["b", "c"] },
    ];
    expect(joinWords(dropStrokes(words, new Set(["a"])))).toBe("deux");
    const partial = dropStrokes(words, new Set(["c"]));
    expect(partial[2].strokeIds).toEqual(["b"]);
    expect(dropStrokes(words, new Set(["a", "b", "c"]))).toEqual([]);
  });

  it("aligne les mots d'une ligne sur une taille et un axe communs", () => {
    const placed = layoutWords([
      { label: "une", box: { x: 100, y: 110, w: 60, h: 30 }, strokeIds: ["a"] },
      { label: " ", strokeIds: [] },
      { label: "Riemann", box: { x: 180, y: 95, w: 150, h: 60 }, strokeIds: ["b"] },
      { label: "\n", strokeIds: [] },
      { label: "fin", box: { x: 100, y: 300, w: 60, h: 40 }, strokeIds: ["c"] },
    ], measure);
    expect(placed).toHaveLength(3);
    expect(placed[0].fontSize).toBe(placed[1].fontSize);
    expect(placed[0].y).toBe(placed[1].y);
    expect(placed[2].y).toBeGreaterThan(placed[0].y + placed[0].fontSize);
    expect(placed[0].x).toBe(100);
  });

  it("ne fait jamais chevaucher deux mots tapes", () => {
    const placed = layoutWords([
      { label: "abcdefghij", box: { x: 100, y: 100, w: 40, h: 40 }, strokeIds: ["a"] },
      { label: " ", strokeIds: [] },
      { label: "z", box: { x: 150, y: 100, w: 20, h: 40 }, strokeIds: ["b"] },
    ], measure);
    const first = placed[0];
    expect(placed[1].x).toBeGreaterThanOrEqual(first.x + measure("abcdefghij", first.fontSize));
  });
});
