import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFs } from "../core/storage/fs";
import { Repo } from "../core/storage/repo";
import { collectLinkPages, indexPage, searchAll } from "../core/storage/search";
import { docHeadings, docPlainText, parseDoc, serializeDoc, type DocToken } from "../core/text/doc";
import {
  backlinksTo, blockLinkRef, fuzzyScore, indexById, linkBlockFields, linkCandidates, linkLabel, linkMarkdown,
  linkUrl, pagePathOf, parseLinkMarkdown, parseLinkUrl, rankCandidates, resolveLink, spotExists,
  type LinkPage,
} from "../core/links";
import type { Block, Page } from "../core/types";
import { uuid } from "../core/id";

describe("format des liens", () => {
  it("adresse : page, bloc, titre", () => {
    expect(linkUrl({ pageId: "p1" })).toBe("cahiers:p1");
    expect(linkUrl({ pageId: "p1", blockId: "b2" })).toBe("cahiers:p1#b2");
    expect(linkUrl({ pageId: "p1", heading: "Théorème de Thévenin" })).toBe("cahiers:p1#titre:Théorème%20de%20Thévenin");
    expect(parseLinkUrl("cahiers:p1#titre:Théorème%20de%20Thévenin", "Elec/Cours/0003"))
      .toEqual({ pageId: "p1", heading: "Théorème de Thévenin", path: "Elec/Cours/0003" });
    expect(parseLinkUrl("cahiers:p1#b2")).toEqual({ pageId: "p1", blockId: "b2" });
    expect(parseLinkUrl("http://x")).toBeNull();
    expect(parseLinkUrl("cahiers:")).toBeNull();
  });

  it("titre avec parentheses et guillemets : encode, relu a l'identique", () => {
    const heading = 'Loi (des "mailles") #2';
    const url = linkUrl({ pageId: "p", heading });
    expect(url).not.toMatch(/[\s()"]/);
    expect(parseLinkUrl(url)?.heading).toBe(heading);
  });

  it("markdown : aller-retour dans le texte tape, avec le chemin lisible", () => {
    const md = `voir ${linkMarkdown("théorème [1]", { pageId: "abc", blockId: "blk", path: "Maths/Cours/0012" })} ici`;
    expect(md).toBe('voir [théorème \\[1\\]](cahiers:abc#blk "Maths/Cours/0012") ici');
    const tokens = parseDoc(md);
    expect(tokens).toEqual([
      { kind: "text", text: "voir " },
      { kind: "link", label: "théorème [1]", href: "cahiers:abc#blk", hint: "Maths/Cours/0012" },
      { kind: "text", text: " ici" },
    ]);
    expect(serializeDoc(tokens)).toBe(md);
  });

  it("lien a cote d'une couleur, dans un titre, et texte entre crochets", () => {
    const src = "# Exo [lien](cahiers:p) et [rouge]{.attention}\n\\[pas un lien\\](cahiers:x)";
    const tokens = parseDoc(src);
    expect(tokens.filter((t) => t.kind === "link")).toHaveLength(1);
    expect(tokens.find((t) => t.kind === "text" && t.color === "attention")).toBeTruthy();
    expect(serializeDoc(tokens)).toBe(src);
    expect(docHeadings(tokens)).toEqual(["Exo lien et rouge"]);
  });

  it("un lien sans href cahiers: reste du texte", () => {
    const tokens = parseDoc("[a](http://x)");
    expect(tokens.every((t) => t.kind === "text")).toBe(true);
  });

  it("presse-papiers : lien seul reconnu, le reste non", () => {
    const md = linkMarkdown("Thévenin", { pageId: "p1", heading: "Thévenin", path: "Elec/Cours/0003" });
    expect(parseLinkMarkdown(md)).toEqual({
      label: "Thévenin", ref: { pageId: "p1", heading: "Thévenin", path: "Elec/Cours/0003" },
    });
    expect(parseLinkMarkdown(`texte ${md}`)).toBeNull();
    expect(parseLinkMarkdown("[x](cahiers:)")).toBeNull();
  });

  it("libelle pour l'export (linkLabel) et texte simple", () => {
    expect(linkLabel({ label: "  théorème \n de Rolle " })).toBe("théorème de Rolle");
    expect(linkLabel({ label: "", heading: "Rolle" })).toBe("Rolle");
    expect(linkLabel({})).toBe("lien");
    expect(docPlainText("voir [Rolle](cahiers:p) !")).toBe("voir Rolle !");
  });

  it("ancien bloc link : chemin lisible ET id", () => {
    const f = linkBlockFields({ pageId: "id1", blockId: "b3" }, { notebook: "Maths", divider: "Cours", number: 12 }, "théorème");
    expect(f).toEqual({ target: "Maths/Cours/0012#b3", pageId: "id1", label: "théorème" });
    expect(blockLinkRef({ ...f })).toEqual({ pageId: "id1", blockId: "b3", path: "Maths/Cours/0012" });
    expect(blockLinkRef({ target: "Maths/Cours/0012#block-3", label: "x" }))
      .toEqual({ pageId: "", blockId: "block-3", path: "Maths/Cours/0012" });
    expect(pagePathOf({ notebook: "Elec", divider: "E3A/S1", number: 3 })).toBe("Elec/E3A/S1/0003");
  });
});

describe("resolution", () => {
  const pages: LinkPage[] = [
    { notebook: "Elec", divider: "Cours", number: 4, id: "thev" },
    { notebook: "Elec", divider: "Cours", number: 3, id: "neuve" },
  ];

  it("par id d'abord, meme si le chemin a change", () => {
    const r = resolveLink({ pageId: "thev", path: "Elec/Cours/0003" }, indexById(pages));
    expect(r).toEqual({ kind: "page", page: { notebook: "Elec", divider: "Cours", number: 4 }, via: "id" });
  });

  it("page a la corbeille : jamais remplacee par celle qui a pris son numero", () => {
    const r = resolveLink({ pageId: "partie", path: "Elec/Cours/0003" }, indexById(pages), {
      trashed: true, pathExists: (s) => spotExists(pages, s),
    });
    expect(r.kind).toBe("trash");
  });

  it("repli sur le chemin (ancien lien sans id), sinon introuvable", () => {
    const opts = { pathExists: (s: { notebook: string; divider: string; number: number }) => spotExists(pages, s) };
    expect(resolveLink({ pageId: "", path: "Elec/Cours/0003" }, indexById(pages), opts))
      .toEqual({ kind: "page", page: { notebook: "Elec", divider: "Cours", number: 3 }, via: "path" });
    expect(resolveLink({ pageId: "x", path: "Elec/Cours/0009" }, indexById(pages), opts).kind).toBe("missing");
  });
});

describe("retroliens", () => {
  it("une entree par page qui cite, libelles sans doublon, jamais la page elle-meme", () => {
    const pages: LinkPage[] = [
      { notebook: "Elec", divider: "TD", number: 2, id: "td2", title: "TD 2", links: [
        { pageId: "thev", label: "Thévenin" }, { pageId: "thev", label: "Thévenin" }, { pageId: "x", label: "autre" },
      ] },
      { notebook: "Elec", divider: "Cours", number: 3, id: "thev", links: [{ pageId: "thev", label: "ici" }] },
      { notebook: "Elec", divider: "TD", number: 1, id: "td1", firstLine: "Exercice 1", links: [
        { pageId: "thev", heading: "Thévenin", label: "" },
      ] },
    ];
    const back = backlinksTo("thev", pages);
    expect(back.map((b) => [b.number, b.title, b.labels])).toEqual([
      [1, "Exercice 1", ["Thévenin"]],
      [2, "TD 2", ["Thévenin"]],
    ]);
  });
});

describe("recherche floue du selecteur [[", () => {
  const pages: LinkPage[] = [
    { notebook: "Elec", notebookTitle: "Élec", divider: "Cours", number: 3, id: "p3", title: "Théorème de Thévenin",
      headings: ["Théorème de Thévenin", "Générateur équivalent"], anchors: [{ blockId: "m1", kind: "math", text: "Eth = Vab" }] },
    { notebook: "Elec", notebookTitle: "Élec", divider: "TD", number: 1, id: "p1", firstLine: "Exercice : pont diviseur" },
    { notebook: "Maths", notebookTitle: "Maths", divider: "Cours", number: 7, id: "p7", title: "Théorème de Rolle" },
  ];
  const all = linkCandidates(pages);

  it("candidats : pages, titres (sans redire le titre de page), formules", () => {
    expect(all.map((c) => `${c.kind}:${c.label}`)).toEqual([
      "page:Théorème de Thévenin", "heading:Générateur équivalent", "math:Eth = Vab",
      "page:Exercice : pont diviseur", "page:Théorème de Rolle",
    ]);
    expect(all[1].ref).toEqual({ pageId: "p3", heading: "Générateur équivalent", path: "Elec/Cours/0003" });
  });

  it("« thev » : le theoreme de Thevenin d'abord, accents ignores", () => {
    expect(rankCandidates("thev", all)[0].label).toBe("Théorème de Thévenin");
    expect(rankCandidates("THÉV", all)[0].ref.pageId).toBe("p3");
  });

  it("mots en ET, matiere ou intercalaire comme filtre, lettres dans l'ordre", () => {
    expect(rankCandidates("maths theoreme", all).map((c) => c.ref.pageId)).toEqual(["p7"]);
    expect(rankCandidates("generateur", all)[0].kind).toBe("heading");
    expect(rankCandidates("thvnin", all)[0].label).toBe("Théorème de Thévenin");
    expect(rankCandidates("zzz", all)).toEqual([]);
  });

  it("score : debut de mot avant milieu, sous-chaine avant lettres eparses", () => {
    expect(fuzzyScore("rol", "Théorème de Rolle")!).toBeGreaterThan(fuzzyScore("oll", "Théorème de Rolle")!);
    expect(fuzzyScore("rolle", "Rolle")!).toBeGreaterThan(fuzzyScore("rle", "Rolle")!);
    expect(fuzzyScore("x", "abc")).toBeNull();
  });
});

describe("liens et disque (renumerotation, corbeille, index)", () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = new Repo(new MemoryFs());
    await repo.ensureRootLayout();
  });

  async function page(nb: string, div: string, content: string, at?: number): Promise<{ n: number; id: string }> {
    const dirs = await repo.listNotebookDirs();
    const dir = dirs.includes(nb) ? nb : await repo.createNotebook(nb, "#000");
    if (!(await repo.listDividers(dir)).includes(div)) await repo.createDivider(dir, div);
    const n = await repo.createPage(dir, div, at);
    const p = await repo.readPage(dir, div, n);
    p.blocks.push({ id: uuid(), type: "text", content } as Block);
    await repo.writePage(dir, div, n, p);
    return { n, id: p.id };
  }

  it("le lien suit sa cible quand une page est inseree avant elle", async () => {
    const thev = await page("Elec", "Cours", "# Théorème de Thévenin\nEth = Vab");
    const md = linkMarkdown("Thévenin", { pageId: thev.id, heading: "Théorème de Thévenin", path: "Elec/Cours/0001" });
    const td = await page("Elec", "TD", `voir ${md}`);
    // Page inseree avant la cible : elle devient la 2.
    await page("Elec", "Cours", "intro", 1);
    const pages = (await collectLinkPages(repo))!;
    const body = (await repo.readPage("Elec", "TD", td.n)).blocks.find((b) => b.type === "text") as { content: string };
    const tokens = parseDoc(body.content);
    const link = tokens.find((t): t is Extract<DocToken, { kind: "link" }> => t.kind === "link")!;
    const r = resolveLink(parseLinkUrl(link.href, link.hint)!, indexById(pages));
    expect(r).toEqual({ kind: "page", page: { notebook: "Elec", divider: "Cours", number: 2 }, via: "id" });
    // Retroliens de la cible, calcules depuis l'index.
    expect(backlinksTo(thev.id, pages).map((b) => [b.divider, b.number, b.labels])).toEqual([["TD", 1, ["Thévenin"]]]);
    // Selecteur : titre de page trouve.
    expect(rankCandidates("thev", linkCandidates(pages))[0].ref.pageId).toBe(thev.id);
  });

  it("page supprimee : retrouvee dans la corbeille par son id, puis restauree", async () => {
    const a = await page("Maths", "Cours", "# Rolle");
    await page("Maths", "Cours", "# Suite");
    await repo.deletePage("Maths", "Cours", a.n);
    const pages = (await collectLinkPages(repo))!;
    expect(indexById(pages).has(a.id)).toBe(false);
    const entry = await repo.findTrashedPage(a.id);
    expect(entry).toMatchObject({ dir: "Maths", divider: "Cours", page: 1 });
    expect(await repo.findTrashedPage("inconnu")).toBeNull();
    await repo.restorePage(entry!);
    const again = (await collectLinkPages(repo))!;
    expect(indexById(again).get(a.id)?.number).toBe(1);
  });

  it("index de page : id, titres, liens, formules ; la recherche trouve le libelle", async () => {
    const p: Page = {
      version: 2, id: "pid", created: "", modified: "",
      blocks: [
        { id: "t", type: "text", content: "# Titre\n## Partie\nvoir [accroissements finis](cahiers:cible#titre:TAF)" },
        { id: "m", type: "math", strokes: [], latex: "f'(c)", mode: "math", rect: { x: 0, y: 0, w: 10, h: 10 } } as Block,
        { id: "l", type: "link", target: "Maths/Cours/0007", label: "ancien", pageId: "cible" },
      ],
    };
    const idx = indexPage(p);
    expect(idx.id).toBe("pid");
    expect(idx.headings).toEqual(["Titre", "Partie"]);
    expect(idx.links).toEqual([
      { pageId: "cible", label: "ancien" },
      { pageId: "cible", heading: "TAF", label: "accroissements finis" },
    ]);
    expect(idx.anchors).toEqual([{ blockId: "m", kind: "math", text: "f'(c)" }]);
    expect(idx.blocks.find((b) => b.id === "t")?.text).toContain("voir accroissements finis");

    await page("Elec", "TD", "voir [accroissements finis](cahiers:x)");
    const hits = await searchAll(repo, "accroissements");
    expect(hits).toHaveLength(1);
    expect(hits[0].pageId).toBeTruthy();
  });
});
