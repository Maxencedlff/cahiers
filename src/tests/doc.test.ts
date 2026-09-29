import { describe, expect, it } from "vitest";
import {
  absorbTextBoxes, docImageIds, docPlainText, normalizeTokens, parseDoc, serializeDoc, trailingOperand,
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
