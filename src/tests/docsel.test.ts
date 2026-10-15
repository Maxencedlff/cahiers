import { describe, expect, it } from "vitest";
import { allStyled, chainBounds, docUndoValid, formatContent, joinDoc, linked, planDocDelete } from "../core/docsel";
import { parseDoc } from "../core/text/doc";
import type { Block, Page } from "../core/types";

function page(id: string, content: string, continues?: string, extra: Block[] = []): Page {
  return {
    version: 2, id, created: "2026-10-15T10:00:00Z", modified: "2026-10-15T10:00:00Z",
    blocks: [{ id: `${id}-t`, type: "text", content }, ...extra],
    ...(continues ? { continues } : {}),
  };
}

describe("selection document : chaine des pages de suite", () => {
  const pages = [
    { id: "a" }, { id: "b", continues: "a" }, { id: "c", continues: "b" }, // un document de 3 pages
    { id: "d" }, // page ajoutee a la main
    { id: "e", continues: "d" },
    { id: "f", continues: "x" }, // suite d'une page qui n'est pas juste avant
  ];

  it("linked : seulement la page juste avant", () => {
    expect(linked(pages[0], pages[1])).toBe(true);
    expect(linked(pages[2], pages[3])).toBe(false);
    expect(linked(null, pages[1])).toBe(false);
  });

  it("chainBounds : de la premiere a la derniere page du document, depuis n'importe laquelle", () => {
    expect(chainBounds(pages, 0)).toEqual([0, 2]);
    expect(chainBounds(pages, 1)).toEqual([0, 2]);
    expect(chainBounds(pages, 2)).toEqual([0, 2]);
    expect(chainBounds(pages, 3)).toEqual([3, 4]);
    expect(chainBounds(pages, 5)).toEqual([5, 5]);
  });

  it("chainBounds : une page illisible (null) coupe la chaine", () => {
    expect(chainBounds([{ id: "a" }, null, { id: "c", continues: "b" }], 0)).toEqual([0, 0]);
  });

  it("joinDoc : les pages bout a bout, une ligne par saut de page", () => {
    expect(joinDoc(["a\nb", "c", ""])).toBe("a\nb\nc\n");
  });
});

describe("selection document : mise en forme", () => {
  it("gras sur tout le texte, formules et photos intactes", () => {
    const out = formatContent("Loi $U=RI$ ici\n![](img:p1)", { bold: true });
    expect(out).toBe("**Loi **$U=RI$** ici**\n![](img:p1)");
    // Relu : tout le texte en gras, la formule et la photo telles quelles.
    const toks = parseDoc(out);
    expect(toks.filter((t) => t.kind === "text" && t.text.trim()).every((t) => t.kind === "text" && t.bold)).toBe(true);
    expect(toks.some((t) => t.kind === "math" && t.latex === "U=RI")).toBe(true);
    expect(toks.some((t) => t.kind === "image" && t.id === "p1")).toBe(true);
  });

  it("gras retire, titres et puces gardes", () => {
    expect(formatContent("# **Titre**\n- **point**", { bold: false })).toBe("# Titre\n- point");
  });

  it("couleur et taille sur le texte et les formules ; null et la taille normale les retirent", () => {
    const c = formatContent("a $x$", { color: "theoreme" });
    expect(c).toBe("[a $x$]{.theoreme}");
    expect(formatContent(c, { color: null })).toBe("a $x$");
    const z = formatContent("a", { size: 18 });
    expect(z).toBe("[a]{.s18}");
    expect(formatContent(z, { size: 14 })).toBe("a");
  });

  it("texte vide : rien", () => {
    expect(formatContent("", { bold: true })).toBe("");
  });

  it("allStyled : comme Word, Ctrl+B sur un document deja tout en gras retire le gras", () => {
    expect(allStyled(["**a**\n", "**b** $x$"], "bold")).toBe(true);
    expect(allStyled(["**a**", "b"], "bold")).toBe(false);
    expect(allStyled(["", "$x$"], "bold")).toBe(false);
    expect(allStyled(["*a*"], "italic")).toBe(true);
  });
});

describe("selection document : suppression", () => {
  const ink: Block = { id: "ink", type: "ink", strokes: [], recognized: null, mode: "raw" } as Block;
  const photo: Block = { id: "p1", type: "image", src: "x.jpg" } as Block;

  it("la premiere page garde le remplacement, les suites vides partent", () => {
    const plan = planDocDelete([page("a", "x"), page("b", "y", "a"), page("c", "z", "b")], "r");
    expect(plan.contents).toEqual(["r", "", ""]);
    expect(plan.trash).toEqual([false, true, true]);
  });

  it("une suite avec de l'encre reste (texte vide) et suit la derniere page gardee", () => {
    const plan = planDocDelete([page("a", "x"), page("b", "y", "a"), page("c", "z", "b", [ink])], "");
    expect(plan.trash).toEqual([false, true, false]);
    expect(plan.continues).toEqual([undefined, "a", "a"]);
  });

  it("la photo du texte efface part avec sa page ; une photo qui n'est pas dans le texte la garde", () => {
    expect(planDocDelete([page("a", ""), page("b", "![](img:p1)", "a", [photo])], "").trash).toEqual([false, true]);
    expect(planDocDelete([page("a", ""), page("b", "y", "a", [photo])], "").trash).toEqual([false, false]);
  });

  it("la premiere page garde son propre lien de suite", () => {
    const first = page("a", "x", "z");
    expect(planDocDelete([first, page("b", "y", "a")], "").continues[0]).toBe("z");
  });
});

describe("selection document : Ctrl+Z", () => {
  it("rien n'a change : on peut annuler", () => {
    expect(docUndoValid(["", "", "ok"], ["", "", "ok"])).toBe(true);
  });

  it("la frappe qui a remplace la selection (au plus 10 caracteres) n'empeche pas l'annulation", () => {
    expect(docUndoValid(["x"], ["xyz"])).toBe(true);
    expect(docUndoValid([""], ["0123456789abc"])).toBe(false);
    expect(docUndoValid(["x"], ["xyz"], 0)).toBe(false);
  });

  it("une autre page a change ou a disparu : on n'ecrase rien", () => {
    expect(docUndoValid(["", "a"], ["", "ab"])).toBe(false);
    expect(docUndoValid(["", "a"], ["", null])).toBe(false);
    expect(docUndoValid(["", "a"], [""])).toBe(false);
  });
});
