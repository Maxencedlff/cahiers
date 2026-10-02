import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXTRA, KEEP_MARGIN, MOUNT_MARGIN, SizeMemo, anchorIndex, anchoredScroll, estimateSize,
  isFastScroll, measureSize, pageAt, planWindow, slotHeight, visibleRange, type Box,
} from "../core/virtual";
import { PAGE_H } from "../core/ink/sheet";

/** Emplacements empiles (hauteurs + ecart), vus depuis un defilement `scroll`. */
function stack(heights: number[], gap = 12, scroll = 0): (i: number) => Box {
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) { tops.push(y); y += h + gap; }
  return (i) => ({ top: tops[i] - scroll, bottom: tops[i] + heights[i] - scroll });
}

describe("virtualisation : pages a l'ecran", () => {
  const H = Array.from({ length: 100 }, () => 1000);

  it("trouve les pages qui coupent la vue (recherche dichotomique)", () => {
    expect(visibleRange(100, stack(H), 0, 900)).toEqual([0, 0]);
    expect(visibleRange(100, stack(H), 0, 1100)).toEqual([0, 1]);
    // Defilement au milieu de la page 57 (indice 56).
    const s = 56 * 1012 + 500;
    expect(visibleRange(100, stack(H, 12, s), 0, 900)).toEqual([56, 57]);
    // L'ecart entre deux pages n'est a personne.
    expect(visibleRange(100, stack(H, 12, 1001), 0, 5)).toBeNull();
    expect(visibleRange(100, stack(H, 12, 1001), 0, 20)).toEqual([1, 1]);
  });

  it("vue vide, au-dela des pages, liste vide : rien", () => {
    expect(visibleRange(0, stack([]), 0, 900)).toBeNull();
    expect(visibleRange(3, stack([100, 100, 100], 0, 400), 0, 900)).toBeNull();
    expect(visibleRange(3, stack([100, 100, 100]), 50, 50)).toBeNull();
  });

  it("pages de hauteurs differentes (ancienne page longue)", () => {
    const hs = [1000, 3000, 1000, 1000];
    expect(visibleRange(4, stack(hs, 0, 1500), 0, 900)).toEqual([1, 1]);
    expect(visibleRange(4, stack(hs, 0, 3500), 0, 900)).toEqual([1, 2]);
  });
});

describe("virtualisation : fenetre de pages montees", () => {
  it("monte les pages a l'ecran d'abord, puis une page de marge de chaque cote", () => {
    const p = planWindow(100, [56, 57], []);
    expect(MOUNT_MARGIN).toBe(1);
    expect(p.mount).toEqual([56, 57, 58, 55]);
    expect(p.unmount).toEqual([]);
  });

  it("ne remonte pas ce qui l'est deja", () => {
    expect(planWindow(100, [56, 57], [55, 56, 57]).mount).toEqual([58]);
  });

  it("bords de l'intercalaire", () => {
    expect(planWindow(100, [0, 0], []).mount).toEqual([0, 1]);
    expect(planWindow(3, [2, 2], []).mount).toEqual([2, 1]);
    expect(planWindow(1, [0, 0], []).mount).toEqual([0]);
  });

  it("demonte au-dela de KEEP_MARGIN pages (petit aller-retour : rien ne bouge)", () => {
    expect(KEEP_MARGIN).toBeGreaterThanOrEqual(MOUNT_MARGIN);
    const p = planWindow(100, [56, 56], [10, 11, 53, 54, 55, 56, 57, 58, 59]);
    expect(p.unmount).toEqual([10, 11, 53, 59]);
    // Une page revenue a 2 pages de l'ecran reste montee.
    expect(planWindow(100, [56, 56], [54, 58]).unmount).toEqual([]);
  });

  it("une page retenue (focus, ecriture en attente) n'est jamais demontee", () => {
    const p = planWindow(100, [90, 91], [3, 4, 90, 91], (i) => i === 4);
    expect(p.unmount).toEqual([3]);
  });

  it("pages disparues (intercalaire raccourci) : demontees", () => {
    expect(planWindow(5, [3, 4], [3, 4, 7]).unmount).toEqual([7]);
  });

  it("zoom a 50 % : beaucoup de pages a l'ecran, toutes montees", () => {
    expect(planWindow(100, [10, 14], []).mount).toEqual([10, 11, 12, 13, 14, 15, 9]);
  });

  it("defilement rapide : on attend l'arret avant de construire", () => {
    expect(isFastScroll(null, 40)).toBe(false);
    expect(isFastScroll(40, 41)).toBe(false);
    expect(isFastScroll(40, 43)).toBe(true);
    expect(isFastScroll(43, 40)).toBe(true);
  });
});

describe("virtualisation : hauteurs", () => {
  it("une A4 a 100 % (k = 1) : feuille + numero", () => {
    const s = estimateSize(undefined, null);
    expect(s).toEqual({ sheet: PAGE_H, extra: DEFAULT_EXTRA, measured: false });
    expect(slotHeight(s, 1)).toBe(PAGE_H + DEFAULT_EXTRA);
  });

  it("la feuille suit le zoom, le numero non", () => {
    const m = measureSize(1242, 1274, 1);
    expect(m).toEqual({ sheet: 1242, extra: 32, measured: true });
    expect(slotHeight(m, 2)).toBe(2484 + 32);
    expect(slotHeight(m, 0.62)).toBe(Math.round(1242 * 0.62 + 32));
  });

  it("mesure a un autre zoom : ramenee en unites de page", () => {
    const m = measureSize(1242 * 1.5, 1242 * 1.5 + 40, 1.5);
    expect(m.sheet).toBeCloseTo(1242, 6);
    expect(m.extra).toBeCloseTo(40, 6);
  });

  it("estimation : hauteur memorisee, sinon une page typique deja mesuree, sinon A4", () => {
    const typical = measureSize(1242, 1274, 1);
    expect(estimateSize(3720, typical)).toEqual({ sheet: 3720, extra: 32, measured: false });
    expect(estimateSize(undefined, typical)).toEqual({ sheet: 1242, extra: 32, measured: false });
    expect(estimateSize(NaN, null).sheet).toBe(PAGE_H);
    expect(estimateSize(0, null).sheet).toBe(PAGE_H);
  });

  it("memoire des hauteurs bornee, la plus ancienne part", () => {
    const m = new SizeMemo(2);
    m.set("a", 1240); m.set("b", 2480); m.set("a", 1300); m.set("c", 3000);
    expect(m.get("b")).toBeUndefined();
    expect(m.get("a")).toBe(1300);
    expect(m.get("c")).toBe(3000);
    m.set("d", NaN);
    expect(m.size).toBe(2);
  });
});

describe("virtualisation : ancrage du defilement", () => {
  it("ancre = premiere page dont le bas passe sous le haut de la vue", () => {
    const H = Array.from({ length: 10 }, () => 1000);
    expect(anchorIndex(10, stack(H, 12, 0), 0)).toBe(0);
    expect(anchorIndex(10, stack(H, 12, 3500), 0)).toBe(3);
    expect(anchorIndex(10, stack(H, 12, 99999), 0)).toBe(-1);
    expect(anchorIndex(0, stack([]), 0)).toBe(-1);
  });

  it("une page au-dessus grandit a son montage : le texte lu ne bouge pas", () => {
    // Pages 0..9 estimees a 1000 ; on lit la page 5 a 200 px de son haut.
    const est = Array.from({ length: 10 }, () => 1000);
    const scroll = 5 * 1012 + 200;
    const a = anchorIndex(10, stack(est, 12, scroll), 0);
    expect(a).toBe(5);
    const before = stack(est, 12, scroll)(a).top;
    // La page 3, montee, mesure en fait 3000 (ancienne page longue).
    const real = est.slice(); real[3] = 3000;
    const after = stack(real, 12, scroll)(a).top;
    const next = anchoredScroll(scroll, before, after);
    expect(next - scroll).toBe(2000);
    expect(stack(real, 12, next)(a).top).toBe(before);
  });

  it("page en vue : la derniere dont le haut a passe la ligne", () => {
    const H = Array.from({ length: 10 }, () => 1000);
    expect(pageAt(10, stack(H, 12, 0), 80)).toBe(0);
    expect(pageAt(10, stack(H, 12, 1012 - 79), 80)).toBe(1);
    expect(pageAt(10, stack(H, 12, 1012 - 81), 80)).toBe(0);
    expect(pageAt(10, stack(H, 12, 99999), 80)).toBe(9);
    expect(pageAt(0, stack([]), 80)).toBe(0);
  });

  it("une page au-dessus retrecit : on remonte d'autant, jamais sous 0", () => {
    expect(anchoredScroll(5000, -200, -1200)).toBe(4000);
    expect(anchoredScroll(100, 0, -500)).toBe(0);
  });
});
