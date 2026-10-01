import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFs } from "../core/storage/fs";
import { Repo, safeName, trashStamp, TRASH_DIR, serializePage } from "../core/storage/repo";
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
    // Simule une creation depuis l'explorateur Windows : sans page ni
    // cahier.json, il est dans « Autres dossiers » (D5) ; avec une page,
    // c'est une matiere.
    await fs.mkdir("Maths/Cours");
    expect((await repo.classifyRoot()).others).toEqual([{ dir: "Maths", git: false }]);
    await fs.writeText("Maths/Cours/0001.page.json", "{}");
    expect(await new Repo(fs).listNotebookDirs()).toContain("Maths");
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

  it("les points d'un trait tiennent sur une ligne, sans rien perdre", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 1.5, y: 1400.2 + i, p: 0.42, t: i * 5 }));
    const page = {
      version: 1 as const, id: "p", created: "c", modified: "m", height: 1600,
      blocks: [{ id: "ink", type: "ink" as const, mode: "raw" as const, recognized: null,
        strokes: [{ id: "s1", color: "normal" as const, width: 2.2, tool: "pen" as const, points: pts }] }],
    };
    const raw = serializePage(page);
    expect(JSON.parse(raw)).toEqual(page);
    expect(raw).toContain("\n");
    // Un seul point par ligne indentee aurait donne 50 x 6 lignes.
    expect(raw.split("\n").length).toBeLessThan(40);
    expect(raw.length).toBeLessThan(JSON.stringify(page, null, 2).length / 2);
  });

  it("memorise le mode par intercalaire (la position reste sur la machine)", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.setViewMode(nb, "Cours", "scroll");
    const meta = await repo.readMeta(nb);
    expect(meta.viewMode?.Cours).toBe("scroll");
    expect(meta.lastPosition).toBeUndefined();
  });

  it("memorise le fond de page par intercalaire (D12), suit un renommage", async () => {
    const nb = await repo.createNotebook("Elec", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createDivider(nb, "TP");
    expect((await repo.readMeta(nb)).paper).toBeUndefined();
    await repo.setPaper(nb, "TP", "quadrille");
    await repo.setPaper(nb, "Cours", "seyes");
    expect((await repo.readMeta(nb)).paper).toEqual({ TP: "quadrille", Cours: "seyes" });
    await repo.renameDivider(nb, "TP", "Travaux");
    expect((await repo.readMeta(nb)).paper).toEqual({ Travaux: "quadrille", Cours: "seyes" });
    // Retour a « uni » : l'entree part, puis le champ entier.
    await repo.setPaper(nb, "Travaux", "uni");
    await repo.setPaper(nb, "Cours", "uni");
    const raw = await fs.readText(`${nb}/cahier.json`);
    expect(JSON.parse(raw).paper).toBeUndefined();
  });

  it("un fond inconnu (version plus recente) est garde tel quel", async () => {
    const nb = await repo.createNotebook("Elec", "#000");
    await repo.createDivider(nb, "Cours");
    const raw = JSON.parse(await fs.readText(`${nb}/cahier.json`));
    raw.paper = { Cours: "hexagones" };
    await fs.writeText(`${nb}/cahier.json`, JSON.stringify(raw));
    await repo.setViewMode(nb, "Cours", "scroll");
    expect((await repo.readMeta(nb)).paper).toEqual({ Cours: "hexagones" });
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
    // La photo est posee dans le texte : son OCR compte.
    const img = uuid();
    page.blocks.push(
      { id: uuid(), type: "text", content: `Critère de Riemann ![](img:${img})` },
      { id: uuid(), type: "math", mode: "math", strokes: [], latex: "\\int_0^{+\\infty} e^{-x}" },
      { id: img, type: "image", src: "assets/a.png", ocr: "photo du tableau" },
    );
    await repo.writePage(nb, "Cours", n, page);

    expect(await searchAll(repo, "riemann")).toHaveLength(1);
    // Le LaTeX est relu en texte : \infty se cherche « infini ».
    expect(await searchAll(repo, "infini")).toHaveLength(1);
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

describe("matieres et cahier.json (nav-10, nav-13, donnees-14)", () => {
  it("lire le menu et les intercalaires n'ecrit aucun cahier.json", async () => {
    await fs.mkdir("Docs pour ESEO/Stage");
    await fs.mkdir("Maths/Cours");
    await fs.writeText("Maths/Cours/0001.page.json", "{}");
    await fs.mkdir("Maths/Exos");
    await repo.listNotebooks();
    await repo.listDividers("Maths");
    expect(await fs.exists("Maths/cahier.json")).toBe(false);
    expect(await fs.exists("Docs pour ESEO/cahier.json")).toBe(false);
    expect(await repo.listDividers("Maths")).toEqual(["Cours", "Exos"]);
  });

  it("une matiere = cahier.json ou des pages ; le reste va dans Autres dossiers", async () => {
    await repo.createNotebook("Maths", "#000");
    await fs.mkdir("Rapports/2025");
    await fs.writeText("Rapports/2025/rapport.pdf", "x");
    await fs.mkdir("Elec/E3A/S1");
    await fs.writeText("Elec/E3A/S1/0001.page.json", "{}");
    const { notebooks, others } = await repo.classifyRoot();
    expect(notebooks).toEqual(expect.arrayContaining(["Maths", "Elec", "Vrac"]));
    expect(others).toEqual([{ dir: "Rapports", git: false }]);
  });

  it("un depot git n'est jamais une matiere, meme avec un cahier.json", async () => {
    await fs.mkdir("C/.git");
    await fs.writeText("C/cahier.json", JSON.stringify({ version: 1, title: "C", color: "#000", dividers: ["TD1"] }));
    await fs.mkdir("C/TD1");
    const { notebooks, others } = await repo.classifyRoot();
    expect(notebooks).not.toContain("C");
    expect(others).toEqual([{ dir: "C", git: true }]);
    expect(await repo.listDividers("C")).toEqual(["TD1"]);
  });

  it("un depot git ne devient jamais une matiere (creation ou adoption)", async () => {
    await fs.mkdir("cahiers/.git");
    await expect(repo.createNotebook("Cahiers", "#000")).rejects.toThrow(/git/);
    await expect(repo.adoptNotebook("cahiers", "#000")).rejects.toThrow(/git/);
    expect(await fs.exists("cahiers/cahier.json")).toBe(false);
  });

  it("Vrac reste en dernier, quel que soit l'ordre des dates", async () => {
    const a = await repo.createNotebook("Algebre", "#000");
    await repo.createDivider(a, "Cours");
    await repo.createPage(a, "Cours");
    await new Promise((r) => setTimeout(r, 5));
    await repo.createPage("Vrac", "Notes");
    const list = await repo.listNotebooks();
    expect(list[list.length - 1].dir).toBe("Vrac");
    expect(list[0].dir).toBe(a);
  });

  it("garde les champs inconnus de cahier.json (version plus recente)", async () => {
    await fs.writeText("Maths/cahier.json", JSON.stringify({
      version: 1, title: "Maths", color: "#111", dividers: [], fondDePage: { Cours: "seyes" },
    }));
    await repo.createDivider("Maths", "Cours");
    const raw = JSON.parse(await fs.readText("Maths/cahier.json"));
    expect(raw.fondDePage).toEqual({ Cours: "seyes" });
    expect(raw.dividers).toEqual(["Cours"]);
  });

  it("deux mises a jour de cahier.json en meme temps ne se perdent pas", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    for (const d of ["Cours", "Exos", "TD"]) await repo.createDivider(nb, d);
    await Promise.all([
      repo.setViewMode(nb, "Cours", "scroll"),
      repo.reorderDividers(nb, ["TD", "Cours", "Exos"]),
      repo.setNotebookColor(nb, "#dc2626"),
      repo.renameDivider(nb, "Exos", "Exercices"),
    ]);
    const meta = await repo.readMeta(nb);
    expect(meta.viewMode?.Cours).toBe("scroll");
    expect(meta.dividers).toEqual(["TD", "Cours", "Exercices"]);
    expect(meta.color).toBe("#dc2626");
  });

  it("recreer une matiere existante ne la remet pas a zero", async () => {
    const nb = await repo.createNotebook("Maths", "#2563eb");
    await repo.createDivider(nb, "Cours");
    await repo.createDivider(nb, "TD");
    await repo.reorderDividers(nb, ["TD", "Cours"]);
    await repo.setViewMode(nb, "Cours", "scroll");
    expect(await repo.createNotebook("maths", "#0891b2")).toBe(nb);
    const meta = await repo.readMeta(nb);
    expect(meta.color).toBe("#2563eb");
    expect(meta.dividers).toEqual(["TD", "Cours"]);
    expect(meta.viewMode?.Cours).toBe("scroll");
  });

  it("en faire une matiere : le dossier recoit son cahier.json", async () => {
    await fs.mkdir("MOOC/Semaine 1");
    expect(await repo.findDir("mooc")).toBe("MOOC");
    await repo.adoptNotebook("MOOC", "#059669", "MOOC IA");
    const meta = await repo.readMeta("MOOC");
    expect(meta.title).toBe("MOOC IA");
    expect(meta.color).toBe("#059669");
    expect(await repo.listNotebookDirs()).toContain("MOOC");
  });

  it("renomme une matiere : titre et dossier, refuse un nom pris", async () => {
    const nb = await repo.createNotebook("Elec", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createPage(nb, "Cours");
    const next = await repo.renameNotebook(nb, "Électronique");
    expect(next).toBe("Électronique");
    expect(await fs.exists("Elec")).toBe(false);
    expect(await repo.listPageNumbers(next, "Cours")).toEqual([1]);
    expect((await repo.readMeta(next)).title).toBe("Électronique");
    await repo.createNotebook("Maths", "#000");
    await expect(repo.renameNotebook(next, "maths")).rejects.toThrow();
    // Changement de casse seul : le dossier suit.
    expect(await repo.renameNotebook(next, "ÉLECTRONIQUE")).toBe("ÉLECTRONIQUE");
  });

  it("supprime une matiere vers la corbeille, puis la restaure", async () => {
    const nb = await repo.createNotebook("Info", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createPage(nb, "Cours");
    const entry = await repo.deleteNotebook(nb);
    expect(entry.kind).toBe("notebook");
    expect(await repo.listNotebookDirs()).not.toContain(nb);
    expect(await fs.exists(`${entry.bin}/${nb}/Cours/0001.page.json`)).toBe(true);
    expect(await repo.restoreNotebook(entry)).toBe(nb);
    expect(await repo.listPageNumbers(nb, "Cours")).toEqual([1]);
    await expect(repo.deleteNotebook("Vrac")).rejects.toThrow();
  });

  it("propose de ranger les matieres sans page, et le cahier.json part a la corbeille", async () => {
    await fs.writeText("Docs/cahier.json", JSON.stringify({ version: 1, title: "Docs", color: "#000", dividers: [] }));
    await fs.mkdir("Docs/Stage");
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    await repo.createPage(nb, "Cours");
    const list = await repo.listNotebooks();
    expect(await repo.pagelessNotebooks(list)).toEqual(["Docs"]);
    const entry = await repo.unmarkNotebook("Docs");
    expect(await fs.exists("Docs/cahier.json")).toBe(false);
    expect(await fs.exists("Docs/Stage")).toBe(true);
    expect((await new Repo(fs).classifyRoot()).others.map((o) => o.dir)).toContain("Docs");
    await repo.restoreMeta(entry);
    expect(await fs.exists("Docs/cahier.json")).toBe(true);
  });

  it("sous-dossiers d'un intercalaire (rangement a 3 niveaux)", async () => {
    await fs.mkdir("Elec/E3A/S1/Chapitre 1");
    await fs.mkdir("Elec/E3A/assets");
    expect(await repo.listSubfolders("Elec", "E3A")).toEqual(["S1"]);
  });

  it("une page d'une version plus recente n'est jamais reecrite", async () => {
    const nb = await repo.createNotebook("Maths", "#000");
    await repo.createDivider(nb, "Cours");
    const n = await repo.createPage(nb, "Cours");
    const future = JSON.stringify({ version: 2, id: "x", created: "", modified: "", blocks: [], nouveau: true });
    await fs.writeText(`${nb}/Cours/0001.page.json`, future);
    const page = await repo.readPage(nb, "Cours", n);
    await expect(repo.writePage(nb, "Cours", n, page)).rejects.toThrow(/plus récente/);
    expect(await fs.readText(`${nb}/Cours/0001.page.json`)).toBe(future);
  });
});
