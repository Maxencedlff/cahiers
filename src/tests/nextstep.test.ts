import { describe, it, expect } from "vitest";
import { equivalents, nextStepSuggest } from "../core/calc/nextstep";
import { greekWordAtEnd } from "../core/text/automath";
import { texToPlain } from "../core/text/doc";

const sug = (l: string) => nextStepSuggest(l)?.insert ?? null;

describe("etape suivante derriere un =", () => {
  it("nombres : valeur exacte, ou decimale si le calcul l'est", () => {
    expect(equivalents("3/6")).toEqual(["1/2"]);
    expect(equivalents("2+3*4")).toEqual(["14"]);
    expect(equivalents("2/((-2)(4))")).toEqual(["-1/4"]);
    expect(equivalents("3 × 0,5")).toEqual(["1,5"]);
    expect(equivalents("cos 0")).toEqual(["1"]);
    expect(equivalents("(-3 + sqrt(1))/2")).toEqual(["-1"]);
  });
  it("polynome en une lettre : termes regroupes, factorise par ses racines, developpe", () => {
    expect(equivalents("3p + 4p")).toEqual(["7p"]);
    expect(equivalents("2μ + 3μ")).toEqual(["5μ"]);
    expect(equivalents("p^2 + 3p + 2")).toEqual(["(p + 1)(p + 2)"]);
    expect(equivalents("x^3 + 2x^2")).toEqual(["x^2(x + 2)"]);
    expect(equivalents("(x+1)^2")).toEqual(["x^2 + 2x + 1"]);
  });
  it("fraction : denominateur factorise, simplifiee, puis elements simples", () => {
    expect(equivalents("2/(p(p-1)(p^2-p-2))")[0]).toBe("2/(p(p - 1)(p + 1)(p - 2))");
    expect(equivalents("2/((p+1)(p+2)) × 1/p")[0]).toBe("2/(p(p + 1)(p + 2))");
    expect(equivalents("p × 2/(p (p+1)(p+2))")[0]).toBe("2/((p + 1)(p + 2))");
    expect(equivalents("2/(p (p+1)(p+2))")).toEqual(["1/p - 2/(p + 1) + 1/(p + 2)"]);
    expect(equivalents("2/(p(p+2)(p^2+p+2))")).toEqual(["1/(2p) - 1/(4(p + 2)) - (p + 3)/(4(p^2 + p + 2))"]);
    expect(equivalents("1/p - 2/(p+1) + 1/(p+2)")).toEqual(["2/(p(p + 1)(p + 2))"]);
    expect(equivalents("-d/dp(1/(p+3))")).toEqual(["1/(p + 3)^2"]);
  });
  it("fonctions (y(t), Y(p), s(0), γ(t)) : des blocs, jamais des produits", () => {
    expect(equivalents("y''(t) + y")).toEqual([]);
    expect(equivalents("0,5 s''(t) + 1,5 s'(t) + s(t)")).toEqual([]);
    expect(equivalents("s(0)")).toEqual([]);
    expect(equivalents("p^2 Y(p) + Y(p)")).toEqual(["Y(p)(p^2 + 1)"]);
    expect(equivalents("γ(t) - e^t γ(t)")).toEqual(["γ(t)(1 - e^t)"]);
    expect(equivalents("G(p)")).toEqual([]);
  });
  it("plusieurs lettres : regroupe par puissances, rien d'artificiel", () => {
    expect(equivalents("a p^3 + b p^2 + c p - a p^2 - b p - c")).toEqual(["a p^3 + (b - a)p^2 + (c - b)p - c"]);
    expect(equivalents("4 α + 2 β + 2 ν")).toEqual([]);
    expect(equivalents("Vs - Vz")).toEqual([]);
  });
  it("rien tape : la forme simplifiee ; debut tape : la forme qui commence ainsi", () => {
    expect(sug("3p + 4p =")).toBe(" 7p");
    expect(sug("On a 3p + 4p = ")).toBe("7p");
    expect(sug("3p + 4p = 7")).toBe("p");
    expect(sug("p^2 + 3p + 2 = (p")).toBe(" + 1)(p + 2)");
    expect(sug("y = (x+1)^2 = x")).toBe("^2 + 2x + 1");
  });
  it("rien si aucune forme ne colle", () => {
    expect(sug("3p + 4p = 9")).toBeNull();
    expect(sug("Vs =")).toBeNull();
    expect(sug("x = 2 et donc =")).toBeNull();
    expect(sug("a <= b")).toBeNull();
  });
});

describe("lettres grecques tapees en toutes lettres", () => {
  it("mu, nu et les autres", () => {
    expect(greekWordAtEnd("on a mu")).toBe("on a μ");
    expect(greekWordAtEnd("on a nu")).toBe("on a ν");
    expect(greekWordAtEnd("xi")).toBe("ξ");
    expect(greekWordAtEnd("numero")).toBeNull();
  });
});

describe("inconnues du dernier membre : valeurs remplacees", () => {
  it("elements simples reels : identification", () => {
    expect(nextStepSuggest("=", "2/(p(p+1)(p+2)) = a/p + b/(p+1) + c/(p+2)")?.insert).toBe(" 1/p - 2/(p + 1) + 1/(p + 2)");
    expect(nextStepSuggest("2/(p(p+1)(p+2)) = a/p + b/(p+1) + c/(p+2) =")?.insert).toBe(" 1/p - 2/(p + 1) + 1/(p + 2)");
  });
  it("poles complexes : residus, coefficients exacts avec racines", () => {
    const prev = texToPlain("\\frac{2}{p\\left(p+2\\right)\\left(p^2+p+2\\right)}=\\frac{1}{2p}-\\frac{1}{4\\left(p+2\\right)}-\\frac{p+3}{4\\left(p^2+p+2\\right)}=\\frac{\\alpha}{p+\\frac12-\\frac{i\\sqrt{7}}{2}}+\\frac{\\beta}{p+\\frac12+i\\,\\frac{\\sqrt{7}}{2}}");
    expect(nextStepSuggest("=", prev)?.insert)
      .toBe(" (-7 + 5i sqrt(7))/(56(p + 1/2 - i sqrt(7)/2)) + (-7 - 5i sqrt(7))/(56(p + 1/2 + i sqrt(7)/2))");
    expect(nextStepSuggest("=", "1/(p^2+1) = a/(p - i) + b/(p + i)")?.insert).toBe(" -i/(2(p - i)) + i/(2(p + i))");
  });
  it("« donc α = » : la valeur trouvee dans un calcul plus haut", () => {
    const chain = texToPlain("\\frac{2}{p\\left(p+2\\right)\\left(p^2+p+2\\right)}=\\frac{1}{2p}-\\frac{1}{4\\left(p+2\\right)}-\\frac{p+3}{4\\left(p^2+p+2\\right)}=\\frac{\\alpha}{p+\\frac12-\\frac{i\\sqrt{7}}{2}}+\\frac{\\beta}{p+\\frac12+i\\,\\frac{\\sqrt{7}}{2}}");
    const above = ["Conclusion :", chain, "= alpha + beta (p+1/2-i sqrt(7)/2)/(p+1/2+i sqrt(7)/2)"].join("\n");
    expect(nextStepSuggest("donc α =", above)?.insert).toBe(" (-7 + 5i sqrt(7))/56");
    expect(nextStepSuggest("donc β = ", above)?.insert).toBe("(-7 - 5i sqrt(7))/56");
    // Ligne telle qu'enregistree dans la page (MathLive : « \sqrt7 », « { p}^{2} »).
    const saved = [
      "\\frac{2}{ p\\left( p+2\\right)\\left({ p}^{2}+ p+2\\right)} = \\frac{1}{2 p} - \\frac{1}{4\\left( p+2\\right)} - \\frac{ p + 3}{4\\left({ p}^{2}+ p+2\\right)}",
      "\\frac{\\alpha}{p+\\frac12-\\frac{i\\sqrt7}{2}}", "\\frac{\\beta}{p+\\frac12+i\\;\\frac{\\sqrt7}{2}}",
    ].map(texToPlain);
    const line = `${saved[0]}=${saved[1]}+ ${saved[2]}`;
    expect(nextStepSuggest("donc α =", `${line}\n= alpha + beta (p+1/2-i sqrt(7)/2)/(p+1/2+i sqrt(7)/2)`)?.insert).toBe(" (-7 + 5i sqrt(7))/56");
    // Signe du terme pris en compte : « - b/(p+1) » donne b = 2.
    expect(nextStepSuggest("donc b =", "2/(p(p+1)(p+2)) = a/p - b/(p+1) + c/(p+2)")?.insert).toBe(" 2");
  });
  it("copier en clair : « 1/(2p) », « i sqrt(7) »", () => {
    expect(texToPlain("\\frac{1}{2p}")).toBe("1/(2p)");
    expect(texToPlain("\\frac{i\\sqrt{7}}{2}")).toBe("i sqrt(7)/2");
  });
});

describe("suite d'un calcul sur la ligne du dessous", () => {
  it("ligne qui commence par = : le dernier membre de la ligne du dessus", () => {
    const prev = "y(t) = gamma (t) - 1 e^t.gamma(t)-1/3e^(-t).gamma(t)+1/3e^(2t)";
    expect(nextStepSuggest("\t=", prev)?.insert).toBe(" γ(t)(1 - e^t - 1/3 e^(-t)) + 1/3 e^(2t)");
    expect(nextStepSuggest("= ", "a = 3p + 4p")?.insert).toBe("7p");
    expect(nextStepSuggest("=", "")).toBeNull();
  });
});

describe("fraction en p avec un parametre (boucle fermee)", () => {
  it("K/(p(p+3)) / (1 + K/(p(p+3))) : bloc simplifie puis developpe", () => {
    expect(equivalents("(K/(p(p+3)))/(1+K/(p(p+3)))")).toEqual(["K/(p(p + 3) + K)", "K/(p^2 + 3p + K)"]);
    expect(equivalents("K/(p+a) / (1 + K/(p+a))")[0]).toBe("K/(p + a + K)");
    expect(nextStepSuggest("= K/(p(p+3)) / (1+K/(p(p+3))) =")?.insert.trim()).toBe("K/(p(p + 3) + K)");
  });
});
