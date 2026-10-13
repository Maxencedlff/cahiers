import { describe, it, expect, vi, afterEach } from "vitest";
import { BrowserFs, MemoryFs, type CondWrite, type FileStamp } from "../core/storage/fs";
import { META_BAK, Repo, TRASH_DIR, serializePage } from "../core/storage/repo";
import { parseConflictName } from "../core/sync";
import { parsePageNumber, type Block, type Page, type Stroke } from "../core/types";
import {
  conflictCopyName, contentKey, hashText, machineTag, mergedPage, planExternal,
} from "../core/writeguard";
import {
  KEEP_MS, SNAPSHOT_EVERY_MS, parseStamp, parseVersionName, planVersionPurge, shouldSnapshot,
  stampOf, trashToPurge, versionFileName, versionLabel,
} from "../core/versions";
import { commitPull, textComesBack } from "../core/flowguard";

const stroke = (id: string, y = 10): Stroke => ({
  id, color: "normal", width: 2, tool: "pen",
  points: [{ x: 10, y, p: 0.5, t: 0 }, { x: 20, y, p: 0.5, t: 8 }],
});

const ink = (...ids: string[]): Block => ({ id: "ink", type: "ink", mode: "raw", recognized: null, strokes: ids.map((i) => stroke(i)) });
const text = (content: string): Block => ({ id: "txt", type: "text", content });

const page = (id: string, blocks: Block[], extra: Partial<Page> = {}): Page => ({
  version: 2, id, created: "2026-10-01T08:00:00.000Z", modified: "2026-10-01T08:00:00.000Z", blocks, ...extra,
});

const strokeIds = (p: Page): string[] => p.blocks.flatMap((b) => (b.type === "ink" ? b.strokes.map((s) => s.id) : []));
const bodyOf = (p: Page): string => (p.blocks.find((b) => b.type === "text") as { content: string } | undefined)?.content ?? "";

/** Matiere « Maths », intercalaire « Cours », pages donnees (1, 2, ...). */
async function setup(...pages: Page[]): Promise<{ fs: MemoryFs; repo: Repo }> {
  const fs = new MemoryFs();
  const repo = new Repo(fs);
  await repo.createNotebook("Maths", "#2563eb");
  await repo.createDivider("Maths", "Cours");
  for (const p of pages) await repo.createPage("Maths", "Cours", undefined, p);
  return { fs, repo };
}

/** L'autre PC (OneDrive) ecrit la page n directement sur le disque. */
async function external(fs: MemoryFs, n: number, p: Page): Promise<void> {
  await fs.writeText(`Maths/Cours/${String(n).padStart(4, "0")}.page.json`, serializePage(p));
}

async function disk(fs: MemoryFs, file: string): Promise<Page> {
  return JSON.parse(await fs.readText(`Maths/Cours/${file}`)) as Page;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("ecriture conditionnelle des pages (R1)", () => {
  it("ecrit normalement une page inchangee sur le disque", async () => {
    const { fs, repo } = await setup(page("p1", [text("A"), ink("a")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    (mine.blocks[1] as { strokes: Stroke[] }).strokes.push(stroke("b"));
    expect(await repo.writePage("Maths", "Cours", 1, mine)).toEqual({ kind: "written", n: 1 });
    expect(await repo.writePage("Maths", "Cours", 1, mine)).toEqual({ kind: "written", n: 1 });
    expect(strokeIds(await repo.readPage("Maths", "Cours", 1))).toEqual(["a", "b"]);
    expect(await fs.listFiles("Maths/Cours")).toEqual(["0001.page.json"]);
  });

  it("fichier seulement touche (meme contenu) : pas un conflit", async () => {
    const { fs, repo } = await setup(page("p1", [text("A")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    const raw = await fs.readText("Maths/Cours/0001.page.json");
    await fs.writeText("Maths/Cours/0001.page.json", raw); // nouvelle date, meme contenu
    (mine.blocks[0] as { content: string }).content = "A et B";
    expect((await repo.writePage("Maths", "Cours", 1, mine)).kind).toBe("written");
    expect(bodyOf(await disk(fs, "0001.page.json"))).toBe("A et B");
  });

  it("encre ajoutee ailleurs, texte change ici : les deux sont gardes (fusion)", async () => {
    const { fs, repo } = await setup(page("p1", [text("A"), ink("a")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    await external(fs, 1, page("p1", [text("A"), ink("a", "z")]));
    (mine.blocks[0] as { content: string }).content = "A modifie ici";
    const out = await repo.writePage("Maths", "Cours", 1, mine);
    expect(out.kind).toBe("merged");
    const onDisk = await disk(fs, "0001.page.json");
    expect(bodyOf(onDisk)).toBe("A modifie ici");
    expect(onDisk.blocks.flatMap((b) => (b.type === "ink" ? (b.strokes as unknown as { id: string }[]).map((s) => s.id) : []))).toEqual(["a", "z"]);
    // La page de la vue, une fois l'encre du disque reprise, s'ecrit sans nouveau conflit.
    expect(out.kind === "merged" && out.added).toBe(1);
    expect((await repo.writePage("Maths", "Cours", 1, mine)).kind).toBe("written");
    expect(await fs.listFiles("Maths/Cours")).toEqual(["0001.page.json"]);
  });

  it("texte change ailleurs, encre seule ici : page du disque + notre encre", async () => {
    const { fs, repo } = await setup(page("p1", [text("A"), ink("a")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    await external(fs, 1, page("p1", [text("A et la suite tapee sur le PC fixe"), ink("a")]));
    (mine.blocks[1] as { strokes: Stroke[] }).strokes.push(stroke("b"));
    const out = await repo.writePage("Maths", "Cours", 1, mine);
    expect(out.kind).toBe("replaced");
    const onDisk = await repo.readPage("Maths", "Cours", 1);
    expect(bodyOf(onDisk)).toBe("A et la suite tapee sur le PC fixe");
    expect(strokeIds(onDisk)).toEqual(["a", "b"]);
  });

  it("texte change des deux cotes : jamais ecrase, notre version en copie de conflit", async () => {
    const { fs, repo } = await setup(page("p1", [text("A")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    await external(fs, 1, page("p1", [text("A ecrit sur le PC fixe")]));
    (mine.blocks[0] as { content: string }).content = "A ecrit sur le portable";
    const out = await repo.writePage("Maths", "Cours", 1, mine);
    expect(out.kind).toBe("conflict");
    if (out.kind !== "conflict") return;
    expect(out.copy).toBe("0001.page-NAVIGATEUR.json");
    expect(parseConflictName(out.copy)).toEqual({ page: 1, label: "NAVIGATEUR" });
    expect(bodyOf(await disk(fs, "0001.page.json"))).toBe("A ecrit sur le PC fixe");
    expect(bodyOf(await disk(fs, out.copy))).toBe("A ecrit sur le portable");
    expect(out.page && bodyOf(out.page)).toBe("A ecrit sur le PC fixe");
    // Repo la voit comme toute copie OneDrive (bandeau, fusion, corbeille).
    expect((await repo.listConflicts("Maths", "Cours")).map((c) => c.file)).toEqual([out.copy]);
    // La page relue du disque s'ecrit ensuite sans conflit.
    const again = await repo.readPage("Maths", "Cours", 1);
    expect((await repo.writePage("Maths", "Cours", 1, again)).kind).toBe("written");
  });

  it("deux copies de conflit ne s'ecrasent pas", async () => {
    const { fs, repo } = await setup(page("p1", [text("A")]));
    for (const v of ["un", "deux"]) {
      const mine = await repo.readPage("Maths", "Cours", 1);
      await external(fs, 1, page("p1", [text(`autre ${v}`)]));
      (mine.blocks[0] as { content: string }).content = `ici ${v}`;
      await repo.writePage("Maths", "Cours", 1, mine);
    }
    const files = await fs.listFiles("Maths/Cours");
    expect(files).toEqual(["0001.page-NAVIGATEUR-2.json", "0001.page-NAVIGATEUR.json", "0001.page.json"]);
    expect(bodyOf(await disk(fs, "0001.page-NAVIGATEUR.json"))).toBe("ici un");
    expect(bodyOf(await disk(fs, "0001.page-NAVIGATEUR-2.json"))).toBe("ici deux");
  });

  it("fichier tronque (OneDrive pas fini) : jamais ecrase", async () => {
    const { fs, repo } = await setup(page("p1", [text("A")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    await fs.writeText("Maths/Cours/0001.page.json", "{\"version\":2,\"id\":\"p1\",\"blo");
    (mine.blocks[0] as { content: string }).content = "A suite";
    const out = await repo.writePage("Maths", "Cours", 1, mine);
    expect(out.kind === "conflict" && out.page).toBeNull();
    expect(await fs.readText("Maths/Cours/0001.page.json")).toContain("\"blo");
  });

  it("diskChanged : vrai seulement si le contenu a change", async () => {
    const { fs, repo } = await setup(page("p1", [text("A")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    expect(await repo.diskChanged("Maths", "Cours", 1, mine)).toBe(false);
    await fs.writeText("Maths/Cours/0001.page.json", await fs.readText("Maths/Cours/0001.page.json"));
    expect(await repo.diskChanged("Maths", "Cours", 1, mine)).toBe(false);
    await external(fs, 1, page("p1", [text("B")]));
    expect(await repo.diskChanged("Maths", "Cours", 1, mine)).toBe(true);
  });

  it("une lecture pour la recherche ne change rien a la garde de la page ouverte", async () => {
    const { fs, repo } = await setup(page("p1", [text("A")]));
    const mine = await repo.readPage("Maths", "Cours", 1);
    await external(fs, 1, page("p1", [text("autre PC")]));
    await repo.scanDivider("Maths", "Cours");
    await repo.readPage("Maths", "Cours", 1);
    (mine.blocks[0] as { content: string }).content = "ici";
    expect((await repo.writePage("Maths", "Cours", 1, mine)).kind).toBe("conflict");
  });
});

describe("la page visee porte le bon id (R2)", () => {
  it("page renumerotee ailleurs : retrouvee par son id, l'autre page intacte", async () => {
    const { fs, repo } = await setup(page("p1", [text("un")]), page("p2", [text("deux")]));
    const two = await repo.readPage("Maths", "Cours", 2);
    // L'autre PC a insere une page en tete : p1 -> 2, p2 -> 3.
    await fs.rename("Maths/Cours/0002.page.json", "Maths/Cours/0003.page.json");
    await fs.rename("Maths/Cours/0001.page.json", "Maths/Cours/0002.page.json");
    await external(fs, 1, page("p0", [text("inseree")]));
    (two.blocks[0] as { content: string }).content = "deux, suite";
    const out = await repo.writePage("Maths", "Cours", 2, two);
    expect(out).toEqual({ kind: "written", n: 3 });
    expect(bodyOf(await disk(fs, "0002.page.json"))).toBe("un");
    expect(bodyOf(await disk(fs, "0003.page.json"))).toBe("deux, suite");
  });

  it("page supprimee ailleurs : notre version en copie, rien d'ecrase", async () => {
    const { fs, repo } = await setup(page("p1", [text("un")]), page("p2", [text("deux")]));
    const two = await repo.readPage("Maths", "Cours", 2);
    await fs.remove("Maths/Cours/0002.page.json");
    (two.blocks[0] as { content: string }).content = "deux, suite";
    const out = await repo.writePage("Maths", "Cours", 2, two);
    expect(out.kind).toBe("conflict");
    expect(bodyOf(await disk(fs, "0001.page.json"))).toBe("un");
    expect(await fs.exists("Maths/Cours/0002.page.json")).toBe(false);
    expect(out.kind === "conflict" && bodyOf(await disk(fs, out.copy))).toBe("deux, suite");
  });

  it("le renommage n'ecrase jamais une destination", async () => {
    const { fs } = await setup(page("p1", [text("un")]), page("p2", [text("deux")]));
    await expect(fs.rename("Maths/Cours/0001.page.json", "Maths/Cours/0002.page.json")).rejects.toThrow(/existe déjà/);
    expect(bodyOf(await disk(fs, "0001.page.json"))).toBe("un");
    expect(bodyOf(await disk(fs, "0002.page.json"))).toBe("deux");
    // Changement de casse seul : autorise (meme fichier sous Windows).
    await fs.mkdir("Maths/TD");
    await fs.rename("Maths/TD", "Maths/td");
    expect(await fs.exists("Maths/td")).toBe(true);
  });

  it("une page renumerotee par l'appli s'ecrit sans faux conflit", async () => {
    const { repo } = await setup(page("p1", [text("un")]), page("p2", [text("deux")]));
    const two = await repo.readPage("Maths", "Cours", 2);
    await repo.createPage("Maths", "Cours", 1);
    (two.blocks[0] as { content: string }).content = "deux bis";
    expect(await repo.writePage("Maths", "Cours", 3, two)).toEqual({ kind: "written", n: 3 });
  });
});

describe("cahier.json illisible (R5)", () => {
  it("refuse d'ecrire et garde le fichier tel quel", async () => {
    const { fs, repo } = await setup();
    await repo.setViewMode("Maths", "Cours", "pages");
    expect(JSON.parse(await fs.readText(`Maths/${META_BAK}`)).dividers).toEqual(["Cours"]);
    await fs.writeText("Maths/cahier.json", "{\"title\":\"Ma");
    await expect(repo.setNotebookColor("Maths", "#dc2626")).rejects.toThrow(/illisible/);
    expect(await fs.readText("Maths/cahier.json")).toBe("{\"title\":\"Ma");
    // La lecture se replie sur la copie de secours.
    const meta = await repo.readMeta("Maths");
    expect(meta.dividers).toEqual(["Cours"]);
  });

  it("accepte un cahier.json avec BOM", async () => {
    const { fs, repo } = await setup();
    const raw = await fs.readText("Maths/cahier.json");
    await fs.writeText("Maths/cahier.json", "﻿" + raw);
    await repo.setNotebookColor("Maths", "#dc2626");
    expect((await repo.readMeta("Maths")).color).toBe("#dc2626");
  });
});

describe("historique des versions", () => {
  it("rythme, noms et retention", () => {
    const d = new Date(2026, 9, 13, 14, 3, 22, 123);
    expect(stampOf(d)).toBe("2026-10-13_14-03-22-123");
    expect(versionFileName(d)).toBe("2026-10-13_14-03-22-123.json");
    expect(parseVersionName("2026-10-13_14-03-22-123.json")).toBe(d.getTime());
    expect(parseVersionName("2026-10-13_14-03-22-123-2.json")).toBe(d.getTime());
    expect(parseVersionName("notes.json")).toBeNull();
    expect(parseStamp("2026-02-31_10-00-00-000")).toBeNull();
    expect(shouldSnapshot(null, 0)).toBe(true);
    expect(shouldSnapshot(1000, 1000 + SNAPSHOT_EVERY_MS - 1)).toBe(false);
    expect(shouldSnapshot(1000, 1000 + SNAPSHOT_EVERY_MS)).toBe(true);
    const now = new Date(2026, 9, 13, 18, 0).getTime();
    const h = 3600_000, day = 24 * h;
    const times = [
      now - 1 * h, now - 2 * h, now - 20 * h, // dernieres 24 h : gardees
      now - 3 * day, now - 3 * day - h, now - 3 * day - 2 * h, // meme jour : la plus recente
      now - 10 * day, // seule de son jour
      now - 31 * day, now - 40 * day, // trop vieilles
    ];
    expect(planVersionPurge(times, now).sort()).toEqual(
      [now - 3 * day - h, now - 3 * day - 2 * h, now - 31 * day, now - 40 * day].sort());
    // La plus recente reste toujours, meme vieille.
    expect(planVersionPurge([now - 40 * day, now - 50 * day], now)).toEqual([now - 50 * day]);
    expect(versionLabel(now - h, now)).toMatch(/^Aujourd'hui à 17:00$/);
    expect(versionLabel(new Date(2026, 8, 2, 9, 5).getTime(), now)).toBe("2 sept. 2026 à 09:05");
  });

  it("garde l'ancienne version avant d'ecraser, au plus une toutes les 10 min", async () => {
    let now = new Date(2026, 9, 13, 10, 0).getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { fs, repo } = await setup(page("p1", [text("v1")]));
    const p = await repo.readPage("Maths", "Cours", 1);
    const set = (s: string) => { (p.blocks[0] as { content: string }).content = s; };
    set("v2"); await repo.writePage("Maths", "Cours", 1, p);
    now += 60_000;
    set("v3"); await repo.writePage("Maths", "Cours", 1, p);
    let versions = await repo.listVersions("Maths", "p1");
    expect(versions.length).toBe(1);
    expect(bodyOf(await repo.readVersion("Maths", "p1", versions[0].file))).toBe("v1");
    now += SNAPSHOT_EVERY_MS;
    set("v4"); await repo.writePage("Maths", "Cours", 1, p);
    versions = await repo.listVersions("Maths", "p1");
    expect(versions.length).toBe(2);
    expect(bodyOf(await repo.readVersion("Maths", "p1", versions[0].file))).toBe("v3");
    // Le dossier des versions n'est ni un intercalaire ni une page.
    expect(await repo.listDividers("Maths")).toEqual(["Cours"]);
    expect((await fs.listFiles("Maths/.versions/p1")).every((f) => parsePageNumber(f) === null)).toBe(true);
  });

  it("restaurer : la version actuelle passe d'abord en version", async () => {
    let now = new Date(2026, 9, 13, 10, 0).getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { repo } = await setup(page("p1", [text("ancien")]));
    const p = await repo.readPage("Maths", "Cours", 1);
    (p.blocks[0] as { content: string }).content = "actuel";
    await repo.writePage("Maths", "Cours", 1, p);
    const [old] = await repo.listVersions("Maths", "p1");
    now += 1000;
    const { page: back, outcome } = await repo.restoreVersion("Maths", "Cours", 1, p, old.file);
    expect(outcome.kind).toBe("written");
    expect(back.id).toBe("p1");
    expect(bodyOf(await repo.readPage("Maths", "Cours", 1))).toBe("ancien");
    const all = await repo.listVersions("Maths", "p1");
    expect(all.length).toBe(2);
    expect(bodyOf(await repo.readVersion("Maths", "p1", all[0].file))).toBe("actuel");
  });
});

describe("corbeille : purge a 30 jours", () => {
  it("plan : seulement les suppressions de plus de 30 jours", () => {
    const now = new Date(2026, 9, 13, 12, 0).getTime();
    const old = stampOf(new Date(now - KEEP_MS - 60_000));
    const young = stampOf(new Date(now - KEEP_MS + 60_000));
    expect(trashToPurge([old, `${old}-2`, young, "a la main", "2026-13-01_00-00-00-000"], now)).toEqual([old, `${old}-2`]);
  });

  it("Repo.purgeTrash ne touche pas au reste", async () => {
    const { fs, repo } = await setup(page("p1", [text("un")]), page("p2", [text("deux")]));
    const entry = await repo.deletePage("Maths", "Cours", 2);
    const old = `${TRASH_DIR}/${stampOf(new Date(Date.now() - KEEP_MS - 3600_000))}`;
    await fs.writeText(`${old}/Maths/Cours/0009.page.json`, "{}");
    expect(await repo.purgeTrash()).toBe(1);
    expect(await fs.exists(old)).toBe(false);
    expect(await fs.exists(entry.bin)).toBe(true);
  });
});

describe("mode navigateur : quota (R9)", () => {
  it("le depassement remonte et rien n'est garde a moitie", async () => {
    const store = new Map<string, string>();
    let full = false;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full) { const e = new Error("exceeded the quota"); e.name = "QuotaExceededError"; throw e; }
        store.set(k, v);
      },
      removeItem: (k: string) => { store.delete(k); },
    });
    try {
      const fs = new BrowserFs();
      await fs.writeText("Maths/Cours/0001.page.json", "un");
      full = true;
      await expect(fs.writeText("Maths/Cours/0001.page.json", "deux")).rejects.toThrow(/quota/);
      expect(await fs.readText("Maths/Cours/0001.page.json")).toBe("un");
      await expect(fs.writeText("Maths/Cours/0002.page.json", "x")).rejects.toThrow();
      expect(await fs.exists("Maths/Cours/0002.page.json")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writeTextIf suit le meme contrat que la commande Rust", async () => {
    const fs = new MemoryFs();
    const absent: CondWrite = await fs.writeTextIf("a.json", "1", null);
    expect(absent.ok).toBe(true);
    expect((await fs.writeTextIf("a.json", "2", null)).ok).toBe(false);
    const st = absent.stat as FileStamp;
    const ok = await fs.writeTextIf("a.json", "22", st);
    expect(ok.ok).toBe(true);
    const stale = await fs.writeTextIf("a.json", "3", st);
    expect(stale.ok).toBe(false);
    expect(stale.stat?.size).toBe(2);
    expect(await fs.readText("a.json")).toBe("22");
  });
});

describe("empreintes et plan de fusion", () => {
  it("contentKey ignore l'encre et sa lecture, pas le texte", () => {
    const a = page("p", [text("A"), ink("a")]);
    const b = page("p", [text("A"), ink("a", "b")], { height: 2000, modified: "2027-01-01T00:00:00.000Z" });
    expect(contentKey(a)).toBe(contentKey(b));
    expect(contentKey(page("p", [text("B"), ink("a")]))).not.toBe(contentKey(a));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });

  it("planExternal : fusion seulement sans perte", () => {
    const base = { hash: "", key: contentKey(page("p", [text("A")])) };
    const inkOnly = page("p", [text("A"), ink("x")]);
    const textMine = page("p", [text("A ici")]);
    const textOther = page("p", [text("A la-bas")]);
    expect(planExternal(base, textMine, inkOnly)).toBe("ours");
    expect(planExternal(base, inkOnly, textOther)).toBe("disk");
    expect(planExternal(base, textMine, textOther)).toBe("conflict");
    expect(planExternal(null, textMine, textOther)).toBe("conflict");
    const m = mergedPage("disk", inkOnly, textOther);
    expect(bodyOf(m.page)).toBe("A la-bas");
    expect(strokeIds(m.page)).toEqual(["x"]);
  });

  it("nom de copie de conflit", () => {
    expect(machineTag("PC de Max")).toBe("PC_de_Max");
    expect(machineTag("")).toBe("CE-PC");
    expect(conflictCopyName(3, "LAPTOP", [])).toBe("0003.page-LAPTOP.json");
    expect(conflictCopyName(3, "LAPTOP", ["0003.page-laptop.json"])).toBe("0003.page-LAPTOP-2.json");
  });
});

describe("pagination : remontee et annulation (R3, perte du 13/10)", () => {
  it("la page d'avant est ecrite avant que la suite parte a la corbeille", async () => {
    const order: string[] = [];
    const r = await commitPull({
      writeFrom: async () => { order.push("write"); },
      trashNext: async () => { order.push("trash"); },
      revert: () => { order.push("revert"); },
    });
    expect(r.result).toBe("pulled");
    expect(order).toEqual(["write", "trash"]);
  });

  it("ecriture en echec : remontee defaite, la suite reste", async () => {
    const order: string[] = [];
    const r = await commitPull({
      writeFrom: async () => { throw new Error("disque plein"); },
      trashNext: async () => { order.push("trash"); },
      revert: () => { order.push("revert"); },
    });
    expect(r.result).toBe("reverted");
    expect(order).toEqual(["revert"]);
  });

  it("corbeille en echec : contenu en double, jamais perdu", async () => {
    const r = await commitPull({
      writeFrom: async () => undefined,
      trashNext: async () => { throw new Error("verrou"); },
      revert: () => { throw new Error("jamais"); },
    });
    expect(r.result).toBe("kept-both");
  });

  it("scenario du 13/10 sur le disque : remontee puis annulation, le texte remonte reste", async () => {
    const { fs, repo } = await setup(
      page("p1", [text("Debut du cours")]),
      page("p2", [text("Suite remontee : theoreme de Rolle")], { continues: "p1" }),
    );
    const from = await repo.readPage("Maths", "Cours", 1);
    const next = await repo.readPage("Maths", "Cours", 2);
    const before = bodyOf(from);
    // Remontee : la suite rejoint la page 1, ecrite AVANT la corbeille.
    (from.blocks[0] as { content: string }).content = `${before}\n${bodyOf(next)}`;
    const r = await commitPull({
      writeFrom: async () => { await repo.writePage("Maths", "Cours", 1, from); },
      trashNext: async () => { await repo.deletePage("Maths", "Cours", 2); },
      revert: () => { (from.blocks[0] as { content: string }).content = before; },
    });
    expect(r.result).toBe("pulled");
    expect(await repo.listPageNumbers("Maths", "Cours")).toEqual([1]);
    expect(bodyOf(await repo.readPage("Maths", "Cours", 1))).toContain("theoreme de Rolle");
    // Puis un debordement de la page 1 et un Ctrl+Z avec le « texte d'avant
    // la frappe » d'avant la remontee : la page creee porte la suite, qui ne
    // revient pas dans ce texte-la : l'annulation est refusee.
    expect(textComesBack("Suite remontee : theoreme de Rolle", before)).toBe(false);
    // Le texte d'avant la frappe pris APRES la remontee : l'annulation est sure.
    expect(textComesBack("Suite remontee : theoreme de Rolle", `${before}\nSuite remontee : theoreme de Rolle`)).toBe(true);
    // Le bout tape juste avant le debordement (≤ 10 caracteres) est tolere.
    expect(textComesBack("Suite remontee : theoreme de Rolle et", `${before}\nSuite remontee : theoreme de Rolle`)).toBe(true);
    expect(fs).toBeTruthy();
  });

  it("scenario du 13/10 : ecriture de la page 1 refusee, la suite n'est jamais mise a la corbeille", async () => {
    const { fs, repo } = await setup(
      page("p1", [text("Debut")]),
      page("p2", [text("Suite")], { continues: "p1" }),
    );
    const from = await repo.readPage("Maths", "Cours", 1);
    const before = bodyOf(from);
    (from.blocks[0] as { content: string }).content = "Debut\nSuite";
    // L'autre PC a change la page 1 entre-temps (texte) : conflit, pas d'ecriture.
    await external(fs, 1, page("p1", [text("Debut modifie ailleurs")]));
    const r = await commitPull({
      writeFrom: async () => {
        const out = await repo.writePage("Maths", "Cours", 1, from);
        if (out.kind !== "written" && out.kind !== "merged") throw new Error(out.kind);
      },
      trashNext: async () => { await repo.deletePage("Maths", "Cours", 2); },
      revert: () => { (from.blocks[0] as { content: string }).content = before; },
    });
    expect(r.result).toBe("reverted");
    expect(await repo.listPageNumbers("Maths", "Cours")).toEqual([1, 2]);
    expect(bodyOf(await repo.readPage("Maths", "Cours", 2))).toBe("Suite");
    expect(bodyOf(from)).toBe("Debut");
  });
});
