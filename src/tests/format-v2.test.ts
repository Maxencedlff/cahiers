import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFs } from "../core/storage/fs";
import { Repo, serializePage, migratePage } from "../core/storage/repo";
import { decodeStroke, encodeStroke, roundPoint } from "../core/ink/stroke";
import { SCHEMA_VERSION, isFutureVersion, type InkPoint, type Page, type Stroke } from "../core/types";

/*
 * Format d'encre compact v2 (donnees-10, lot 11) : points en tableaux plats
 * sur le disque, objets {x, y, p, t} en memoire.
 */

let fs: MemoryFs;
let repo: Repo;
let nb: string;

beforeEach(async () => {
  fs = new MemoryFs();
  repo = new Repo(fs);
  await repo.ensureRootLayout();
  nb = await repo.createNotebook("Maths", "#000");
  await repo.createDivider(nb, "Cours");
  await repo.createPage(nb, "Cours");
});

const path = () => `${nb}/Cours/0001.page.json`;

/** Trait « reel » : coordonnees en double precision, temps fractionnaires. */
function rawPoints(n: number, pressure?: (i: number) => number): InkPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    x: 611.2000122070312 + i * 1.37,
    y: 113.60000610351562 + Math.sin(i) * 7.3,
    p: pressure ? pressure(i) : 0.5,
    t: i * 16.6999999821186,
  }));
}

function stroke(id: string, points: InkPoint[], extra: Partial<Stroke> = {}): Stroke {
  return { id, points, color: "normal", width: 1.4, tool: "pen", ...extra };
}

/** Page v1 telle qu'ecrite par l'ancienne version (indentee, pleine precision). */
function v1File(strokes: Stroke[]): string {
  return JSON.stringify({
    version: 1, id: "page-1", created: "2026-09-01T08:00:00.000Z", modified: "2026-09-01T08:00:00.000Z",
    blocks: [{ id: "ink-1", type: "ink", strokes, recognized: null, mode: "raw" }],
  }, null, 2);
}

describe("trait : encodage v2", () => {
  it("aller-retour sans perte, a l'arrondi pres", () => {
    const pts = rawPoints(40, (i) => 0.3 + i / 100);
    pts[3].tiltX = 12.4; pts[3].tiltY = -30.6;
    const s = stroke("s1", pts, { startedAt: 1759305600123 });
    const back = decodeStroke(JSON.parse(JSON.stringify(encodeStroke(s))));
    expect(back).toEqual({ ...s, points: pts.map(roundPoint) });
  });

  it("tableaux plats : pts au dixieme, p au centieme, t en ecarts entiers", () => {
    const enc = encodeStroke(stroke("s", [
      { x: 10.04, y: 20.06, p: 0.333, t: 0 },
      { x: 11.5, y: 21.25, p: 0.5, t: 8.4 },
      { x: 12, y: 22, p: 0.6, t: 16.7 },
    ]));
    expect(enc.pts).toEqual([10, 20.1, 11.5, 21.3, 12, 22]);
    expect(enc.p).toEqual([0.33, 0.5, 0.6]);
    // 0, 8, 17 : ecarts des temps arrondis, pas de derive.
    expect(enc.t).toEqual([0, 8, 9]);
    expect(enc).not.toHaveProperty("points");
    expect(enc).not.toHaveProperty("tilt");
  });

  it("trait d'un point", () => {
    const s = stroke("dot", [{ x: 50.04, y: 60, p: 0.5, t: 0 }]);
    const enc = encodeStroke(s);
    expect(enc.pts).toEqual([50, 60]);
    expect(enc.p).toBe(0.5);
    expect(enc).not.toHaveProperty("t");
    expect(decodeStroke(enc).points).toEqual([{ x: 50, y: 60, p: 0.5, t: 0 }]);
  });

  it("pression constante : un seul nombre ; sans pression (souris) : absente", () => {
    const enc = encodeStroke(stroke("c", rawPoints(5, () => 0.42)));
    expect(enc.p).toBe(0.42);
    expect(decodeStroke(enc).points.every((q) => q.p === 0.42)).toBe(true);
    const mouse = encodeStroke(stroke("m", rawPoints(5, () => 0)));
    expect(mouse).not.toHaveProperty("p");
    expect(decodeStroke(mouse).points.every((q) => q.p === 0)).toBe(true);
  });

  it("trait vide et tableaux abimes : jamais d'exception", () => {
    expect(decodeStroke(encodeStroke(stroke("e", []))).points).toEqual([]);
    const bad = decodeStroke({ id: "b", color: "normal", width: 1, tool: "pen", pts: [1, "x", 3], p: [null], t: "?" });
    expect(bad.points).toEqual([{ x: 1, y: 0, p: 0, t: 0 }]);
    expect(decodeStroke({ id: "z" }).points).toEqual([]);
  });

  it("garde les champs inconnus d'un trait", () => {
    const s = { ...stroke("s", rawPoints(3)), futur: { a: 1 } } as Stroke;
    expect((decodeStroke(encodeStroke(s)) as unknown as { futur: unknown }).futur).toEqual({ a: 1 });
  });
});

describe("page : v1 -> memoire -> v2 -> memoire", () => {
  it("lit une page v1, l'ecrit en v2, la relit a l'identique (ids compris)", async () => {
    const strokes = [
      stroke("a", rawPoints(30, (i) => 0.2 + (i % 7) / 10), { startedAt: 1759305600000 }),
      stroke("b", rawPoints(1)),
      stroke("c", rawPoints(12), { color: "theoreme", tool: "highlighter", width: 15 }),
    ];
    await fs.writeText(path(), v1File(strokes));

    const mem = await repo.readPage(nb, "Cours", 1);
    expect(mem.version).toBe(SCHEMA_VERSION);
    const ink = mem.blocks[0];
    if (ink.type !== "ink") throw new Error("bloc ink attendu");
    expect(ink.strokes.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(ink.strokes[0].points[0]).toEqual(strokes[0].points[0]);

    await repo.writePage(nb, "Cours", 1, mem);
    const raw = await fs.readText(path());
    const disk = JSON.parse(raw);
    expect(disk.version).toBe(2);
    expect(disk.blocks[0].strokes[0].pts).toHaveLength(60);
    expect(raw).not.toContain("\"x\":");
    // Un trait par ligne.
    expect(raw.split("\n").filter((l) => l.includes("\"pts\"")).length).toBe(3);

    const again = await repo.readPage(nb, "Cours", 1);
    const ink2 = again.blocks[0];
    if (ink2.type !== "ink") throw new Error("bloc ink attendu");
    expect(ink2.strokes).toEqual(strokes.map((s) => ({ ...s, points: s.points.map(roundPoint) })));
    // Et un second cycle ne bouge plus rien.
    await repo.writePage(nb, "Cours", 1, again);
    const raw2 = await fs.readText(path());
    expect(raw2.replace(/"modified": "[^"]*"/, "")).toBe(raw.replace(/"modified": "[^"]*"/, ""));
  });

  it("ouvrir une page v1 ne la reecrit pas", async () => {
    const file = v1File([stroke("a", rawPoints(5))]);
    await fs.writeText(path(), file);
    await repo.readPage(nb, "Cours", 1);
    await repo.listPageNumbers(nb, "Cours");
    expect(await fs.readText(path())).toBe(file);
  });

  it("page mixte : traits v1 et v2 dans un meme fichier, encre, maths et PDF", async () => {
    const v1 = stroke("v1", rawPoints(4));
    const v2 = encodeStroke(stroke("v2", rawPoints(6, (i) => i / 10)));
    const ann = encodeStroke(stroke("ann", rawPoints(3)));
    await fs.writeText(path(), JSON.stringify({
      version: 2, id: "p", created: "", modified: "",
      blocks: [
        { id: "t", type: "text", content: "Theoreme" },
        { id: "i", type: "ink", strokes: [v1, v2], recognized: null, mode: "raw" },
        { id: "m", type: "math", strokes: [{ ...v2, id: "m1" }], latex: "x^2", mode: "math" },
        { id: "d", type: "pdf", src: "assets/y.pdf", page: 3, annotations: [ann] },
      ],
    }));
    const page = await repo.readPage(nb, "Cours", 1);
    const [text, ink, math, pdf] = page.blocks;
    expect(text).toEqual({ id: "t", type: "text", content: "Theoreme" });
    if (ink.type !== "ink" || math.type !== "math" || pdf.type !== "pdf") throw new Error("blocs");
    expect(ink.strokes[0]).toEqual(v1);
    expect(ink.strokes[1].points).toHaveLength(6);
    expect(ink.strokes[1].points[3].p).toBe(0.3);
    expect(math.strokes[0].id).toBe("m1");
    expect(math.strokes[0].points).toHaveLength(6);
    expect(pdf.annotations[0].points).toHaveLength(3);
    expect(pdf.annotations[0]).not.toHaveProperty("pts");
  });

  it("la version 1 de l'appli lit un trait v2 sans planter (points vide)", () => {
    const page: Page = {
      version: 2, id: "p", created: "", modified: "",
      blocks: [{ id: "i", type: "ink", strokes: [stroke("a", rawPoints(3))], recognized: null, mode: "raw" }],
    };
    const disk = JSON.parse(serializePage(page));
    expect(disk.blocks[0].strokes[0].points).toEqual([]);
    expect(disk.blocks[0].strokes[0].pts).toHaveLength(6);
    // Le decodage v2 ignore ce `points` vide.
    expect(migratePage(disk).blocks[0]).toMatchObject({ strokes: [{ id: "a", points: { length: 3 } }] });
  });

  it("cahier.json garde la version 1 (son format n'a pas change)", async () => {
    expect(JSON.parse(await fs.readText(`${nb}/cahier.json`)).version).toBe(1);
  });
});

describe("page d'une version future (v3)", () => {
  it("lecture seule : version gardee, encre affichable, jamais reecrite", async () => {
    const file = JSON.stringify({
      version: 3, id: "x", created: "", modified: "", nouveau: { a: 1 },
      blocks: [{ id: "i", type: "ink", recognized: null, mode: "raw",
        strokes: [{ ...encodeStroke(stroke("s", rawPoints(4))), forme: "bezier" }] }],
    });
    await fs.writeText(path(), file);
    const page = await repo.readPage(nb, "Cours", 1);
    expect(page.version).toBe(3);
    expect(isFutureVersion(page)).toBe(true);
    const ink = page.blocks[0];
    if (ink.type !== "ink") throw new Error("bloc ink attendu");
    expect(ink.strokes[0].points).toHaveLength(4);
    await expect(repo.writePage(nb, "Cours", 1, page)).rejects.toThrow(/plus récente/);
    expect(await fs.readText(path())).toBe(file);
  });
});

describe("copies de conflit et corbeille : lisibles quelle que soit leur version", () => {
  it("copie v1 et copie v2", async () => {
    await fs.writeText(`${nb}/Cours/0001.page-PC-A.json`, v1File([stroke("a", rawPoints(5))]));
    const v2page: Page = {
      version: 2, id: "page-1", created: "", modified: "",
      blocks: [{ id: "ink-1", type: "ink", strokes: [stroke("b", rawPoints(7))], recognized: null, mode: "raw" }],
    };
    await fs.writeText(`${nb}/Cours/0001.page-PC-B.json`, serializePage(v2page));
    const a = await repo.readConflict(nb, "Cours", "0001.page-PC-A.json");
    const b = await repo.readConflict(nb, "Cours", "0001.page-PC-B.json");
    expect(a.blocks[0]).toMatchObject({ strokes: [{ id: "a", points: { length: 5 } }] });
    expect(b.blocks[0]).toMatchObject({ strokes: [{ id: "b", points: { length: 7 } }] });
  });

  it("page v1 mise a la corbeille puis remise", async () => {
    await fs.writeText(path(), v1File([stroke("a", rawPoints(5))]));
    const entry = await repo.deletePage(nb, "Cours", 1);
    const n = await repo.restorePage(entry);
    const page = await repo.readPage(nb, "Cours", n);
    expect(page.blocks[0]).toMatchObject({ strokes: [{ id: "a", points: { length: 5 } }] });
  });
});
