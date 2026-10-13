import { describe, expect, it } from "vitest";
import {
  absorbTextBoxes, docClipboardLines, frenchSpaceAtEnd, docClipboardText, docImageIds, pastedMath, docPlainText, normalizeTokens, parseDoc, serializeDoc, texToPlain,
  trailingOperand,
  type DocToken,
} from "../core/text/doc";

const round = (tokens: DocToken[]) => parseDoc(serializeDoc(tokens));

describe("texte de page au clavier", () => {
  it("texte simple et retours a la ligne", () => {
    const t: DocToken[] = [
      { kind: "text", text: "Definition" }, { kind: "br" }, { kind: "text", text: "suite" },
    ];
    expect(serializeDoc(t)).toBe("Definition\nsuite");
    expect(round(t)).toEqual(t);
  });

  it("formule en ligne", () => {
    const t: DocToken[] = [
      { kind: "text", text: "on a " },
      { kind: "math", latex: "\\frac{1}{2}+\\int_0^{+\\infty}e^{-x}\\,dx" },
      { kind: "text", text: " donc" },
    ];
    expect(serializeDoc(t)).toBe("on a $\\frac{1}{2}+\\int_0^{+\\infty}e^{-x}\\,dx$ donc");
    expect(round(t)).toEqual(t);
  });

  it("echappe les caracteres speciaux du texte", () => {
    const t: DocToken[] = [{ kind: "text", text: "prix 3$ * 2 \\ fin" }];
    expect(round(t)).toEqual(t);
  });

  it("dollar dans une formule", () => {
    const t: DocToken[] = [{ kind: "math", latex: "\\$5" }];
    expect(round(t)).toEqual(t);
  });

  it("gras et italique", () => {
    const t: DocToken[] = [
      { kind: "text", text: "Theoreme", bold: true },
      { kind: "text", text: " de " },
      { kind: "text", text: "Rolle", italic: true },
    ];
    expect(serializeDoc(t)).toBe("**Theoreme** de *Rolle*");
    expect(round(t)).toEqual(t);
  });

  it("code : chasse fixe, ni formule ni gras a l'interieur", () => {
    const t: DocToken[] = [
      { kind: "text", text: "lancer " },
      { kind: "text", text: "rsync -a --delete $HOME/*.log `x` \\", code: true },
      { kind: "text", text: " puis " },
      { kind: "text", text: "rw-r--r--", code: true, bold: true },
    ];
    expect(serializeDoc(t)).toBe("lancer `rsync -a --delete $HOME/*.log \\`x\\` \\\\` puis **`rw-r--r--`**");
    expect(round(t)).toEqual(t);
  });

  it("un ` seul ou un ` tape dans le texte reste du texte", () => {
    expect(parseDoc("l`apostrophe\nsuite`")).toEqual([
      { kind: "text", text: "l`apostrophe" }, { kind: "br" }, { kind: "text", text: "suite`" },
    ]);
    const t: DocToken[] = [{ kind: "text", text: "a ` b ` c" }];
    expect(serializeDoc(t)).toBe("a \\` b \\` c");
    expect(round(t)).toEqual(t);
  });

  it("espace fine insecable devant : ; ? ! tapes apres une espace", () => {
    expect(frenchSpaceAtEnd("On a :")).toBe("On a\u202f:");
    expect(frenchSpaceAtEnd("Pourquoi ?")).toBe("Pourquoi\u202f?");
    expect(frenchSpaceAtEnd("http:")).toBeNull();
    expect(frenchSpaceAtEnd(" :")).toBeNull();
    expect(frenchSpaceAtEnd("a\n :")).toBeNull();
  });

  it("un $ isole reste du texte", () => {
    expect(parseDoc("5 $ par mois")).toEqual([{ kind: "text", text: "5 $ par mois" }]);
  });

  it("fusionne et nettoie", () => {
    expect(normalizeTokens([
      { kind: "text", text: "a" }, { kind: "text", text: "b" },
      { kind: "math", latex: " " }, { kind: "text", text: "" },
    ])).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("texte brut pour la recherche", () => {
    expect(docPlainText("**Aire** $\\pi r^2$")).toBe("Aire \\pi r^2");
  });

  it("numerateur repris avant Alt+F", () => {
    expect(trailingOperand("on pose 3x")).toBe("3x");
    expect(trailingOperand("vaut 2,5")).toBe("2,5");
    expect(trailingOperand("fin. ")).toBe("");
    expect(trailingOperand("")).toBe("");
  });
});

describe("anciennes zones Texte", () => {
  it("vides : retirees ; pleines : versees dans le texte de la page", () => {
    const blocks: any[] = [
      { id: "a", type: "text", content: "", rect: { x: 60, y: 60, w: 780, h: 40 } },
      { id: "b", type: "text", content: "debut" },
      { id: "c", type: "text", content: "second *", rect: { x: 60, y: 300, w: 780, h: 40 } },
      { id: "d", type: "text", content: "premier", rect: { x: 60, y: 200, w: 780, h: 40 } },
      { id: "e", type: "ink", strokes: [] },
    ];
    expect(absorbTextBoxes(blocks, () => "n")).toBe(true);
    expect(blocks.map((b) => b.id)).toEqual(["b", "e"]);
    expect(parseDoc(blocks[0].content)).toEqual([
      { kind: "text", text: "debut" }, { kind: "br" },
      { kind: "text", text: "premier" }, { kind: "br" },
      { kind: "text", text: "second *" },
    ]);
  });

  it("page sans zone : rien ne bouge", () => {
    expect(absorbTextBoxes([{ id: "b", type: "text", content: "x" }], () => "n")).toBe(false);
  });
});

describe("photos dans le texte", () => {
  it("aller-retour avec texte autour", () => {
    const t: DocToken[] = [
      { kind: "text", text: "avant" }, { kind: "br" },
      { kind: "image", id: "ab-12" }, { kind: "br" },
      { kind: "text", text: "apres" },
    ];
    expect(serializeDoc(t)).toBe("avant\n![](img:ab-12)\napres");
    expect(round(t)).toEqual(t);
    expect(docImageIds(serializeDoc(t))).toEqual(["ab-12"]);
    expect(docPlainText(serializeDoc(t))).toBe("avant\n\napres");
  });

  it("un ![ tape dans le texte reste du texte", () => {
    const t: DocToken[] = [{ kind: "text", text: "voir ![](img:x) ici !" }];
    expect(round(t)).toEqual(t);
  });
});

describe("texte en couleur", () => {
  it("groupes de couleur, formule comprise", () => {
    const t: DocToken[] = [
      { kind: "text", text: "Def " },
      { kind: "text", text: "Theoreme", color: "theoreme", bold: true },
      { kind: "text", text: " : ", color: "theoreme" },
      { kind: "math", latex: "\\sqrt[3]{x}", color: "theoreme" },
      { kind: "br" },
      { kind: "text", text: "fin" },
    ];
    expect(serializeDoc(t)).toBe("Def [**Theoreme** : $\\sqrt[3]{x}$]{.theoreme}\nfin");
    expect(round(t)).toEqual(t);
  });

  it("crochets du texte echappes, anciens crochets relus tels quels", () => {
    const t: DocToken[] = [{ kind: "text", text: "[a,+b[ et x]{.theoreme}" }];
    expect(round(t)).toEqual(t);
    expect(parseDoc("[a, b] et ]{.inconnu}")).toEqual([{ kind: "text", text: "[a, b] et ]{.inconnu}" }]);
  });
});

describe("presse-papiers et recherche", () => {
  it("aller-retour d'un morceau copie avec formule, couleur et gras", () => {
    const t: DocToken[] = [
      { kind: "text", text: "on a " },
      { kind: "math", latex: "V_s = V_z - V_{be}" },
      { kind: "text", text: " donc", bold: true },
      { kind: "br" },
      { kind: "math", latex: "I_1", color: "theoreme" },
    ];
    expect(round(t)).toEqual(t);
    expect(docClipboardText(t)).toBe("on a $V_s = V_z - V_{be}$ donc\n$I_1$");
  });

  it("formules relues en texte simple", () => {
    expect(texToPlain("V_{be}")).toBe("Vbe");
    expect(texToPlain("V_s = V_z - V_{be}")).toBe("Vs = Vz - Vbe");
    expect(texToPlain("i_D = \\frac{V_z - V_{be}}{\\beta \\cdot R_u}")).toBe("iD = (Vz - Vbe)/(beta · Ru)");
    expect(texToPlain("\\frac{\\left(v_{batt} - V_z\\right)^2}{R}")).toBe("(vbatt - Vz)^2/R");
    expect(texToPlain("0{,}6\\,\\mathrm{V}")).toBe("0,6 V");
    expect(texToPlain("\\sqrt{L\\,C}")).toBe("sqrt(L C)");
    expect(texToPlain("x \\leq \\varepsilon")).toBe("x <= epsilon");
    // Signe en tete : pas de parentheses ; numerateur produit : pas de parentheses.
    expect(texToPlain("\\frac{-R_2}{R_1} \\cdot V_e")).toBe("-R2/R1 · Ve");
    expect(texToPlain("\\frac{V_e \\cdot R_2}{R_1 + R_2}")).toBe("Ve · R2/(R1 + R2)");
    expect(texToPlain("\\frac{1}{2\\,\\pi\\,R\\,C}")).toBe("1/(2 pi R C)");
    // Fractions abregees de MathLive, indices composes, bornes.
    expect(texToPlain("E=\\frac12C")).toBe("E=1/2C");
    expect(texToPlain("\\frac{R_{2}}{R_{1}}")).toBe("R2/R1");
    expect(texToPlain("u_{n + 1} = 2\\,u_n")).toBe("u_(n + 1) = 2 un");
    expect(texToPlain("\\int_{0}^{1} x^{2}\\,\\mathrm{d}x")).toBe("int_0^1 x^2 dx");
    expect(texToPlain("\\sum_{k = 0}^{n} k")).toBe("sum_(k = 0)^n k");
  });
});

describe("copier vers un autre logiciel", () => {
  it("formules relues comme tapees dans le texte simple, a part pour le HTML", () => {
    const t = parseDoc("$3+2=5$ le tout divise par 2; $\\frac{3+5}{2}$");
    expect(docClipboardText(t, texToPlain)).toBe("3+2=5 le tout divise par 2; (3+5)/2");
    expect(docClipboardLines(t)).toEqual([{ marker: "", parts: [
      { latex: "3+2=5" }, { text: " le tout divise par 2; " }, { latex: "\\frac{3+5}{2}" },
    ] }]);
  });
});

describe("coller du LaTeX ($…$, $$…$$, \\(…\\), \\[…\\])", () => {
  it("formule centree $$…$$ apres du texte", () => {
    const src = "S(p) = $$S(p) = \\left[ -\\frac{t\\, e^{-(p+3)t}}{p+3} \\right]_0^{+\\infty} + \\frac{1}{p+3} \\int_0^{+\\infty} e^{-(p+3)t}\\, dt$$";
    expect(pastedMath(src)).toEqual([
      { kind: "text", text: "S(p) = " },
      { kind: "math", latex: "\\displaystyle S(p) = \\left[ -\\frac{t\\, e^{-(p+3)t}}{p+3} \\right]_0^{+\\infty} + \\frac{1}{p+3} \\int_0^{+\\infty} e^{-(p+3)t}\\, dt" },
    ]);
  });

  it("formules en ligne, \\( \\) et \\[ \\], retours a la ligne", () => {
    expect(pastedMath("soit $x^2$ et \\(y\\)\n\\[\n\\int f\n\\]")).toEqual([
      { kind: "text", text: "soit " }, { kind: "math", latex: "x^2" }, { kind: "text", text: " et " },
      { kind: "math", latex: "y" }, { kind: "br" }, { kind: "math", latex: "\\displaystyle \\int f" },
    ]);
  });

  it("des prix ou un $ seul restent du texte", () => {
    expect(pastedMath("5 $ et 10 $")).toBeNull();
    expect(pastedMath("entre $5 et $10")).toBeNull();
    expect(pastedMath("rien de special")).toBeNull();
    expect(pastedMath("un \\$ et $a$")).toEqual([
      { kind: "text", text: "un $ et " }, { kind: "math", latex: "a" },
    ]);
  });

  it("la formule collee survit a l'enregistrement", () => {
    const t = pastedMath("$$\\frac{1}{p+3}$$")!;
    expect(parseDoc(serializeDoc(t))).toEqual(t);
  });
});
