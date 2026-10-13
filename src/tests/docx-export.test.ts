import { describe, it, expect } from "vitest";
import { crc32, unzipStore, zipStore } from "../core/export/zip";
import { latexToOmml, mathmlToOmml, parseXml } from "../core/export/omml";
import { buildDocx, docxParts, type DxDoc, type DxImage } from "../core/export/docx";
import {
  docxFileName, estimateSpans, tokenRuns, fitEmu, indentOf, inkZones, joinPages, planPage, planToParas, reviewToParas,
  EMU_PER_UNIT, type Assets, type PlanItem,
} from "../core/export/plan";
import { docLines, parseDoc } from "../core/text/doc";
import { TEXT_TOP, LINE } from "../core/textlayout";
import type { Block, InkColor, Page, Stroke } from "../core/types";
import type { ReviewResult } from "../core/review";
import { uuid } from "../core/id";

const dec = new TextDecoder();

function stroke(color: InkColor, x0: number, y0: number, x1: number, y1: number, tool: Stroke["tool"] = "pen"): Stroke {
  const points = Array.from({ length: 5 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / 4, y: y0 + ((y1 - y0) * i) / 4, p: 0.5, t: i * 10,
  }));
  return { id: uuid(), points, color, width: tool === "highlighter" ? 14 : 2, tool };
}
function page(blocks: Block[]): Page {
  return { version: 2, id: uuid(), created: "2026-09-01T08:00:00Z", modified: "2026-09-01T08:00:00Z", blocks };
}
const text = (content: string): Block => ({ id: uuid(), type: "text", content });
const ink = (strokes: Stroke[], extra: Record<string, unknown> = {}): Block =>
  ({ id: uuid(), type: "ink", strokes, recognized: null, mode: "raw", ...extra }) as Block;

const PNG: DxImage = { data: new Uint8Array([137, 80, 78, 71]), type: "png", cx: 100000, cy: 50000 };
const assets: Assets = {
  ink: (_s, box) => ({ ...PNG, cx: box.w * EMU_PER_UNIT, cy: box.h * EMU_PER_UNIT }),
  inline: (id) => [{ kind: "text", text: `[${id}]` }],
};

describe("zip", () => {
  it("crc32 connu", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("aller-retour, noms UTF-8", () => {
    const zip = zipStore([{ name: "a.txt", data: "bonjour" }, { name: "dossier/é.bin", data: new Uint8Array([1, 2, 3]) }]);
    const files = unzipStore(zip);
    expect(dec.decode(files.get("a.txt")!)).toBe("bonjour");
    expect([...files.get("dossier/é.bin")!]).toEqual([1, 2, 3]);
    // Fin de repertoire central presente.
    const v = new DataView(zip.buffer);
    expect(v.getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });
});

describe("LaTeX -> OMML", () => {
  const omml = (l: string) => {
    const o = latexToOmml(l);
    expect(o, l).not.toBeNull();
    // Toujours du XML bien forme.
    parseXml(o!);
    return o!;
  };

  it("indices : Vs = Vz - Vbe", () => {
    const o = omml("V_s = V_z - V_{be}");
    expect(o.match(/<m:sSub>/g)?.length).toBe(3);
    expect(o).toContain(">be<");
    expect(o).toContain("−");
  });

  it("fraction fc = 1/(2πRC)", () => {
    const o = omml("f_c=\\frac{1}{2\\pi RC}");
    expect(o).toContain("<m:f>");
    expect(o).toMatch(/<m:num>.*>1<.*<\/m:num>/);
    expect(o).toContain("π");
  });

  it("H(jω) : fraction emboitee", () => {
    const o = omml("H(j\\omega)=\\frac{1}{1+j\\frac{\\omega}{\\omega_0}}");
    expect(o.match(/<m:f>/g)?.length).toBe(2);
    expect(o).toContain("ω");
  });

  it("integrale avec bornes : m:nary, integrande dans m:e", () => {
    const o = omml("\\int_0^{+\\infty} e^{-x}\\,dx = 1");
    expect(o).toContain("<m:nary>");
    expect(o).toContain("<m:chr m:val=\"∫\"/>");
    expect(o).toMatch(/<m:sub>.*>0<.*<\/m:sub>/);
    expect(o).toMatch(/<m:sup>.*∞.*<\/m:sup>/);
    // L'integrande s'arrete a la relation.
    const e = o.slice(o.indexOf("<m:e>", o.indexOf("<m:nary>")));
    expect(e.indexOf("<m:sSup>")).toBeLessThan(e.indexOf(">=<"));
    expect(o).toMatch(/<\/m:nary>.*>=</);
  });

  it("somme : bornes dessous/dessus", () => {
    const o = omml("\\sum_{n=1}^{N} u_n");
    expect(o).toContain("<m:chr m:val=\"∑\"/><m:limLoc m:val=\"undOvr\"/>");
  });

  it("matrice et systeme", () => {
    const o = omml("\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}");
    expect(o).toContain("<m:d>");
    expect(o.match(/<m:mr>/g)?.length).toBe(2);
    expect(o).toContain("<m:count m:val=\"2\"/>");
    const c = omml("\\begin{cases}a&x>0\\\\b\\end{cases}");
    expect(c).toContain("<m:begChr m:val=\"{\"/><m:endChr m:val=\"\"/>");
    // Rangees completees : meme nombre de cases.
    expect(c.match(/<m:e\/>/g)?.length).toBe(1);
  });

  it("lim, fonctions, racines, accents, parentheses extensibles", () => {
    const o = omml("\\lim_{x\\to 0}\\frac{\\sin x}{x}");
    expect(o).toContain("<m:limLow>");
    expect(o).toContain("<m:func>");
    expect(o).toMatch(/<m:sty m:val="p"\/><\/m:rPr>.*>lim</);
    const r = omml("\\sqrt[3]{x}+\\sqrt{2}+\\vec{u}+\\overline{z}+\\hat{x}");
    expect(r.match(/<m:rad>/g)?.length).toBe(2);
    expect(r).toContain("<m:degHide m:val=\"1\"/>");
    expect(r).toContain("<m:acc>");
    expect(r).toContain("⃗");
    expect(r).toContain("<m:bar>");
    const d = omml("\\left(\\frac{a}{b}\\right)^2");
    expect(d).toContain("<m:begChr m:val=\"(\"/><m:endChr m:val=\")\"/>");
  });

  it("ensembles, texte, couleur", () => {
    const o = latexToOmml("\\forall x\\in\\mathbb{R},\\ \\text{si } x>0", { color: "DC2626" })!;
    expect(o).toContain("double-struck");
    expect(o).toContain("<m:nor/>");
    expect(o).toContain("<w:color w:val=\"DC2626\"/>");
  });

  it("formule illisible : null (repli), jamais d'exception", () => {
    expect(latexToOmml("\\frac{")).toBeNull();
    expect(() => mathmlToOmml("<math><mi>x</mi>")).toThrow();
  });
});

describe("document Word", () => {
  const doc: DxDoc = {
    title: "Élec - Cours - p.1",
    paras: [
      { heading: 1, runs: [{ kind: "text", text: "Diode Zener" }] },
      { list: { ordered: false, level: 0 }, runs: [{ kind: "text", text: "puce" }] },
      { list: { ordered: true, level: 0, num: 1 }, runs: [{ kind: "text", text: "un" }] },
      { list: { ordered: true, level: 1, num: 1 }, runs: [{ kind: "text", text: "sous" }] },
      { list: { ordered: true, level: 0, num: 2 }, runs: [{ kind: "text", text: "deux" }] },
      { runs: [{ kind: "text", text: "Coupure" }] },
      { list: { ordered: true, level: 0, num: 1 }, runs: [{ kind: "text", text: "repart" }] },
      { runs: [{ kind: "text", text: "On a ", bold: true, color: "2563EB" }, { kind: "math", latex: "V_s = V_z - V_{be}" }] },
      { runs: [{ kind: "math", latex: "\\frac{1}{2}" }] },
      { runs: [{ kind: "image", image: PNG }], indent: 200, pageBreakBefore: true },
      { runs: [{ kind: "math", latex: "\\frac{" }] },
    ],
  };
  const parts = new Map(docxParts(doc, { now: "2026-10-02T10:00:00Z" }).map((p) => [p.name, typeof p.data === "string" ? p.data : dec.decode(p.data)]));
  const body = parts.get("word/document.xml")!;

  it("paquet complet, XML bien forme", () => {
    expect([...parts.keys()][0]).toBe("[Content_Types].xml");
    for (const name of ["word/document.xml", "word/styles.xml", "word/numbering.xml", "word/settings.xml", "_rels/.rels", "word/_rels/document.xml.rels", "docProps/core.xml"]) {
      expect(parts.has(name), name).toBe(true);
      expect(() => parseXml(parts.get(name)!.replace(/^<\?xml[^>]*\?>\n/, "")), name).not.toThrow();
    }
    expect(parts.get("[Content_Types].xml")).toContain("image/png");
    expect(parts.has("word/media/image1.png")).toBe(true);
    expect(parts.get("word/_rels/document.xml.rels")).toContain("media/image1.png");
  });

  it("A4, marges normales, fr-FR, Cambria, styles de titres", () => {
    expect(body).toContain("<w:pgSz w:w=\"11906\" w:h=\"16838\"/>");
    expect(body).toContain("w:left=\"1417\"");
    const styles = parts.get("word/styles.xml")!;
    expect(styles).toContain("<w:lang w:val=\"fr-FR\"");
    expect(styles).toContain("w:ascii=\"Cambria\"");
    expect(styles).toContain("<w:name w:val=\"heading 1\"/>");
    expect(styles).toContain("<w:outlineLvl w:val=\"0\"/>");
    expect(parts.get("word/settings.xml")).toContain("<m:mathFont m:val=\"Cambria Math\"/>");
    expect(body).toContain("<w:pStyle w:val=\"Heading1\"/>");
  });

  it("listes : puces, numeros, niveaux, depart propre apres une coupure", () => {
    const numIds = [...body.matchAll(/<w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(numIds[0]).toEqual([0, 1]); // puce
    const [, un] = numIds[1], [, sous] = numIds[2], [, deux] = numIds[3], [, repart] = numIds[4];
    expect(deux).toBe(un);
    expect(sous).not.toBe(un);
    expect(repart).not.toBe(un);
    const numbering = parts.get("word/numbering.xml")!;
    expect(numbering).toContain("w:val=\"bullet\"");
    expect(numbering).toContain("w:val=\"decimal\"");
    expect(numbering).toContain(`<w:num w:numId="${repart}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>`);
  });

  it("texte, equations (en ligne et en bloc), image, saut de page", () => {
    expect(body).toContain("<w:b/>");
    expect(body).toContain("<w:color w:val=\"2563EB\"/>");
    expect(body.match(/<m:oMath>/g)?.length).toBe(2);
    expect(body).toContain("<m:oMathPara>");
    expect(body).toContain("<wp:inline");
    expect(body).toContain("<w:pageBreakBefore/>");
    expect(body).toContain("<w:ind w:left=\"200\"/>");
    // Formule illisible : jamais le LaTeX brut.
    expect(body).not.toContain("\\frac{");
  });

  it("repli image d'une formule", () => {
    const xml = new Map(docxParts({ title: "t", paras: [{ runs: [{ kind: "math", latex: "\\frac{" }] }] }, { fallback: () => PNG })
      .map((p) => [p.name, p.data])).get("word/document.xml") as string;
    expect(xml).toContain("<wp:inline");
  });

  it("archive lisible", () => {
    const files = unzipStore(buildDocx(doc));
    expect(dec.decode(files.get("word/document.xml")!)).toContain("<m:oMath>");
  });
});

describe("plan d'une page", () => {
  const lineOf = (i: number) => ({ top: TEXT_TOP + i * LINE, bottom: TEXT_TOP + (i + 1) * LINE });

  it("lignes estimees sur la grille, titres sur deux lignes", () => {
    const lines = docLines(parseDoc("# Titre\nTexte\n$\\frac{a}{b}$"));
    const sp = estimateSpans(lines);
    expect(sp[0]).toEqual({ top: TEXT_TOP, bottom: TEXT_TOP + 2 * LINE });
    expect(sp[1].bottom - sp[1].top).toBeCloseTo(LINE);
    expect(sp[2].bottom - sp[2].top).toBeCloseTo(2 * LINE);
  });

  it("schema place entre les lignes a sa hauteur, lignes vides recouvertes retirees", () => {
    // Lignes : 0 titre, 1 texte, 2-5 vides, 6 texte.
    const p = page([
      text("Ligne A\nLigne B\n\n\n\n\nLigne C"),
      ink([stroke("normal", 200, lineOf(2).top + 4, 500, lineOf(4).bottom - 4), stroke("normal", 210, lineOf(3).top, 480, lineOf(3).bottom)]),
    ]);
    const items = planPage(p, null);
    const kinds = items.map((i) => (i.kind === "line" ? (i.line.tokens[0] as { text?: string } | undefined)?.text ?? "vide" : i.kind));
    expect(kinds).toEqual(["Ligne A", "Ligne B", "ink", "vide", "Ligne C"]);
  });

  it("encre sous tout le texte : a la fin ; deux traits proches = une zone", () => {
    const p = page([text("Haut"), ink([stroke("normal", 100, 600, 300, 620), stroke("definition", 100, 630, 300, 650), stroke("normal", 100, 900, 200, 920)])]);
    const items = planPage(p, [lineOf(0)]);
    expect(items.map((i) => i.kind)).toEqual(["line", "ink", "ink"]);
    expect((items[1] as Extract<PlanItem, { kind: "ink" }>).strokes.length).toBe(2);
  });

  it("zones cote a cote a la meme hauteur : une seule image", () => {
    const zones = inkZones([stroke("normal", 100, 600, 150, 700), stroke("normal", 600, 620, 700, 680)]);
    expect(zones.length).toBe(1);
  });

  it("option : mots reconnus et zone math remplaces par du texte et une equation", () => {
    const a = stroke("normal", 100, 300, 160, 320), b = stroke("normal", 180, 300, 260, 320);
    const zone = stroke("theoreme", 100, 400, 300, 430);
    const p = page([
      text("Debut"),
      ink([a, b], { words: [
        { label: "Loi", box: { x: 100, y: 300, w: 60, h: 20 }, strokeIds: [a.id] },
        { label: " ", strokeIds: [] },
        { label: "d'Ohm", box: { x: 180, y: 300, w: 80, h: 20 }, strokeIds: [b.id] },
      ] }),
      { id: uuid(), type: "math", strokes: [zone], latex: "U = RI", mode: "math", rect: { x: 90, y: 390, w: 220, h: 50 } } as Block,
    ]);
    const off = planPage(p, [lineOf(0)]);
    expect(off.filter((i) => i.kind === "ink").length).toBeGreaterThan(0);
    expect(off.some((i) => i.kind === "words" || i.kind === "equation")).toBe(false);
    const on = planPage(p, [lineOf(0)], { replaceRecognized: true });
    expect(on.filter((i) => i.kind === "ink").length).toBe(0);
    const w = on.find((i) => i.kind === "words") as Extract<PlanItem, { kind: "words" }>;
    expect(w.text).toBe("Loi d'Ohm");
    const eq = on.find((i) => i.kind === "equation") as Extract<PlanItem, { kind: "equation" }>;
    expect(eq.latex).toBe("U = RI");
    expect(eq.color).toBe("theoreme");
  });

  it("surligneur seul sur une ligne tapee : fond de la ligne", () => {
    const p = page([text("Important\nSuite"), ink([stroke("attention", 80, lineOf(0).top + 12, 300, lineOf(0).top + 12, "highlighter")])]);
    const items = planPage(p, [lineOf(0), lineOf(1)]);
    expect(items.filter((i) => i.kind === "ink").length).toBe(0);
    expect((items[0] as Extract<PlanItem, { kind: "line" }>).shade).toBe("FCD34D");
  });

  it("paragraphes : titres, listes numerotees, couleurs, retrait de l'encre", () => {
    const p = page([
      text("## Sous-titre\n- puce\n  1. sous\n3. trois\n[def]{.definition} et $x^2$ ![](img:ph1)"),
      ink([stroke("normal", 400, 900, 600, 950)]),
    ]);
    const paras = planToParas(planPage(p, null), assets);
    expect(paras[0].heading).toBe(2);
    expect(paras[1].list).toEqual({ ordered: false, level: 0 });
    expect(paras[2].list).toEqual({ ordered: true, level: 1, num: 1 });
    expect(paras[3].list).toEqual({ ordered: true, level: 0, num: 3 });
    expect(paras[4].runs[0]).toMatchObject({ kind: "text", text: "def", color: "2563EB" });
    expect(paras[4].runs.some((r) => r.kind === "math")).toBe(true);
    expect(paras[4].runs.some((r) => r.kind === "text" && r.text === "[ph1]")).toBe(true);
    const inkPara = paras[5];
    expect(inkPara.runs[0].kind).toBe("image");
    expect(inkPara.indent).toBeGreaterThan(0);
  });

  it("taille et retrait bornes a la largeur utile", () => {
    const big = fitEmu(900, 300);
    expect(big.cx).toBe(5760720);
    expect(big.cy).toBeLessThan(300 * EMU_PER_UNIT);
    expect(indentOf(800, big.cx)).toBe(0);
  });

  it("pages a la suite : saut de page avant chaque nouvelle page", () => {
    const joined = joinPages([[{ runs: [] }], [], [{ runs: [] }, { runs: [] }]]);
    expect(joined.map((p) => !!p.pageBreakBefore)).toEqual([false, true, true, false]);
  });

  it("nom de fichier", () => {
    expect(docxFileName("Élec", "S1/Chapitre 1", 4)).toBe("Élec - S1 - Chapitre 1 - p.4.docx");
    expect(docxFileName("Maths", "Cours")).toBe("Maths - Cours.docx");
    expect(docxFileName("A:B", "x?")).toBe("A B - x.docx");
  });
});

describe("fiche de revision", () => {
  it("titre, page, extraits colores, encre en image", () => {
    const st = stroke("theoreme", 100, 100, 200, 120);
    const result: ReviewResult = {
      count: 2,
      byColor: { definition: 0, theoreme: 2, exemple: 0, attention: 0, perso: 0 },
      notebooks: [{
        notebook: "Elec", notebookTitle: "Élec",
        dividers: [{ divider: "Cours", pages: [{ page: 3, items: [
          { key: "a", kind: "text", color: "theoreme", blockId: "b", plain: "Thevenin", tokens: [{ kind: "text", text: "Thevenin " }, { kind: "math", latex: "E_{th}" }] },
          { key: "c", kind: "ink", color: "theoreme", blockId: "d", plain: "", strokes: [st], box: { x: 99, y: 99, w: 102, h: 22 } },
        ] }] }],
      }],
    } as unknown as ReviewResult;
    const paras = reviewToParas(result, "Révision · Élec · Théorème", true, () => PNG);
    expect(paras[0]).toMatchObject({ heading: 1 });
    expect(paras[1].runs[0]).toMatchObject({ text: "Élec" });
    expect(paras[2]).toMatchObject({ heading: 2 });
    expect(paras[3].runs[0]).toMatchObject({ text: "Théorème : ", bold: true, color: "DC2626" });
    expect(paras[3].runs.some((r) => r.kind === "math")).toBe(true);
    expect(paras[4].runs.some((r) => r.kind === "image")).toBe(true);
  });
});

describe("liens entre pages dans Word", () => {
  it("un lien sort en texte souligne avec son libelle", () => {
    const runs = tokenRuns(parseDoc('voir [Thévenin](cahiers:abc#titre:Thevenin "Elec/Cours/0002")'), { inline: () => [] });
    const link = runs.find((r) => r.kind === "text" && r.text === "Thévenin");
    expect(link).toMatchObject({ kind: "text", underline: true });
    const entry = docxParts({ title: "t", paras: [{ runs }] } as DxDoc).find((e) => e.name === "word/document.xml");
    const xml = String(entry?.data);
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain("Thévenin");
  });
});
