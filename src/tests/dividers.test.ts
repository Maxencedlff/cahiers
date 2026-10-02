import { describe, it, expect } from "vitest";
import {
  buildTree, flattenTree, openableDividers, findNode, siblingsIn, subtreeHeight, defaultExpanded,
  expandedChain, moveAmongSiblings, moveRefusal, renamePrefix, remapKeys, dividerLabel, parsePagePath,
  parentPath, leafName, isUnder, type RawDir,
} from "../core/dividers";

/** Electronique tel que sur le disque de Maxence (E3A/S1/Chapitre 1). */
const ELEC: RawDir[] = [
  { name: "E3A", pages: true, children: [
    { name: "S1", children: [{ name: "Chapitre 1" }, { name: "Chapitre 2" }, { name: "TP 4" }] },
    { name: "S2", children: [{ name: "Electronique_Numerique" }] },
  ] },
  { name: "E4A" },
  { name: "EON Puissance" },
];

describe("chemins d'intercalaires", () => {
  it("decoupe, remonte et compare", () => {
    expect(parentPath("E3A/S1/Chapitre 1")).toBe("E3A/S1");
    expect(parentPath("Cours")).toBe("");
    expect(leafName("E3A/S1/Chapitre 1")).toBe("Chapitre 1");
    expect(isUnder("E3A/S1", "E3A")).toBe(true);
    expect(isUnder("E3AB", "E3A")).toBe(false);
  });

  it("renomme un groupe : tout son contenu suit, rien d'autre", () => {
    expect(renamePrefix("S1/Chapitre 1", "S1", "Semestre 1")).toBe("Semestre 1/Chapitre 1");
    expect(renamePrefix("S1", "S1", "Semestre 1")).toBe("Semestre 1");
    expect(renamePrefix("S10", "S1", "Semestre 1")).toBe("S10");
    expect(remapKeys({ "S1/TD": "scroll", Cours: "pages", S1: "pages" }, "S1", "X"))
      .toEqual({ Cours: "pages", "X/TD": "scroll", X: "pages" });
  });

  it("affiche les niveaux et relit un lien a plusieurs niveaux", () => {
    expect(dividerLabel("E3A/S1/Chapitre 1")).toBe("E3A › S1 › Chapitre 1");
    expect(dividerLabel("E3A/S1/Chapitre 1", 2)).toBe("S1 › Chapitre 1");
    expect(dividerLabel("Cours")).toBe("Cours");
    expect(parsePagePath("Elec/E3A/S1/Chapitre 1/0003"))
      .toEqual({ notebook: "Elec", divider: "E3A/S1/Chapitre 1", number: 3 });
    expect(parsePagePath("Maths/Cours/0012")).toEqual({ notebook: "Maths", divider: "Cours", number: 12 });
    expect(parsePagePath("Maths/0012")).toBeNull();
  });
});

describe("arbre des intercalaires (3 niveaux)", () => {
  it("ordre de cahier.json par niveau, puis le disque", () => {
    const tree = buildTree(ELEC, ["EON Puissance", "E3A", "E3A/S2", "E3A/S1/TP 4"]);
    expect(tree.map((n) => n.path)).toEqual(["EON Puissance", "E3A", "E4A"]);
    expect(flattenTree(tree)).toEqual([
      "EON Puissance", "E3A", "E3A/S2", "E3A/S2/Electronique_Numerique",
      "E3A/S1", "E3A/S1/TP 4", "E3A/S1/Chapitre 1", "E3A/S1/Chapitre 2", "E4A",
    ]);
  });

  it("un ancien cahier.json (premier niveau seulement) reste valable", () => {
    const tree = buildTree([{ name: "Cours" }, { name: "Exos" }, { name: "TD" }], ["TD", "Cours"]);
    expect(flattenTree(tree)).toEqual(["TD", "Cours", "Exos"]);
  });

  it("groupe avec pages = intercalaire ouvrable ; groupe sans page = rangement", () => {
    const tree = buildTree(ELEC, []);
    expect(findNode(tree, "E3A")?.pages).toBe(true);
    expect(findNode(tree, "E3A/S1")?.pages).toBe(false);
    expect(openableDividers(tree)).toEqual([
      "E3A", "E3A/S1/Chapitre 1", "E3A/S1/Chapitre 2", "E3A/S1/TP 4",
      "E3A/S2/Electronique_Numerique", "E4A", "EON Puissance",
    ]);
  });

  it("jamais plus de 3 niveaux sous la matiere", () => {
    const tree = buildTree([{ name: "A", children: [{ name: "B", children: [{ name: "C", children: [{ name: "D" }] }] }] }], []);
    expect(flattenTree(tree)).toEqual(["A", "A/B", "A/B/C"]);
    expect(findNode(tree, "A/B/C")?.pages).toBe(true);
    expect(subtreeHeight(tree[0])).toBe(3);
  });

  it("voisins, sous-bande ouverte et fil d'Ariane", () => {
    const tree = buildTree(ELEC, []);
    expect(siblingsIn(tree, "E3A/S1/TP 4").map((n) => n.name)).toEqual(["Chapitre 1", "Chapitre 2", "TP 4"]);
    expect(siblingsIn(tree, "E4A").map((n) => n.name)).toEqual(["E3A", "E4A", "EON Puissance"]);
    expect(defaultExpanded(tree, "E3A/S1/Chapitre 1")).toBe("E3A/S1");
    expect(defaultExpanded(tree, "E3A")).toBe("E3A");
    expect(defaultExpanded(tree, "E4A")).toBeNull();
    expect(expandedChain("E3A/S1")).toEqual(["E3A", "E3A/S1"]);
    expect(expandedChain(null)).toEqual([]);
  });
});

describe("deplacer un intercalaire", () => {
  it("glisser change seulement l'ordre des voisins", () => {
    const flat = ["Cours", "S1", "S1/A", "S1/B", "S1/C", "TD"];
    expect(moveAmongSiblings(flat, "S1/C", 0)).toEqual(["Cours", "S1", "S1/C", "S1/A", "S1/B", "TD"]);
    // Seul compte le rang relatif des voisins : l'arbre se reconstruit dans cet ordre.
    const order = moveAmongSiblings(flat, "TD", 0);
    const raw: RawDir[] = [{ name: "Cours" }, { name: "S1", children: [{ name: "A" }, { name: "B" }, { name: "C" }] }, { name: "TD" }];
    expect(flattenTree(buildTree(raw, order))).toEqual(["TD", "Cours", "S1", "S1/A", "S1/B", "S1/C"]);
  });

  it("refuse dans lui-meme, sur place, ou au-dela de 3 niveaux", () => {
    expect(moveRefusal("S1", "S1/A")).toMatch(/lui-même/);
    expect(moveRefusal("S1/A", "S1")).toMatch(/déjà/);
    expect(moveRefusal("TD", "E3A/S1")).toBeNull();
    expect(moveRefusal("S1", "E3A", 2)).toBeNull();
    expect(moveRefusal("S1", "E3A/S2", 2)).toMatch(/3 niveaux/);
    expect(moveRefusal("E3A/S1/TP 4", "")).toBeNull();
  });
});
