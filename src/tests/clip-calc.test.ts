/**
 * Copier une formule de la page, la coller dans la calculatrice (bout en
 * bout) : LaTeX de la page -> texToPlain (text/plain du presse-papiers) ->
 * routage du collage (Calcul ou Résoudre) -> acceptText -> insertText ->
 * CalcEngine.evaluate / solveEquation / simplifyExpr.
 * Formules reelles des cahiers de Maxence (TD d'electronique, Laplace).
 */
import { describe, it, expect } from "vitest";
import { texToPlain } from "../core/text/doc";
import { acceptText } from "../ui/calculator/keys";
import { CalcEngine, type EvalResult } from "../core/calc/engine";
import { insertText, pasteGoesToSolve } from "../core/calc/screen";
import { solveEquation, type SolveOutcome } from "../core/calc/solve";
import { simplifyExpr } from "../core/calc/derive";

/** Ce que l'ecran Calcul recoit au collage (meme chemin que le listener « paste »). */
function clip(latex: string): string {
  return texToPlain(latex).replace(/\s+/g, " ").trim();
}

type Pasted = { tab: "calcul"; r: EvalResult } | { tab: "resoudre"; s: SolveOutcome };

function paste(latex: string, engine = new CalcEngine()): Pasted {
  const text = clip(latex);
  if (pasteGoesToSolve(text)) return { tab: "resoudre", s: solveEquation(text) };
  const t = acceptText(text.replace(/\s+/g, " "));
  expect(t.rejected, `caracteres refuses dans « ${text} »`).toBe("");
  const st = insertText({ input: "", caret: 0 }, t.text, engine.history.length > 0, false);
  return { tab: "calcul", r: engine.evaluate(st.input) };
}

/** Valeur numerique du collage dans l'onglet Calcul. */
function value(latex: string, engine?: CalcEngine): number {
  const p = paste(latex, engine);
  expect(p.tab).toBe("calcul");
  const r = (p as { r: EvalResult }).r;
  expect(r.ok, `${latex} -> ${clip(latex)} : ${r.ok ? "" : r.message}`).toBe(true);
  return Number((r as any).raw);
}

function error(latex: string, engine?: CalcEngine): string {
  const p = paste(latex, engine);
  expect(p.tab).toBe("calcul");
  const r = (p as { r: EvalResult }).r;
  expect(r.ok).toBe(false);
  return (r as any).message as string;
}

/** Calculatrice avec des grandeurs definies (comme tapees dans l'onglet Calcul). */
function withVars(defs: string[]): CalcEngine {
  const e = new CalcEngine();
  for (const d of defs) expect(e.evaluate(d).ok, d).toBe(true);
  return e;
}

/** Une expression a lettres, evaluee en un point (pour comparer des formes). */
function at(expr: string, scope: Record<string, number>): number {
  return Number(new CalcEngine().math.evaluate(expr.replace(/·/g, "*"), scope));
}

describe("coller une fraction : cas du TD (signalés)", () => {
  it("\\frac{10^5}{1+10^5.0,1} : le point est le signe fois (10^5 × 0,1)", () => {
    expect(clip("\\frac{10^5}{1+10^5.0,1}")).toBe("10^5/(1+10^5.0,1)");
    expect(value("\\frac{10^5}{1+10^5.0,1}")).toBeCloseTo(1e5 / (1 + 1e4), 9);
    expect(value("\\frac{10^4}{1+10^4.0,1}")).toBeCloseTo(1e4 / 1001, 9);
  });

  it("puissances de 10 a la francaise : 10.10^3 = 10×10³", () => {
    expect(value("\\frac{-1}{10.10^3\\cdot100.10^{-6}}")).toBeCloseTo(-1, 12);
  });

  it("fraction de fractions", () => {
    expect(clip("\\frac{\\frac{1}{2}}{\\frac{3}{4}}")).toBe("1/2/(3/4)");
    expect(value("\\frac{\\frac{1}{2}}{\\frac{3}{4}}")).toBeCloseTo(2 / 3, 12);
    expect(value("\\frac{1}{\\frac{1}{3}}")).toBeCloseTo(3, 12);
  });

  it("fraction elevee a une puissance", () => {
    expect(clip("\\frac{3}{4}^{2}")).toBe("(3/4)^2");
    expect(value("\\frac{3}{4}^{2}")).toBeCloseTo(0.5625, 12);
    expect(value("\\frac{1}{2}^{3}")).toBeCloseTo(0.125, 12);
  });

  it("facteur colle ou separe par \\, : un produit", () => {
    expect(value("2\\,\\frac{3}{4}")).toBeCloseTo(1.5, 12);
    expect(value("2\\frac{1}{2}")).toBeCloseTo(1, 12); // jamais « 21/2 »
    expect(value("\\frac{1}{2}\\sin(2)")).toBeCloseTo(Math.sin(2) / 2, 12);
    expect(value("\\frac{3}{2}\\left(1+2\\right)")).toBeCloseTo(4.5, 12);
  });

  it("\\frac12\\,\\sin(2\\,t) sans valeur de t : message propre", () => {
    expect(error("\\frac{1}{2}\\,\\sin\\left(2\\,t\\right)")).toBe("Symbole inconnu : t");
    expect(value("\\frac{1}{2}\\,\\sin\\left(2\\,t\\right)", withVars(["t = 0.25"]))).toBeCloseTo(Math.sin(0.5) / 2, 12);
  });

  it("p(p+1) : p n'est pas une fonction, c'est un produit", () => {
    expect(error("\\frac{5}{p\\left(p+1\\right)}")).toBe("Symbole inconnu : p");
    expect(value("\\frac{5}{p\\left(p+1\\right)}", withVars(["p = 2"]))).toBeCloseTo(5 / 6, 12);
  });

  it("R.C.p : le point entre lettres est un produit", () => {
    expect(error("\\frac{1}{R.C.p+1}")).toBe("Symbole inconnu : R");
    const e = withVars(["R = 1000", "C = 1e-6", "p = 500"]);
    expect(value("\\frac{1}{R.C.p+1}", e)).toBeCloseTo(1 / 1.5, 12);
    // « -1/R.C » serait relu (-1/R)·C : le denominateur garde ses parentheses.
    expect(clip("\\frac{-1}{R.C}")).toBe("-1/(R.C)");
    expect(value("\\frac{-1}{R.C}", e)).toBeCloseTo(-1000, 9);
  });

  it("grandeurs a indice sans valeur : symbole inconnu nomme", () => {
    expect(error("\\frac{V_z-V_{BE}}{R_u}")).toBe("Symbole inconnu : Vz");
    const e = withVars(["Vz = 5.6", "VBE = 0,7", "beta = 100", "Ru = 1000"]);
    expect(value("\\frac{V_z-V_{BE}}{R_u}", e)).toBeCloseTo(4.9e-3, 12);
    expect(value("\\frac{V_z-V_{BE}}{\\beta R_u}", e)).toBeCloseTo(4.9e-5, 12);
  });

  it("Feq = fraction de fractions : part dans Résoudre, lue et mise en forme", () => {
    const latex = "F_{eq}=\\frac{\\frac{K}{p(p+3)}}{1+\\frac{K}{p(p+3)}}";
    const p = paste(latex);
    expect(p.tab).toBe("resoudre");
    const s = (p as { s: SolveOutcome }).s;
    expect(s.ok, s.message).toBe(true);
    expect(s.variable).toBe("Feq");
    const text = s.roots![0].text;
    // K/(p² + 3p + K), une seule barre de fraction.
    expect(text.split("/").length).toBe(2);
    expect(text.replace(/\s+/g, "")).toBe("K/(p^2+3*p+K)");
    for (const [K, pp] of [[2, 1.3], [7, -0.4], [0.5, 4]]) {
      expect(at(text, { K, p: pp })).toBeCloseTo(K / (pp * pp + 3 * pp + K), 10);
    }
    // Onglet Littéral, Simplifier sur le second membre : la meme forme.
    const r = simplifyExpr(clip(latex).split("=")[1]);
    expect(r.ok).toBe(true);
    expect(r.result!.split("/").length).toBe(2);
    expect(at(r.result!, { K: 3, p: 2 })).toBeCloseTo(3 / 13, 10);
  });
});

describe("coller : formules des cahiers", () => {
  it("nombres et virgule decimale", () => {
    expect(value("\\frac{1}{0,1}")).toBeCloseTo(10, 12);
    expect(value("1{,}5\\times2")).toBeCloseTo(3, 12);
    expect(value("\\frac12")).toBeCloseTo(0.5, 12);
    expect(value("\\dfrac{3}{4}")).toBeCloseTo(0.75, 12);
    expect(value("\\left(1+2\\right)\\cdot3")).toBe(9);
    expect(value("2\\times3")).toBe(6);
    expect(value("10^{2.5}")).toBeCloseTo(10 ** 2.5, 9);
  });

  it("Laplace : fonctions de transfert en p", () => {
    const e = withVars(["p = 2"]);
    expect(value("\\frac{4}{p+1}", e)).toBeCloseTo(4 / 3, 12);
    expect(value("\\frac{\\frac{4}{p + 1}}{1+(\\frac{4}{p+1}).0,2}", e)).toBeCloseTo(20 / 19, 12);
    expect(value("{\\displaystyle\\frac{K}{p^2+3\\,p+K}}", withVars(["p = 1", "K = 2"]))).toBeCloseTo(1 / 3, 12);
    expect(value("\\frac{1}{p+1}\\cdot\\frac{2}{p}", e)).toBeCloseTo(1 / 3, 12);
    expect(value("\\frac{K}{p}T", withVars(["K = 2", "p = 4", "T = 10"]))).toBeCloseTo(5, 12);
    // Simplifier (une lettre) : la forme qu'on ecrit.
    const r = simplifyExpr(clip("\\frac{\\frac{4}{p + 1}}{1+(\\frac{4}{p+1}).0,2}"));
    expect(r.ok).toBe(true);
    expect(at(r.result!, { p: 3 })).toBeCloseTo(20 / 24, 10);
  });

  it("Laplace : une equation part dans Résoudre", () => {
    const p = paste("\\frac{4}{p+1}=2");
    expect(p.tab).toBe("resoudre");
    expect((p as { s: SolveOutcome }).s.roots?.map((x) => x.value)).toEqual([1]);
    const q = paste("\\frac{5}{p\\left(p+1\\right)}=1");
    const roots = (q as { s: SolveOutcome }).s.roots!.map((x) => x.value as number);
    expect(roots.length).toBe(2);
    for (const x of roots) expect(5 / (x * (x + 1))).toBeCloseTo(1, 6);
  });

  it("electronique : RC, LC, hacheur, Zener", () => {
    expect(value("\\frac{1}{2\\pi\\sqrt{10.10^{-3}\\cdot100.10^{-9}}}")).toBeCloseTo(1 / (2 * Math.PI * Math.sqrt(1e-9)), 6);
    expect(value("\\frac{1}{2\\pi\\sqrt{L\\,C}}", withVars(["L = 10e-3", "C = 100e-9"]))).toBeCloseTo(1 / (2 * Math.PI * Math.sqrt(1e-9)), 6);
    expect(value("\\frac{t_{on}}{T}", withVars(["ton = 2", "T = 10"]))).toBeCloseTo(0.2, 12);
    expect(value("\\frac{12}{4,7.10^3}")).toBeCloseTo(12 / 4700, 12);
    expect(value("2,2.10^{3}\\cdot4,7.10^{-9}")).toBeCloseTo(2.2e3 * 4.7e-9, 18);
    expect(value("\\frac{230^2}{50}")).toBeCloseTo(1058, 9);
    expect(value("20\\log\\left(\\frac{10^4}{1+10^4.0,1}\\right)")).toBeCloseTo(20 * Math.log10(1e4 / 1001), 9);
  });

  it("module d'un premier ordre en j", () => {
    const p = paste("\\frac{1}{1+j\\cdot2\\pi\\cdot50\\cdot1.10^{3}\\cdot1.10^{-6}}");
    expect(p.tab).toBe("calcul");
    const r = (p as { r: EvalResult }).r;
    expect(r.ok).toBe(true);
    const z = (r as any).raw as { re: number; im: number };
    expect(Math.hypot(z.re, z.im)).toBeCloseTo(1 / Math.hypot(1, 2 * Math.PI * 50e-3), 9);
  });
});

describe("pas de regression a la frappe", () => {
  it("point decimal anglais garde ailleurs", () => {
    const e = new CalcEngine();
    expect(Number((e.evaluate("3.5*2") as any).raw)).toBe(7);
    expect(Number((e.evaluate("2^0.5") as any).raw)).toBeCloseTo(Math.SQRT2, 12);
    expect(Number((e.evaluate("10^2.5") as any).raw)).toBeCloseTo(10 ** 2.5, 9);
    expect(Number((e.evaluate("max(2.5,3)") as any).raw)).toBe(3);
  });

  it("milliers a l'espace, nombres separes = produit", () => {
    const e = new CalcEngine();
    expect(Number((e.evaluate("1 000 + 1") as any).raw)).toBe(1001);
    expect(Number((e.evaluate("2 3/4") as any).raw)).toBeCloseTo(1.5, 12);
  });

  it("fonctions definies et appels gardes", () => {
    const e = new CalcEngine();
    expect(e.evaluate("f(x) = x^2").ok).toBe(true);
    expect(Number((e.evaluate("f(3)") as any).raw)).toBe(9);
    expect(Number((e.evaluate("f(1+2)") as any).raw)).toBe(9);
    expect(Number((e.evaluate("sqrt(16)") as any).raw)).toBe(4);
    expect(Number((e.evaluate("nthRoot(8, 3)") as any).raw)).toBeCloseTo(2, 12);
    expect(e.evaluate("p = 2").ok).toBe(true);
    expect(Number((e.evaluate("p(p+1)") as any).raw)).toBe(6);
    expect(Number((e.evaluate("2p(p+1)") as any).raw)).toBe(12);
    expect((e.evaluate("foo(2)") as any).message).toBe("Fonction inconnue : foo");
  });

  it("unites derriere un nombre", () => {
    const e = new CalcEngine();
    const r = e.evaluate("5 m + 2 m");
    expect(r.ok).toBe(true);
    expect(e.evaluate("5 m + 2 s").ok).toBe(false);
  });

  it("routage du collage", () => {
    expect(pasteGoesToSolve(clip("\\frac{10^5}{1+10^5.0,1}"))).toBe(false);
    expect(pasteGoesToSolve("2μ + 3 = 13")).toBe(true);
    expect(pasteGoesToSolve("sin(pi) = 0")).toBe(false);
  });

  it("U = R I garde sa question (quelle inconnue ?)", () => {
    const s = solveEquation("U = R I");
    expect(s.ok).toBe(false);
    expect(solveEquation("U = R I", "I").roots?.[0].text).toBe("U / R");
  });

  it("texte de recherche : derivee en operateur, fonctions, bornes", () => {
    expect(clip("\\frac{d}{dt}\\left(x\\right)")).toBe("d/dt(x)");
    expect(clip("\\sin\\frac{\\pi}{2}")).toBe("sin pi/2");
    expect(clip("\\int_{0}^{1}\\frac{1}{x}\\,\\mathrm{d}x")).toBe("int_0^1 1/x dx");
    expect(clip("\\pi\\frac{1}{2}")).toBe("pi · 1/2");
  });
});
