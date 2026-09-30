import { describe, it, expect } from "vitest";
import { findFormulas, greekWordAtEnd, subscriptVars, symbolAtEnd } from "../core/text/automath";

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
    expect(f.map((x) => x.latex)).toEqual(["V_s = V_z - V_{be}", "R_u"]);
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

  it("entrees d'AOP en exposant", () => {
    expect(one("V+ = V-").tex).toBe("V^{+} = V^{-}");
    expect(one("eps = V+ - V-").tex).toBe("\\varepsilon = V^{+} - V^{-}");
    expect(one("V+ = Vs.R1/(R1+R2)").tex).toBe("V^{+} = \\frac{V_s \\cdot R_1}{R_1 + R_2}");
    expect(one("Vs = V+ ").tex).toBe("V_s = V^{+}");
    expect(one("a = b+c").tex).not.toContain("^");
  });

  it("pi et eps en minuscules seulement", () => {
    expect(one("P = pi.R").tex).toBe("P = \\pi \\cdot R");
    expect(one("P = PI").tex).toBe("P = P_I");
    expect(one("P = Pi").tex).toBe("P = P_i");
    expect(one("eps = 0").tex).toBe("\\varepsilon = 0");
  });

  it("symboles deja tapes et grecs", () => {
    expect(one("η = Pu / Pf < 1").tex).toBe("\\eta = \\frac{P_u}{P_f} < 1");
    expect(one("Ru >> R").tex).toBe("R_u \\gg R");
    expect(one("iD < 0 <=> vbatt > Vz").tex).toBe("i_D < 0 \\Leftrightarrow v_{batt} > V_z");
    expect(one("Pc = (vbatt − Vz)² / R").tex).toBe("P_c = \\frac{\\left(v_{batt} - V_z\\right)^2}{R}");
  });
});

describe("variables de l'editeur de formules", () => {
  it("Ru, Vbe, Vbatt passent en indice", () => {
    expect(subscriptVars("I_{d}=\\frac{V_{z}-V_{be}}{\\beta\;Ru}")).toBe("I_{d}=\\frac{V_{z}-V_{be}}{\\beta\;R_{u}}");
    expect(subscriptVars("Vbatt>Vz")).toBe("V_{batt}>V_{z}");
  });
  it("commandes, unites et mots ne bougent pas", () => {
    expect(subscriptVars("\\Delta+\\Omega")).toBe("\\Delta+\\Omega");
    expect(subscriptVars("5\\,\\mathrm{Hz}")).toBe("5\\,\\mathrm{Hz}");
    expect(subscriptVars("\\text{Donc }x")).toBe("\\text{Donc }x");
    expect(subscriptVars("R_{u}^{Ab}")).toBe("R_{u}^{Ab}");
  });
});

describe("saisie hors formule", () => {
  it("lettres grecques en toutes lettres", () => {
    expect(greekWordAtEnd("on prend pi")).toBe("on prend π");
    expect(greekWordAtEnd("eps")).toBe("ε");
    expect(greekWordAtEnd("(omega")).toBe("(ω");
    expect(greekWordAtEnd("un pixel")).toBeNull();
    expect(greekWordAtEnd("api")).toBeNull();
    expect(greekWordAtEnd("Vpi")).toBeNull();
  });
  it("symboles a deux touches", () => {
    expect(symbolAtEnd("donc ->")).toBe("donc →");
    expect(symbolAtEnd("Ru >=")).toBe("Ru ≥");
    expect(symbolAtEnd("a ≤>")).toBe("a ⇔");
    expect(symbolAtEnd("Vs ~=")).toBe("Vs ≈");
    expect(symbolAtEnd("rien")).toBeNull();
  });
  it("eps dans une formule", () => {
    expect(findFormulas("x < eps")[0].latex).toBe("x < \\varepsilon");
  });
});

describe("variables seules", () => {
  it("mises en forme dans la phrase", () => {
    const f = findFormulas("Vz est imposee et I1 traverse Ru, vbatt et iD aussi");
    expect(f.map((x) => x.latex)).toEqual(["V_z", "I_1", "R_u", "v_{batt}", "i_D"]);
  });
  it("les mots restent du texte", () => {
    for (const line of ["La tension et On a Il faut", "Q1. Zener", "EON S01", "une valeur R", "Le TP porte sur Linux",
      "Si on le fait", "Or on voit que", "En effet"]) {
      expect(findFormulas(line), line).toEqual([]);
    }
  });
});
