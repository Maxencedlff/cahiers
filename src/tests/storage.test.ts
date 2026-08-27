import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFs } from "../core/storage/fs";
import { Repo, safeName } from "../core/storage/repo";
import { searchAll, listFlags, normalize } from "../core/storage/search";
import { pageFileName, parsePageNumber } from "../core/types";
import { uuid, nowIso } from "../core/id";

let fs: MemoryFs;
let repo: Repo;

beforeEach(async () => {
  fs = new MemoryFs();
  repo = new Repo(fs);
  await repo.ensureRootLayout();
});

describe("noms de fichiers", () => {
  it("numerote sur 4 chiffres", () => {
    expect(pageFileName(1)).toBe("0001.page.json");
    expect(pageFileName(247)).toBe("0247.page.json");
  });

  it("relit le numero", () => {
    expect(parsePageNumber("0012.page.json")).toBe(12);
    expect(parsePageNumber("cahier.json")).toBeNull();
  });

  it("nettoie les noms interdits par Windows", () => {
    expect(safeName("Maths / Analyse")).toBe("Maths Analyse");
    expect(safeName("  ")).toBe("Sans titre");
    expect(safeName("Elec:TD?")).toBe("Elec TD");
  });
});

describe("arborescence", () => {
  it("cree Vrac au premier lancement", async () => {
    expect(await repo.listNotebookDirs()).toContain("Vrac");
  });

  it("voit un dossier cree hors de l'application", async () => {
    // Simule une creation depuis l'explorateur Windows.
    await fs.mkdir("Maths/Cours");
    const dirs = await repo.listNotebookDirs();
    expect(dirs).toContain("Maths");
    expect(await repo.listDividers("Maths")).toEqual(["Cours"]);
  });

  it("garde l'ordre choisi des intercalaires", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createDivider(nb, "Exos");
    await repo.createDivider(nb, "TD");
    await repo.reorderDividers(nb, ["TD", "Cours", "Exos"]);
    expect(await repo.listDividers(nb)).toEqual(["TD", "Cours", "Exos"]);
  });

  it("ajoute a la fin un intercalaire apparu sur le disque", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await fs.mkdir(`${nb}/Annales`);
    expect(await repo.listDividers(nb)).toEqual(["Cours", "Annales"]);
  });

  it("renomme un intercalaire sur le disque", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Exos");
    await repo.createPage(nb, "Exos");
    const next = await repo.renameDivider(nb, "Exos", "Exercices");
    expect(next).toBe("Exercices");
    expect(await repo.listDividers(nb)).toEqual(["Exercices"]);
    expect(await repo.listPageNumbers(nb, "Exercices")).toEqual([1]);
  });
});

describe("numerotation des pages", () => {
  it("numerote par intercalaire, pas globalement", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createDivider(nb, "Exos");
    await repo.createPage(nb, "Cours");
    await repo.createPage(nb, "Cours");
    await repo.createPage(nb, "Exos");
    expect(await repo.listPageNumbers(nb, "Cours")).toEqual([1, 2]);
    expect(await repo.listPageNumbers(nb, "Exos")).toEqual([1]);
  });

  it("inserer au milieu renumerote", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    for (let i = 0; i < 3; i++) await repo.createPage(nb, "Cours");
    const p1 = await repo.readPage(nb, "Cours", 1);
    const p3 = await repo.readPage(nb, "Cours", 3);

    const inserted = await repo.createPage(nb, "Cours", 2);
    expect(inserted).toBe(2);
    expect(await repo.listPageNumbers(nb, "Cours")).toEqual([1, 2, 3, 4]);
    // L'ancienne page 1 n'a pas bouge, l'ancienne 3 est devenue la 4.
    expect((await repo.readPage(nb, "Cours", 1)).id).toBe(p1.id);
    expect((await repo.readPage(nb, "Cours", 4)).id).toBe(p3.id);
  });

  it("supprimer referme le trou", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    for (let i = 0; i < 3; i++) await repo.createPage(nb, "Cours");
    const p3 = await repo.readPage(nb, "Cours", 3);
    await repo.deletePage(nb, "Cours", 2);
    expect(await repo.listPageNumbers(nb, "Cours")).toEqual([1, 2]);
    expect((await repo.readPage(nb, "Cours", 2)).id).toBe(p3.id);
  });
});

describe("fichiers de page", () => {
  it("un fichier par page, jamais un fichier global", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createPage(nb, "Cours");
    await repo.createPage(nb, "Cours");
    const files = await fs.listFiles(`${nb}/Cours`);
    expect(files).toEqual(["0001.page.json", "0002.page.json"]);
  });

  it("relit exactement ce qui a ete ecrit", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    const n = await repo.createPage(nb, "Cours");
    const page = await repo.readPage(nb, "Cours", n);
    page.blocks.push({
      id: uuid(), type: "math", mode: "math", latex: "\\int_0^{+\\infty}",
      strokes: [{ id: uuid(), color: "theoreme", width: 2, tool: "pen", points: [{ x: 1, y: 2, p: 0.5, t: 0 }] }],
    });
    await repo.writePage(nb, "Cours", n, page);
    const back = await repo.readPage(nb, "Cours", n);
    expect(back.blocks).toHaveLength(1);
    const b = back.blocks[0];
    expect(b.type).toBe("math");
    if (b.type === "math") {
      expect(b.latex).toBe("\\int_0^{+\\infty}");
      // Regle absolue : l'encre brute survit a l'aller-retour disque.
      expect(b.strokes).toHaveLength(1);
      expect(b.strokes[0].points[0].p).toBe(0.5);
    }
  });

  it("le JSON reste lisible a la main", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createPage(nb, "Cours");
    const raw = await fs.readText(`${nb}/Cours/0001.page.json`);
    expect(raw).toContain("\n");
    expect(JSON.parse(raw).version).toBe(1);
  });

  it("memorise la derniere position et le mode par intercalaire", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.setLastPosition(nb, "Cours", 7);
    await repo.setViewMode(nb, "Cours", "scroll");
    const meta = await repo.readMeta(nb);
    expect(meta.lastPosition).toEqual({ divider: "Cours", page: 7 });
    expect(meta.viewMode?.Cours).toBe("scroll");
  });

  it("survit a un cahier.json corrompu", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await fs.writeText(`${nb}/cahier.json`, "{ ceci n'est pas du JSON");
    const meta = await repo.readMeta(nb);
    expect(meta.title).toBe("Maths");
  });
});

describe("recherche", () => {
  it("ignore la casse et les accents", () => {
    expect(normalize("Théorème")).toBe("theoreme");
  });

  it("trouve dans le texte, le LaTeX et l'OCR", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    const n = await repo.createPage(nb, "Cours");
    const page = await repo.readPage(nb, "Cours", n);
    page.blocks.push(
      { id: uuid(), type: "text", content: "Critère de Riemann" },
      { id: uuid(), type: "math", mode: "math", strokes: [], latex: "\\int_0^{+\\infty} e^{-x}" },
      { id: uuid(), type: "image", src: "assets/a.png", ocr: "photo du tableau" },
    );
    await repo.writePage(nb, "Cours", n, page);

    expect(await searchAll(repo, "riemann")).toHaveLength(1);
    expect(await searchAll(repo, "infty")).toHaveLength(1);
    expect(await searchAll(repo, "tableau")).toHaveLength(1);
    expect(await searchAll(repo, "introuvable")).toHaveLength(0);
  });

  it("liste les reperes pas compris non resolus", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    const n = await repo.createPage(nb, "Cours");
    const page = await repo.readPage(nb, "Cours", n);
    page.blocks.push(
      { id: uuid(), type: "flag", note: "revoir le critere de Riemann" },
      { id: uuid(), type: "flag", note: "deja compris", resolved: true },
    );
    await repo.writePage(nb, "Cours", n, page);
    const flags = await listFlags(repo);
    expect(flags).toHaveLength(1);
    expect(flags[0].note).toContain("Riemann");
  });

  it("compte les reperes dans le resume du cahier", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    const n = await repo.createPage(nb, "Cours");
    const page = await repo.readPage(nb, "Cours", n);
    page.blocks.push({ id: uuid(), type: "flag", note: "x" });
    await repo.writePage(nb, "Cours", n, page);
    const s = await repo.summary(nb);
    expect(s.flagCount).toBe(1);
    expect(s.pageCount).toBe(1);
  });
});

describe("tri du menu", () => {
  it("classe par derniere modification, pas par ordre alphabetique", async () => {
    const a = await repo.createNotebook("Algebre", "#000");
    const z = await repo.createNotebook("Zoologie", "#000");
    for (const nb of [a, z]) await repo.createDivider(nb, "Cours");
    await repo.createPage(a, "Cours");
    await new Promise((r) => setTimeout(r, 5));
    await repo.createPage(z, "Cours");
    const list = await repo.listNotebooks();
    expect(list[0].dir).toBe(z);
  });
});

describe("horodatage", () => {
  it("nowIso est un ISO 8601 valide", () => {
    expect(new Date(nowIso()).toString()).not.toBe("Invalid Date");
  });
});
