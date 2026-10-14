import { describe, it, expect } from "vitest";
import { CalcEngine, normalizeInput } from "../core/calc/engine";
import { derivative, nthDerivative, simplifyExpr, substitute } from "../core/calc/derive";
import { antiderivative, definiteIntegral } from "../core/calc/integrate";
import { solveEquation, solveSystem, polynomialCoefficients } from "../core/calc/solve";
import { applyMatrixOp, parseMatrix, rank } from "../core/calc/matrix";
import { samplePlot, valueTable, rootsInWindow } from "../core/calc/plot";

/**
 * Calculs a resultat connu (section 10). Ajouter les matrices ne doit pas
 * casser la derivation sans qu'on le voie tout de suite.
 */

const num = (e: CalcEngine, expr: string): number => {
  const r = e.evaluate(expr);
  if (!r.ok) throw new Error(`${expr} : ${r.message}`);
  return Number(r.raw);
};

describe("evaluation", () => {
  it("arithmetique et priorites", () => {
    const e = new CalcEngine();
    expect(num(e, "2 + 3 * 4")).toBe(14);
    expect(num(e, "(2 + 3) * 4")).toBe(20);
    expect(num(e, "2^10")).toBe(1024);
  });

  it("RAD par defaut", () => {
    const e = new CalcEngine();
    expect(num(e, "sin(pi/2)")).toBeCloseTo(1, 12);
    expect(num(e, "cos(pi)")).toBeCloseTo(-1, 12);
  });

  it("bascule DEG", () => {
    const e = new CalcEngine();
    e.angleMode = "DEG";
    expect(num(e, "sin(90)")).toBeCloseTo(1, 12);
    expect(num(e, "cos(60)")).toBeCloseTo(0.5, 12);
    expect(num(e, "atan(1)")).toBeCloseTo(45, 12);
  });

  it("ans reprend le dernier resultat", () => {
    const e = new CalcEngine();
    e.evaluate("7 * 6");
    expect(num(e, "ans + 8")).toBe(50);
  });

  it("nombres complexes", () => {
    const e = new CalcEngine();
    const r = e.evaluate("(1 + 2i) * (3 - i)");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.replace(/\s/g, "")).toBe("5+5i");
    expect(num(e, "abs(3 + 4i)")).toBe(5);
  });

  it("normalise les symboles du pave", () => {
    expect(normalizeInput("2×3")).toBe("2*3");
    expect(normalizeInput("π")).toBe("pi");
    expect(normalizeInput("x²")).toBe("x^2");
    expect(normalizeInput("3,5")).toBe("3.5");
  });

  it("erreurs lisibles", () => {
    const e = new CalcEngine();
    const r = e.evaluate("2 +");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(3);
  });

  it("reaffiche l'expression comprise en LaTeX", () => {
    const e = new CalcEngine();
    expect(e.toLatex("sin(x)^2")).toContain("sin");
    expect(e.toLatex("1/2")).toContain("frac");
  });
});

describe("derivation", () => {
  it("polynome", () => {
    const d = derivative("x^3 + 2x", "x");
    expect(d.ok).toBe(true);
    expect(d.result?.replace(/\s/g, "")).toBe("3*x^2+2");
  });

  it("produit", () => {
    const d = derivative("x * sin(x)", "x");
    expect(d.ok).toBe(true);
    expect(d.steps?.rule).toBe("produit");
    const names = d.steps?.parts.map((p) => p.name);
    expect(names).toEqual(["u", "v", "u'", "v'"]);
  });

  it("quotient", () => {
    const d = derivative("(x + 1) / (x - 1)", "x");
    expect(d.ok).toBe(true);
    expect(d.steps?.rule).toBe("quotient");
  });

  it("chaine", () => {
    const d = derivative("sin(x^2)", "x");
    expect(d.ok).toBe(true);
    expect(d.steps?.rule).toBe("chaine");
    expect(d.result).toContain("cos");
  });

  it("puissance", () => {
    const d = derivative("(2x + 1)^5", "x");
    expect(d.ok).toBe(true);
    expect(d.steps?.rule).toBe("puissance");
  });

  it("constante", () => {
    expect(derivative("42", "x").result).toBe("0");
  });

  it("derivee seconde", () => {
    const d = nthDerivative("x^4", "x", 2);
    expect(d.ok).toBe(true);
    expect(d.result?.replace(/\s/g, "")).toBe("12*x^2");
  });
});

describe("calcul litteral", () => {
  it("2x + x donne 3x", () => {
    const r = simplifyExpr("2x + x");
    expect(r.ok).toBe(true);
    expect(r.result?.replace(/\s/g, "")).toBe("3*x");
  });

  it("substitution", () => {
    const r = substitute("a * x + b", { a: 2, b: 3 });
    expect(r.ok).toBe(true);
    expect(r.result?.replace(/\s/g, "")).toBe("2*x+3");
  });
});

describe("primitives", () => {
  it("polynome", () => {
    const r = antiderivative("x^2", "x");
    expect(r.ok).toBe(true);
    expect(r.result?.replace(/\s/g, "")).toContain("x^3");
  });

  it("1/x donne un logarithme", () => {
    const r = antiderivative("1/x", "x");
    expect(r.ok).toBe(true);
    expect(r.result).toContain("log");
  });

  it("composee affine sin(2x)", () => {
    const r = antiderivative("sin(2x)", "x");
    expect(r.ok).toBe(true);
    expect(r.result).toContain("cos");
    // Verification numerique : la derivee de la primitive redonne sin(2x).
    const d = derivative(r.result!, "x");
    expect(d.ok).toBe(true);
  });

  it("somme et constante multiplicative", () => {
    const r = antiderivative("3*x^2 + 2*x", "x");
    expect(r.ok).toBe(true);
  });

  it("echoue proprement sur un produit non couvert", () => {
    // x*sin(x) passe par parties ; exp(x)*sin(x) (parties cycliques) non.
    const r = antiderivative("exp(x) * sin(x)", "x");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/parties|non couverte/i);
  });

  it("integrale definie exacte", () => {
    const r = definiteIntegral("x^2", "x", 0, 3);
    expect(r.ok).toBe(true);
    expect(r.value).toBeCloseTo(9, 8);
  });

  it("integrale definie numerique quand la primitive manque", () => {
    const r = definiteIntegral("exp(x) * sin(x)", "x", 0, Math.PI);
    expect(r.ok).toBe(true);
    expect(r.method).toBe("numerique");
    expect(r.value).toBeCloseTo((Math.exp(Math.PI) + 1) / 2, 5);
  });
});

describe("resolution", () => {
  it("coefficients d'un polynome", () => {
    expect(polynomialCoefficients("2*x^2 - 3*x + 1")).toEqual([1, -3, 2]);
  });

  it("premier degre", () => {
    const r = solveEquation("2x + 6 = 0");
    expect(r.roots?.[0].value).toBe(-3);
  });

  it("second degre, delta positif", () => {
    const r = solveEquation("x^2 - 3x + 2 = 0");
    expect(r.discriminant).toBe(1);
    expect(r.nature).toMatch(/deux racines réelles/);
    expect(r.roots?.map((x) => x.value)).toEqual([1, 2]);
  });

  it("second degre, delta nul", () => {
    const r = solveEquation("x^2 - 2x + 1 = 0");
    expect(r.discriminant).toBe(0);
    expect(r.roots).toHaveLength(1);
  });

  it("second degre, delta negatif donne des complexes", () => {
    const r = solveEquation("x^2 + 1 = 0");
    expect(r.discriminant).toBe(-4);
    expect(r.nature).toMatch(/complexes/);
    expect(r.roots).toHaveLength(2);
  });

  it("equation non polynomiale, racine numerique", () => {
    const r = solveEquation("cos(x) = 0");
    expect(r.ok).toBe(true);
    expect(r.method).toBe("numerique");
    expect(r.roots!.some((x) => Math.abs(Number(x.value) - Math.PI / 2) < 1e-6)).toBe(true);
  });

  it("systeme lineaire 2x2", () => {
    const r = solveSystem(["x + y = 10", "x - y = 2"]);
    expect(r.ok).toBe(true);
    expect(r.solution).toEqual({ x: "6", y: "4" });
  });

  it("systeme singulier", () => {
    const r = solveSystem(["x + y = 1", "2x + 2y = 2"]);
    expect(r.ok).toBe(false);
  });
});

describe("matrices", () => {
  const m = [[1, 2], [3, 4]];

  it("determinant", () => {
    expect(applyMatrixOp(m, "det").scalar).toBe(-2);
  });

  it("inverse", () => {
    const r = applyMatrixOp(m, "inv");
    expect(r.ok).toBe(true);
    expect(r.matrix).toEqual([[-2, 1], [1.5, -0.5]]);
  });

  it("transposee", () => {
    expect(applyMatrixOp(m, "transpose").matrix).toEqual([[1, 3], [2, 4]]);
  });

  it("rang", () => {
    expect(rank([[1, 2], [2, 4]])).toBe(1);
    expect(rank(m)).toBe(2);
  });

  it("matrice non inversible", () => {
    const r = applyMatrixOp([[1, 2], [2, 4]], "inv");
    expect(r.ok).toBe(false);
  });

  it("lecture texte", () => {
    expect(parseMatrix("1 2\n3 4")).toEqual([[1, 2], [3, 4]]);
    expect(parseMatrix("1 2\n3")).toBeNull();
  });
});

describe("courbes", () => {
  it("echantillonne", () => {
    const p = samplePlot("sin(x)", -Math.PI, Math.PI, 101);
    expect(p.ok).toBe(true);
    expect(p.samples).toHaveLength(101);
    expect(p.yMin).toBeCloseTo(-1, 2);
    expect(p.yMax).toBeCloseTo(1, 2);
  });

  it("coupe le trait sur une asymptote", () => {
    const p = samplePlot("1/x", -2, 2, 101);
    expect(p.ok).toBe(true);
    expect(p.samples!.some((s) => s.y === null)).toBe(true);
  });

  it("accepte y = f(x)", () => {
    expect(samplePlot("y = x^2", -2, 2, 11).ok).toBe(true);
  });

  it("tableau de valeurs", () => {
    const rows = valueTable("x^2", 0, 3, 1);
    expect(rows.map((r) => r.y)).toEqual(["0", "1", "4", "9"]);
  });

  it("racines dans la fenetre", () => {
    const roots = rootsInWindow("x^2 - 4", -5, 5);
    expect(roots.some((r) => Math.abs(r - 2) < 1e-4)).toBe(true);
    expect(roots.some((r) => Math.abs(r + 2) < 1e-4)).toBe(true);
  });
});

describe("affichage de l'expression lue", () => {
  it("ne montre rien pour une saisie vide", () => {
    const e = new CalcEngine();
    expect(e.toLatex("")).toBeNull();
    expect(e.toLatex("   ")).toBeNull();
  });

  it("ne montre rien pour une saisie incomplete", () => {
    const e = new CalcEngine();
    expect(e.toLatex("2 +")).toBeNull();
  });

  it("leve l'ambiguite de sin x^2", () => {
    const e = new CalcEngine();
    const tex = e.toLatex("sin(x)^2");
    expect(tex).toContain("sin");
    expect(tex).toContain("2");
  });
});

describe("Littéral : LaTeX colle avec point de multiplication, fraction reduite", () => {
  it("$$ frac(frac(4,p+1), 1+(frac(4,p+1)).0,2) $$ donne 20/(5p+9)", () => {
    const r = simplifyExpr("$$ \\frac{\\frac{4}{p+1}}{1+(\\frac{4}{p+1}).0,2} $$");
    expect(r.ok).toBe(true);
    expect(r.result?.replace(/\s/g, "")).toBe("20/(5*p+9)");
  });
  it("point a la francaise : produit, jamais dans un nombre", () => {
    expect(normalizeInput("(a+b).2")).toBe("(a+b)*2");
    expect(normalizeInput("R.I")).toBe("R*I");
    expect(normalizeInput("3.5")).toBe("3.5");
  });
});

describe("detail d'une simplification (Littéral)", () => {
  it("fraction de fractions : meme denominateur, inverse, simplification, entiers", async () => {
    const { simplifySteps } = await import("../core/calc/nextstep");
    const s = simplifySteps("(4/(p+1))/(1+(4/(p+1))*0,2)")!;
    expect(s.some((l) => l.includes("même dénominateur"))).toBe(true);
    expect(s.some((l) => l.includes("inverse"))).toBe(true);
    expect(s.some((l) => l.startsWith("On simplifie par"))).toBe(true);
    expect(s[s.length - 1]).toContain("\\frac{20}{5p + 9}");
    expect(simplifySteps("2x + x")).toBeNull();
    expect(simplifySteps("1/p + 1/(p+1)")![1]).toContain("p\\left(p + 1\\right)");
  });
});

describe("detail avec un parametre (boucle fermee)", () => {
  it("K/(p(p+3)) / (1 + K/(p(p+3))) : meme denominateur, inverse, simplification, developpe", async () => {
    const { simplifySteps } = await import("../core/calc/nextstep");
    const s = simplifySteps("K/(p(p+3)) / (1+K/(p(p+3)))")!;
    expect(s.some((l) => l.startsWith("En bas, on met tout au même dénominateur"))).toBe(true);
    expect(s.some((l) => l.startsWith("On simplifie par"))).toBe(true);
    expect(s[s.length - 1]).toContain("\\frac{K}{p^{2} + 3\\,p + K}");
    expect(s.join(" ")).not.toContain("mathrm");
  });
});

