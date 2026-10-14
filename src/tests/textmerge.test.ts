import { describe, it, expect } from "vitest";
import { diffLines, merge3 } from "../core/textmerge";
import { MemoryFs } from "../core/storage/fs";
import { Repo, serializePage } from "../core/storage/repo";
import { diskBaseOf, hashText, mergeText } from "../core/writeguard";
import type { Block, Page, Stroke } from "../core/types";

const L = (...l: string[]) => l.join("\n");

describe("fusion a trois du texte (merge3)", () => {
  const base = L("# Cours", "Ligne 1", "Ligne 2", "Ligne 3", "Ligne 4");

  it("un seul cote change : on prend ce cote", () => {
    const o = L("# Cours", "Ligne 1 bis", "Ligne 2", "Ligne 3", "Ligne 4");
    expect(merge3(base, o, base)).toBe(o);
    expect(merge3(base, base, o)).toBe(o);
    expect(merge3(base, o, o)).toBe(o);
  });

  it("lignes differentes changees des deux cotes : les deux changements", () => {
    const o = L("# Cours", "Ligne 1 portable", "Ligne 2", "Ligne 3", "Ligne 4");
    const t = L("# Cours", "Ligne 1", "Ligne 2", "Ligne 3", "Ligne 4 fixe");
    expect(merge3(base, o, t)).toBe(L("# Cours", "Ligne 1 portable", "Ligne 2", "Ligne 3", "Ligne 4 fixe"));
  });

  it("ajout en fin des deux cotes : les deux gardes, le notre d'abord", () => {
    const o = L(base, "Portable");
    const t = L(base, "Fixe");
    expect(merge3(base, o, t)).toBe(L(base, "Portable", "Fixe"));
  });

  it("le meme ajout des deux cotes : une seule fois", () => {
    const o = L(base, "Pareil");
    expect(merge3(base, o, o)).toBe(o);
    const t = L("# Cours", "Ligne 1 fixe", "Ligne 2", "Ligne 3", "Ligne 4", "Pareil");
    expect(merge3(base, o, t)).toBe(L("# Cours", "Ligne 1 fixe", "Ligne 2", "Ligne 3", "Ligne 4", "Pareil"));
  });

  it("la meme ligne changee differemment : pas de fusion", () => {
    const o = L("# Cours", "Ligne 1 portable", "Ligne 2", "Ligne 3", "Ligne 4");
    const t = L("# Cours", "Ligne 1 fixe", "Ligne 2", "Ligne 3", "Ligne 4");
    expect(merge3(base, o, t)).toBeNull();
  });

  it("ligne supprimee d'un cote, modifiee de l'autre : pas de fusion", () => {
    const o = L("# Cours", "Ligne 1", "Ligne 3", "Ligne 4");
    const t = L("# Cours", "Ligne 1", "Ligne 2 corrigee", "Ligne 3", "Ligne 4");
    expect(merge3(base, o, t)).toBeNull();
  });

  it("ajout juste avant une ligne que l'autre change : ambigu, pas de fusion", () => {
    const o = L("# Cours", "Ligne 1", "Nouvelle", "Ligne 2", "Ligne 3", "Ligne 4");
    const t = L("# Cours", "Ligne 1", "Ligne 2 corrigee", "Ligne 3", "Ligne 4");
    expect(merge3(base, o, t)).toBeNull();
  });

  it("aucun texte perdu sur des changements disjoints au hasard", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 200; k++) {
      const b = Array.from({ length: 20 }, (_, i) => `l${i}`);
      const o = [...b], t = [...b];
      const i = rnd(9), j = 10 + rnd(9);
      o[i] = `o${k}`;
      t[j] = `t${k}`;
      if (rnd(2)) o.splice(i + 1, 0, `oa${k}`);
      if (rnd(2)) t.splice(j + 2, 0, `ta${k}`);
      const m = merge3(b.join("\n"), o.join("\n"), t.join("\n"));
      expect(m).not.toBeNull();
      const lines = m!.split("\n");
      for (const x of [...o, ...t]) if (!b.includes(x)) expect(lines).toContain(x);
      expect(lines).not.toContain(`l${i}`);
      expect(lines).not.toContain(`l${j}`);
    }
  });

  it("diffLines : morceaux de la base remplaces", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([{ start: 1, end: 2, lines: ["x"] }]);
    expect(diffLines(["a", "b"], ["a", "b", "c"])).toEqual([{ start: 2, end: 2, lines: ["c"] }]);
    expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual([{ start: 1, end: 2, lines: [] }]);
  });
});

const stroke = (id: string): Stroke => ({
  id, color: "normal", width: 2, tool: "pen",
  points: [{ x: 10, y: 10, p: 0.5, t: 0 }, { x: 20, y: 10, p: 0.5, t: 8 }],
});
const text = (content: string): Block => ({ id: "txt", type: "text", content });
const page = (blocks: Block[]): Page => ({
  version: 2, id: "p1", created: "2026-10-01T08:00:00.000Z", modified: "2026-10-01T08:00:00.000Z", blocks,
});
const bodyText = (p: Page) => (p.blocks.find((b) => b.type === "text") as { content: string }).content;

describe("mergeText : page modifiee sur les deux PC", () => {
  it("texte fusionne, encre des deux cotes reunie", () => {
    const base = page([text(L("A", "B", "C"))]);
    const b = diskBaseOf(base, "h");
    const ours = page([text(L("A portable", "B", "C")), { id: "i1", type: "ink", mode: "raw", recognized: null, strokes: [stroke("s1")] }]);
    const disk = page([text(L("A", "B", "C", "D fixe")), { id: "i2", type: "ink", mode: "raw", recognized: null, strokes: [stroke("s2")] }]);
    const m = mergeText(b, ours, disk);
    expect(m).not.toBeNull();
    expect(bodyText(m!.page)).toBe(L("A portable", "B", "C", "D fixe"));
    const ids = m!.page.blocks.flatMap((x) => (x.type === "ink" ? x.strokes.map((s) => s.id) : []));
    expect(ids.sort()).toEqual(["s1", "s2"]);
  });

  it("photo ajoutee sur l'autre PC + texte tape ici : la photo et les deux textes", () => {
    const base = page([text(L("A", "B"))]);
    const b = diskBaseOf(base, "h");
    const ours = page([text(L("A", "B", "ici"))]);
    const disk = page([text(L("![](img:P)", "A", "B")), { id: "P", type: "image", src: "assets/P.png", ocr: null }]);
    const m = mergeText(b, ours, disk)!;
    expect(bodyText(m.page)).toBe(L("![](img:P)", "A", "B", "ici"));
    expect(m.page.blocks.some((x) => x.id === "P")).toBe(true);
  });

  it("le disque retire ou change une ligne (ancienne version ?) : pas de fusion, rien ne disparait", () => {
    const b = diskBaseOf(page([text(L("A", "B", "C"))]), "h");
    const ours = page([text(L("A", "B", "C", "D ici"))]);
    expect(mergeText(b, ours, page([text(L("A", "C"))]))).toBeNull();
    expect(mergeText(b, ours, page([text(L("A", "B corrige", "C"))]))).toBeNull();
    // Une ligne vide retiree ne compte pas.
    const b2 = diskBaseOf(page([text(L("A", "", "C"))]), "h");
    expect(mergeText(b2, page([text(L("A", "", "C", "D"))]), page([text(L("A", "C"))]))).not.toBeNull();
  });

  it("autre chose que le texte change des deux cotes : pas de fusion", () => {
    const base = page([text("A")]);
    const b = diskBaseOf(base, "h");
    const ours = page([text(L("A", "x")), { id: "P", type: "image", src: "assets/P.png", ocr: null }]);
    const disk = page([text(L("y", "A")), { id: "Q", type: "image", src: "assets/Q.png", ocr: null }]);
    expect(mergeText(b, ours, disk)).toBeNull();
  });

  it("sans base connue : pas de fusion", () => {
    expect(mergeText(null, page([text("a")]), page([text("b")]))).toBeNull();
  });
});

describe("Repo : ecriture qui trouve le texte change ailleurs", () => {
  it("lignes differentes : texte reuni sur le disque, pas de copie de conflit", async () => {
    const fs = new MemoryFs();
    const repo = new Repo(fs);
    await repo.createNotebook("Maths", "#2563eb");
    await repo.createDivider("Maths", "Cours");
    await repo.createPage("Maths", "Cours", undefined, page([text(L("# TD", "Exo 1", "Exo 2"))]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    await fs.writeText("Maths/Cours/0001.page.json", serializePage(page([text(L("# TD", "Exo 1", "Exo 2", "Exo 3 (fixe)"))])));
    (mine.blocks[0] as { content: string }).content = L("# TD", "Exo 1 : fait au portable", "Exo 2");
    const out = await repo.writePage("Maths", "Cours", 1, mine);
    expect(out.kind).toBe("replaced");
    if (out.kind !== "replaced") return;
    expect(out.textMerged).toBe(true);
    expect(bodyText(out.page)).toBe(L("# TD", "Exo 1 : fait au portable", "Exo 2", "Exo 3 (fixe)"));
    const onDisk = JSON.parse(await fs.readText("Maths/Cours/0001.page.json")) as Page;
    expect(bodyText(onDisk)).toBe(L("# TD", "Exo 1 : fait au portable", "Exo 2", "Exo 3 (fixe)"));
    expect(await fs.listFiles("Maths/Cours")).toEqual(["0001.page.json"]);
    // La page relue s'ecrit ensuite sans conflit.
    const again = await repo.readPage("Maths", "Cours", 1);
    expect((await repo.writePage("Maths", "Cours", 1, again)).kind).toBe("written");
    expect(hashText("x")).toBeTruthy();
  });
});
