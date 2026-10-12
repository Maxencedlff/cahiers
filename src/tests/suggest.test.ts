import { describe, it, expect } from "vitest";
import { extractFormulas, formulaKey, SuggestIndex, type CorpusPage } from "../core/suggest";

const page = (content: string, divider = "EON Puissance", modified = "2026-10-12T13:00:00Z"): CorpusPage =>
  ({ notebook: "Electronique", divider, modified, formulas: extractFormulas(content) });
const ctx = { notebook: "Electronique", divider: "EON Puissance", now: Date.parse("2026-10-13T08:00:00Z") };

// Lignes reelles du cahier (EON Puissance p.27-28).
const BUCK = [
  "[On démontre ΔS = $\\frac{\\Delta i_{L}}{8C}$T]{.attention}",
  "[Les 4 expressions à connaitre pour le Buck: ]{.attention}",
  "[1. $S = \\alpha \\cdot E$]{.attention}",
  "[2. $\\Delta i_{L}$= $\\frac{E(1-\\alpha)}{L}\\alpha T$]{.attention}",
  "3. [$i_{Lmoy}$ = $\\frac{S}{R}$]{.attention}",
  "4. [ΔS = $\\frac{\\Delta i_{L}}{8C}T$]{.attention}",
  "[$f = 50$ khz; $E = 12\\,\\mathrm{V}$; $S = 5\\,\\mathrm{V}$; $i_{Lmoy}$ = 1A; $\\Delta i_{L}$ = 250 mA]{.exemple}",
  "[La puisance moyenne consommée par la bobine et le consommateur ont été pris a puissance moyenne nulle.]{.exemple}",
].join("\n");

describe("suggestions de formules", () => {
  it("extrait les relations, texte et formules melanges", () => {
    const f = extractFormulas(BUCK).map((x) => x.insert);
    expect(f).toContain("ΔS = $\\frac{\\Delta i_{L}}{8C}T$");
    expect(f).toContain("$S = \\alpha \\cdot E$");
    expect(f).toContain("$i_{Lmoy}$ = $\\frac{S}{R}$");
    expect(f).toContain("$\\Delta i_{L}$ = $\\frac{E(1-\\alpha)}{L}\\alpha T$");
    expect(extractFormulas("On a donc $V_s = V_z - V_{be}$ ici").map((x) => x.insert)).toEqual(["$V_s = V_z - V_{be}$"]);
    // Phrase : rien.
    expect(f.some((x) => /puisance/.test(x))).toBe(false);
  });

  it("cles pliees : grec en clair ou abrege", () => {
    expect(formulaKey("ΔS = x").long).toBe("deltas=x");
    expect(formulaKey("ΔS = x").short).toBe("ds=x");
  });

  const idx = new SuggestIndex([page(BUCK)]);
  it("ΔS, DeltaS, DS : la formule de l'ondulation", () => {
    for (const q of ["ΔS =", "DeltaS", "deltaS=", "DS =", "Donc DeltaS ="]) {
      const s = idx.suggest(q, ctx);
      expect(s?.insert, q).toMatch(/^ΔS = \$\\frac\{\\Delta i_\{L\}\}\{8C\}/);
    }
    expect(idx.suggest("Donc DeltaS =", ctx)?.replace).toBe("DeltaS =".length);
  });

  it("valeur seule moins bien classee que la formule", () => {
    expect(idx.suggest("Deltai", ctx)?.insert).toMatch(/frac\{E\(1-\\alpha\)\}/);
    expect(idx.suggest("iLm", ctx)?.insert).toBe("$i_{Lmoy}$ = $\\frac{S}{R}$");
    expect(idx.suggest("S =", ctx)?.insert).toBe("$S = \\alpha \\cdot E$");
  });

  it("rien sur un mot courant ou trop court", () => {
    for (const q of ["d", "de", "pour", "On a", "la puissance"]) expect(idx.suggest(q, ctx), q).toBeNull();
  });

  it("intercalaire courant prioritaire", () => {
    const two = new SuggestIndex([
      page("$S = \\alpha \\cdot E$", "EON Puissance"),
      page("$S = 2 \\cdot E \\cdot \\beta$", "Autre"),
      page("$S = 2 \\cdot E \\cdot \\beta$", "Autre"),
    ]);
    expect(two.suggest("S =", ctx)?.insert).toBe("$S = \\alpha \\cdot E$");
  });
});
