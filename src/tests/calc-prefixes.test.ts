import { describe, it, expect } from "vitest";
import { CalcEngine, siPrefixes, engFormat } from "../core/calc/engine";
import { mapKey, acceptText, isPrintable, KEYPAD } from "../ui/calculator/keys";

const num = (e: CalcEngine, expr: string): number => {
  const r = e.evaluate(expr);
  if (!r.ok) throw new Error(`${expr} : ${r.message}`);
  return Number(r.raw);
};

describe("prefixes d'ingenieur colles a un nombre", () => {
  it("valeurs usuelles", () => {
    const e = new CalcEngine();
    expect(num(e, "2,2k")).toBeCloseTo(2200, 9);
    expect(num(e, "10n")).toBeCloseTo(1e-8, 20);
    expect(num(e, "4,7µ")).toBeCloseTo(4.7e-6, 18);
    expect(num(e, "4,7u")).toBeCloseTo(4.7e-6, 18);
    expect(num(e, "100m")).toBeCloseTo(0.1, 12);
    expect(num(e, "1M")).toBe(1e6);
    expect(num(e, "3G")).toBe(3e9);
    expect(num(e, "2T")).toBe(2e12);
    expect(num(e, "22p")).toBeCloseTo(22e-12, 22);
  });
  it("le scenario du filtre RC, sans unite", () => {
    const e = new CalcEngine();
    expect(num(e, "1/(2*pi*2,2k*10n)")).toBeCloseTo(1 / (2 * Math.PI * 2200 * 1e-8), 6);
  });
  it("les unites existantes ne bougent pas", () => {
    const e = new CalcEngine();
    expect(e.evaluate("1/(2*pi*2,2kΩ*10nF)").ok && (e.evaluate("1/(2*pi*2,2kΩ*10nF)") as any).text).toMatch(/kHz/);
    const r = e.evaluate("5 V / 2 kΩ");
    expect(r.ok && r.text).toBe("2.5 mA");
    expect(siPrefixes("5mA").src).toBe("5mA");
    expect(siPrefixes("10nF").src).toBe("10nF");
    expect(siPrefixes("2.2kohm").src).toBe("2.2kohm");
  });
  it("ambiguites : metre espace, pi, e, notation scientifique, identifiants", () => {
    expect(siPrefixes("5 m").src).toBe("5 m");
    expect(siPrefixes("2pi").src).toBe("2pi");
    expect(siPrefixes("1e-3").src).toBe("1e-3");
    expect(siPrefixes("3e").src).toBe("3e");
    expect(siPrefixes("x2k").src).toBe("x2k");
    expect(siPrefixes("max(1,2)").src).toBe("max(1,2)");
    expect(siPrefixes("nthRoot(8,3)").src).toBe("nthRoot(8,3)");
    expect(siPrefixes("2k*3n").src).toBe("2e3*3e-9");
    expect(siPrefixes("(2.2k)").src).toBe("(2.2e3)");
    const e = new CalcEngine();
    expect(num(e, "1e-3*2")).toBeCloseTo(2e-3, 15);
    expect(num(e, "2e")).toBeCloseTo(2 * Math.E, 12);
  });
  it("une variable definie garde le produit", () => {
    const e = new CalcEngine();
    e.evaluate("k = 5");
    expect(num(e, "2k")).toBe(10);
    expect(num(e, "2M")).toBe(2e6);
  });
  it("Lu par le moteur montre la valeur lue", () => {
    const e = new CalcEngine();
    expect(e.toLatex("2,2k", true)).toBe("2{,}2\\,\\mathrm{k}");
    // Hors onglet Calcul (Litteral, Courbes) : lecture inchangee.
    expect(e.toLatex("2m")).toMatch(/m/);
  });
});

describe("lecture ingenieur des resultats", () => {
  it("unites : 4 chiffres, virgule, µ et Ω", () => {
    const e = new CalcEngine();
    const r = e.evaluate("1/(2*pi*2,2kΩ*10nF)");
    expect(r.ok && r.eng).toBe("7,234 kHz");
    const c = e.evaluate("4,7µF");
    expect(c.ok && c.eng).toBe("4,7 µF");
    const z = e.evaluate("2,2 kΩ");
    expect(z.ok && z.eng).toBe("2,2 kΩ");
  });
  it("nombres : seulement si la saisie avait un prefixe", () => {
    const e = new CalcEngine();
    const r = e.evaluate("1/(2*pi*2,2k*10n)");
    expect(r.ok && r.eng).toBe("7,234 k");
    const s = e.evaluate("2,2k*10n");
    expect(s.ok && s.eng).toBe("22 µ");
    const p = e.evaluate("2^10");
    expect(p.ok && p.eng).toBeUndefined();
    expect(engFormat(999.96e3, true)).toBe("1 M");
    expect(engFormat(0.5, true)).toBe("500 m");
    expect(engFormat(12, true)).toBe("12");
  });
  it("l'historique garde la lecture ingenieur", () => {
    const e = new CalcEngine();
    e.evaluate("2,2k*10n");
    expect(e.history.at(-1)!.eng).toBe("22 µ");
  });
});

describe("calc-fuite-frappe : toute touche imprimable reste a la calculatrice", () => {
  it("caracteres hors liste : refuses, jamais rendus a la page", () => {
    for (const c of ["é", "€", "§", "°", "@", "&", "#", "~"]) {
      expect(mapKey({ key: c }), c).toEqual({ kind: "reject", text: c });
    }
  });
  it("equivalents traduits", () => {
    expect(mapKey({ key: "×" })).toEqual({ kind: "insert", text: "*" });
    expect(mapKey({ key: "÷" })).toEqual({ kind: "insert", text: "/" });
    expect(mapKey({ key: "μ" })).toEqual({ kind: "insert", text: "µ" });
    expect(mapKey({ key: "Ω" })).toEqual({ kind: "insert", text: "Ω" });
  });
  it("AltGr : les caracteres sont pris, les raccourcis Ctrl+Alt+lettre non", () => {
    expect(mapKey({ key: "€", ctrlKey: true, altKey: true })).toEqual({ kind: "reject", text: "€" });
    expect(mapKey({ key: "e", ctrlKey: true, altKey: true })).toBeNull();
    expect(mapKey({ key: "{", ctrlKey: true, altKey: true })).toEqual({ kind: "insert", text: "{" });
  });
  it("noms de touches et raccourcis passent", () => {
    for (const key of ["Tab", "F1", "Shift", "Control", "Process", "Unidentified"]) expect(mapKey({ key }), key).toBeNull();
    expect(mapKey({ key: "l", ctrlKey: true })).toBeNull();
    expect(isPrintable("Ω")).toBe(true);
    expect(isPrintable("Tab")).toBe(false);
  });
  it("texte insere sans keydown (insertText, IME, collage)", () => {
    expect(acceptText("Ω*10nF)")).toEqual({ text: "Ω*10nF)", rejected: "" });
    expect(acceptText("2,2 kΩ × 3")).toEqual({ text: "2,2 kΩ * 3", rejected: "" });
    expect(acceptText("é1")).toEqual({ text: "1", rejected: "é" });
    expect(acceptText("√2")).toEqual({ text: "sqrt(2", rejected: "" });
  });
});

describe("pave : prefixes et Ω en 2nd", () => {
  it("chaque prefixe a sa touche, le pave ne grandit pas", () => {
    const seconds = KEYPAD.map((k) => k.second?.insert).filter(Boolean);
    for (const p of ["p", "n", "µ", "m", "k", "M", "G", "T", "Ω"]) expect(seconds, p).toContain(p);
    expect(KEYPAD).toHaveLength(39);
  });
});
