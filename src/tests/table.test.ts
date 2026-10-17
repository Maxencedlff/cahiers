import { describe, expect, it } from "vitest";
import {
  cellText, docClipboardLines, docClipboardText, docLines, docPlainText, emptyTable, normalizeTokens, parseDoc, serializeDoc, type DocToken,
} from "../core/text/doc";

const T = (text: string): DocToken => ({ kind: "text", text });
const M = (latex: string): DocToken => ({ kind: "math", latex });

describe("tableaux dans le texte (format pipe)", () => {
  it("ecrit un tableau lisible et le relit a l'identique", () => {
    const tokens: DocToken[] = [
      T("Avant"), { kind: "br" },
      { kind: "table", rows: [[[T("x")], [M("f(x)")]], [[T("0")], [M("\\frac{1}{2}")]]] },
      { kind: "br" }, T("Après"),
    ];
    const md = serializeDoc(tokens);
    expect(md).toBe("Avant\n| x | $f(x)$ |\n| --- | --- |\n| 0 | $\\frac{1}{2}$ |\nAprès");
    expect(parseDoc(md)).toEqual(normalizeTokens(tokens));
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it("lit un tableau tape a la main (alignements, sans barre finale, blancs)", () => {
    const toks = parseDoc("|a|b\n|:---|---:|\n| **c** |  d  |");
    expect(toks).toHaveLength(1);
    const t = toks[0];
    expect(t.kind).toBe("table");
    if (t.kind !== "table") return;
    expect(t.rows.map((r) => r.map((c) => cellText(c)))).toEqual([["a", "b"], ["c", "d"]]);
    expect(t.rows[1][0][0]).toMatchObject({ bold: true });
  });

  it("une barre dans le texte d'une case est echappee, pas dans une formule", () => {
    const tokens: DocToken[] = [{ kind: "table", rows: [[[T("a | b")], [M("|x| \\| y")]]] }];
    const md = serializeDoc(tokens);
    expect(md.split("\n")[0]).toBe("| a \\| b | $|x| \\| y$ |");
    expect(parseDoc(md)).toEqual(tokens);
  });

  it("ancien texte qui commence par | sans ligne de separation : reste du texte", () => {
    const old = "|x| < 1 donc\n| a | b |\nfin";
    const toks = parseDoc(old);
    expect(toks.some((t) => t.kind === "table")).toBe(false);
    expect(docPlainText(old)).toBe(old);
    // Reecrit : les lignes qui commencent par | sont echappees et se relisent pareil.
    const again = serializeDoc(toks);
    expect(again).toBe("\\|x| < 1 donc\n\\| a | b |\nfin");
    expect(parseDoc(again)).toEqual(toks);
  });

  it("texte qui ressemblerait a un tableau : echappe, jamais converti", () => {
    const toks: DocToken[] = [T("| a | b |"), { kind: "br" }, T("| --- | --- |")];
    const md = serializeDoc(toks);
    expect(parseDoc(md)).toEqual(toks);
  });

  it("une formule \\begin{array} reste une formule", () => {
    const md = "$\\begin{array}{c|c} a & b \\\\ c & d \\end{array}$";
    expect(parseDoc(md)).toEqual([M("\\begin{array}{c|c} a & b \\\\ c & d \\end{array}")]);
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it("le tableau est seul sur sa ligne (texte colle derriere : ligne suivante)", () => {
    const tokens: DocToken[] = [T("x"), { kind: "table", rows: [[[T("1")]]] }, T("y")];
    const lines = docLines(normalizeTokens(tokens));
    expect(lines.map((l) => l.tokens.map((t) => t.kind))).toEqual([["text"], ["table"], ["text"]]);
    expect(serializeDoc(tokens)).toBe("x\n| 1 |\n| --- |\ny");
  });

  it("lignes inegales completees, cases vides, saut dans une case = espace", () => {
    const tokens: DocToken[] = [{ kind: "table", rows: [[[T("a")], [T("b")], []], [[T("c"), { kind: "br" }, T("d")]]] }];
    const md = serializeDoc(tokens);
    expect(md).toBe("| a | b |  |\n| --- | --- | --- |\n| c d |  |  |");
    const t = parseDoc(md)[0];
    expect(t.kind === "table" && t.rows[1].length).toBe(3);
  });

  it("tableau vide, puis suite du texte", () => {
    const md = serializeDoc([emptyTable(2, 2), { kind: "br" }, T("ok")]);
    expect(md).toBe("|  |  |\n| --- | --- |\n|  |  |\nok");
    const toks = parseDoc(md);
    expect(toks[0]).toEqual(emptyTable(2, 2));
    expect(toks.slice(1)).toEqual([{ kind: "br" }, T("ok")]);
  });

  it("presse-papiers : tabulations pour les autres logiciels, cases pour le HTML", () => {
    const tokens: DocToken[] = [{ kind: "table", rows: [[[T("x")], [M("x^2")]], [[T("2")], [T("4")]]] }];
    expect(docClipboardText(tokens)).toBe("x\t$x^2$\n2\t4");
    const lines = docClipboardLines(tokens);
    expect(lines[0].table?.[0][1]).toEqual([{ latex: "x^2" }]);
  });

  it("couleur et lien dans une case", () => {
    const md = "| [rouge]{.theoreme} | [p](cahiers:abc \"Maths/Cours/0001\") |\n| --- | --- |";
    const t = parseDoc(md)[0];
    expect(t.kind).toBe("table");
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });
});

import { buildDocx } from "../core/export/docx";
import { planPage, planToParas, type Assets } from "../core/export/plan";
import { unzipStore } from "../core/export/zip";
import { flattenTables } from "../core/text/doc";

describe("tableau : export Word et mise a plat", () => {
  const assets: Assets = { ink: () => null, inline: () => [] } as unknown as Assets;
  const page = (content: string) => ({
    version: 2, id: "p", created: "2026-10-17T08:00:00Z", modified: "2026-10-17T08:00:00Z",
    blocks: [{ id: "t", type: "text", content }],
  }) as never;

  it("un tableau du texte devient un vrai tableau Word (formules en equations)", () => {
    const md = "Valeurs :\n| t | $y(t)$ |\n| --- | --- |\n| 0 | $0$ |\n| τ | $0{,}63K$ |\nfin";
    const paras = planToParas(planPage(page(md), null), assets);
    const t = paras.find((p) => p.table);
    expect(t?.table).toHaveLength(3);
    expect(t?.table?.[0][1][0]).toMatchObject({ kind: "math", latex: "y(t)" });
    const files = unzipStore(buildDocx({ title: "x", paras }));
    const xml = new TextDecoder().decode(files.get("word/document.xml")!);
    expect(xml).toContain("<w:tbl>");
    expect((xml.match(/<w:tr>/g) ?? []).length).toBe(3);
    expect((xml.match(/<w:tc>/g) ?? []).length).toBe(6);
    expect(xml).toContain("<m:oMath");
    expect(xml.indexOf("Valeurs")).toBeLessThan(xml.indexOf("<w:tbl>"));
    expect(xml.indexOf("fin")).toBeGreaterThan(xml.indexOf("</w:tbl>"));
  });

  it("tableau en fin de document : un paragraphe le suit (Word l'exige)", () => {
    const paras = planToParas(planPage(page("| a |\n| --- |"), null), assets);
    const files = unzipStore(buildDocx({ title: "x", paras }));
    const xml = new TextDecoder().decode(files.get("word/document.xml")!);
    expect(xml).toMatch(/<\/w:tbl><w:p>/);
  });

  it("mise a plat : une ligne de texte par rangee", () => {
    const toks = flattenTables(parseDoc("| a | $x$ |\n| --- | --- |\n| b | c |"));
    expect(toks.map((t) => (t.kind === "text" ? t.text : t.kind === "math" ? `$${t.latex}$` : t.kind === "br" ? "\n" : "?")).join(""))
      .toBe("a | $x$\nb | c\n");
  });
});

import { extractFormulas } from "../core/suggest";

describe("tableau : suggestions de formules", () => {
  it("une relation ecrite dans une case est reprise", () => {
    const f = extractFormulas("| grandeur | valeur |\n| --- | --- |\n| constante | $\\tau = RC$ |");
    expect(f.some((x) => x.insert.includes("\\tau = RC"))).toBe(true);
  });
});
