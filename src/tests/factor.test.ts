import { describe, it, expect } from "vitest";
import { factorSuggest } from "../core/factor";

const sug = (s: string) => factorSuggest(s)?.insert ?? null;

describe("factorisation proposee", () => {
  it("lettre en facteur", () => {
    expect(sug("3p + 4p = p(")).toBe("3 + 4)");
    expect(sug("3p - 4p = p(")).toBe("3 - 4)");
    expect(sug("On a 3p + p = p(")).toBe("3 + 1)");
    expect(sug("-2x + 5x = x(")).toBe("-2 + 5)");
    expect(sug("ap + bp + p/2 = p(")).toBe("a + b + 1/2)");
  });
  it("puissance et facteur de plusieurs lettres", () => {
    expect(sug("p^2 + 3p = p(")).toBe("p + 3)");
    expect(sug("x^3 + 2x^2 = x^2(")).toBe("x + 2)");
    expect(sug("2RC + RC = RC(")).toBe("2 + 1)");
  });
  it("entier en facteur", () => {
    expect(sug("6x + 9 = 3(")).toBe("2x + 3)");
    expect(sug("6x + 3 = 3(")).toBe("2x + 1)");
  });
  it("rien si un terme n'a pas le facteur ou s'il n'y a qu'un terme", () => {
    expect(sug("3p + 4q = p(")).toBeNull();
    expect(sug("3p = p(")).toBeNull();
    expect(sug("6x + 4 = 3(")).toBeNull();
    expect(sug("3p + 4p = p")).toBeNull();
  });
});
