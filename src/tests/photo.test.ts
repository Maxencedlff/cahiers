import { describe, it, expect, beforeEach } from "vitest";
import {
  cropLayout, cropKey, isPhotoImportKey, binarizeRadius, fitRatio, scaleQuad, roundQuad,
  readQuad, photoFileNames, finalMime, isHeic, unreadableMessage, loadBwChoice, saveBwChoice,
  ORIGINAL_MAX, type KeyLike,
} from "../core/image/photo";
import { DataUrlCache } from "../core/image/cache";
import type { Quad } from "../core/image/dewarp";

const key = (k: string, more: Partial<KeyLike> = {}): KeyLike => ({
  key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : undefined,
  ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...more,
});

describe("dialogue de redressement : mise en page", () => {
  it("une photo portrait de telephone tient en hauteur (coins du bas visibles)", () => {
    // Photo de 3000x4000 reduite a l'original garde (1920x2560).
    const l = cropLayout(1920, 2560, 1500, 900);
    expect(l.side).toBe(true);
    // Vue + titre + boutons dans les 84 % de la fenetre.
    expect(l.viewH + 176).toBeLessThanOrEqual(Math.floor(900 * 0.84));
    expect(l.viewW / l.viewH).toBeCloseTo(1920 / 2560, 2);
    // Vue + apercu a cote tiennent en largeur.
    expect(l.viewW + l.previewW + 16 + 76).toBeLessThanOrEqual(1500);
  });

  it("paysage : borne par la largeur ou la hauteur, jamais agrandie", () => {
    const l = cropLayout(2560, 1920, 1280, 800);
    expect(l.viewW + l.previewW + 16 + 76).toBeLessThanOrEqual(1280);
    expect(l.viewH + 176).toBeLessThanOrEqual(Math.floor(800 * 0.84));
    const petite = cropLayout(300, 200, 1500, 900);
    expect(petite.scale).toBe(1);
    expect(petite.viewW).toBe(300);
  });

  it("fenetre etroite : apercu en bandeau sous la photo", () => {
    const l = cropLayout(1920, 2560, 600, 800);
    expect(l.side).toBe(false);
    expect(l.viewW + 76).toBeLessThanOrEqual(600);
    expect(l.viewH + 176 + l.previewH + 16 + 56).toBeLessThanOrEqual(Math.floor(800 * 0.84));
  });
});

describe("dialogue de redressement : clavier", () => {
  it("Echap, Entree, N, R, S", () => {
    expect(cropKey(key("Escape"))).toBe("cancel");
    expect(cropKey(key("Enter"))).toBe("insert");
    expect(cropKey(key("n"))).toBe("bw");
    expect(cropKey(key("N", { shiftKey: true }))).toBe("bw");
    expect(cropKey(key("r"))).toBe("reset");
    expect(cropKey(key("s"))).toBe("skip");
  });

  it("ignore Ctrl/Alt, la repetition et les autres touches", () => {
    expect(cropKey(key("n", { ctrlKey: true }))).toBeNull();
    expect(cropKey(key("r", { altKey: true }))).toBeNull();
    expect(cropKey(key("Enter", { repeat: true }))).toBeNull();
    expect(cropKey(key("n", { repeat: true }))).toBeNull();
    expect(cropKey(key("x"))).toBeNull();
  });

  it("import : Alt+Maj+P, pas Alt+P (modele Puissance)", () => {
    expect(isPhotoImportKey(key("P", { altKey: true, shiftKey: true }))).toBe(true);
    expect(isPhotoImportKey(key("p", { altKey: true }))).toBe(false);
    expect(isPhotoImportKey(key("P", { altKey: true, shiftKey: true, ctrlKey: true }))).toBe(false);
  });
});

describe("photo : fichiers et formats", () => {
  it("couleur en JPEG, noir et blanc en PNG, original toujours en JPEG", () => {
    expect(photoFileNames("abc", false)).toEqual({ final: "abc.jpg", original: "abc.original.jpg" });
    expect(photoFileNames("abc", true)).toEqual({ final: "abc.png", original: "abc.original.jpg" });
    expect(finalMime(true)).toBe("image/png");
    expect(finalMime(false)).toBe("image/jpeg");
  });

  it("rayon de binarisation proportionnel : 12 a 1600 px, 4 a 520 px", () => {
    expect(binarizeRadius(1600, 1200)).toBe(12);
    expect(binarizeRadius(390, 520)).toBe(4);
    expect(binarizeRadius(10, 10)).toBe(3);
  });

  it("original reduit a 2560 px, jamais agrandi", () => {
    expect(fitRatio(3000, 4000, ORIGINAL_MAX)).toBeCloseTo(0.64, 5);
    expect(fitRatio(800, 600, ORIGINAL_MAX)).toBe(1);
  });

  it("quad : echelle, arrondi, lecture defensive", () => {
    const q: Quad = [{ x: 10, y: 20 }, { x: 110.123, y: 20 }, { x: 110, y: 220 }, { x: 10, y: 220.06 }];
    expect(scaleQuad(q, 2)[1]).toEqual({ x: 220.246, y: 40 });
    expect(roundQuad(q)[1]).toEqual({ x: 110.1, y: 20 });
    expect(roundQuad(q)[3]).toEqual({ x: 10, y: 220.1 });
    expect(readQuad(JSON.parse(JSON.stringify(q)))).toEqual(q);
    expect(readQuad(undefined)).toBeNull();
    expect(readQuad([{ x: 1, y: 2 }])).toBeNull();
    expect(readQuad([{ x: 1, y: 2 }, { x: 1, y: 2 }, { x: 1, y: "3" }, { x: 1, y: 2 }])).toBeNull();
  });

  it("HEIC : message qui cite le fichier et le reglage iPhone", () => {
    expect(isHeic("IMG_0001.HEIC")).toBe(true);
    expect(isHeic("photo.jpg", "image/heif")).toBe(true);
    expect(isHeic("photo.jpg", "image/jpeg")).toBe(false);
    const m = unreadableMessage("IMG_0001.HEIC");
    expect(m).toContain("IMG_0001.HEIC");
    expect(m).toContain("Le plus compatible");
    expect(unreadableMessage("notes.txt")).toContain("notes.txt");
  });
});

describe("noir et blanc : dernier choix retenu (D9)", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("couleur au premier import, puis le dernier choix", () => {
    expect(loadBwChoice()).toBe(false);
    saveBwChoice(true);
    expect(loadBwChoice()).toBe(true);
    saveBwChoice(false);
    expect(loadBwChoice()).toBe(false);
  });

  it("valeur abimee : couleur", () => {
    store.set("cahiers.photo.v1", "{pas du json");
    expect(loadBwChoice()).toBe(false);
  });
});

describe("cache des data URL", () => {
  it("rend ce qui a ete mis, oublie un dossier entier", () => {
    const c = new DataUrlCache(1000);
    c.set("Maths/Cours/assets/a.jpg", "data:a");
    c.set("Maths/Cours/assets/b.jpg", "data:b");
    c.set("Maths/Exos/assets/c.jpg", "data:c");
    expect(c.get("Maths/Cours/assets/a.jpg")).toBe("data:a");
    c.forget("Maths/Cours");
    expect(c.get("Maths/Cours/assets/a.jpg")).toBeUndefined();
    expect(c.get("Maths/Cours/assets/b.jpg")).toBeUndefined();
    expect(c.get("Maths/Exos/assets/c.jpg")).toBe("data:c");
    // Prefixe de nom, pas de dossier : garde.
    c.set("Maths/Cours2/x.png", "data:x");
    c.forget("Maths/Cours");
    expect(c.get("Maths/Cours2/x.png")).toBe("data:x");
  });

  it("borne en taille : la plus ancienne lue part la premiere", () => {
    const c = new DataUrlCache(30);
    c.set("a", "x".repeat(10));
    c.set("b", "y".repeat(10));
    c.get("a"); // a redevient la plus recente
    c.set("c", "z".repeat(15));
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
    expect(c.get("c")).toBeDefined();
    expect(c.bytes).toBe(25);
    // Plus grosse que tout le budget : pas gardee.
    c.set("d", "w".repeat(40));
    expect(c.get("d")).toBeUndefined();
  });

  it("une ecriture remplace l'entree", () => {
    const c = new DataUrlCache();
    c.set("a", "data:1");
    c.set("a", "data:22");
    expect(c.get("a")).toBe("data:22");
    expect(c.count).toBe(1);
    expect(c.bytes).toBe(7);
  });
});
