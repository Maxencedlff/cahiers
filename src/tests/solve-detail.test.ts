import { describe, it, expect } from "vitest";
import { solveEquation } from "../core/calc/solve";
import { texToPlain } from "../core/text/doc";

describe("resolution avec le detail", () => {
  it("lettre grecque copiee de la page : une inconnue comme une autre", () => {
    const r = solveEquation(texToPlain("2\\,\\mu + 3 = 13"));
    expect(r.variable).toBe("μ");
    expect(r.roots?.[0].text).toBe("5");
    expect(r.steps?.at(-1)).toContain("= 5");
  });
  it("second degre : discriminant detaille", () => {
    const r = solveEquation("x^2 - 5x + 6 = 0");
    expect(r.steps?.some((s) => s.includes("\\Delta = b^{2} - 4ac"))).toBe(true);
  });
  it("inconnue choisie parmi plusieurs lettres", () => {
    expect(solveEquation("U = R I", "I").roots?.[0].text).toBe("U / R");
    expect(solveEquation("1/2 m v^2 = E", "v").roots?.[0].latex).toContain("\\pm");
    expect(solveEquation("Vs = Vz - Vbe", "Vbe").roots?.[0].text.replace(/\s/g, "")).toBe("Vz-Vs");
  });
  it("elements simples : les quatre constantes, methode des poles", () => {
    const src = texToPlain("\\frac{2}{p\\left(p - 1\\right)\\left(p^{2} - p - 2\\right)} = \\frac{\\alpha}{p} + \\frac{\\beta}{p - 1} + \\frac{\\mu}{p + 1} + \\frac{\\nu}{p - 2}");
    const r = solveEquation(src);
    expect(r.values?.map((v) => `${v.name}=${v.text}`)).toEqual(["α=1", "β=-1", "μ=-1/3", "ν=1/3"]);
    expect(r.steps?.[1]).toMatch(/\\alpha\s*= \\left\[.*\\right\]_\{\s*p = 0\} = 1$/);
  });
  it("identification d'un polynome", () => {
    const r = solveEquation("(x+1)^2 = x^2 + a x + b");
    expect(r.values?.map((v) => `${v.name}=${v.text}`)).toEqual(["a=2", "b=1"]);
  });
});

describe("LaTeX colle dans la calculatrice", () => {
  it("elements simples avec un trinome, copie en LaTeX", () => {
    const r = solveEquation("$$ \\frac{2}{p\\left(p+2\\right)\\left(p^2+p+2\\right)}=\\frac{\\alpha}{p}+\\frac{\\beta}{p+2}+\\frac{\\mu p+\\nu}{p^2+p+2} $$");
    expect(r.values?.map((v) => `${v.name}=${v.text}`)).toEqual(["α=1/2", "β=-1/4", "μ=-1/4", "ν=-3/4"]);
  });
  it("un seul membre colle : message clair", () => {
    expect(solveEquation("$$ \\frac{\\alpha}{p}+\\frac{\\beta}{p+2} $$").message).toMatch(/signe =/);
  });
});
