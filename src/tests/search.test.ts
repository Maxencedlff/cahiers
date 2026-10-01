import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryFs } from "../core/storage/fs";
import { Repo } from "../core/storage/repo";
import { searchAll, listFlags, indexPage, sortFlags, type FlagHit } from "../core/storage/search";
import { fold, flagContext, makeExcerpt, normalize, parseQuery } from "../core/text/find";
import type { Block, Page } from "../core/types";
import { uuid } from "../core/id";

let fs: MemoryFs;
let repo: Repo;

beforeEach(async () => {
  fs = new MemoryFs();
  repo = new Repo(fs);
  await repo.ensureRootLayout();
});

/** Une page de cours avec ces blocs, dans Maths/Cours (ou ailleurs). */
async function pageWith(blocks: Block[], nb = "Maths", div = "Cours"): Promise<number> {
  const dirs = await repo.listNotebookDirs();
  const dir = dirs.includes(nb) ? nb : await repo.createNotebook(nb, "#000");
  if (!(await repo.listDividers(dir)).includes(div)) await repo.createDivider(dir, div);
  const n = await repo.createPage(dir, div);
  const page = await repo.readPage(dir, div, n);
  page.blocks.push(...blocks);
  await repo.writePage(dir, div, n, page);
  return n;
}

const text = (content: string): Block => ({ id: uuid(), type: "text", content });

describe("pliage du texte", () => {
  it("casse, accents, grec par son nom, ligatures", () => {
    expect(normalize("Théorème")).toBe("theoreme");
    expect(normalize("π r²")).toBe("pi r^2");
    expect(normalize("x₁")).toBe("x1");
    expect(normalize("Cœur")).toBe("coeur");
    expect(normalize("Δ")).toBe("delta");
  });

  it("garde l'indice d'origine de chaque caractere", () => {
    const f = fold("Été  π");
    expect(f.text).toBe("ete pi");
    // "p" et "i" viennent tous deux de π (indice 5).
    expect(f.map.slice(4, 6)).toEqual([5, 5]);
    expect(f.map[f.text.length]).toBe(6);
  });
});

describe("requete", () => {
  it("mots en ET, phrase entre guillemets", () => {
    expect(parseQuery("Rolle  Riemann").terms).toEqual(["rolle", "riemann"]);
    expect(parseQuery('"loi d\'Ohm" maille').terms).toEqual(["loi d'ohm", "maille"]);
  });

  it("filtres matiere et couleur", () => {
    const q = parseQuery("@Élec #théorème thevenin");
    expect(q.notebook).toBe("elec");
    expect(q.color).toBe("theoreme");
    expect(q.terms).toEqual(["thevenin"]);
    // Un # qui n'est pas une couleur reste un mot cherche.
    expect(parseQuery("#include").terms).toEqual(["#include"]);
  });
});

describe("extrait", () => {
  it("marque les termes et coupe sur les mots", () => {
    const long = "Au debut du cours on a rappele des choses. Le critere de Riemann dit que la serie converge si et seulement si alpha est plus grand que un, et rien de plus.";
    const parts = makeExcerpt(long, ["riemann"]);
    expect(parts[0].text).toBe("…");
    expect(parts.find((p) => p.mark)?.text).toBe("Riemann");
    expect(parts[parts.length - 1].text).toBe("…");
    const joined = parts.map((p) => p.text).join("");
    expect(joined).not.toMatch(/^…\S*[a-z]Le/);
  });

  it("le terme garde ses accents et sa casse d'origine", () => {
    const parts = makeExcerpt("Le Théorème de Rolle", ["theoreme"]);
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["Théorème"]);
  });
});

describe("contexte d'un repere", () => {
  it("la ligne du curseur, pas les precedentes", () => {
    expect(flagContext("Titre\nLa tension Vz vaut", " 5 V\nautre ligne")).toBe("La tension Vz vaut 5 V");
  });

  it("garde surtout ce qui precede le curseur, coupe sur un mot", () => {
    const before = "mot ".repeat(40) + "fin de la phrase ecrite";
    const c = flagContext(before, " suite");
    expect(c.length).toBeLessThanOrEqual(81);
    expect(c.startsWith("…")).toBe(true);
    expect(c).toContain("fin de la phrase ecrite");
  });
});

describe("recherche dans le texte tape", () => {
  it("trouve un mot en gras, en couleur, et relit les formules", async () => {
    await pageWith([text("Le **Théorème** de Rolle et le [critère de Riemann]{.theoreme}. On a $V_s = V_z - V_{be}$")]);
    expect(await searchAll(repo, "theoreme de rolle")).toHaveLength(1);
    expect(await searchAll(repo, '"critere de riemann"')).toHaveLength(1);
    expect(await searchAll(repo, "vbe")).toHaveLength(1);
    // Les jetons techniques ne remontent plus.
    expect(await searchAll(repo, "{.theoreme}")).toHaveLength(0);
    const [hit] = await searchAll(repo, "riemann");
    expect(hit.excerpt).not.toContain("]{");
    expect(hit.excerpt).not.toContain("**");
  });

  it("« Loi d'Ohm » converti par erreur reste trouvable", async () => {
    await pageWith([text("$L_{oi}$ d'$O_{hm}$ $U = R_I$")]);
    expect(await searchAll(repo, "loi d'ohm")).toHaveLength(1);
    expect(await searchAll(repo, "ohm")).toHaveLength(1);
  });

  it("pi tape devient π, et se cherche encore « pi »", async () => {
    await pageWith([text("Aire = π r²")]);
    expect(await searchAll(repo, "pi r")).toHaveLength(1);
    expect(await searchAll(repo, "π")).toHaveLength(1);
  });

  it("un exposant tape se cherche comme la formule, et inversement", async () => {
    await pageWith([text("Aire = π r²")]);
    await pageWith([text("Energie $E = m c^2$ et $x_1$")]);
    expect(await searchAll(repo, "r^2")).toHaveLength(1);
    expect(await searchAll(repo, "c²")).toHaveLength(1);
    expect(await searchAll(repo, "x₁")).toHaveLength(1);
  });

  it("le marqueur d'une photo ne matche pas « img »", async () => {
    const id = uuid();
    await pageWith([
      text(`Schema ![](img:${id}) du montage`),
      { id, type: "image", src: "assets/a.png", ocr: "pont de Wheatstone" },
    ]);
    expect(await searchAll(repo, "img")).toHaveLength(0);
    expect(await searchAll(repo, "wheatstone")).toHaveLength(1);
  });

  it("l'OCR d'une photo retiree du texte ne remonte plus", async () => {
    await pageWith([
      text("Schema du montage"),
      { id: uuid(), type: "image", src: "assets/a.png", ocr: "pont de Wheatstone" },
    ]);
    expect(await searchAll(repo, "wheatstone")).toHaveLength(0);
    // Une ancienne photo posee sur la page (avec cadre) reste cherchable.
    await pageWith([{ id: uuid(), type: "image", src: "assets/b.png", ocr: "Wheatstone", rect: { x: 0, y: 0, w: 10, h: 10 } }]);
    expect(await searchAll(repo, "wheatstone")).toHaveLength(1);
  });

  it("mots dans n'importe quel ordre, tous obligatoires", async () => {
    await pageWith([text("Critere de Riemann, puis theoreme de Rolle")]);
    expect(await searchAll(repo, "rolle riemann")).toHaveLength(1);
    expect(await searchAll(repo, "rolle cauchy")).toHaveLength(0);
    expect(await searchAll(repo, '"rolle riemann"')).toHaveLength(0);
  });

  it("filtres @matiere et #couleur", async () => {
    await pageWith([text("[Thevenin]{.theoreme} et Norton")], "Élec");
    await pageWith([text("Thevenin en maths ?")], "Maths");
    expect(await searchAll(repo, "thevenin")).toHaveLength(2);
    expect(await searchAll(repo, "thevenin @elec")).toHaveLength(1);
    expect(await searchAll(repo, "thevenin", { notebook: "Maths" })).toHaveLength(1);
    expect(await searchAll(repo, "#theoreme thevenin")).toHaveLength(1);
    expect(await searchAll(repo, "#theoreme norton")).toHaveLength(0);
  });

  it("#couleur seul : tous les theoremes, @matiere pour en garder une", async () => {
    await pageWith([text("[Thevenin]{.theoreme} et Norton")], "Élec");
    await pageWith([text("[Rolle]{.theoreme}, [une definition]{.definition}")], "Maths");
    expect(await searchAll(repo, "#theoreme")).toHaveLength(2);
    const maths = await searchAll(repo, "#theoreme @maths");
    expect(maths.map((h) => h.excerpt)).toEqual(["Rolle"]);
    // Un filtre matiere seul ne liste pas tout le cahier.
    expect(await searchAll(repo, "@maths")).toHaveLength(0);
  });

  it("les pages les plus recentes d'abord", async () => {
    await pageWith([text("limite ancienne")]);
    await new Promise((r) => setTimeout(r, 5));
    await pageWith([text("limite recente")]);
    const hits = await searchAll(repo, "limite");
    expect(hits.map((h) => h.excerpt)).toEqual(["limite recente", "limite ancienne"]);
  });

  it("s'arrete quand une frappe plus recente arrive", async () => {
    for (let i = 0; i < 3; i++) await pageWith([text("serie numero " + i)]);
    const read = vi.spyOn(repo, "readPage");
    let calls = 0;
    const hits = await searchAll(repo, "serie", { isStale: () => ++calls > 1 });
    expect(hits).toEqual([]);
    expect(read.mock.calls.length).toBeLessThan(3);
  });
});

describe("cache de session", () => {
  it("une page inchangee n'est pas relue, une page changee l'est", async () => {
    const n = await pageWith([text("Thevenin")]);
    await searchAll(repo, "thevenin");
    const read = vi.spyOn(repo, "readPage");
    expect(await searchAll(repo, "thevenin")).toHaveLength(1);
    await repo.listNotebooks();
    expect(read).not.toHaveBeenCalled();

    // Ecriture par l'appli : relue.
    const page = await repo.readPage("Maths", "Cours", n);
    (page.blocks[0] as { content: string }).content = "Norton";
    await repo.writePage("Maths", "Cours", n, page);
    read.mockClear();
    expect(await searchAll(repo, "thevenin")).toHaveLength(0);
    expect(await searchAll(repo, "norton")).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("une page changee hors de l'appli (OneDrive) est relue", async () => {
    const n = await pageWith([text("Thevenin")]);
    expect(await searchAll(repo, "thevenin")).toHaveLength(1);
    const path = `Maths/Cours/000${n}.page.json`;
    const raw = JSON.parse(await fs.readText(path)) as Page;
    (raw.blocks[0] as { content: string }).content = "Norton";
    await fs.writeText(path, JSON.stringify(raw));
    expect(await searchAll(repo, "thevenin")).toHaveLength(0);
    expect(await searchAll(repo, "norton")).toHaveLength(1);
  });

  it("sans dates de fichiers (commande en echec), tout est relu", async () => {
    await pageWith([text("Thevenin")]);
    fs.listFilesStat = async () => { throw new Error("commande inconnue"); };
    expect(await searchAll(repo, "thevenin")).toHaveLength(1);
    expect((await repo.summary("Maths")).pageCount).toBe(1);
  });

  it("une renumerotation ne melange pas les pages", async () => {
    await pageWith([text("alpha page")]);
    await pageWith([text("beta page")]);
    expect((await searchAll(repo, "alpha"))[0].page).toBe(1);
    await repo.deletePage("Maths", "Cours", 1);
    const hits = await searchAll(repo, "page");
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt).toBe("beta page");
    expect(hits[0].page).toBe(1);
  });

  it("une page remise de la corbeille est relue a sa nouvelle place", async () => {
    await pageWith([text("alpha page")]);
    await pageWith([text("beta page")]);
    await searchAll(repo, "page");
    const trash = await repo.deletePage("Maths", "Cours", 1);
    expect((await searchAll(repo, "page")).map((h) => h.excerpt)).toEqual(["beta page"]);
    await repo.restorePage(trash);
    const hits = await searchAll(repo, "page");
    expect(hits.map((h) => `${h.page}:${h.excerpt}`).sort()).toEqual(["1:alpha page", "2:beta page"]);
    expect((await repo.summary("Maths")).pageCount).toBe(2);
  });
});

describe("reperes « pas compris »", () => {
  it("le resume du menu porte les reperes, avec leur ligne", async () => {
    await pageWith([
      text("La tension Vz"),
      { id: uuid(), type: "flag", note: "À revoir", context: "La tension Vz", created: "2026-10-01T08:00:00Z", rect: { x: 0, y: 40, w: 30, h: 30 } },
      { id: uuid(), type: "flag", note: "x", resolved: true },
    ]);
    const [s] = (await repo.listNotebooks()).filter((n) => n.dir === "Maths");
    expect(s.flagCount).toBe(1);
    expect(s.flags[0]).toMatchObject({ notebook: "Maths", divider: "Cours", page: 1, context: "La tension Vz" });
    expect(await listFlags(repo, "Maths")).toHaveLength(1);
  });

  it("la note par defaut n'est pas un resultat de recherche a part", async () => {
    await pageWith([{ id: uuid(), type: "flag", note: "À revoir" }, { id: uuid(), type: "flag", note: "voir le prof" }]);
    expect(await searchAll(repo, "revoir")).toHaveLength(0);
    expect(await searchAll(repo, "prof")).toHaveLength(1);
  });

  it("tri : poses recemment d'abord, les anciens (sans date) a la fin", () => {
    const f = (id: string, created?: string): FlagHit => ({
      notebook: "M", notebookTitle: "M", divider: "C", page: 1, blockId: id, note: "", created,
    });
    expect(sortFlags([f("a"), f("b", "2026-09-01"), f("c", "2026-10-01")]).map((x) => x.blockId))
      .toEqual(["c", "b", "a"]);
  });

  it("indexPage ignore les reperes resolus", () => {
    const idx = indexPage({
      version: 1, id: "p", created: "", modified: "m",
      blocks: [{ id: "f", type: "flag", note: "x", resolved: true }],
    });
    expect(idx.flags).toEqual([]);
  });
});
