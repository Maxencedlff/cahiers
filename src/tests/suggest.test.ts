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

  // Ecrites deux fois (cours puis TD) : assez sures pour etre proposees.
  const idx = new SuggestIndex([page(BUCK), page(BUCK, "TD")]);
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

  it("deux ecritures aussi frequentes : rien plutot qu'un choix au hasard", () => {
    const two = new SuggestIndex([
      page("$S = \\alpha \\cdot E$", "EON Puissance"),
      page("$S = 2 \\cdot E \\cdot \\beta$", "Autre"),
      page("$S = 2 \\cdot E \\cdot \\beta$", "Autre"),
    ]);
    expect(two.suggest("S =", ctx)).toBeNull();
  });

  // Cas reels : 3235 propositions sur ses cahiers, 121 justes, avant (mots en cours de frappe).
  const strict = new SuggestIndex([
    page("$P_f = V_{batt} \\cdot I_e$", "EON Puissance"),
    page("$P_f = V_{batt} \\cdot I_e$", "Autre"),
    page("$I_s = I_e - i$\n$I_s = I_e - i$\n$\\cos 0 = 1$\nvbatt = 9 V\nvbatt = 9 V", "EON Puissance"),
    page("$\\alpha = t_{on}/T$\n$\\alpha = t_{on}/T$", "EON Puissance"),
  ]);
  it("jamais pendant un mot francais ni dans une phrase", () => {
    for (const q of ["Sa tension n'est pas co", "On veut al", "La batterie est une bonne so", "CO", "di", "Il faut que i"]) {
      expect(strict.suggest(q, ctx), q).toBeNull();
    }
  });
  it("membre gauche tape puis « = » : la formule qu'il ecrit d'habitude", () => {
    expect(strict.suggest("Pf =", ctx)?.insert).toBe("$P_f = V_{batt} \\cdot I_e$");
    expect(strict.suggest("donc Pf = V", ctx)?.insert).toBe("$P_f = V_{batt} \\cdot I_e$");
    expect(strict.suggest("alpha =", ctx)?.insert).toBe("$\\alpha = t_{on}/T$");
  });
  it("casse, debut du membre droit, terme au milieu d'un calcul, valeur, autre matiere : rien", () => {
    expect(strict.suggest("is =", ctx)).toBeNull();
    expect(strict.suggest("Pf = Vbatt.i", ctx)).toBeNull();
    expect(strict.suggest("eta = Pu / Pf =", ctx)).toBeNull();
    expect(strict.suggest("vbatt =", ctx)).toBeNull();
    expect(strict.suggest("Pf =", { ...ctx, notebook: "Signaux" })).toBeNull();
  });
  it("ecrite une seule fois ailleurs : pas assez sur", () => {
    expect(new SuggestIndex([page("$R_{eq} = \\beta R_u$")]).suggest("Req =", ctx)).toBeNull();
  });
});
