/**
 * LaTeX colle dans la calculatrice -> saisie lisible (texToCalc).
 * Deux exigences : la saisie ressemble a ce qu'on taperait au pave (jamais
 * de commande « \... »), et elle se calcule comme la formule d'origine.
 */
import { describe, it, expect } from "vitest";
import { looksLikeTex, pastedToCalc, texToCalc } from "../core/calc/texinput";
import { CalcEngine } from "../core/calc/engine";

const conv = (tex: string) => texToCalc(tex).expr;

/** Valeur calculee par la calculatrice, grandeurs definies au prealable. */
function value(expr: string, defs: string[] = []): number {
  const e = new CalcEngine();
  for (const d of defs) expect(e.evaluate(d).ok, d).toBe(true);
  const r = e.evaluate(expr);
  expect(r.ok, `${expr} : ${r.ok ? "" : r.message}`).toBe(true);
  return Number((r as any).raw);
}

/** La conversion se calcule comme l'expression de reference. */
function sameValue(tex: string, reference: string, defs: string[] = []): void {
  expect(value(conv(tex), defs)).toBeCloseTo(value(reference, defs), 9);
}

const RC = ["R = 1000", "C = 100e-9"];

describe("texToCalc : ecriture lisible", () => {
  it("fractions, avec les parentheses qu'il faut", () => {
    expect(conv("\\frac{1}{2\\pi RC}")).toBe("1/(2π·R·C)");
    expect(conv("\\frac{1}{2}")).toBe("1/2");
    expect(conv("\\frac12")).toBe("1/2");
    expect(conv("\\frac{a+b}{c}")).toBe("(a + b)/c");
    expect(conv("\\frac{R_2}{R_1+R_2}")).toBe("R2/(R1 + R2)");
    expect(conv("\\dfrac{v_s}{v_{batt}}")).toBe("vs/vbatt");
    expect(conv("\\frac{E(1-\\alpha)}{L}")).toBe("E(1 - α)/L");
  });

  it("fractions imbriquees", () => {
    expect(conv("\\frac{\\frac{1}{2}}{3}")).toBe("(1/2)/3");
    expect(conv("\\frac{1}{\\frac{1}{R_1}+\\frac{1}{R_2}}")).toBe("1/(1/R1 + 1/R2)");
    expect(conv("\\frac{\\frac{K}{p(p+3)}}{1+\\frac{K}{p(p+3)}}")).toBe("(K/(p(p + 3)))/(1 + K/(p(p + 3)))");
  });

  it("racines, puissances, exponentielle", () => {
    expect(conv("\\sqrt{x}")).toBe("√(x)");
    expect(conv("\\sqrt[3]{8}")).toBe("nthRoot(8, 3)");
    expect(conv("\\frac{1}{2\\pi\\sqrt{LC}}")).toBe("1/(2π·√(L·C))");
    expect(conv("e^{-t/\\tau}")).toBe("e^(-t/τ)");
    expect(conv("e^{\\frac{-t}{\\tau}}")).toBe("e^(-t/τ)");
    expect(conv("x^{2}+3x")).toBe("x^2 + 3x");
    expect(conv("10^{-3}")).toBe("10^(-3)");
    expect(conv("\\left(\\frac{3}{4}\\right)^2")).toBe("(3/4)^2");
    expect(conv("{\\frac{3}{4}}^2")).toBe("(3/4)^2");
  });

  it("grec, indices, \\left \\right retires", () => {
    expect(conv("\\omega")).toBe("ω");
    expect(conv("\\tau\\ln 9")).toBe("τ·ln(9)");
    expect(conv("R_{1}")).toBe("R1");
    expect(conv("V_{be}")).toBe("Vbe");
    expect(conv("i_{L\\,min}")).toBe("iLmin");
    expect(conv("\\left(R_1+R_2\\right)")).toBe("(R1 + R2)");
    expect(conv("j\\omega RC")).toBe("jω·R·C");
  });

  it("fonctions : argument entre parentheses", () => {
    expect(conv("\\sin\\frac{\\pi}{2}")).toBe("sin(π/2)");
    expect(conv("\\sin(2\\pi f t)")).toBe("sin(2π·f·t)");
    expect(conv("\\cos\\omega t")).toBe("cos(ω·t)");
    expect(conv("\\ln 2 + 1")).toBe("ln(2) + 1");
    expect(conv("\\sin^2 x")).toBe("sin(x)^2");
    expect(conv("\\sin^{-1}(0,5)")).toBe("asin(0,5)");
    expect(conv("\\log_{2} 8")).toBe("log(8, 2)");
    expect(conv("\\operatorname{sh}(1)")).toBe("sinh(1)");
    expect(conv("\\left|z\\right|")).toBe("abs(z)");
  });

  it("produits : implicites, \\cdot, \\times, point a la francaise", () => {
    expect(conv("2\\cdot3")).toBe("2×3");
    expect(conv("V_{CE}\\cdot I_C")).toBe("VCE×IC");
    expect(conv("a \\times b")).toBe("a×b");
    expect(conv("R.C")).toBe("R×C");
    expect(conv("10.10^{3}")).toBe("10×10^3");
    expect(conv("3.5")).toBe("3.5");
    expect(conv("2\\,3")).toBe("2×3");
    expect(conv("p(p+1)")).toBe("p(p + 1)");
    expect(conv("2e^{t}")).toBe("2·e^t");
    expect(conv("\\frac{1}{2}x")).toBe("1/2·x");
  });

  it("nombres et unites", () => {
    expect(conv("2{,}5")).toBe("2,5");
    expect(conv("50\\,\\Omega")).toBe("50 Ω");
    expect(conv("2{,}2\\,\\text{k}\\Omega")).toBe("2,2kΩ");
    expect(conv("76\\,\\text{mA}")).toBe("76 mA");
    expect(conv("10\\,\\mu F")).toBe("10 μF");
    expect(conv("100\\,\\mathrm{nF}")).toBe("100 nF");
    expect(conv("25\\,\\%")).toBe("25%");
  });

  it("jamais de commande brute, ce qui ne se calcule pas est nomme", () => {
    const cases = [
      "\\int_0^{1} x^2 \\,\\mathrm{d}x", "\\sum_{k=0}^{n} k", "v_s \\approx 3{,}8\\,\\text{V}",
      "\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}", "\\underbrace{i_L(0)}_{i_{L\\,min}}",
      "\\langle U_L\\rangle_T", "\\foo{x}", "a \\Leftrightarrow b", "\\pm 3",
    ];
    for (const c of cases) expect(conv(c), c).not.toMatch(/\\|[{}$]/);
    expect(texToCalc("v_s \\approx 3{,}8\\,\\text{V}")).toEqual({ expr: "vs", dropped: ["≈"] });
    expect(texToCalc("\\int_0^{1} x^2 \\,\\mathrm{d}x")).toEqual({ expr: "x^2", dropped: ["intégrale"] });
    expect(texToCalc("\\int x\\,dx").expr).toBe("x");
    expect(texToCalc("\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}")).toEqual({ expr: "x + y = 1; x - y = 0", dropped: ["système"] });
    expect(texToCalc("\\frac{1}{2}").dropped).toEqual([]);
  });

  it("cas limites", () => {
    expect(conv("")).toBe("");
    expect(conv("x")).toBe("x");
    expect(conv("\\frac{}{2}")).toBe("1/2");
    expect(conv("\\frac{1}{2")).toBe("1/2"); // accolade non fermee
    expect(conv("}")).toBe("");
    expect(conv("y''(t)+y")).toBe("y''(t) + y");
    expect(conv("-\\frac{R_2}{R_1}")).toBe("-R2/R1");
  });
});

describe("texToCalc : la valeur calculee ne change pas", () => {
  it("electronique", () => {
    sameValue("\\frac{1}{2\\pi RC}", "1/(2*pi*R*C)", RC);
    sameValue("\\frac{1}{2\\pi\\sqrt{LC}}", "1/(2*pi*sqrt(L*C))", ["L = 10e-3", "C = 100e-9"]);
    sameValue("\\frac{R_2}{R_1+R_2}\\cdot 12", "R2/(R1+R2)*12", ["R1 = 1000", "R2 = 2200"]);
    sameValue("\\frac{1}{\\frac{1}{R_1}+\\frac{1}{R_2}}", "1/(1/R1+1/R2)", ["R1 = 1000", "R2 = 2200"]);
    sameValue("e^{-t/\\tau}", "exp(-t/tau)", ["t = 0.002", "tau = 0.001"]);
    sameValue("5\\left(1-e^{\\frac{-t}{\\tau}}\\right)", "5*(1-exp(-t/tau))", ["t = 0.002", "tau = 0.001"]);
    sameValue("\\frac{E(1-\\alpha)}{L}\\alpha T", "E*(1-a)/L*a*T", ["E = 12", "α = 0.4", "a = 0.4", "L = 0.001", "T = 0.00002"]);
  });

  it("nombres, puissances, fonctions", () => {
    sameValue("\\frac{\\frac{1}{2}}{3}", "1/6");
    sameValue("\\left(\\frac{3}{4}\\right)^2", "9/16");
    sameValue("2\\frac{3}{4}", "1.5");
    sameValue("\\frac{10^5}{1+10^5.0{,}1}", "1e5/(1+1e5*0.1)");
    sameValue("10.10^{3}", "10000");
    sameValue("2{,}5\\times 4", "10");
    sameValue("\\sqrt{2}\\cdot\\sqrt{8}", "4");
    sameValue("\\sqrt[3]{27}", "3");
    sameValue("\\sin\\frac{\\pi}{2}", "1");
    sameValue("\\cos^2 0 + \\sin^2 0", "1");
    sameValue("\\ln e^{2}", "2");
    sameValue("\\log 1000", "3");
    sameValue("2\\pi\\cdot 50", "100*pi");
    sameValue("\\frac{-b+\\sqrt{b^2-4ac}}{2a}", "(-b+sqrt(b^2-4*a*c))/(2*a)", ["a = 1", "b = -3", "c = 2"]);
    sameValue("3!", "6");
  });

  it("unites et prefixes", () => {
    sameValue("\\frac{12}{2{,}2\\,\\text{k}}", "12/2200");
    expect(new CalcEngine().evaluate(conv("2{,}2\\,\\text{k}\\Omega")).ok).toBe(true);
    sameValue("\\frac{1}{2\\pi\\cdot 1\\,\\text{k}\\cdot 100\\,\\text{n}}", "1/(2*pi*1e3*100e-9)");
  });
});

describe("pastedToCalc / looksLikeTex", () => {
  it("delimiteurs $ $$ \\( \\) retires, texte autour garde", () => {
    expect(pastedToCalc("$$ \\frac{\\alpha}{p} $$").expr).toBe("α/p");
    expect(pastedToCalc("$\\frac{1}{2}$").expr).toBe("1/2");
    expect(pastedToCalc("\\(\\sqrt{2}\\)").expr).toBe("√(2)");
    expect(pastedToCalc("f = $\\frac{1}{2\\pi RC}$").expr).toBe("f = 1/(2π·R·C)");
  });

  it("texte simple laisse tel quel", () => {
    expect(pastedToCalc("(3+5)/2").expr).toBe("(3+5)/2");
    expect(looksLikeTex("(3+5)/2")).toBe(false);
    expect(looksLikeTex("2,2k")).toBe(false);
    expect(looksLikeTex("\\frac12")).toBe(true);
    expect(looksLikeTex("x^{2}")).toBe(true);
    expect(looksLikeTex("2{,}5")).toBe(true);
  });
});
