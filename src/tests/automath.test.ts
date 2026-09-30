import { describe, it, expect } from "vitest";
import { findFormulas } from "../core/text/automath";

const one = (line: string) => {
  const f = findFormulas(line);
  expect(f).toHaveLength(1);
  return { src: line.slice(f[0].start, f[0].end), tex: f[0].latex };
};

describe("formules automatiques", () => {
  it("indices, relation, unite", () => {
    const r = one("Vs = Vz - Vbe");
    expect(r.src).toBe("Vs = Vz - Vbe");
    expect(r.tex).toBe("V_s = V_z - V_{be}");
    expect(one("Vs ≈ Vz − 0,6 V").tex).toBe("V_s \\approx V_z - 0{,}6\\,\\mathrm{V}");
  });

  it("fractions et produits", () => {
    expect(one("Is = Vs/Ru").tex).toBe("I_s = \\frac{V_s}{R_u}");
    expect(one("iD = (Vz-Vbe)/(beta.Ru) - (vbatt-Vz)/R").tex)
      .toBe("i_D = \\frac{V_z - V_{be}}{\\beta \\cdot R_u} - \\frac{v_{batt} - V_z}{R}");
    expect(one("Vbatt > Vz + R.(Vz-Vbe)/(beta Ru)").tex)
      .toBe("V_{batt} > V_z + \\frac{R \\cdot \\left(V_z - V_{be}\\right)}{\\beta\\,R_u}");
  });

  it("formule au milieu d'une phrase", () => {
    const f = findFormulas("On a donc Vs = Vz - Vbe, ce qui ne depend pas de Ru.");
    expect(f).toHaveLength(1);
    expect(f[0].latex).toBe("V_s = V_z - V_{be}");
  });

  it("deux formules separees par un mot", () => {
    const f = findFormulas("Vce = Vbatt - Vs > 0 donc Vbatt > Vz - 0,6 V");
    expect(f.map((x) => x.latex)).toEqual([
      "V_{ce} = V_{batt} - V_s > 0",
      "V_{batt} > V_z - 0{,}6\\,\\mathrm{V}",
    ]);
  });

  it("le texte courant ne bouge pas", () => {
    for (const line of [
      "On voit donc que la tension de sortie Vs n'est pas dependante de la resistance Ru.",
      "Est-elle dependante de la resistance ?",
      "Q4. Puissances (Zener en inverse)",
      "Fichier 1009_Q12.asc, directive .dc",
      "Linux a été créé par Linus Torvalds en 1991",
      "Le composant chauffe, donc il fini par ne plus marcher.",
      "c'est-à-dire une demi-onde",
      "Q1. Zener bloquée",
      "III. Pont diviseur",
      "batterie lithium-ion",
      "Q2. Zener en inverse",
    ]) expect(findFormulas(line), line).toEqual([]);
  });

  it("point de phrase et mots proches de variables", () => {
    expect(one("Q12. Ru = 50 Ω").tex).toBe("R_u = 50\\,\\Omega");
    expect(one("vs = Vz − Vbe. Ensuite").tex).toBe("v_s = V_z - V_{be}");
    expect(one("le courant vaut −iD = 3").src).toBe("−iD = 3");
    expect(one("Pertes = Pf − Pu").src).toBe("Pf − Pu");
  });

  it("calculs sans variable", () => {
    expect(one("3/2").tex).toBe("\\frac{3}{2}");
    expect(one("donc 1/2 = 0,5").tex).toBe("\\frac{1}{2} = 0{,}5");
    expect(one("2^10 = 1024").tex).toBe("2^{10} = 1024");
    for (const line of ["Séance du 30/09", "le 29/09/2026", "pages 1 - 2", "en 1991"]) {
      expect(findFormulas(line), line).toEqual([]);
    }
  });

  it("symboles deja tapes et grecs", () => {
    expect(one("η = Pu / Pf < 1").tex).toBe("\\eta = \\frac{P_u}{P_f} < 1");
    expect(one("Ru >> R").tex).toBe("R_u \\gg R");
    expect(one("iD < 0 <=> vbatt > Vz").tex).toBe("i_D < 0 \\Leftrightarrow v_{batt} > V_z");
    expect(one("Pc = (vbatt − Vz)² / R").tex).toBe("P_c = \\frac{\\left(v_{batt} - V_z\\right)^2}{R}");
  });
});
