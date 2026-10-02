import { describe, it, expect, beforeEach } from "vitest";
import {
  clusterStrokes, dividerMatches, extractReview, focusQuery, groupReview, textRuns, tokensPlain,
  whereLabel, zoneColor, type ReviewSource,
} from "../core/review";
import { collectReview, indexPage } from "../core/storage/search";
import { MemoryFs } from "../core/storage/fs";
import { Repo } from "../core/storage/repo";
import type { Block, InkColor, Page, Stroke } from "../core/types";
import { uuid } from "../core/id";

/** Trait droit de (x0,y0) a (x1,y1), quelques points. */
function stroke(color: InkColor, x0: number, y0: number, x1: number, y1: number, tool: Stroke["tool"] = "pen"): Stroke {
  const points = Array.from({ length: 5 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / 4, y: y0 + ((y1 - y0) * i) / 4, p: 0.5, t: i * 10,
  }));
  return { id: uuid(), points, color, width: tool === "highlighter" ? 14 : 2, tool };
}

function page(blocks: Block[]): Page {
  return { version: 1, id: uuid(), created: "2026-09-01T08:00:00Z", modified: "2026-09-01T08:00:00Z", blocks };
}

const text = (content: string): Block => ({ id: uuid(), type: "text", content });
const ink = (strokes: Stroke[], extra: Partial<Block> = {}): Block =>
  ({ id: uuid(), type: "ink", strokes, recognized: null, mode: "raw", ...extra }) as Block;

describe("texte tape colore", () => {
  it("un passage par groupe de couleur, dans l'ordre, neutre ignore", () => {
    const runs = textRuns("Intro [Soit f continue]{.definition} puis [Rolle : f(a)=f(b)]{.theoreme} fin");
    expect(runs.map((r) => r.color)).toEqual(["definition", "theoreme"]);
    expect(tokensPlain(runs[0].tokens)).toBe("Soit f continue");
  });

  it("formules gardees en LaTeX (rendu KaTeX), texte simple relu", () => {
    const [r] = textRuns("[On a $\\frac{a}{b}$ donc]{.theoreme}");
    expect(r.tokens.some((t) => t.kind === "math" && t.latex === "\\frac{a}{b}")).toBe(true);
    expect(tokensPlain(r.tokens)).not.toContain("\\frac");
  });

  it("continue par-dessus un retour a la ligne de la meme couleur", () => {
    const runs = textRuns("[Ligne 1]{.definition}\n[Ligne 2]{.definition}\nneutre\n[Autre]{.definition}");
    expect(runs).toHaveLength(2);
    expect(runs[0].tokens.filter((t) => t.kind === "br")).toHaveLength(1);
    expect(tokensPlain(runs[0].tokens)).toBe("Ligne 1\nLigne 2");
  });

  it("une photo coupe le passage, gras et italique gardes", () => {
    const runs = textRuns("[**A** *b*]{.exemple}![](img:x)[C]{.exemple}");
    expect(runs).toHaveLength(2);
    expect(runs[0].tokens[0]).toMatchObject({ kind: "text", text: "A", bold: true });
  });

  it("couleur du bloc entier", () => {
    const runs = textRuns("Tout le bloc", "attention");
    expect(runs).toEqual([{ color: "attention", tokens: [{ kind: "text", text: "Tout le bloc" }] }]);
  });

  it("blancs seuls : pas d'extrait", () => {
    expect(textRuns("[   ]{.theoreme}")).toEqual([]);
  });
});

describe("encre", () => {
  it("groupe les traits proches, separe les eloignes, de haut en bas", () => {
    const a = stroke("theoreme", 100, 400, 140, 400);
    const b = stroke("theoreme", 150, 402, 190, 402);      // meme mot
    const c = stroke("theoreme", 100, 430, 160, 430);      // ligne suivante
    const far = stroke("theoreme", 100, 100, 160, 100);    // en haut, isole
    const groups = clusterStrokes([a, b, c, far]);
    expect(groups.map((g) => g.length)).toEqual([1, 3]);
    expect(groups[0][0]).toBe(far);
  });

  it("couleur d'une zone : la moitie de ses traits au moins", () => {
    expect(zoneColor([stroke("theoreme", 0, 0, 10, 0), stroke("theoreme", 0, 5, 10, 5), stroke("normal", 0, 9, 9, 9)])).toBe("theoreme");
    expect(zoneColor([stroke("normal", 0, 0, 10, 0), stroke("normal", 0, 5, 10, 5), stroke("theoreme", 0, 9, 9, 9)])).toBe(null);
    expect(zoneColor([])).toBe(null);
  });

  it("encre neutre jamais extraite ; encre coloree avec son cadre et ses mots reconnus", () => {
    const red = stroke("theoreme", 100, 300, 200, 300);
    const black = stroke("normal", 100, 500, 200, 500);
    const block = ink([red, black], {
      words: [{ label: "Rolle", strokeIds: [red.id], box: { x: 100, y: 290, w: 100, h: 20 } }],
    } as Partial<Block>);
    const items = extractReview(page([block]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "ink", color: "theoreme", blockId: block.id, plain: "Rolle" });
    expect(items[0].box!.y).toBeLessThan(300);
    expect(items[0].strokes).toEqual([red]);
  });

  it("zone math de la couleur : un seul extrait avec son LaTeX", () => {
    const s1 = stroke("definition", 100, 600, 150, 600), s2 = stroke("definition", 160, 600, 200, 610);
    const math: Block = {
      id: uuid(), type: "math", strokes: [s1, s2], latex: "\\int_0^1 f", mode: "math",
      rect: { x: 90, y: 580, w: 130, h: 50 },
    };
    const items = extractReview(page([math]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "math", color: "definition", latex: "\\int_0^1 f", box: math.rect });
  });

  it("zone texte reconnue de la couleur ; zone neutre : ses traits colores sortent en encre", () => {
    const zone = ink([stroke("exemple", 100, 700, 200, 700)], { rect: { x: 90, y: 690, w: 120, h: 30 }, recognized: "par exemple" } as Partial<Block>);
    const neutral = ink([stroke("normal", 100, 800, 200, 800), stroke("normal", 100, 810, 200, 810), stroke("attention", 300, 900, 340, 900)],
      { rect: { x: 90, y: 790, w: 300, h: 130 }, recognized: "x" } as Partial<Block>);
    const items = extractReview(page([zone, neutral]));
    expect(items.map((i) => [i.kind, i.color])).toEqual([["zone", "exemple"], ["ink", "attention"]]);
    expect(items[0].plain).toBe("par exemple");
  });

  it("surligneur : la bande et l'encre qu'elle recouvre", () => {
    const under = stroke("normal", 110, 1000, 190, 1000);
    const elsewhere = stroke("normal", 110, 1100, 190, 1100);
    const band = stroke("attention", 100, 1000, 200, 1000, "highlighter");
    const items = extractReview(page([ink([under, elsewhere, band])]));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("highlight");
    expect(items[0].strokes).toContain(under);
    expect(items[0].strokes).not.toContain(elsewhere);
  });

  it("le texte tape d'abord, puis l'encre de haut en bas", () => {
    const low = stroke("theoreme", 100, 900, 150, 900), high = stroke("theoreme", 100, 200, 150, 200);
    const items = extractReview(page([ink([low, high]), text("[Rolle]{.theoreme}")]));
    expect(items.map((i) => i.kind)).toEqual(["text", "ink", "ink"]);
    expect(items[1].strokes).toEqual([high]);
  });

  it("indexPage porte les extraits (cache de session de scanDivider)", () => {
    expect(indexPage(page([text("rien de colore")])).review).toBeUndefined();
    expect(indexPage(page([text("[Def]{.definition}")])).review).toHaveLength(1);
  });
});

describe("filtres et groupement", () => {
  const item = (color: "theoreme" | "definition", n = 0) =>
    ({ key: `k${n}${color}`, kind: "text" as const, color, blockId: "b", plain: color });
  const src = (notebook: string, divider: string, page: number, items: ReturnType<typeof item>[]): ReviewSource =>
    ({ notebook, notebookTitle: notebook, divider, page, items });

  it("matiere > intercalaire > page, ordre recu, vides omis, compteurs par couleur", () => {
    const r = groupReview([
      src("Maths", "Cours", 1, [item("theoreme"), item("definition")]),
      src("Maths", "Cours", 2, [item("definition")]),
      src("Maths", "TD", 1, [item("theoreme", 1)]),
      src("Elec", "Cours", 3, [item("theoreme", 2)]),
    ], { colors: ["theoreme"] });
    expect(r.count).toBe(3);
    expect(r.byColor.theoreme).toBe(3);
    expect(r.byColor.definition).toBe(2);
    expect(r.notebooks.map((n) => [n.notebook, n.dividers.map((d) => [d.divider, d.pages.map((p) => p.page)])])).toEqual([
      ["Maths", [["Cours", [1]], ["TD", [1]]]],
      ["Elec", [["Cours", [3]]]],
    ]);
  });

  it("plusieurs couleurs : ordre de la page garde", () => {
    const r = groupReview([src("Maths", "Cours", 1, [item("theoreme"), item("definition")])], { colors: ["definition", "theoreme"] });
    expect(r.notebooks[0].dividers[0].pages[0].items.map((i) => i.color)).toEqual(["theoreme", "definition"]);
  });

  it("filtre d'intercalaire, exact ou par dossier parent (arborescence)", () => {
    expect(dividerMatches("S1/Chapitre 1", "S1")).toBe(true);
    expect(dividerMatches("S10", "S1")).toBe(false);
    expect(dividerMatches("Cours", "Cours")).toBe(true);
    expect(dividerMatches("Cours", undefined)).toBe(true);
    const r = groupReview([src("M", "S1/A", 1, [item("theoreme")]), src("M", "S2/A", 1, [item("theoreme")])], { colors: ["theoreme"], divider: "S1" });
    expect(r.count).toBe(1);
  });

  it("phrase a retrouver dans la page, libelle d'endroit", () => {
    expect(focusQuery("Théorème de Rolle : si f est continue sur [a, b] et dérivable sur ]a, b[")).toBe("\"Théorème de Rolle : si f est continue sur [a,\"");
    expect(focusQuery("dit \"bonjour\"\nsuite")).toBe("\"dit bonjour\"");
    expect(focusQuery("")).toBe("");
    expect(whereLabel("S1/Cours", 4)).toBe("S1 › Cours p. 4");
  });
});

describe("collecte sur le disque", () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo(new MemoryFs());
    await repo.ensureRootLayout();
  });

  async function fill(nb: string, div: string, count: number): Promise<string> {
    const dirs = await repo.listNotebookDirs();
    const dir = dirs.includes(nb) ? nb : await repo.createNotebook(nb, "#000");
    if (!(await repo.listDividers(dir)).includes(div)) await repo.createDivider(dir, div);
    for (let i = 0; i < count; i++) {
      const n = await repo.createPage(dir, div);
      const p = await repo.readPage(dir, div, n);
      p.blocks.push(
        { id: uuid(), type: "text", content: `Cours ${i} [Théorème ${i}]{.theoreme} et [déf ${i}]{.definition}` },
        ink([stroke("theoreme", 100, 400, 200, 400), stroke("normal", 100, 600, 300, 600)]),
      );
      await repo.writePage(dir, div, n, p);
    }
    return dir;
  }

  it("tous les theoremes d'une matiere, dans l'ordre des pages ; 200 pages rapides", async () => {
    const maths = await fill("Maths", "Cours", 200);
    await fill("Elec", "Cours", 3);
    const t0 = performance.now();
    const first = await collectReview(repo, { colors: ["theoreme"] }, { notebook: maths });
    const t1 = performance.now();
    const again = await collectReview(repo, { colors: ["theoreme"] }, { notebook: maths });
    const t2 = performance.now();
    expect(first!.pages).toBe(200);
    expect(first!.count).toBe(400);
    expect(first!.notebooks).toHaveLength(1);
    expect(first!.notebooks[0].dividers[0].pages.map((p) => p.page).slice(0, 3)).toEqual([1, 2, 3]);
    expect(again!.count).toBe(400);
    // Indication (MemoryFs sans dates : tout est relu) ; le vrai cache tient par date+taille.
    console.info(`revision 200 pages : ${Math.round(t1 - t0)} ms, puis ${Math.round(t2 - t1)} ms`);
    const all = await collectReview(repo, { colors: ["definition"] });
    expect(all!.notebooks.map((n) => n.notebook)).toEqual(expect.arrayContaining(["Maths", "Elec"]));
    expect(all!.count).toBe(203);
  });

  it("arret propre quand une autre demande prend la main", async () => {
    await fill("Maths", "Cours", 2);
    expect(await collectReview(repo, { colors: ["theoreme"] }, { isStale: () => true })).toBeNull();
  });
});
