import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFs } from "../core/storage/fs";
import { Repo, safeName, trashStamp, TRASH_DIR } from "../core/storage/repo";
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

describe("corbeille", () => {
  const ids = async (nb: string, d: string) => {
    const out: string[] = [];
    for (const n of await repo.listPageNumbers(nb, d)) out.push((await repo.readPage(nb, d, n)).id);
    return out;
  };

  it("horodatage lisible et triable", () => {
    expect(trashStamp(new Date(2026, 9, 1, 9, 5, 7, 42))).toBe("2026-10-01_09-05-07-042");
  });

  it("une page supprimee part a la corbeille, pas dans le vide", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    for (let i = 0; i < 3; i++) await repo.createPage(nb, "Cours");
    const [a, b, c] = await ids(nb, "Cours");
    const entry = await repo.deletePage(nb, "Cours", 2);
    expect(await ids(nb, "Cours")).toEqual([a, c]);
    expect(entry.bin.startsWith(`${TRASH_DIR}/`)).toBe(true);
    const kept = JSON.parse(await fs.readText(`${entry.bin}/Maths/Cours/0002.page.json`));
    expect(kept.id).toBe(b);
    // La corbeille ne se montre pas comme une matiere.
    expect(await repo.listNotebookDirs()).not.toContain(TRASH_DIR);
  });

  it("Annuler remet la page a son numero et nettoie la corbeille", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    for (let i = 0; i < 4; i++) await repo.createPage(nb, "Cours");
    const before = await ids(nb, "Cours");
    const entry = await repo.deletePage(nb, "Cours", 2);
    expect(await repo.restorePage(entry)).toBe(2);
    expect(await ids(nb, "Cours")).toEqual(before);
    expect(await fs.exists(entry.bin)).toBe(false);
  });

  it("deux suppressions rapides ont chacune leur dossier", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    for (let i = 0; i < 3; i++) await repo.createPage(nb, "Cours");
    const e1 = await repo.deletePage(nb, "Cours", 1);
    const e2 = await repo.deletePage(nb, "Cours", 1);
    expect(e1.bin).not.toBe(e2.bin);
  });

  it("un intercalaire supprime revient a sa place", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    for (const d of ["Cours", "Exos", "TD"]) await repo.createDivider(nb, d);
    await repo.createPage(nb, "Exos");
    const id = (await repo.readPage(nb, "Exos", 1)).id;
    const entry = await repo.deleteDivider(nb, "Exos");
    expect(await repo.listDividers(nb)).toEqual(["Cours", "TD"]);
    expect(await repo.restoreDivider(entry)).toBe("Exos");
    expect(await repo.listDividers(nb)).toEqual(["Cours", "Exos", "TD"]);
    expect((await repo.readPage(nb, "Exos", 1)).id).toBe(id);
  });

  it("n'ecrase pas un intercalaire recree entre temps", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "TD");
    const entry = await repo.deleteDivider(nb, "TD");
    await repo.createDivider(nb, "TD");
    expect(await repo.restoreDivider(entry)).toBe("TD (restauré)");
  });

  it("une page restauree apres d'autres suppressions ne laisse pas de trou", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    for (let i = 0; i < 3; i++) await repo.createPage(nb, "Cours");
    const [a, , c] = await ids(nb, "Cours");
    const entry = await repo.deletePage(nb, "Cours", 3);
    await repo.deletePage(nb, "Cours", 2);
    // Il ne reste qu'une page : la p.3 revient en p.2, pas en p.3.
    expect(await repo.restorePage(entry)).toBe(2);
    expect(await repo.listPageNumbers(nb, "Cours")).toEqual([1, 2]);
    expect(await ids(nb, "Cours")).toEqual([a, c]);
  });

  it("un intercalaire supprime emporte ses photos", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "TD");
    const src = await repo.writeAsset(nb, "TD", "x.png", "data:image/png;base64,AAAA");
    const entry = await repo.deleteDivider(nb, "TD");
    expect(await fs.exists(`${entry.bin}/Maths/TD/${src}`)).toBe(true);
    await repo.restoreDivider(entry);
    expect(await fs.exists(`Maths/TD/${src}`)).toBe(true);
  });
});

describe("renommer un intercalaire", () => {
  it("refuse un nom deja pris, sans tenir compte de la casse", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createDivider(nb, "Exos");
    expect(await repo.renameDivider(nb, "Exos", "cours")).toBe("Exos");
    expect(await repo.renameDivider(nb, "Exos", "assets")).toBe("Exos");
    // Un nom cache (".corbeille") disparaitrait de la bande d'intercalaires.
    expect(await repo.renameDivider(nb, "Exos", ".corbeille")).toBe("Exos");
    expect(await repo.listDividers(nb)).toEqual(["Cours", "Exos"]);
  });

  it("change la casse seule", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "cours");
    await repo.createPage(nb, "cours");
    expect(await repo.renameDivider(nb, "cours", "Cours")).toBe("Cours");
    expect(await repo.listDividers(nb)).toEqual(["Cours"]);
    expect(await repo.listPageNumbers(nb, "Cours")).toEqual([1]);
  });
});
