import { describe, it, expect } from "vitest";
import {
  CalcEngine, normalizeInput, frNumber, displayValue, humanError, texArc,
} from "../core/calc/engine";
import { insertText } from "../core/calc/screen";
import { calcTex, exprTex, resultTex } from "../core/calc/live";
import {
  samplePlot, valueTable, logTicks, engTick, dbWrap, dbUnwrap, levelCrossings, plotVariable,
} from "../core/calc/plot";
import { antiderivative } from "../core/calc/integrate";
import { mapKey, acceptText } from "../ui/calculator/keys";

/**
 * Seance de TD d'electronique jouee par le testeur UX (constats 7, 9, 10, 18).
 * Un test par constat, ecrit avant le correctif.
 */

const ok = (e: CalcEngine, expr: string) => {
  const r = e.evaluate(expr);
  if (!r.ok) throw new Error(`${expr} : ${r.message}`);
  return r;
};

describe("7. j est l'unite imaginaire (electronique)", () => {
  it("(3+4j)*(1-2j) = 11 - 2j", () => {
    const e = new CalcEngine();
    const r = ok(e, "(3+4j)*(1-2j)");
    expect((r.raw as any).re).toBeCloseTo(11, 12);
    expect((r.raw as any).im).toBeCloseTo(-2, 12);
    expect(r.display).toBe("11 - 2j");
  });
  it("2j, j*w, jω, j(...) sont lus comme i", () => {
    expect(normalizeInput("2j")).toBe("2i");
    expect(normalizeInput("1+j*w")).toBe("1+i*w");
    expect(normalizeInput("1+jω")).toBe("1+i*ω");
    expect(normalizeInput("j(1+x)")).toBe("i*(1+x)");
    // Un nom qui contient j n'est pas touche.
    expect(normalizeInput("adj+jx")).toBe("adj+jx");
  });
  it("j defini par l'utilisateur reste sa variable", () => {
    const e = new CalcEngine();
    ok(e, "j = 3");
    expect(ok(e, "2*j").raw).toBe(6);
  });
  it("reglage i : affichage avec i", () => {
    const e = new CalcEngine();
    e.imagUnit = "i";
    expect(ok(e, "sqrt(-4)").display).toBe("2i");
    e.imagUnit = "j";
    expect(ok(e, "sqrt(-4)").display).toBe("2j");
  });
  it("forme polaire : module et argument (rad ou degres selon le mode)", () => {
    const e = new CalcEngine();
    expect(ok(e, "3+4j").polar).toBe("5 ∠ 0,927295 rad");
    e.angleMode = "DEG";
    expect(ok(e, "3+4j").polar).toBe("5 ∠ 53,1301°");
    expect(ok(e, "1+j").polar).toBe("1,41421 ∠ 45°");
  });
  it("abs, arg, conj, re, im ; arg suit le mode d'angle", () => {
    const e = new CalcEngine();
    expect(ok(e, "abs(3+4j)").raw).toBe(5);
    expect(ok(e, "re(3+4j)").raw).toBe(3);
    expect(ok(e, "im(3+4j)").raw).toBe(4);
    expect(ok(e, "conj(3+4j)").display).toBe("3 - 4j");
    e.angleMode = "DEG";
    expect(ok(e, "arg(1+j)").raw as number).toBeCloseTo(45, 10);
  });
  it("lu par le moteur : j reste j", () => {
    const e = new CalcEngine();
    const tex = e.toLatex("(3+4j)*(1-2j)", true)!;
    expect(tex).toContain("j");
    expect(tex).not.toMatch(/(?<![\\a-z])i(?![a-z])/);
  });
});

describe("7. une frappe apres une erreur remplace l'expression", () => {
  it("insertText en mode apres-erreur", () => {
    const s = insertText({ input: "2,2k||", caret: 6 }, "5", true, true);
    expect(s).toEqual({ input: "5", caret: 1 });
    // Pas d'enchainement sur ans apres une erreur.
    expect(insertText({ input: "1+", caret: 2 }, "+", true, true).input).toBe("+");
  });
});

describe("10. affichage des nombres a la francaise", () => {
  it("6 chiffres significatifs, virgule decimale", () => {
    expect(frNumber(0.3)).toBe("0,3");
    expect(frNumber(-4.64346024258)).toBe("-4,64346");
    expect(frNumber(3.826086956)).toBe("3,82609");
    expect(frNumber(7234.31559509)).toBe("7234,32");
    expect(frNumber(1024)).toBe("1024");
    expect(frNumber(1073741824)).toBe("1073741824");
    expect(frNumber(1.5e-12)).toBe("1,5·10⁻¹²");
    expect(frNumber(6.02214076e23)).toBe("6,02214·10²³");
  });
  it("infini et non defini en francais", () => {
    expect(frNumber(Infinity)).toBe("∞");
    expect(frNumber(-Infinity)).toBe("-∞");
    expect(frNumber(NaN)).toBe("non défini");
    const e = new CalcEngine();
    expect(ok(e, "1/0").display).toBe("∞");
    expect(ok(e, "-1/0").display).toBe("-∞");
    expect(ok(e, "0/0").display).toBe("non défini");
  });
  it("complexe arrondi lisible", () => {
    const v = displayValue({ isComplex: true, re: 0.343553428041, im: -0.474894167286 } as any, { imag: "j", angle: "RAD" });
    expect(v.text).toBe("0,343553 - 0,474894j");
  });
  it("valeur complete gardee a cote", () => {
    const e = new CalcEngine();
    const r = ok(e, "20*log(1/sqrt(1+(1000/723)^2))");
    expect(r.display).toBe("-4,64346");
    expect(r.full).toMatch(/^-4,6434602/);
    expect(ok(e, "0.3").full).toBeUndefined();
  });
  it("l'erreur cite ce que l'utilisateur a tape", () => {
    const e = new CalcEngine();
    const r = e.evaluate("2,2,2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain("2.2");
    expect(humanError(new Error('Unexpected part "2.2" (char 4)'), "1+2,2,5")).toBe("Caractère inattendu : 2,2");
  });
});

describe("operateur parallele // et ||", () => {
  it("2,2k||4,7k et 2,2k//4,7k", () => {
    const e = new CalcEngine();
    expect(ok(e, "2,2k||4,7k").raw as number).toBeCloseTo(2200 * 4700 / 6900, 9);
    expect(ok(e, "2,2k//4,7k").raw as number).toBeCloseTo(2200 * 4700 / 6900, 9);
  });
  it("associatif, plus fort que +, plus faible que *", () => {
    const e = new CalcEngine();
    expect(ok(e, "3//6//2").raw as number).toBeCloseTo(1, 12);
    expect(ok(e, "1+3//6").raw as number).toBeCloseTo(3, 12);
    expect(ok(e, "2*3//6").raw as number).toBeCloseTo(3, 12);
    expect(ok(e, "(1+2)//6").raw as number).toBeCloseTo(2, 12);
  });
  it("impedances complexes et unites", () => {
    const e = new CalcEngine();
    const z = ok(e, "100 // (-100j)").raw as any;
    expect(z.re).toBeCloseTo(50, 9);
    expect(z.im).toBeCloseTo(-50, 9);
    expect(ok(e, "2,2kΩ || 4,7kΩ").eng).toBe("1,499 kΩ");
  });
  it("lu par le moteur avec le signe parallele", () => {
    const e = new CalcEngine();
    expect(e.toLatex("2,2k||4,7k", true)).toContain("\\parallel");
  });
  it("| se tape au clavier", () => {
    expect(mapKey({ key: "|" })).toEqual({ kind: "insert", text: "|" });
    expect(acceptText("2k||3k").text).toBe("2k||3k");
  });
});

describe("blocs calcul de la page : valeur lisible", () => {
  it("7234,32 avec ≈, pas 7234,31559509", () => {
    const tex = calcTex("1/(2*pi*2,2k*10n)", "7234.31559509");
    expect(tex).toContain("\\approx 7234{,}32");
    expect(tex).not.toContain("7234{,}3155");
  });
  it("10n s'affiche 10 n, jamais 1·10⁻⁸", () => {
    const tex = exprTex("1/(2*pi*2,2k*10n)");
    expect(tex).not.toContain("10^{-8}");
    expect(tex).toMatch(/10\\,\\mathrm\{n\}/);
    expect(tex).toMatch(/2\{,\}2\\,\\mathrm\{k\}/);
  });
  it("infini, complexe avec j", () => {
    expect(resultTex("Infinity")).toBe("\\infty");
    expect(calcTex("(3+4j)*(1-2j)", "11 - 2i")).toMatch(/= 11 - 2\\,j$/);
    expect(calcTex("7*6", "42")).toBe("7 \\times 6 = 42");
  });
});

describe("18. Bode : axe log, dB, tableau logarithmique", () => {
  const H = "1/(1+j*2*pi*x*2,2k*10n)";
  it("dB d'un passe-bas RC avec j et prefixes", () => {
    const p = samplePlot(dbWrap(H), 10, 1e5, 200, "x", "RAD", true);
    expect(p.ok).toBe(true);
    const s = p.samples!;
    expect(s[0].x).toBeCloseTo(10, 9);
    expect(s[s.length - 1].x).toBeCloseTo(1e5, 6);
    // Pas logarithmique : le point du milieu est a 1 kHz.
    expect(s[100].x).toBeGreaterThan(900);
    expect(s[100].x).toBeLessThan(1100);
    expect(s[0].y!).toBeCloseTo(0, 3);
  });
  it("coupure a -3 dB vers 7,2 kHz", () => {
    const c = levelCrossings(dbWrap(H), -3.0103, 10, 1e5, "x", "RAD", true);
    expect(c).toHaveLength(1);
    expect(c[0]).toBeGreaterThan(7200);
    expect(c[0]).toBeLessThan(7270);
  });
  it("une fonction complexe sans dB le dit", () => {
    const p = samplePlot(H, 10, 1e5, 50, "x", "RAD", true);
    expect(p.ok).toBe(false);
    expect(p.message).toMatch(/complexe/);
  });
  it("dB : enveloppe et reconnaissance", () => {
    expect(dbWrap("H")).toBe("20*log10(abs(H))");
    expect(dbUnwrap("20*log10(abs(1/(1+j*x)))")).toBe("1/(1+j*x)");
    expect(dbUnwrap("sin(x)")).toBeNull();
  });
  it("graduations par decade en notation ingenieur", () => {
    expect(logTicks(10, 1e5).major).toEqual([10, 100, 1000, 1e4, 1e5]);
    expect(engTick(1000)).toBe("1k");
    expect(engTick(1e4)).toBe("10k");
    expect(engTick(0.1)).toBe("100m");
    expect(engTick(1e6)).toBe("1M");
  });
  it("tableau en pas 1-2-5 quand log x", () => {
    const rows = valueTable(dbWrap(H), 10, 1e5, 0, "x", "RAD", true);
    expect(rows.map((r) => r.x).slice(0, 4)).toEqual([10, 20, 50, 100]);
    expect(rows.at(-1)!.x).toBe(1e5);
    expect(rows[0].y).toMatch(/^-8,29\d*·10⁻⁶$/);
    expect(rows[0].y).not.toContain(".");
  });
  it("variable deduite : f quand il n'y a pas de x", () => {
    expect(plotVariable("1/(1+j*2*pi*f*2,2k*10n)")).toBe("f");
    expect(plotVariable("sin(x)*t")).toBe("x");
    expect(plotVariable("2*pi")).toBe("x");
  });
});

describe("primitives : arctan et integration par parties", () => {
  it("1/(1+x^2) : arctan, jamais tan^-1", () => {
    const r = antiderivative("1/(1+x^2)");
    expect(r.ok).toBe(true);
    expect(r.resultLatex).toContain("\\arctan");
    expect(r.resultLatex).not.toContain("tan^{-1}");
    expect(texArc("\\tan^{-1}\\left(x\\right)")).toBe("\\arctan\\left(x\\right)");
  });
  const check = (expr: string, prim: string) => {
    const r = antiderivative(expr);
    expect(r.ok, `${expr} : ${r.message}`).toBe(true);
    // Derivee numerique de la primitive = integrande.
    const e = new CalcEngine();
    for (const x of [0.3, 1.1, 2.5]) {
      const F = (t: number) => Number(e.math.evaluate(r.result!, { x: t }));
      const d = (F(x + 1e-5) - F(x - 1e-5)) / 2e-5;
      expect(d).toBeCloseTo(Number(e.math.evaluate(normalizeInput(expr), { x })), 4);
    }
    expect(r.rule).toContain(prim);
  };
  it("x*exp(x), x*sin(x), x*cos(x), x^2*exp(2x)", () => {
    check("x*exp(x)", "parties");
    check("x*sin(x)", "parties");
    check("x*cos(x)", "parties");
    check("x^2*exp(2x)", "parties");
    check("(x+1)*sin(3x)", "parties");
  });
  it("ln(x) et x*ln(x)", () => {
    check("ln(x)", "log");
    check("x*ln(x)", "parties");
  });
});
