import { describe, it, expect } from "vitest";
import {
  findFormulas, greekWordAtEnd, latexToSource, planLine, slashOpensFraction, subscriptVars, symbolAtEnd, type LinePart,
} from "../core/text/automath";

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

describe("variables seules : quand les convertir", () => {
  it("une formule qui commence par une variable reste d'un seul tenant", () => {
    // Frappe mot a mot : a chaque espace, rien ne doit etre converti trop tot.
    for (const part of ["iD", "iD =", "iD = (Vz", "iD = (Vz -"]) {
      expect(findFormulas(part, "space"), part).toEqual([]);
    }
    expect(one("iD = (Vz - Vbe)/(beta.Ru)").tex).toBe("i_D = \\frac{V_z - V_{be}}{\\beta \\cdot R_u}");
  });
  it("au mot suivant ou a l'Entree", () => {
    expect(findFormulas("Vz", "space")).toEqual([]);
    expect(findFormulas("Vz", "final").map((f) => f.latex)).toEqual(["V_z"]);
    expect(findFormulas("I1", "final").map((f) => f.latex)).toEqual(["I_1"]);
    expect(findFormulas("Vz est", "space").map((f) => f.latex)).toEqual(["V_z"]);
    expect(findFormulas("donc I1,", "space").map((f) => f.latex)).toEqual(["I_1"]);
    expect(findFormulas("on a Vz.", "space").map((f) => f.latex)).toEqual(["V_z"]);
    expect(findFormulas("Vz =", "final")).toEqual([]);
  });
  it("jamais a la pause : un mot peut etre coupe", () => {
    for (const w of ["Qu", "Pa", "Vo", "Ca", "Vz", "I1"]) expect(findFormulas(w, "pause"), w).toEqual([]);
    // Une vraie formule, elle, se met en forme a la pause.
    expect(findFormulas("Vs = Vz", "pause")).toHaveLength(1);
  });
  it("mots, unites et noms propres restent du texte", () => {
    for (const w of ["Voici", "Valeur", "Vaut", "Vu", "Idem", "Intel", "Unix", "Ubuntu", "Tel", "If", "It",
      "In", "Hz", "kV", "dB", "Mo", "Ohm", "Loi", "Cas", "Rappel", "Pas", "Lu", "Pin", "Lac", "uF", "mA"]) {
      expect(findFormulas(`${w} la`, "space"), w).toEqual([]);
    }
    expect(findFormulas("Loi d'Ohm et loi des mailles")).toEqual([]);
  });
  it("les grandeurs de la liste blanche", () => {
    const f = findFormulas("Vz Rth Req Vcc Vin Ceq Pmax R0 C10 uC vS la");
    expect(f.map((x) => x.latex)).toEqual(
      ["V_z", "R_{th}", "R_{eq}", "V_{cc}", "V_{in}", "C_{eq}", "P_{max}", "R_0", "C_{10}", "u_C", "v_S"]);
  });
});

describe("multiples d'unites tapes au clavier", () => {
  it("kOhm, uF, us derriere un nombre", () => {
    expect(one("R = 10 kOhm").tex).toBe("R = 10\\,\\mathrm{k}\\Omega");
    expect(one("C = 10 uF").tex).toBe("C = 10\\,\\mu\\mathrm{F}");
    expect(one("T = 5 us").tex).toBe("T = 5\\,\\mu\\mathrm{s}");
  });
});

describe("barre oblique : unites et sigles", () => {
  it("pas de fraction pour m/s, dB/dec, E/S", () => {
    expect(findFormulas("en m/s")).toEqual([]);
    expect(findFormulas("les E/S du micro")).toEqual([]);
    expect(findFormulas("TCP/IP")).toEqual([]);
    expect(one("v = 10 m/s").tex).toBe("v = 10\\,\\mathrm{m}/\\mathrm{s}");
    expect(one("G = 20 dB/dec").tex).toBe("G = 20\\,\\mathrm{dB}/\\mathrm{dec}");
  });
  it("le / tape derriere une unite ou un sigle reste une barre", () => {
    expect(slashOpensFraction("v = 10 m", "v = 10 m")).toBe(false);
    expect(slashOpensFraction("20 dB", "une pente de 20 dB")).toBe(false);
    expect(slashOpensFraction("m", "en m")).toBe(false);
    expect(slashOpensFraction("E", "les E")).toBe(false);
    expect(slashOpensFraction("Id = Vz", "Id = Vz")).toBe(true);
    expect(slashOpensFraction("V", "donc V")).toBe(true);
    expect(slashOpensFraction("3", "3")).toBe(true);
  });
});

describe("trous du parseur", () => {
  it("la lettre a en maths", () => {
    expect(one("x = -b/(2a)").tex).toBe("x = \\frac{-b}{2\\,a}");
    expect(one("a != b").tex).toBe("a \\neq b");
    expect(findFormulas("il y a un probleme")).toEqual([]);
  });
  it("produits de lettres et pulsation", () => {
    expect(one("y = ax + b").tex).toBe("y = a\\,x + b");
    expect(one("Delta = b² - 4ac").tex).toBe("\\Delta = b^2 - 4\\,a\\,c");
    expect(one("x = sin(wt + phi)").tex).toBe("x = \\sin\\left(\\omega t + \\varphi\\right)");
    expect(one("u = e^(jwt)").tex).toBe("u = e^{j\\omega t}");
  });
  it("operateurs nommes et notation f(x)", () => {
    expect(one("Re(Z) = R").tex).toBe("\\operatorname{Re}\\left(Z\\right) = R");
    expect(one("f(x) = 2x").tex).toBe("f\\left(x\\right) = 2\\,x");
    expect(one("Re = 10 kΩ").tex).toBe("R_e = 10\\,\\mathrm{k}\\Omega");
  });
  it("produits avec espace dans une formule", () => {
    expect(one("P = R I²").tex).toBe("P = R\\,I^2");
    expect(one("v(t) = Vm sin(wt)").tex).toBe("v\\left(t\\right) = V_m\\,\\sin\\left(\\omega t\\right)");
    expect(one("T = 2 pi sqrt(L C)").tex).toBe("T = 2\\,\\pi\\,\\sqrt{L\\,C}");
    expect(one("Vs = Vz (1 + R2/R1)").tex).toBe("V_s = V_z\\,\\left(1 + \\frac{R_2}{R_1}\\right)");
    expect(one("Z = R + jL omega").tex).toBe("Z = R + j\\,L\\,\\omega");
  });
});

describe("code et symboles", () => {
  it("les operateurs colles a un nom ne bougent pas", () => {
    expect(symbolAtEnd("p->")).toBeNull();
    expect(symbolAtEnd("if (a>=")).toBeNull();
    expect(symbolAtEnd("cout<<")).toBeNull();
    expect(symbolAtEnd("donc ->")).toBe("donc →");
    expect(symbolAtEnd("a <=>")).toBe("a ⇔");
  });
  it("Pi et lambda restent des mots", () => {
    expect(greekWordAtEnd("Raspberry Pi")).toBeNull();
    expect(greekWordAtEnd("lambda")).toBeNull();
    expect(greekWordAtEnd("omega")).toBe("ω");
  });
});

describe("editeur de formules : indices et unites", () => {
  it("R1 dans une fraction, Hz en romain", () => {
    expect(subscriptVars("\\frac{V_{z}}{R1}")).toBe("\\frac{V_{z}}{R_{1}}");
    expect(subscriptVars("50Hz")).toBe("50\\mathrm{Hz}");
    expect(subscriptVars("V_{R1}")).toBe("V_{R1}");
  });
  it("source tapee d'un denominateur", () => {
    expect(latexToSource("(\\beta.R_{u})")).toBe("(beta.Ru)");
    expect(latexToSource("(\\beta)")).toBe("(beta)");
    expect(latexToSource("R1")).toBe("R1");
    expect(latexToSource("\\beta\\cdot R_{u}")).toBe("beta * Ru");
    expect(latexToSource("x^{2}")).toBeNull();
    expect(latexToSource("\\frac{a}{b}")).toBeNull();
  });
});

describe("relecture d'une ligne deja en partie en forme", () => {
  const plan = (parts: [LinePart["kind"], string][], mode: "final" | "space" | "pause" = "space") =>
    planLine(parts.map(([kind, str]) => ({ kind, str })), mode);
  it("une formule prolongee par la frappe", () => {
    const p = plan([["eq", "Vs = Vz"], ["cur", " - Vbe"]]);
    expect(p?.formulas.map((f) => f.latex)).toEqual(["V_s = V_z - V_{be}"]);
  });
  it("une fraction entre parentheses reprise avec le texte d'avant", () => {
    const p = plan([["text", "Vs = Vz ("], ["eq", "1 + R2/R1"], ["cur", ")"]]);
    expect(p?.formulas.map((f) => f.latex)).toEqual(["V_s = V_z\\,\\left(1 + \\frac{R_2}{R_1}\\right)"]);
  });
  it("une formule deja en forme n'est pas refaite", () => {
    expect(plan([["eq", "Vs = Vz"], ["cur", " donc"]])).toBeNull();
  });
  it("un mot colle a une formule la defait", () => {
    const p = plan([["eq", "x = Q"], ["cur", "uand"]], "pause");
    expect(p?.undone).toBe(0);
    expect(p?.formulas).toEqual([]);
  });
  it("Retour arriere : seule une formule finie au curseur s'annule", () => {
    // "Vs = Vz - Vbe" puis Espace : la formule touche le curseur.
    expect(plan([["cur", "Vs = Vz - Vbe"]])?.atCaret).toBe(true);
    // "I1" mis en forme a l'Espace qui suit "traverse" : deux mots plus tot.
    const p = plan([["cur", "Le courant I1 traverse"]]);
    expect(p?.formulas.map((f) => f.latex)).toEqual(["I_1"]);
    expect(p?.atCaret).toBe(false);
    // Point de fin de phrase apres la formule : il reste entre elle et le curseur.
    expect(plan([["cur", "On a U = R I."]])?.atCaret).toBe(false);
  });
  it("l'ancien texte de la ligne n'est pas touche", () => {
    // "Vz" deja relu dans un texte d'avant la formule : on ne le reprend pas.
    expect(plan([["text", "Soit Vz la "], ["eq", "I_1"], ["cur", " fin"]])).toBeNull();
  });
});
