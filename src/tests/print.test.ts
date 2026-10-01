import { describe, expect, it } from "vitest";
import { findCut, merge, planPrint, PRINT_FIT, PRINT_ZOOM_MAX, type Span } from "../core/print";

/** Lignes de texte de 20 px tous les 30 px, de `from` a `to`. */
function lines(from: number, to: number): Span[] {
  const out: Span[] = [];
  for (let y = from; y + 20 <= to; y += 30) out.push({ top: y, bottom: y + 20 });
  return out;
}

describe("export PDF : decoupage en feuilles A4", () => {
  it("une page qui tient sur une A4 part telle quelle", () => {
    expect(planPrint(900, 26, lines(40, 880))).toEqual({ zoom: 1, cuts: [0, 900] });
  });

  it("un peu trop haute : legerement reduite, jamais sous ~92 %", () => {
    const p = planPrint(1100, 26, []);
    expect(p.cuts).toEqual([0, 1100]);
    expect(p.zoom).toBeCloseTo(PRINT_FIT / 1126, 5);
    expect(p.zoom).toBeGreaterThan(PRINT_FIT / PRINT_ZOOM_MAX - 1e-9);
  });

  it("une page longue n'est jamais reduite : elle est coupee", () => {
    const p = planPrint(2430, 26, lines(40, 2400));
    expect(p.zoom).toBe(1);
    expect(p.cuts[0]).toBe(0);
    expect(p.cuts[p.cuts.length - 1]).toBe(2430);
    expect(p.cuts.length).toBe(4);
    for (let i = 1; i < p.cuts.length; i++) {
      expect(p.cuts[i] - p.cuts[i - 1]).toBeLessThanOrEqual(PRINT_FIT - 26);
    }
  });

  it("la coupe passe entre deux lignes, jamais au travers", () => {
    const text = lines(40, 2400);
    const p = planPrint(2430, 26, text);
    for (const c of p.cuts.slice(1, -1)) {
      expect(text.some((l) => l.top < c && c < l.bottom)).toBe(false);
    }
  });

  it("une photo n'est pas coupee : la feuille s'arrete avant elle", () => {
    const photo = { top: 800, bottom: 1300 };
    const p = planPrint(2000, 26, [...lines(40, 790), photo, ...lines(1310, 1990)]);
    expect(p.cuts[1]).toBeLessThanOrEqual(797);
    expect(p.cuts[1]).toBeGreaterThan(500);
  });

  it("evite l'encre si possible, sinon coupe dedans plutot que dans le texte", () => {
    // Schema a l'encre de 700 a 1100 : la coupe passe au-dessus.
    const text = lines(40, 640);
    const ink = [{ top: 700, bottom: 1100 }];
    const p = planPrint(1800, 26, text, ink);
    expect(p.cuts[1]).toBeLessThan(700);
    expect(text.some((l) => l.top < p.cuts[1] && p.cuts[1] < l.bottom)).toBe(false);
    // Encre sur toute la hauteur : on coupe dans l'encre, pas dans le texte.
    const full = planPrint(1800, 26, text.concat(lines(700, 1790)), [{ top: 0, bottom: 1800 }]);
    expect(full.cuts.length).toBeGreaterThan(2);
  });

  it("photo plus haute qu'une feuille : coupee a la hauteur maximale", () => {
    const p = planPrint(2600, 26, [{ top: 20, bottom: 2580 }]);
    expect(p.cuts[1]).toBe(PRINT_FIT - 26);
  });

  it("findCut et merge", () => {
    const spans = merge([{ top: 50, bottom: 80 }, { top: 10, bottom: 30 }, { top: 78, bottom: 120 }]);
    expect(spans).toEqual([{ top: 10, bottom: 30 }, { top: 50, bottom: 120 }]);
    expect(findCut(0, 100, spans)).toBe(40);
    expect(findCut(60, 100, spans)).toBeNull();
    expect(findCut(0, 200, spans)).toBe(200);
    expect(findCut(0, 9, spans)).toBe(8);
  });

  it("interligne de quelques pixels : la coupe passe au milieu", () => {
    // Lignes de 19 px tous les 24 px (police 16 px, interligne 1,5).
    const text: Span[] = [];
    for (let y = 30; y < 2000; y += 24) text.push({ top: y, bottom: y + 19 });
    const p = planPrint(2000, 26, text);
    expect(p.cuts.length).toBeGreaterThan(2);
    for (const c of p.cuts.slice(1, -1)) {
      expect(text.some((l) => l.top <= c && c <= l.bottom)).toBe(false);
    }
  });
});
