import { describe, it, expect, beforeEach } from "vitest";
import {
  mergeInk, othersPresent, parseConflictName, parsePresence, presenceAgo, presenceFileName,
  isPresenceFile, renumberConflictName, PRESENCE_TTL_MS,
} from "../core/sync";
import { MemoryFs } from "../core/storage/fs";
import { Repo, TRASH_DIR } from "../core/storage/repo";
import { parsePageNumber, type Page, type Stroke } from "../core/types";

const stroke = (id: string, y = 10): Stroke => ({
  id, color: "normal", width: 2, tool: "pen",
  points: [{ x: 10, y, p: 0.5, t: 0 }, { x: 20, y, p: 0.5, t: 8 }],
});

const page = (blocks: Page["blocks"], extra: Partial<Page> = {}): Page => ({
  version: 1, id: "p1", created: "2026-10-01T08:00:00.000Z", modified: "2026-10-01T08:00:00.000Z",
  blocks, ...extra,
});

describe("copies de conflit OneDrive", () => {
  it("reconnait le nom que OneDrive donne a la copie", () => {
    expect(parseConflictName("0003.page-LAPTOP-MAX.json")).toEqual({ page: 3, label: "LAPTOP-MAX" });
    expect(parseConflictName("0012.page-PC-FIXE-2.json")).toEqual({ page: 12, label: "PC-FIXE-2" });
  });

  it("traite les variantes de copie comme des copies", () => {
    expect(parseConflictName("0003.page - Copie.json")?.label).toBe("Copie");
    expect(parseConflictName("0003.page (1).json")?.label).toBe("1");
    expect(parseConflictName("0003.page_DESKTOP.json")?.page).toBe(3);
  });

  it("ne prend jamais une page normale ni un autre fichier pour une copie", () => {
    expect(parseConflictName("0003.page.json")).toBeNull();
    expect(parseConflictName("cahier.json")).toBeNull();
    expect(parseConflictName("0003.page.tmp-write")).toBeNull();
    expect(parseConflictName("cahier-LAPTOP.json")).toBeNull();
    expect(parseConflictName("0003.pageX.json")).toBeNull();
  });

  it("une copie n'est jamais une page (numerotation intacte)", () => {
    expect(parsePageNumber("0003.page-LAPTOP-MAX.json")).toBeNull();
  });

  it("renumerote une copie en gardant son origine", () => {
    expect(renumberConflictName("0003.page-LAPTOP-MAX.json", 4)).toBe("0004.page-LAPTOP-MAX.json");
    expect(renumberConflictName("0010.page (1).json", 9)).toBe("0009.page (1).json");
  });
});

describe("fusion de l'encre par id de trait", () => {
  it("reprend les traits absents du fond de page, sans doublon", () => {
    const mine = page([{ id: "ink", type: "ink", mode: "raw", recognized: null, strokes: [stroke("a"), stroke("b")] }]);
    const other = page([{ id: "ink", type: "ink", mode: "raw", recognized: null, strokes: [stroke("a"), stroke("c")] }]);
    const r = mergeInk(mine, other);
    expect(r.added).toBe(1);
    const ink = r.blocks[0];
    expect(ink.type === "ink" && ink.strokes.map((s) => s.id)).toEqual(["a", "b", "c"]);
    // La page d'origine n'est pas touchee : l'annulation la garde intacte.
    expect(mine.blocks[0].type === "ink" && mine.blocks[0].strokes.length).toBe(2);
  });

  it("rejoint le fond de page meme si chaque PC a cree le sien", () => {
    const mine = page([{ id: "ink-A", type: "ink", mode: "raw", recognized: null, strokes: [stroke("a")] }]);
    const other = page([{ id: "ink-B", type: "ink", mode: "raw", recognized: null, strokes: [stroke("z")] }]);
    const r = mergeInk(mine, other);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].type === "ink" && r.blocks[0].strokes.map((s) => s.id)).toEqual(["a", "z"]);
  });

  it("ne duplique pas un trait deplace dans une zone math", () => {
    const mine = page([
      { id: "ink", type: "ink", mode: "raw", recognized: null, strokes: [] },
      { id: "m", type: "math", mode: "math", latex: "x", strokes: [stroke("a")], rect: { x: 0, y: 0, w: 50, h: 20 } },
    ]);
    const other = page([{ id: "ink", type: "ink", mode: "raw", recognized: null, strokes: [stroke("a")] }]);
    expect(mergeInk(mine, other).added).toBe(0);
  });

  it("ajoute une zone math absente, avec sa lecture si tous ses traits sont nouveaux", () => {
    const mine = page([]);
    const other = page([{ id: "m", type: "math", mode: "math", latex: "\\int", strokes: [stroke("s1"), stroke("s2")], rect: { x: 0, y: 0, w: 9, h: 9 } }]);
    const r = mergeInk(mine, other);
    expect(r.added).toBe(2);
    const m = r.blocks[0];
    expect(m.type === "math" && m.latex).toBe("\\int");
  });

  it("une zone a moitie connue repart a la reconnaissance", () => {
    const mine = page([{ id: "ink", type: "ink", mode: "raw", recognized: null, strokes: [stroke("s1")] }]);
    const other = page([{ id: "m", type: "math", mode: "math", latex: "\\int", strokes: [stroke("s1"), stroke("s2")], rect: { x: 0, y: 0, w: 9, h: 9 } }]);
    const r = mergeInk(mine, other);
    const m = r.blocks.find((b) => b.id === "m");
    expect(m?.type === "math" && m.latex).toBeNull();
    expect(m?.type === "math" && m.pending).toBe(true);
    expect(m?.type === "math" && m.strokes.map((s) => s.id)).toEqual(["s2"]);
  });

  it("un bloc deja reconnu qui recoit des traits repasse en attente", () => {
    const mine = page([{ id: "m", type: "math", mode: "math", latex: "x", strokes: [stroke("a")] }]);
    const other = page([{ id: "m", type: "math", mode: "math", latex: "x+1", strokes: [stroke("a"), stroke("b")] }]);
    const m = mergeInk(mine, other).blocks[0];
    expect(m.type === "math" && m.pending).toBe(true);
    expect(m.type === "math" && m.latex).toBe("x");
  });

  it("garde la hauteur de feuille de la copie si elle a de l'encre plus bas", () => {
    const mine = page([{ id: "ink", type: "ink", mode: "raw", recognized: null, strokes: [] }]);
    const other = page([{ id: "ink", type: "ink", mode: "raw", recognized: null, strokes: [stroke("low", 1500)] }], { height: 1600 });
    expect(mergeInk(mine, other).height).toBe(1600);
  });

  it("ne fusionne pas le texte tape mais le signale", () => {
    const mine = page([{ id: "t", type: "text", content: "Cours du lundi" }]);
    const other = page([{ id: "t", type: "text", content: "Cours du lundi, suite" }]);
    const r = mergeInk(mine, other);
    expect(r.added).toBe(0);
    expect(r.textDiffers).toBe(true);
    expect(r.blocks[0].type === "text" && r.blocks[0].content).toBe("Cours du lundi");
  });

  it("supporte une copie abimee (blocs absents)", () => {
    const r = mergeInk(page([]), { ...page([]), blocks: undefined as never });
    expect(r.added).toBe(0);
  });
});

describe("presence sur l'autre PC", () => {
  const now = Date.parse("2026-10-01T10:00:00.000Z");
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

  it("un fichier par machine, au nom sans caractere douteux", () => {
    expect(presenceFileName("LAPTOP-MAX")).toBe(".presence-LAPTOP-MAX.json");
    expect(presenceFileName("PC de Max")).toBe(".presence-PC_de_Max.json");
    expect(isPresenceFile(".presence-LAPTOP-MAX.json")).toBe(true);
    expect(isPresenceFile("cahier.json")).toBe(false);
  });

  it("ignore cette machine et les presences perimees", () => {
    const r = othersPresent([
      { machine: "PORTABLE", at: at(1) },
      { machine: "FIXE", at: at(30) },
    ], "portable", now);
    expect(r).toEqual([]);
  });

  it("voit l'autre PC rafraichi recemment, le plus recent d'abord", () => {
    const r = othersPresent([
      { machine: "FIXE", at: at(12) },
      { machine: "TABLETTE", at: at(2) },
      null,
    ], "PORTABLE", now);
    expect(r.map((o) => o.machine)).toEqual(["TABLETTE", "FIXE"]);
    expect(presenceAgo(r[0].age)).toBe("il y a 2 min");
  });

  it("perime exactement a 15 min", () => {
    expect(othersPresent([{ machine: "FIXE", at: new Date(now - PRESENCE_TTL_MS).toISOString() }], "P", now)).toEqual([]);
  });

  it("tolere une horloge un peu en avance, pas une date absurde", () => {
    expect(othersPresent([{ machine: "FIXE", at: at(-3) }], "P", now)[0]?.age).toBe(0);
    expect(othersPresent([{ machine: "FIXE", at: at(-600) }], "P", now)).toEqual([]);
  });

  it("lit un fichier de presence sans se fier a son contenu", () => {
    expect(parsePresence('{"machine":"FIXE","at":"2026-10-01T09:58:00.000Z"}')?.machine).toBe("FIXE");
    expect(parsePresence("{")).toBeNull();
    expect(parsePresence('{"machine":"FIXE","at":"hier"}')).toBeNull();
    expect(presenceAgo(20_000)).toBe("à l'instant");
  });
});

describe("copies de conflit sur le disque", () => {
  let fs: MemoryFs;
  let repo: Repo;
  const write = (rel: string, id: string) => fs.writeText(rel, JSON.stringify(page([], { id })));

  beforeEach(async () => {
    fs = new MemoryFs();
    repo = new Repo(fs);
    await repo.ensureRootLayout();
    for (let i = 1; i <= 3; i++) await write(`Maths/Cours/000${i}.page.json`, `p${i}`);
    await write("Maths/Cours/0002.page-LAPTOP-MAX.json", "p2");
  });

  it("liste les copies a part, jamais comme pages", async () => {
    expect(await repo.listPageNumbers("Maths", "Cours")).toEqual([1, 2, 3]);
    expect(await repo.listConflicts("Maths", "Cours")).toEqual([
      { file: "0002.page-LAPTOP-MAX.json", page: 2, label: "LAPTOP-MAX", orphan: false },
    ]);
    expect((await repo.countConflicts("Maths")).get("Cours")).toBe(1);
  });

  it("une insertion avant la page decale aussi sa copie", async () => {
    await repo.createPage("Maths", "Cours", 1);
    expect(await fs.exists("Maths/Cours/0003.page-LAPTOP-MAX.json")).toBe(true);
    expect(JSON.parse(await fs.readText("Maths/Cours/0003.page.json")).id).toBe("p2");
  });

  it("une suppression avant la page decale sa copie, et la page supprimee emporte la sienne", async () => {
    await repo.deletePage("Maths", "Cours", 1);
    expect((await repo.listConflicts("Maths", "Cours"))[0].file).toBe("0001.page-LAPTOP-MAX.json");
    const entry = await repo.deletePage("Maths", "Cours", 1);
    expect(entry.copies).toEqual(["0001.page-LAPTOP-MAX.json"]);
    expect(await repo.listConflicts("Maths", "Cours")).toEqual([]);
    // « Annuler » remet la page et sa copie, au meme numero.
    await repo.restorePage(entry);
    expect(await fs.exists("Maths/Cours/0001.page-LAPTOP-MAX.json")).toBe(true);
  });

  it("supprimer une copie la met a la corbeille, et Annuler la remet", async () => {
    const entry = await repo.trashConflict("Maths", "Cours", "0002.page-LAPTOP-MAX.json");
    expect(entry.bin.startsWith(TRASH_DIR)).toBe(true);
    expect(await fs.exists(`${entry.bin}/Maths/Cours/0002.page-LAPTOP-MAX.json`)).toBe(true);
    expect(await repo.listConflicts("Maths", "Cours")).toEqual([]);
    await repo.restoreConflict(entry);
    expect((await repo.listConflicts("Maths", "Cours")).length).toBe(1);
  });

  it("refuse de traiter une vraie page comme une copie", async () => {
    await expect(repo.trashConflict("Maths", "Cours", "0002.page.json")).rejects.toThrow();
    await expect(repo.readConflict("Maths", "Cours", "0002.page.json")).rejects.toThrow();
  });

  it("une copie sans page devient une page en fin d'intercalaire", async () => {
    await write("Maths/Cours/0007.page-FIXE.json", "p7");
    const orphan = (await repo.listConflicts("Maths", "Cours")).find((c) => c.page === 7);
    expect(orphan?.orphan).toBe(true);
    const n = await repo.adoptConflict("Maths", "Cours", "0007.page-FIXE.json");
    expect(n).toBe(4);
    expect(await repo.listPageNumbers("Maths", "Cours")).toEqual([1, 2, 3, 4]);
  });

  it("une nouvelle page en fin ne prend pas le numero d'une copie seule", async () => {
    await write("Maths/Cours/0004.page-FIXE.json", "p4");
    expect(await repo.createPage("Maths", "Cours")).toBe(4);
    // La copie seule s'est poussee : elle ne s'accroche pas a la page neuve.
    expect(await fs.exists("Maths/Cours/0005.page-FIXE.json")).toBe(true);
  });
});
