import { describe, it, expect } from "vitest";
import {
  parsePageRange, rangeLabel, hashBytes, pdfAssetName, findPdfAsset, isPdfFile, fitPdfRect,
  backdropPixels, pdfBlockOf, makePdfPage, joinTextItems, locateTerms, placeTextItem,
} from "../core/pdf/pdf";
import { PAGE_H, PAGE_W } from "../core/ink/sheet";
import { indexPage, searchableText } from "../core/storage/search";
import { migratePage, serializePage } from "../core/storage/repo";
import { parseQuery } from "../core/text/find";
import type { Page } from "../core/types";

describe("pdf : choix des pages", () => {
  it("toutes, ou vide", () => {
    expect(parsePageRange("toutes", 3)).toEqual({ pages: [1, 2, 3] });
    expect(parsePageRange("  ", 2)).toEqual({ pages: [1, 2] });
  });
  it("plages, liste, fin ouverte, sans doublon", () => {
    expect(parsePageRange("1-3, 5", 6)).toEqual({ pages: [1, 2, 3, 5] });
    expect(parsePageRange("4-", 6)).toEqual({ pages: [4, 5, 6] });
    expect(parsePageRange("2;2-3", 6)).toEqual({ pages: [2, 3] });
    expect(parsePageRange("2 à 4", 6)).toEqual({ pages: [2, 3, 4] });
    expect(parsePageRange("3–1", 6)).toEqual({ pages: [3, 2, 1] });
  });
  it("erreurs en francais", () => {
    const over = parsePageRange("1-9", 4);
    expect("error" in over && over.error).toMatch(/4 pages/);
    const bad = parsePageRange("abc", 4);
    expect("error" in bad && bad.error).toMatch(/1-3, 5/);
    const zero = parsePageRange("0", 4);
    expect("error" in zero && zero.error).toMatch(/commencent à 1/);
  });
  it("libelle court", () => {
    expect(rangeLabel([1, 2, 3, 5, 7, 8])).toBe("1-3, 5, 7-8");
  });
});

describe("pdf : dedoublonnage", () => {
  const a = new TextEncoder().encode("%PDF-1.4 contenu A");
  const b = new TextEncoder().encode("%PDF-1.4 contenu B");
  it("meme contenu, meme empreinte ; contenu different, autre empreinte", () => {
    expect(hashBytes(a)).toBe(hashBytes(new Uint8Array(a)));
    expect(hashBytes(a)).not.toBe(hashBytes(b));
    expect(hashBytes(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("nom lisible sous Windows, avec l'empreinte", () => {
    const n = pdfAssetName("TD 3 : filtrés passe-bas.PDF", "0123456789abcdef");
    expect(n).toBe("TD-3-filtres-passe-bas-0123456789ab.pdf");
    expect(pdfAssetName("???.pdf", "0123456789abcdef")).toBe("document-0123456789ab.pdf");
  });
  it("retrouve le PDF deja importe, quel que soit son nom d'origine", () => {
    const h = hashBytes(a);
    const files = ["photo.png", pdfAssetName("Poly.pdf", h)];
    expect(findPdfAsset(files, h)).toBe(files[1]);
    expect(findPdfAsset(files, hashBytes(b))).toBeNull();
  });
  it("reconnait un PDF sans type MIME", () => {
    expect(isPdfFile({ name: "cours.PDF", type: "" })).toBe(true);
    expect(isPdfFile({ name: "x", type: "application/pdf" })).toBe(true);
    expect(isPdfFile({ name: "x.png", type: "image/png" })).toBe(false);
  });
});

describe("pdf : mise a l'echelle A4", () => {
  it("A4 portrait : remplit la feuille en hauteur, centre", () => {
    const r = fitPdfRect(595.28, 841.89);
    expect(r.y).toBe(0);
    expect(r.h).toBeCloseTo(PAGE_H, 0);
    expect(r.x).toBeCloseTo((PAGE_W - r.w) / 2, 0);
    expect(r.w).toBeLessThanOrEqual(PAGE_W);
  });
  it("paysage : ajuste en largeur, en haut, place dessous pour les notes", () => {
    const r = fitPdfRect(841.89, 595.28);
    expect(r).toMatchObject({ x: 0, y: 0, w: PAGE_W });
    expect(r.h).toBeCloseTo(PAGE_W * 595.28 / 841.89, 0);
    expect(r.h).toBeLessThan(PAGE_H / 2 + 100);
  });
  it("jamais plus grand que la feuille, taille absurde = feuille entiere", () => {
    const r = fitPdfRect(100, 5000);
    expect(r.h).toBeLessThanOrEqual(PAGE_H);
    expect(fitPdfRect(0, 0)).toEqual({ x: 0, y: 0, w: PAGE_W, h: PAGE_H });
  });
  it("rendu a la taille exacte de la zone du canvas", () => {
    const px = backdropPixels({ x: 0, y: 0, w: PAGE_W, h: 636 }, 1800);
    expect(px).toEqual({ w: 1800, h: 1272 });
  });
});

describe("pdf : page de l'appli", () => {
  const page = makePdfPage({ page: "p1", block: "b1" }, "2026-10-02T08:00:00.000Z", {
    src: "assets/TD3-0123456789ab.pdf", page: 3, size: { w: 595.276, h: 841.89 },
    text: "Filtre passe-bas RC\nfréquence de coupure", name: "TD3.pdf",
  });
  it("un bloc pdf en fond, a l'echelle A4", () => {
    const b = pdfBlockOf(page)!;
    expect(b).toMatchObject({ type: "pdf", src: "assets/TD3-0123456789ab.pdf", page: 3, annotations: [] });
    expect(b.rect!.h).toBeCloseTo(PAGE_H, 0);
    expect(b.size).toEqual({ w: 595.3, h: 841.9 });
  });
  it("le texte du PDF est indexe (Ctrl+K)", () => {
    expect(searchableText(pdfBlockOf(page)!)).toContain("coupure");
    const idx = indexPage(page);
    expect(idx.blocks.some((x) => x.type === "pdf" && x.text.includes("passe-bas"))).toBe(true);
  });
  it("aller-retour disque : le bloc et ses champs restent", () => {
    const back = migratePage(JSON.parse(serializePage(page)) as Page);
    expect(pdfBlockOf(back)).toMatchObject({ page: 3, text: page.blocks[0].type === "pdf" ? page.blocks[0].text : "" });
  });
});

describe("pdf : texte extrait", () => {
  it("lignes gardees, blancs ramenes, mot coupe recolle", () => {
    const t = joinTextItems([
      { str: "Exercice 2 :", hasEOL: false }, { str: "  ", hasEOL: false }, { str: "filtre", hasEOL: true },
      { str: "pont de Wheat-", hasEOL: true }, { str: "stone équilibré", hasEOL: true },
      { str: "Gain en dB-", hasEOL: true }, { str: "Bode", hasEOL: false },
    ]);
    expect(t).toBe("Exercice 2 : filtre\npont de Wheatstone équilibré\nGain en dB-\nBode");
  });
  it("retrouve le mot cherche sur la feuille", () => {
    const items = [
      { str: "Énoncé", box: { x: 10, y: 10, w: 50, h: 12 } },
      { str: "Fréquence de coupure", box: { x: 10, y: 40, w: 120, h: 12 } },
    ];
    expect(locateTerms(items, parseQuery("frequence").terms)).toEqual(items[1].box);
    expect(locateTerms(items, parseQuery("absent").terms)).toBeNull();
  });
  it("place un morceau de texte en unites de page", () => {
    // Viewport a 2 px par unite de page ; texte de 20 px de haut, ligne de base a y = 100.
    const b = placeTextItem([20, 0, 0, 20, 40, 100], 200, { x: 12, y: 0, w: 876, h: 1240 }, 2);
    expect(b.x).toBe(32);
    expect(b.y).toBe(40);
    expect(b.w).toBe(100);
  });
});
