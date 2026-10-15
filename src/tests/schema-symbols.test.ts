import { describe, it, expect } from "vitest";
import {
  GRID, SYMBOLS, symbolByLetter, rotatePoint, rotatedSize, portsAt,
  type SymKey, type Rot,
} from "../core/schema/symbols";

const KEYS = Object.keys(SYMBOLS) as SymKey[];
const ROTS: Rot[] = [0, 90, 180, 270];
const DIPOLES: SymKey[] = ["R", "C", "Cp", "L", "D", "Dz", "LED", "K", "F", "Lamp", "I", "V", "Vdc", "Vm", "Am", "Pot", "X"];
/** Symboles a lettre (le circuit ouvert X n'en a pas : Maj+O). */
const LETTERED = KEYS.filter((k) => SYMBOLS[k].letter);
const ALLOWED_TAGS = new Set(["path", "line", "circle", "rect", "polyline"]);

describe("table des symboles", () => {
  it("27 symboles (26 lettres + circuit ouvert), cle coherente, grille de 10 px", () => {
    expect(GRID).toBe(10);
    expect(KEYS.length).toBe(27);
    expect(LETTERED.length).toBe(26);
    expect(symbolByLetter("O")?.key).toBe("X");
    for (const k of KEYS) expect(SYMBOLS[k].key).toBe(k);
  });

  it("body non vide, seulement des elements autorises, jamais de <text", () => {
    for (const k of KEYS) {
      const b = SYMBOLS[k].body;
      expect(b.length, k).toBeGreaterThan(0);
      expect(b.includes("<text"), k).toBe(false);
      const tags = [...b.matchAll(/<([a-z]+)/g)].map((m) => m[1]);
      expect(tags.length, k).toBeGreaterThan(0);
      for (const t of tags) expect(ALLOWED_TAGS.has(t), `${k} <${t}>`).toBe(true);
      expect(b.includes('stroke="currentColor"'), k).toBe(true);
      expect(b.includes("NaN"), k).toBe(false);
    }
  });

  it("boites entieres, bornes entieres dans la boite, noms uniques", () => {
    for (const k of KEYS) {
      const d = SYMBOLS[k];
      expect(Number.isInteger(d.w) && Number.isInteger(d.h), k).toBe(true);
      expect(d.ports.length, k).toBeGreaterThan(0);
      for (const p of d.ports) {
        expect(Number.isInteger(p.x) && Number.isInteger(p.y), `${k}.${p.name}`).toBe(true);
        expect(p.x >= 0 && p.x <= d.w && p.y >= 0 && p.y <= d.h, `${k}.${p.name}`).toBe(true);
      }
      expect(new Set(d.ports.map((p) => p.name)).size, k).toBe(d.ports.length);
    }
  });

  it("lettres uniques, minuscules, une seule touche", () => {
    const letters = LETTERED.map((k) => SYMBOLS[k].letter);
    expect(new Set(letters).size).toBe(LETTERED.length);
    for (const l of letters) expect(l).toMatch(/^[a-z]$/);
  });

  it("through designe deux bornes existantes", () => {
    for (const k of KEYS) {
      const d = SYMBOLS[k];
      if (!d.through) continue;
      const names = d.ports.map((p) => p.name);
      expect(names, k).toContain(d.through[0]);
      expect(names, k).toContain(d.through[1]);
      expect(d.through[0], k).not.toBe(d.through[1]);
    }
    expect(SYMBOLS.G.through).toBeUndefined();
    expect(SYMBOLS.O.through).toBeUndefined();
    expect(SYMBOLS.B.through).toEqual(["in", "out"]);
    expect(SYMBOLS.S.through).toEqual(["in", "out"]);
  });

  it("dipoles : horizontaux, longueur 4, a et b au milieu", () => {
    for (const k of DIPOLES) {
      const d = SYMBOLS[k];
      expect(d.through, k).toEqual(["a", "b"]);
      const a = d.ports.find((p) => p.name === "a")!;
      const b = d.ports.find((p) => p.name === "b")!;
      expect(d.w, k).toBe(4);
      expect(a, k).toEqual({ name: "a", x: 0, y: d.h / 2 });
      expect(b, k).toEqual({ name: "b", x: 4, y: d.h / 2 });
    }
    expect(SYMBOLS.Pot.ports.map((p) => p.name)).toEqual(["a", "b", "w"]);
  });

  it("bornes nommees des composants a plusieurs pattes", () => {
    const names = (k: SymKey) => SYMBOLS[k].ports.map((p) => p.name).sort();
    expect(names("A")).toEqual(["n", "p", "s"]);
    expect(names("Q")).toEqual(["b", "c", "e"]);
    expect(names("Qp")).toEqual(["b", "c", "e"]);
    expect(names("M")).toEqual(["d", "g", "s"]);
    expect(names("Mp")).toEqual(["d", "g", "s"]);
    expect(names("T")).toEqual(["a1", "a2", "b1", "b2"]);
    expect(names("S")).toEqual(["in", "in2", "in3", "out"]);
    // AOP : E- en haut, E+ en bas
    const at = (k: SymKey, n: string) => SYMBOLS[k].ports.find((p) => p.name === n)!;
    expect(at("A", "n").y).toBeLessThan(at("A", "p").y);
    // transistor : base a gauche, collecteur en haut, emetteur en bas
    expect(at("Q", "b").x).toBe(0);
    expect(at("Q", "c").y).toBe(0);
    expect(at("Q", "e").y).toBe(SYMBOLS.Q.h);
    expect(SYMBOLS.B).toMatchObject({ w: 6, h: 4 });
    expect(at("B", "in")).toEqual({ name: "in", x: 0, y: 2 });
    expect(at("B", "out")).toEqual({ name: "out", x: 6, y: 2 });
    expect(SYMBOLS.B.labelAt).toEqual({ x: 3, y: 2, anchor: "middle" });
  });
});

describe("symbolByLetter", () => {
  it("minuscule : le symbole de la lettre", () => {
    expect(symbolByLetter("r")?.key).toBe("R");
    expect(symbolByLetter("z")?.key).toBe("Dz");
    expect(symbolByLetter("e")?.key).toBe("LED");
    expect(symbolByLetter("u")?.key).toBe("Vdc");
    expect(symbolByLetter("g")?.key).toBe("G");
    for (const k of LETTERED) expect(symbolByLetter(SYMBOLS[k].letter)?.key).toBe(k);
  });
  it("Maj : variante, sinon meme symbole", () => {
    expect(symbolByLetter("C")?.key).toBe("Cp");
    expect(symbolByLetter("Q")?.key).toBe("Qp");
    expect(symbolByLetter("M")?.key).toBe("Mp");
    expect(symbolByLetter("V")?.key).toBe("Vm");
    expect(symbolByLetter("A")?.key).toBe("Am");
    expect(symbolByLetter("R")?.key).toBe("Pot");
    expect(symbolByLetter("Z")?.key).toBe("Dz");
    expect(symbolByLetter("L")?.key).toBe("L");
    expect(symbolByLetter("G")?.key).toBe("G");
  });
  it("hors table", () => {
    expect(symbolByLetter("")).toBeUndefined();
    expect(symbolByLetter("rr")).toBeUndefined();
    expect(symbolByLetter("1")).toBeUndefined();
    expect(symbolByLetter("é")).toBeUndefined();
  });
});

describe("rotatePoint", () => {
  it("sens horaire, ecran y vers le bas", () => {
    // boite 4 x 2 : le coin haut-gauche part en haut a droite a 90
    expect(rotatePoint(0, 0, 90, 4, 2)).toEqual({ x: 2, y: 0 });
    expect(rotatePoint(4, 1, 90, 4, 2)).toEqual({ x: 1, y: 4 });
    expect(rotatePoint(0, 0, 180, 4, 2)).toEqual({ x: 4, y: 2 });
    expect(rotatePoint(0, 0, 270, 4, 2)).toEqual({ x: 0, y: 4 });
    expect(rotatePoint(3, 1, 0, 4, 2)).toEqual({ x: 3, y: 1 });
  });
  it("quatre quarts de tour reviennent au point de depart", () => {
    const pts: [number, number][] = [[0, 0], [4, 1], [1.5, 0.3], [3, 2]];
    for (const [x0, y0] of pts) {
      let w = 4, h = 2, x = x0, y = y0;
      for (let i = 0; i < 4; i++) {
        ({ x, y } = rotatePoint(x, y, 90, w, h));
        ({ w, h } = rotatedSize(w, h, 90));
      }
      expect(x).toBeCloseTo(x0);
      expect(y).toBeCloseTo(y0);
    }
  });
  it("aller-retour pour chaque rotation", () => {
    for (const rot of ROTS) {
      const back = ((360 - rot) % 360) as Rot;
      const s = rotatedSize(6, 4, rot);
      for (const [x, y] of [[0, 1], [6, 2], [2.5, 3.5]] as [number, number][]) {
        const p = rotatePoint(x, y, rot, 6, 4);
        expect(p.x >= 0 && p.x <= s.w && p.y >= 0 && p.y <= s.h).toBe(true);
        const q = rotatePoint(p.x, p.y, back, s.w, s.h);
        expect(q.x).toBeCloseTo(x);
        expect(q.y).toBeCloseTo(y);
      }
    }
  });
});

describe("portsAt", () => {
  const pos = (ps: { name: string; x: number; y: number }[], n: string) => {
    const p = ps.find((q) => q.name === n)!;
    return [p.x, p.y];
  };
  it("rot 0 : simple decalage", () => {
    expect(portsAt("R", 10, 5, 0)).toEqual([{ name: "a", x: 10, y: 6 }, { name: "b", x: 14, y: 6 }]);
  });
  it("dipole tourne de 90 : bornes verticales, a en haut", () => {
    const ps = portsAt("R", 10, 5, 90);
    expect(pos(ps, "a")).toEqual([11, 5]);
    expect(pos(ps, "b")).toEqual([11, 9]);
  });
  it("dipole a 180 et 270", () => {
    expect(pos(portsAt("C", 0, 0, 180), "a")).toEqual([4, 1]);
    expect(pos(portsAt("C", 0, 0, 180), "b")).toEqual([0, 1]);
    expect(pos(portsAt("C", 0, 0, 270), "a")).toEqual([1, 4]);
    expect(pos(portsAt("C", 0, 0, 270), "b")).toEqual([1, 0]);
  });
  it("miroir : gauche-droite avant la rotation", () => {
    const m = portsAt("A", 0, 0, 0, true);
    expect(pos(m, "n")).toEqual([6, 1]);
    expect(pos(m, "p")).toEqual([6, 3]);
    expect(pos(m, "s")).toEqual([0, 2]);
    const m90 = portsAt("Q", 2, 3, 90, true);
    // b (0,2) -> miroir (4,2) -> 90 dans une boite 4x4 : (4-2, 4) = (2,4)
    expect(pos(m90, "b")).toEqual([4, 7]);
  });
  it("toutes les bornes restent entieres et dans la boite tournee", () => {
    for (const k of KEYS) {
      const d = SYMBOLS[k];
      for (const rot of ROTS) {
        for (const mirror of [false, true]) {
          const s = rotatedSize(d.w, d.h, rot);
          for (const p of portsAt(k, 7, -3, rot, mirror)) {
            expect(Number.isInteger(p.x) && Number.isInteger(p.y), `${k} ${rot}`).toBe(true);
            expect(p.x >= 7 && p.x <= 7 + s.w && p.y >= -3 && p.y <= -3 + s.h, `${k} ${rot}`).toBe(true);
          }
        }
      }
    }
  });
});
