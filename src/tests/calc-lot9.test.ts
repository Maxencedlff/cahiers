import { describe, it, expect } from "vitest";
import { CalcEngine, normalizeInput, humanError } from "../core/calc/engine";
import { derivative, nthDerivative } from "../core/calc/derive";
import { antiderivative, definiteIntegral, simpson } from "../core/calc/integrate";
import { solveEquation, polynomialCoefficients, MAX_ROOTS } from "../core/calc/solve";
import { applyMatrixOp, parseMatrix, readMatrix } from "../core/calc/matrix";
import { rootsInWindow, autoWindow, niceTicks, samplePlot, extremaInWindow } from "../core/calc/plot";
import { insertText, HistoryRecall, deleteForward, moveCaret } from "../core/calc/screen";
import { mapKey } from "../ui/calculator/keys";

/**
 * Lot 9 de l'audit : un test par bug, ecrit avant le correctif.
 * Regle : jamais un resultat faux affiche sans avertissement.
 */

const num = (e: CalcEngine, expr: string): number => {
  const r = e.evaluate(expr);
  if (!r.ok) throw new Error(`${expr} : ${r.message}`);
  return Number(r.raw);
};
const text = (e: CalcEngine, expr: string): string => {
  const r = e.evaluate(expr);
  if (!r.ok) throw new Error(`${expr} : ${r.message}`);
  return r.text;
};

describe("calc-virgule : virgule decimale sans casser les separateurs", () => {
  it("separateur dans les fonctions", () => {
    const e = new CalcEngine();
    expect(num(e, "nthRoot(8,3)")).toBeCloseTo(2, 12);
    expect(num(e, "max(1,2)")).toBe(2);
    expect(num(e, "log(8,2)")).toBeCloseTo(3, 12);
  });
  it("separateur dans les matrices", () => {
    const e = new CalcEngine();
    expect(num(e, "det([1,2;3,4])")).toBeCloseTo(-2, 12);
  });
  it("virgule decimale hors appel", () => {
    const e = new CalcEngine();
    expect(num(e, "3,5*2")).toBe(7);
    expect(num(e, "(1,5+1)*2")).toBe(5);
    expect(num(e, "2(0,5)")).toBe(1);
    expect(normalizeInput("3,5")).toBe("3.5");
  });
  it("log10( n'est pas pris pour un groupe", () => {
    const e = new CalcEngine();
    expect(num(e, "log10(100)")).toBeCloseTo(2, 12);
  });
  it("sin(3,5) donne une erreur visible, pas un resultat faux", () => {
    const e = new CalcEngine();
    expect(e.evaluate("sin(3,5)").ok).toBe(false);
  });
});

describe("calc-derive-moins : moins unaire", () => {
  it("exp(-x)", () => {
    const d = derivative("exp(-x)", "x");
    expect(d.ok).toBe(true);
    expect(d.result?.replace(/\s/g, "")).toBe("-exp(-x)");
  });
  it("-x^2+3x", () => {
    const d = derivative("-x^2+3x", "x");
    expect(d.ok).toBe(true);
    expect(d.result?.replace(/\s/g, "")).toMatch(/^(3-2\*x|-2\*x\+3)$/);
    expect(d.steps?.rule).toBe("linearite");
  });
  it("-sin(x) a l'ordre 2", () => {
    const d = nthDerivative("-sin(x)", "x", 2);
    expect(d.ok).toBe(true);
    expect(d.result?.replace(/\s/g, "")).toBe("sin(x)");
  });
  it("-cos(2x) explique", () => {
    const d = derivative("-cos(2x)", "x");
    expect(d.ok).toBe(true);
    expect(d.steps).toBeDefined();
  });
  it("derivee seconde de x*ln(x) : ln reste ln", () => {
    const d = nthDerivative("x*ln(x)", "x", 2);
    expect(d.ok).toBe(true);
    expect(d.result?.replace(/\s/g, "")).toBe("1/x");
  });
});

describe("calc-integrale-fausse : jamais F(b)-F(a) a travers un pole", () => {
  it("1/x sur [-1, 1] n'est pas 0", () => {
    const r = definiteIntegral("1/x", "x", -1, 1);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/impropre/i);
  });
  it("tan sur [0, pi] n'est pas 0", () => {
    const r = definiteIntegral("tan(x)", "x", 0, Math.PI);
    expect(r.ok).toBe(false);
  });
  it("1/x^2 sur [-1, 2] : pole hors grille detecte", () => {
    const r = definiteIntegral("1/x^2", "x", -1, 2);
    expect(r.ok).toBe(false);
  });
  it("les cas normaux restent exacts", () => {
    expect(definiteIntegral("x^2", "x", 0, 3).value).toBeCloseTo(9, 8);
    const r = definiteIntegral("1/x", "x", 1, Math.E);
    expect(r.ok).toBe(true);
    expect(r.method).toBe("exacte");
    expect(r.value).toBeCloseTo(1, 8);
    expect(definiteIntegral("sin(x)", "x", 0, Math.PI).value).toBeCloseTo(2, 8);
  });
  it("fonction tres oscillante : la primitive exacte est gardee", () => {
    const r = definiteIntegral("sin(1000x)", "x", 0, 10);
    expect(r.ok).toBe(true);
    expect(r.value).toBeCloseTo((1 - Math.cos(10000)) / 1000, 8);
  });
  it("simpson reste disponible", () => {
    expect(simpson("x", "x", 0, 2)).toBeCloseTo(2, 10);
  });
});

describe("calc-racines", () => {
  it("les poles de tan ne sont pas des racines", () => {
    const roots = rootsInWindow("tan(x)", -8, 8);
    expect(roots.length).toBe(5);
    for (const r of roots) expect(Math.abs(Math.sin(r))).toBeLessThan(1e-6);
  });
  it("tan(x)=0 : pas de pole dans les solutions", () => {
    const r = solveEquation("tan(x) = 0");
    expect(r.ok).toBe(true);
    for (const x of r.roots!) expect(Math.abs(Math.sin(Number(x.value)))).toBeLessThan(1e-6);
  });
  it("l'inconnue est deduite des symboles", () => {
    const r = solveEquation("t^2 - 4 = 0");
    expect(r.ok).toBe(true);
    expect(r.variable).toBe("t");
    expect(r.roots?.map((x) => x.value)).toEqual([-2, 2]);
  });
  it("plusieurs inconnues : message clair", () => {
    const r = solveEquation("a*x + 1 = 0");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lettres/);
  });
  it("x = x : toujours vrai, pas 4000 racines", () => {
    const r = solveEquation("x = x");
    expect(r.ok).toBe(true);
    expect(r.roots).toHaveLength(0);
    expect(r.message).toMatch(/toujours vrai/i);
  });
  it("x = x + 1 : aucune solution", () => {
    expect(solveEquation("x = x + 1").ok).toBe(false);
  });
  it("identites", () => {
    const r = solveEquation("sin(x)^2 + cos(x)^2 = 1");
    expect(r.roots).toHaveLength(0);
    expect(r.message).toMatch(/toujours vrai/i);
    const n = solveEquation("abs(x) = sqrt(x^2)");
    expect(n.roots).toHaveLength(0);
    expect(n.message).toMatch(/toujours vrai|toutes les valeurs/i);
  });
  it("sin(x) = 0 : au plus 10 racines, puis le compte du reste", () => {
    const r = solveEquation("sin(x) = 0");
    expect(r.roots!.length).toBe(MAX_ROOTS);
    expect(r.more).toBeGreaterThan(40);
    expect(r.roots!.some((x) => x.value === 0)).toBe(true);
  });
  it("cos(x) n'est pas pris pour son polynome de Taylor", () => {
    expect(() => polynomialCoefficients("cos(x)")).toThrow();
    const r = solveEquation("cos(x) = 0");
    expect(r.method).toBe("numerique");
  });
  it("degre 4 : racines complexes", () => {
    const r = solveEquation("x^4 + 1 = 0");
    expect(r.ok).toBe(true);
    expect(r.roots).toHaveLength(4);
    for (const x of r.roots!) {
      const v = x.value as { re: number; im: number };
      expect(Math.abs(v.re)).toBeCloseTo(Math.SQRT1_2, 8);
      expect(Math.abs(v.im)).toBeCloseTo(Math.SQRT1_2, 8);
    }
  });
  it("racine quadruple", () => {
    const r = solveEquation("(x - 1.03)^4 = 0");
    expect(r.ok).toBe(true);
    expect(r.roots).toHaveLength(1);
    expect(Number(r.roots![0].value)).toBeCloseTo(1.03, 8);
    expect(r.roots![0].multiplicity).toBe(4);
  });
  it("degre 3 et 5", () => {
    expect(solveEquation("x^3 - 6x^2 + 11x - 6 = 0").roots?.map((x) => x.value)).toEqual([1, 2, 3]);
    const r = solveEquation("x^5 - x = 0");
    const reals = r.roots!.filter((x) => typeof x.value === "number").map((x) => x.value);
    expect(reals).toEqual([-1, 0, 1]);
    expect(r.roots).toHaveLength(5);
  });
});

describe("calc-clavier-vole et calc-azerty", () => {
  it("Ctrl, Alt et Meta laissent passer", () => {
    expect(mapKey({ key: "l", ctrlKey: true })).toBeNull();
    expect(mapKey({ key: "z", ctrlKey: true })).toBeNull();
    expect(mapKey({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(mapKey({ key: "c", metaKey: true })).toBeNull();
  });
  it("touches d'edition", () => {
    for (const [key, action] of [
      ["ArrowLeft", "left"], ["ArrowRight", "right"], ["Home", "home"], ["End", "end"],
      ["Delete", "delete"], ["Backspace", "back"], ["Escape", "escape"],
      ["ArrowUp", "up"], ["ArrowDown", "down"], ["Enter", "equals"],
    ] as const) {
      expect(mapKey({ key })).toEqual({ kind: "action", action });
    }
  });
  it("caracteres utiles", () => {
    for (const c of ["!", "=", "[", "]", ";", "%", " ", "²", "³", "π", "µ", "Ω", "_"]) {
      expect(mapKey({ key: c })).toEqual({ kind: "insert", text: c });
    }
  });
  it("^ en touche morte AZERTY", () => {
    expect(mapKey({ key: "Dead", code: "BracketLeft" })).toEqual({ kind: "insert", text: "^" });
    expect(mapKey({ key: "Dead", code: "BracketLeft", shiftKey: true })).toEqual({ kind: "swallow" });
  });
  it("AltGr donne les crochets, jamais une lettre", () => {
    expect(mapKey({ key: "[", ctrlKey: true, altKey: true })).toEqual({ kind: "insert", text: "[" });
    expect(mapKey({ key: "e", ctrlKey: true, altKey: true })).toBeNull();
  });
  it("² est compris par le moteur", () => {
    expect(num(new CalcEngine(), "3²")).toBe(9);
  });
});

describe("calc-ecran-ti (D10)", () => {
  it("un operateur en tete reprend ans", () => {
    expect(insertText({ input: "", caret: 0 }, "+", true)).toEqual({ input: "ans+", caret: 4 });
    for (const op of ["*", "/", "^", "²", "!", "^2", "^(-1)"]) {
      expect(insertText({ input: "", caret: 0 }, op, true).input).toBe(`ans${op}`);
    }
  });
  it("le moins reste unaire", () => {
    expect(insertText({ input: "", caret: 0 }, "-", true).input).toBe("-");
  });
  it("sans resultat precedent, rien n'est prefixe", () => {
    expect(insertText({ input: "", caret: 0 }, "+", false).input).toBe("+");
  });
  it("au milieu d'une saisie, insertion au curseur", () => {
    expect(insertText({ input: "12", caret: 1 }, "+", true)).toEqual({ input: "1+2", caret: 2 });
  });
  it("2+3 puis +1 donne 6", () => {
    const e = new CalcEngine();
    e.evaluate("2+3");
    const s = insertText({ input: "", caret: 0 }, "+", e.history.length > 0);
    expect(num(e, insertText(s, "1").input)).toBe(6);
  });
  it("Suppr et curseur", () => {
    expect(deleteForward({ input: "123", caret: 1 })).toEqual({ input: "13", caret: 1 });
    expect(moveCaret({ input: "123", caret: 1 }, 9).caret).toBe(3);
  });
  it("rappel de l'historique avec brouillon", () => {
    const h = new HistoryRecall();
    const list = ["1+1", "2*3"];
    expect(h.step(list, "7", -1)).toBe("2*3");
    expect(h.step(list, "2*3", -1)).toBe("1+1");
    expect(h.step(list, "1+1", -1)).toBeNull();
    expect(h.step(list, "1+1", 1)).toBe("2*3");
    expect(h.step(list, "2*3", 1)).toBe("7");
  });
  it("l'historique garde la saisie telle que tapee", () => {
    const e = new CalcEngine();
    e.evaluate("ln(e)");
    expect(e.history.at(-1)!.expr).toBe("ln(e)");
    // Relue, elle redonne le meme resultat (ln ne devient pas log10).
    expect(num(e, e.history.at(-1)!.expr)).toBeCloseTo(1, 12);
  });
});

describe("calc-ln-log-messages", () => {
  it("ln est le logarithme neperien", () => {
    const e = new CalcEngine();
    expect(num(e, "ln(e^2)")).toBeCloseTo(2, 12);
    expect(derivative("ln(x)", "x").result?.replace(/\s/g, "")).toBe("1/x");
  });
  it("log a un argument est decimal, comme la touche log", () => {
    const e = new CalcEngine();
    expect(num(e, "log(100)")).toBeCloseTo(2, 12);
    expect(num(e, "log(8, 2)")).toBeCloseTo(3, 12);
    expect(num(e, "log(max(10,100))")).toBeCloseTo(2, 12);
  });
  it("messages en francais", () => {
    const e = new CalcEngine();
    const r = e.evaluate("foo(2)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Fonction inconnue/);
    expect(applyMatrixOp([[1, 2], [2, 4]], "inv").message).toMatch(/déterminant nul/);
    expect(applyMatrixOp([[1, 2, 3]], "det").message).toMatch(/carrée/);
    expect(humanError(new Error("Unexpected end of expression"))).toBe("Expression incomplète");
  });
  it("fonctions utilisateur gardees", () => {
    const e = new CalcEngine();
    expect(e.evaluate("f(x) = x^2 + 1").ok).toBe(true);
    expect(num(e, "f(3)")).toBe(10);
  });
  it("une variable redefinie prend sa nouvelle valeur", () => {
    const e = new CalcEngine();
    e.evaluate("a = 3");
    e.evaluate("a = 4");
    expect(num(e, "a * 2")).toBe(8);
  });
  it("une definition ne remplace pas ans", () => {
    const e = new CalcEngine();
    e.evaluate("6*7");
    e.evaluate("g(t) = 2t");
    expect(num(e, "ans")).toBe(42);
  });
});

describe("calc-residus-flottants", () => {
  it("sin(pi) = 0 et cos(90) en DEG = 0", () => {
    const e = new CalcEngine();
    expect(text(e, "sin(pi)")).toBe("0");
    expect(text(e, "cos(pi/2)")).toBe("0");
    e.angleMode = "DEG";
    expect(text(e, "cos(90)")).toBe("0");
    expect(text(e, "sin(180)")).toBe("0");
  });
  it("tan(90°) n'est pas 1.6e16 : erreur explicite", () => {
    const e = new CalcEngine();
    e.angleMode = "DEG";
    expect(e.evaluate("tan(90)").ok).toBe(false);
  });
  it("annulation : 0.1 + 0.2 - 0.3 = 0", () => {
    expect(text(new CalcEngine(), "0.1 + 0.2 - 0.3")).toBe("0");
  });
  it("e^(i pi) = -1 sans partie imaginaire parasite", () => {
    expect(text(new CalcEngine(), "e^(i*pi)")).toBe("-1");
  });
  it("les petites valeurs reelles ne sont jamais arrondies a 0", () => {
    const e = new CalcEngine();
    expect(num(e, "3e-15 * 2")).toBeCloseTo(6e-15, 25);
    expect(num(e, "1e-15 + 2e-15")).toBeCloseTo(3e-15, 25);
    expect(num(e, "sin(1e-13)")).toBeCloseTo(1e-13, 25);
  });
});

describe("unites (electronique)", () => {
  it("µ et Ω", () => {
    const e = new CalcEngine();
    expect(text(e, "1/(2*pi*2,2kΩ*10nF)")).toMatch(/kHz/);
    expect(text(e, "5 V / 2 kΩ")).toBe("2.5 mA");
    expect(text(e, "10 µF * 5 V")).toMatch(/uC|µC/);
  });
  it("angle avec unite, en RAD comme en DEG", () => {
    const e = new CalcEngine();
    expect(num(e, "sin(90 deg)")).toBeCloseTo(1, 12);
    e.angleMode = "DEG";
    expect(num(e, "sin(90 deg)")).toBeCloseTo(1, 12);
    expect(num(e, "cos(1 rad)")).toBeCloseTo(Math.cos(1), 12);
  });
});

describe("calc-fenetre-courbe", () => {
  it("x + 100 reste a l'ecran (fenetre non inversee)", () => {
    const p = samplePlot("x + 100", -8, 8, 300);
    const w = autoWindow(p.samples!);
    expect(w.yMin).toBeLessThan(w.yMax);
    expect(w.yMin).toBeLessThan(93);
    expect(w.yMax).toBeGreaterThan(107);
  });
  it("230 sin(x) n'est pas ecretee", () => {
    const w = autoWindow(samplePlot("230 sin(x)", -8, 8, 600).samples!);
    expect(w.yMax).toBeGreaterThan(229);
    expect(w.yMin).toBeLessThan(-229);
  });
  it("une asymptote n'ecrase pas la courbe", () => {
    const w = autoWindow(samplePlot("tan(x)", -8, 8, 700).samples!);
    expect(w.yMax).toBeLessThan(200);
  });
  it("pas de faux extremums au bord d'une asymptote", () => {
    expect(extremaInWindow("tan(x)", -8, 8)).toEqual([]);
    expect(extremaInWindow("1/x", -2, 2)).toEqual([]);
    const sin = extremaInWindow("sin(x)", -4, 4);
    expect(sin.map((p) => p.kind)).toEqual(["min", "max"]);
    expect(sin[1].x).toBeCloseTo(Math.PI / 2, 1);
  });
  it("graduations rondes", () => {
    expect(niceTicks(-8, 8).ticks).toEqual([-8, -6, -4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(0, 1, 5).step).toBe(0.2);
    expect(niceTicks(0, 1, 5).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe("calc-litteral-preview-envoi : matrices", () => {
  it("virgule decimale dans une cellule", () => {
    expect(parseMatrix("0,5 1,5\n2 3")).toEqual([[0.5, 1.5], [2, 3]]);
  });
  it("separateurs ; et cellules evaluees", () => {
    expect(parseMatrix("1/2 pi; 0 1")).toEqual([[0.5, Math.PI], [0, 1]]);
    expect(parseMatrix("[1, 2; 3, 4]")).toEqual([[1, 2], [3, 4]]);
    expect(parseMatrix("1, 2\n3, 4")).toEqual([[1, 2], [3, 4]]);
  });
  it("message precis si une ligne est trop courte", () => {
    const r = readMatrix("1 2\n3");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Ligne 2/);
  });
});

describe("calc-exact", () => {
  it("x^2 - 2 = 0 donne ±√2", () => {
    const r = solveEquation("x^2 - 2 = 0");
    expect(r.roots?.map((x) => x.latex)).toEqual(["-\\sqrt{2}", "\\sqrt{2}"]);
  });
  it("forme reduite et fractions", () => {
    expect(solveEquation("x^2 - 2x - 1 = 0").roots?.map((x) => x.latex)).toEqual(["1 - \\sqrt{2}", "1 + \\sqrt{2}"]);
    expect(solveEquation("2x^2 - 2x - 1 = 0").roots?.map((x) => x.latex)).toEqual(["\\frac{1 - \\sqrt{3}}{2}", "\\frac{1 + \\sqrt{3}}{2}"]);
    expect(solveEquation("3x - 1 = 0").roots?.[0].latex).toBe("\\frac{1}{3}");
    expect(solveEquation("-x^2 + 2 = 0").roots?.map((x) => x.latex)).toEqual(["-\\sqrt{2}", "\\sqrt{2}"]);
  });
  it("racines complexes exactes", () => {
    const r = solveEquation("x^2 + 2x + 5 = 0");
    expect(r.roots?.map((x) => x.latex)).toEqual(["-1 - 2\\,i", "-1 + 2\\,i"]);
  });
  it("ln 2 garde dans les derivees", () => {
    const d = derivative("2^x", "x");
    expect(d.result).toContain("log(2)");
    expect(d.resultLatex).toContain("\\ln");
  });
});

describe("primitives usuelles ajoutees", () => {
  const check = (f: string, x0 = 0.7) => {
    const r = antiderivative(f, "x");
    expect(r.ok, `${f} : ${r.message}`).toBe(true);
    // Verification : F' = f en un point.
    const h = 1e-5;
    const e = new CalcEngine();
    const F = (x: number) => num(e, `(${r.result})`.replace(/x/g, `(${x})`).replace(/\blog\(/g, "ln("));
    const fx = num(e, f.replace(/x/g, `(${x0})`));
    expect((F(x0 + h) - F(x0 - h)) / (2 * h)).toBeCloseTo(fx, 5);
  };
  it("1/x², 1/√x, 1/(1+x²), cos², sin²", () => {
    check("1/x^2");
    check("1/sqrt(x)");
    check("1/(1+x^2)");
    check("3/(4x^2+9)");
    check("cos(x)^2");
    check("sin(2x)^2");
  });
});
