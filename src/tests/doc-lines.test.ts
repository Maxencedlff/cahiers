import { describe, expect, it } from "vitest";
import {
  docClipboardText, docLines, docPlainText, docTitle, listNumbers, markerStyle, parseDoc, serializeDoc,
  type DocToken, type LineFormat,
} from "../core/text/doc";

const round = (tokens: DocToken[]) => parseDoc(serializeDoc(tokens));

describe("titres (D11)", () => {
  it("trois niveaux, aller-retour", () => {
    const t: DocToken[] = [
      { kind: "line", style: "h1" }, { kind: "text", text: "Diode Zener" }, { kind: "br" },
      { kind: "line", style: "h2" }, { kind: "text", text: "Polarisation" }, { kind: "br" },
      { kind: "line", style: "h3" }, { kind: "text", text: "Inverse" }, { kind: "br" },
      { kind: "text", text: "texte" },
    ];
    expect(serializeDoc(t)).toBe("# Diode Zener\n## Polarisation\n### Inverse\ntexte");
    expect(round(t)).toEqual(t);
  });

  it("formule, gras et couleur dans un titre", () => {
    const t: DocToken[] = [
      { kind: "line", style: "h2" }, { kind: "text", text: "Tension " },
      { kind: "math", latex: "V_z" }, { kind: "text", text: " fixe", color: "theoreme" },
    ];
    expect(serializeDoc(t)).toBe("## Tension $V_z$[ fixe]{.theoreme}");
    expect(round(t)).toEqual(t);
  });

  it("titre vide garde sa ligne", () => {
    const t: DocToken[] = [{ kind: "text", text: "a" }, { kind: "br" }, { kind: "line", style: "h1" }];
    expect(serializeDoc(t)).toBe("a\n# ");
    expect(round(t)).toEqual(t);
  });

  it("#### et #sans espace restent du texte", () => {
    expect(parseDoc("#### x")).toEqual([{ kind: "text", text: "#### x" }]);
    expect(parseDoc("#theoreme")).toEqual([{ kind: "text", text: "#theoreme" }]);
    expect(parseDoc("a # b")).toEqual([{ kind: "text", text: "a # b" }]);
  });
});

describe("listes (D11)", () => {
  it("puces et sous-puces", () => {
    const t: DocToken[] = [
      { kind: "line", style: "ul" }, { kind: "text", text: "Vs = Vz - Vbe" }, { kind: "br" },
      { kind: "line", style: "ul", level: 1 }, { kind: "text", text: "detail" }, { kind: "br" },
      { kind: "line", style: "ul" }, { kind: "text", text: "suite" },
    ];
    expect(serializeDoc(t)).toBe("- Vs = Vz - Vbe\n  - detail\n- suite");
    expect(round(t)).toEqual(t);
  });

  it("liste numerotee : les numeros se suivent a l'ecriture", () => {
    const t: DocToken[] = [
      { kind: "line", style: "ol", num: 1 }, { kind: "text", text: "on mesure Vz" }, { kind: "br" },
      { kind: "line", style: "ol" }, { kind: "text", text: "on calcule R" }, { kind: "br" },
      { kind: "line", style: "ol", num: 7 }, { kind: "text", text: "on conclut" },
    ];
    expect(serializeDoc(t)).toBe("1. on mesure Vz\n2. on calcule R\n3. on conclut");
  });

  it("1) se lit comme 1., un numero de depart est garde", () => {
    expect(parseDoc("1) a\n2) b")).toEqual([
      { kind: "line", style: "ol", num: 1 }, { kind: "text", text: "a" }, { kind: "br" },
      { kind: "line", style: "ol", num: 2 }, { kind: "text", text: "b" },
    ]);
    expect(serializeDoc(parseDoc("3. a\n9. b"))).toBe("3. a\n4. b");
  });

  it("formule dans une puce", () => {
    const t: DocToken[] = [
      { kind: "line", style: "ul" }, { kind: "math", latex: "V_s = V_z - V_{be}" },
    ];
    expect(serializeDoc(t)).toBe("- $V_s = V_z - V_{be}$");
    expect(round(t)).toEqual(t);
  });

  it("niveau borne, ignore hors liste", () => {
    expect(parseDoc("          - x")[0]).toEqual({ kind: "line", style: "ul", level: 4 });
    expect(serializeDoc([{ kind: "line", style: "h1", level: 2 }, { kind: "text", text: "t" }])).toBe("# t");
  });
});

describe("numerotation", () => {
  const f = (style: LineFormat["style"], level = 0, num?: number): LineFormat => ({ style, level, num });

  it("suite, sous-liste, reprise", () => {
    expect(listNumbers([f("ol"), f("ol"), f("ul", 1), f("ol", 1), f("ol", 1), f("ol")]))
      .toEqual([1, 2, null, 1, 2, 3]);
  });

  it("une ligne normale ou un titre coupe la liste", () => {
    expect(listNumbers([f("ol"), null, f("ol"), f("h2"), f("ol")])).toEqual([1, null, 1, null, 1]);
  });

  it("numero de depart pris au premier element seulement", () => {
    expect(listNumbers([f("ol", 0, 5), f("ol", 0, 1), f("ol", 0, 1)])).toEqual([5, 6, 7]);
  });

  it("une puce au meme niveau recommence la numerotation", () => {
    expect(listNumbers([f("ol"), f("ol"), f("ul"), f("ol")])).toEqual([1, 2, null, 1]);
  });
});

describe("compatibilite", () => {
  it("anciennes pages sans titre : rien ne change", () => {
    const src = "Def [**Theoreme** : $\\sqrt[3]{x}$]{.theoreme}\nfin\n![](img:ab)\n";
    expect(serializeDoc(parseDoc(src))).toBe(src);
  });

  it("un texte qui commence par # ou - est echappe et reste du texte", () => {
    for (const text of ["# pas un titre", "- pas une puce", "1. pas un numero", "2) non plus", "  - indente"]) {
      const t: DocToken[] = [{ kind: "text", text: "avant" }, { kind: "br" }, { kind: "text", text }];
      const src = serializeDoc(t);
      expect(src).toContain("\\");
      expect(round(t)).toEqual(t);
    }
    // Rien a echapper : le fichier ne change pas.
    expect(serializeDoc([{ kind: "text", text: "#tag -x 1.5 V" }])).toBe("#tag -x 1.5 V");
  });

  it("couleur sur plusieurs lignes (ancien format) : relue", () => {
    expect(parseDoc("[a\nb]{.theoreme}")).toEqual([
      { kind: "text", text: "a", color: "theoreme" }, { kind: "br" },
      { kind: "text", text: "b", color: "theoreme" },
    ]);
  });

  it("dans un groupe de couleur, le debut n'est pas un debut de ligne", () => {
    expect(parseDoc("x [# y]{.theoreme}")).toEqual([
      { kind: "text", text: "x " }, { kind: "text", text: "# y", color: "theoreme" },
    ]);
  });
});

describe("lignes, recherche, presse-papiers", () => {
  const src = "# Diode Zener\nintro $V_z$\n## Polarisation\n- a\n1. b";

  it("docLines decoupe en lignes", () => {
    const lines = docLines(parseDoc(src));
    expect(lines.map((l) => l.format?.style ?? null)).toEqual(["h1", null, "h2", "ul", "ol"]);
    expect(lines[1].tokens).toEqual([{ kind: "text", text: "intro " }, { kind: "math", latex: "V_z" }]);
  });

  it("texte simple sans les #", () => {
    expect(docPlainText(src)).toBe("Diode Zener\nintro V_z\nPolarisation\na\nb");
  });

  it("titre de la page : premier titre de plus haut niveau", () => {
    expect(docTitle(parseDoc(src))).toBe("Diode Zener");
    expect(docTitle(parseDoc("texte\n## Sous-titre $V_{be}$\n# Grand titre"))).toBe("Grand titre");
    expect(docTitle(parseDoc("## Sous-titre $V_{be}$"))).toBe("Sous-titre Vbe");
    expect(docTitle(parseDoc("texte\n- a"))).toBe("");
    expect(docTitle(parseDoc("# \n# Vrai"))).toBe("Vrai");
  });

  it("presse-papiers : marqueurs markdown", () => {
    expect(docClipboardText(parseDoc(src))).toBe("# Diode Zener\nintro $V_z$\n## Polarisation\n- a\n1. b");
  });

  it("marqueur tape avant l'Espace", () => {
    expect(markerStyle("#")).toEqual({ style: "h1" });
    expect(markerStyle("###")).toEqual({ style: "h3" });
    expect(markerStyle("####")).toBeNull();
    expect(markerStyle("-")).toEqual({ style: "ul" });
    expect(markerStyle("*")).toEqual({ style: "ul" });
    expect(markerStyle("1.")).toEqual({ style: "ol", num: 1 });
    expect(markerStyle("3)")).toEqual({ style: "ol", num: 3 });
    expect(markerStyle("1.5")).toBeNull();
    expect(markerStyle("a")).toBeNull();
  });
});
