import { describe, it, expect, beforeEach } from "vitest";
import { orderedSymbols, recordSymbol, recordLatex, SYMBOLS } from "../core/symbols";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
});

describe("symboles par usage", () => {
  it("sans usage : ordre d'origine", () => {
    expect(orderedSymbols()).toEqual(SYMBOLS);
  });
  it("les plus utilises passent devant", () => {
    const t = Date.now();
    recordSymbol("\\eta", t); recordSymbol("\\eta", t); recordSymbol("\\Omega", t);
    const o = orderedSymbols(t).map((s) => s[1]);
    expect(o.slice(0, 3)).toEqual(["\\eta", "\\Omega", "\\alpha"]);
  });
  it("un vieil usage s'efface devant un usage recent", () => {
    const now = Date.now(), old = now - 90 * 24 * 3600 * 1000;
    for (let i = 0; i < 5; i++) recordSymbol("\\pi", old);
    recordSymbol("\\beta", now);
    expect(orderedSymbols(now)[0][1]).toBe("\\beta");
  });
  it("formules tapees : \\in ne compte pas dans \\infty, fusion sans double compte", () => {
    const t = Date.now();
    recordLatex("x \\to \\infty", "", t);
    const o = orderedSymbols(t).map((s) => s[1]);
    expect(o.slice(0, 2).sort()).toEqual(["\\infty", "\\to"].sort());
    expect(o.indexOf("\\in")).toBe(SYMBOLS.findIndex((s) => s[1] === "\\in"));
    recordLatex("\\beta \\cdot R_u \\gg R", "\\beta \\cdot R_u", t);
    const u = JSON.parse(store.get("cahiers.symbols.v1")!);
    expect(u["\\beta"]).toBeUndefined();
  });
});
