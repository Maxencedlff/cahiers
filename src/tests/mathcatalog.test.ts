import { describe, it, expect } from "vitest";
import katex from "katex";
import { validateLatex } from "mathlive/ssr";
import {
  ALL_KEYS, CATALOG, RIBBON_TABS, SHIFTED, isTemplate, keyTitle, keyUnits, searchKeys, shiftOf, symbolChar, tabOf,
} from "../core/mathcatalog";
import { ribbonCapacity, RIBBON_MIN_W } from "../core/chrome";
import { MATH_TEMPLATES } from "../core/templates";
import { SYMBOLS, symbolName } from "../core/symbols";
import { GREEK_WORDS, mathWordsAtEnd, symbolAtEnd } from "../core/text/automath";
import { shortcutHint } from "../core/text/hint";

/** LaTeX tel qu'il sera rendu une fois les cases remplies. */
const filled = (tex: string) => tex.replace(/#[?@]/g, "{x}");

/** Raccourcis de MathLive ajoutes par textdoc.ts (FIELD_SHORTCUTS), dans une formule ouverte. */
const FIELD_WORDS = new Set(["dot", "ddot", "Lap"]);

describe("catalogue du ruban des formules", () => {
  it("chaque touche se rend dans KaTeX sans erreur (apercu et formule inseree)", () => {
    for (const k of ALL_KEYS) {
      for (const tex of [k.label ?? k.insert, filled(k.insert)]) {
        expect(() => katex.renderToString(tex, { throwOnError: true }), `${k.name} : ${tex}`).not.toThrow();
      }
    }
  });

  it("chaque formule inseree est comprise par MathLive (pas de commande inconnue)", () => {
    for (const k of ALL_KEYS) expect(validateLatex(filled(k.insert)), `${k.name} : ${k.insert}`).toEqual([]);
  });

  it("noms uniques, en clair (pas de LaTeX), insertions uniques", () => {
    const names = ALL_KEYS.map((k) => k.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const inserts = ALL_KEYS.map((k) => k.insert);
    expect(new Set(inserts).size).toBe(inserts.length);
    for (const k of ALL_KEYS) {
      expect(k.name).not.toMatch(/\\/);
      expect(k.name.length).toBeGreaterThan(1);
      expect(symbolName(k.insert)).toBe(k.name);
    }
  });

  it("ordre : modeles d'abord (ceux d'Alt+lettre, dans leur ordre), puis calcul et grec", () => {
    expect(CATALOG.map((s) => s.id).slice(0, 3)).toEqual(["models", "calculus", "greek"]);
    expect(CATALOG[0].keys.map((k) => k.insert)).toEqual(MATH_TEMPLATES.map((t) => t.insert));
    expect(new Set(CATALOG.map((s) => s.id)).size).toBe(CATALOG.length);
    for (const s of CATALOG) expect(s.keys.length).toBeGreaterThan(0);
  });

  it("assez riche pour un etudiant ingenieur : grec complet, ensembles, physique", () => {
    expect(ALL_KEYS.length).toBeGreaterThanOrEqual(150);
    const has = (tex: string) => ALL_KEYS.some((k) => k.insert === tex || k.insert.startsWith(`${tex}_`));
    for (const t of ["\\mu", "\\sigma", "\\rho", "\\varphi", "\\psi", "\\chi", "\\tau", "\\xi", "\\zeta", "\\kappa", "\\nu",
      "\\Phi", "\\Psi", "\\Sigma", "\\Pi", "\\Lambda", "\\Gamma", "\\Theta", "\\oint", "\\nabla", "\\equiv", "\\propto",
      "\\mathbb{N}", "\\mathbb{C}", "\\nexists", "\\hbar", "\\angle", "\\perp", "\\parallel", "\\Re", "\\mapsto", "\\emptyset"]) {
      expect(has(t), t).toBe(true);
    }
  });

  it("symboles seuls : ceux de la frecence ; un caractere court et non latin pour le texte", () => {
    expect(SYMBOLS.map(([, ins]) => ins)).toEqual(ALL_KEYS.filter((k) => !isTemplate(k.insert)).map((k) => k.insert));
    for (const k of ALL_KEYS) {
      if (!k.char) continue;
      expect(isTemplate(k.insert), k.name).toBe(false);
      expect([...k.char].length).toBeLessThanOrEqual(2);
      expect(k.char).not.toMatch(/^[A-Za-z0-9]/);
      expect(symbolChar(k.insert)).toBe(k.char);
    }
    expect(symbolChar("\\alpha")).toBe("α");
    expect(symbolChar("\\cdot")).toBeUndefined();
  });

  it("chaque raccourci de frappe annonce existe vraiment", () => {
    for (const k of ALL_KEYS) {
      const t = k.typed;
      if (!t) continue;
      const why = `${k.name} : « ${t} »`;
      if (FIELD_WORDS.has(t)) continue;
      if (k.char && t in GREEK_WORDS) { expect(GREEK_WORDS[t], why).toBe(k.char); continue; }
      const pair = symbolAtEnd(`a ${t}`);
      if (pair) { expect(pair.endsWith(k.char ?? "?"), why).toBe(true); continue; }
      const word = mathWordsAtEnd(`x ∈ ${t}`, true);
      if (word) { expect(word.endsWith(k.char ?? "?"), why).toBe(true); continue; }
      expect(shortcutHint(`a ${t}`)?.word, why).toBe(t);
    }
  });

  it("infobulle : le nom, puis Alt+lettre ou le mot a taper", () => {
    const omega = ALL_KEYS.find((k) => k.insert === "\\omega")!;
    expect(keyTitle(omega)).toBe("oméga (pulsation) (tape « omega »)");
    const frac = ALL_KEYS.find((k) => k.altKey === "f")!;
    expect(keyTitle(frac)).toBe("Fraction (Alt+F)");
  });

  it("recherche : nom, raccourci, section, grec et accents plies ; le plus probable d'abord", () => {
    const inserts = (q: string) => searchKeys(q).map((k) => k.insert);
    expect(inserts("omega").slice(0, 2)).toEqual(["\\omega", "\\Omega"]);
    expect(inserts("ω")).toContain("\\omega");
    // « fl » : la fleche d'abord (Entree la pose), toute la section ensuite, le flux Φ aussi.
    const fl = inserts("fl");
    expect(fl[0]).toBe("\\to");
    expect(fl).toEqual(expect.arrayContaining(CATALOG.find((s) => s.id === "arrows")!.keys.map((k) => k.insert)));
    expect(fl).toContain("\\Phi");
    expect(fl.indexOf("\\Phi")).toBeGreaterThan(fl.indexOf("\\leftarrow"));
    expect(inserts("norme")).toContain("\\left\\lVert #?\\right\\rVert");
    expect(inserts("integrale double")).toEqual(["\\iint_{#?}#?"]);
    expect(inserts("ensemble vide")).toEqual(["\\emptyset"]);
    expect(searchKeys("")).toEqual([]);
    expect(searchKeys("zzzz")).toEqual([]);
    // A rang egal, l'usage passe devant.
    expect(searchKeys("omega", (i) => (i === "\\Omega" ? 1 : 0))[0].insert).toBe("\\Omega");
  });

  it("ruban : chaque onglet tient sur deux rangees dans la zone des pages la plus etroite", () => {
    // Touches posees par le ruban en plus du catalogue (ui/mathbar.ts) :
    // Equation (large) et Encadrer dans les modeles, Maj dans le grec.
    const extra = (id: string) => (id === "models" ? 3 : shiftOf(id) ? 1 : 0);
    for (const s of CATALOG) {
      expect(keyUnits(s.keys) + extra(s.id), s.title).toBeLessThanOrEqual(ribbonCapacity(RIBBON_MIN_W));
    }
    expect(RIBBON_TABS.map((s) => s.id)).not.toContain("greek-upper");
    expect(tabOf("greek-upper")).toBe("greek");
    expect(shiftOf("greek")).toBe("greek-upper");
    expect(shiftOf("greek-upper")).toBe("greek");
    expect(Object.keys(SHIFTED)).toEqual(["greek"]);
    // Libelles d'onglet courts, apercu etroit rendu par KaTeX.
    for (const s of CATALOG) {
      expect(s.tab.length, s.title).toBeLessThanOrEqual(10);
      expect(() => katex.renderToString(s.glyph, { throwOnError: true }), s.glyph).not.toThrow();
    }
  });
});
