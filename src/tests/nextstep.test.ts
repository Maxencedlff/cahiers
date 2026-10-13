import { describe, it, expect } from "vitest";
import { equivalents, nextStepSuggest } from "../core/calc/nextstep";
import { greekWordAtEnd } from "../core/text/automath";

const sug = (l: string) => nextStepSuggest(l)?.insert ?? null;

describe("etape suivante derriere un =", () => {
  it("formes equivalentes, la simplifiee d'abord", () => {
    expect(equivalents("3p + 4p")).toEqual(["7p", "p(3 + 4)"]);
    expect(equivalents("5(1 - cos(t))")).toEqual(["5 - 5cos(t)"]);
    expect(equivalents("(x+1)^2")).toEqual(["x^2 + 2x + 1"]);
    expect(equivalents("x^3 + 2x^2")).toEqual(["x^2(x + 2)"]);
    expect(equivalents("3/6")).toEqual(["1/2", "0,5"]);
    expect(equivalents("2+3*4")).toEqual(["14"]);
    expect(equivalents("2μ + 3μ")).toEqual(["5μ", "μ(2 + 3)"]);
    expect(equivalents("Vs - Vz")).toEqual([]);
  });
  it("rien tape : la forme simplifiee ; debut tape : la forme qui commence ainsi", () => {
    expect(sug("3p + 4p =")).toBe(" 7p");
    expect(sug("On a 3p + 4p = ")).toBe("7p");
    expect(sug("3p + 4p = p(")).toBe("3 + 4)");
    expect(sug("3p + 4p = 7")).toBe("p");
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

describe("suite d'un calcul sur la ligne du dessous", () => {
  it("ligne qui commence par = : le dernier membre de la ligne du dessus", () => {
    const prev = "y(t) = gamma (t) - 1 e^t.gamma(t)-1/3e^(-t).gamma(t)+1/3e^(2t)";
    expect(nextStepSuggest("\t=", prev)?.insert).toBe(" γ(t)(1 - e^t - 1/3 e^(-t)) + 1/3 e^(2t)");
    expect(nextStepSuggest("= ", "a = 3p + 4p")?.insert).toBe("7p");
    expect(nextStepSuggest("=", "")).toBeNull();
  });
});
