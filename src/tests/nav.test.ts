import { describe, it, expect } from "vitest";
import { NavHistory, dayLabel, dropIndex, filterByTitle, gridStep, moveItem, moveTo, pickSplitDivider } from "../core/nav";
import { firstLineOf, indexPage } from "../core/storage/search";
import type { Page } from "../core/types";

const spot = (notebook: string, divider: string, page: number) => ({ notebook, divider, page });

describe("retour arriere (rech-11)", () => {
  it("revient a l'endroit d'avant le saut", () => {
    const h = new NavHistory();
    h.push(spot("Maths", "Exos", 3));
    h.push(spot("Maths", "Cours", 2));
    expect(h.pop()).toEqual(spot("Maths", "Cours", 2));
    expect(h.pop()).toEqual(spot("Maths", "Exos", 3));
    expect(h.pop()).toBeNull();
  });

  it("ne garde pas deux fois le meme endroit de suite, et saute celui ou l'on est", () => {
    const h = new NavHistory();
    h.push(spot("Maths", "Exos", 3));
    h.push(spot("Maths", "Exos", 3));
    expect(h.size).toBe(1);
    h.push(spot("Maths", "Cours", 1));
    expect(h.pop(spot("Maths", "Cours", 1))).toEqual(spot("Maths", "Exos", 3));
  });

  it("est bornee", () => {
    const h = new NavHistory(3);
    for (let i = 1; i <= 5; i++) h.push(spot("Maths", "Cours", i));
    expect(h.size).toBe(3);
    expect(h.pop()?.page).toBe(5);
  });

  it("ignore un endroit sans page", () => {
    const h = new NavHistory();
    h.push(spot("Maths", "E3A", 0));
    expect(h.size).toBe(0);
  });

  it("suit renommages et corbeille", () => {
    const h = new NavHistory();
    h.push(spot("Elec", "TP", 1));
    h.push(spot("Maths", "Exos", 2));
    h.push(spot("Maths", "Cours", 4));
    h.renameDivider("Maths", "Exos", "Exercices");
    h.renameNotebook("Elec", "Électronique");
    h.drop("Maths", "Cours");
    expect(h.pop()).toEqual(spot("Maths", "Exercices", 2));
    expect(h.pop()).toEqual(spot("Électronique", "TP", 1));
    h.push(spot("Maths", "Exos", 1));
    h.drop("Maths");
    expect(h.pop()).toBeNull();
  });
});

describe("menu au clavier (nav-14)", () => {
  const titles = ["Informatique", "Maths", "Électronique analogique", "Vrac", "Mécanique des fluides"];
  const f = (q: string) => filterByTitle(titles, q, (t) => [t]);

  it("filtre sur le debut des mots, sans casse ni accent", () => {
    expect(f("ma")).toEqual(["Maths"]);
    expect(f("elec")).toEqual(["Électronique analogique"]);
    expect(f("ANA")).toEqual(["Électronique analogique"]);
    expect(f("zz")).toEqual([]);
    expect(f("")).toEqual(titles);
  });

  it("le titre qui commence par la frappe passe devant", () => {
    const list = ["Analyse fonctionnelle", "Mécanique", "Fluides", "Mécanique des fluides"];
    expect(filterByTitle(list, "flu", (t) => [t])).toEqual(["Fluides", "Mécanique des fluides"]);
  });

  it("cherche aussi dans le nom du dossier", () => {
    const items = [{ title: "Électronique", dir: "Elec" }];
    expect(filterByTitle(items, "elec", (i) => [i.title, i.dir])).toHaveLength(1);
  });

  it("fleches dans une grille de 3 colonnes", () => {
    expect(gridStep(-1, "ArrowRight", 3, 7)).toBe(0);
    expect(gridStep(0, "ArrowRight", 3, 7)).toBe(1);
    expect(gridStep(0, "ArrowLeft", 3, 7)).toBe(0);
    expect(gridStep(1, "ArrowDown", 3, 7)).toBe(4);
    expect(gridStep(5, "ArrowDown", 3, 7)).toBe(5);
    expect(gridStep(4, "ArrowUp", 3, 7)).toBe(1);
    expect(gridStep(6, "ArrowRight", 3, 7)).toBe(6);
    expect(gridStep(0, "ArrowDown", 3, 0)).toBe(-1);
  });
});

describe("intercalaires", () => {
  it("deplace d'un cran, sans sortir de la liste", () => {
    expect(moveItem(["Cours", "Exos", "TD"], "TD", -1)).toEqual(["Cours", "TD", "Exos"]);
    expect(moveItem(["Cours", "Exos", "TD"], "Cours", 1)).toEqual(["Exos", "Cours", "TD"]);
    expect(moveItem(["Cours", "Exos"], "Cours", -1)).toEqual(["Cours", "Exos"]);
    expect(moveItem(["Cours"], "Absent", 1)).toEqual(["Cours"]);
  });

  it("split : Exos a droite de Cours, sinon le suivant", () => {
    expect(pickSplitDivider(["Cours", "TD", "Exos"], "Cours")).toBe("Exos");
    expect(pickSplitDivider(["Cours", "Annales", "TD"], "Cours")).toBe("TD");
    expect(pickSplitDivider(["Cours", "Annales", "Fiches"], "Cours")).toBe("Annales");
    expect(pickSplitDivider(["Cours", "Annales", "Fiches"], "Fiches")).toBe("Annales");
    expect(pickSplitDivider(["Cours"], "Cours")).toBeNull();
    expect(pickSplitDivider(["Cours", "Exos"], "Cours", ["Exos"])).toBeNull();
  });

  it("intercalaires imbriques : le TD du meme groupe d'abord (D4)", () => {
    const all = ["S2/TD", "S1/Cours", "S1/TD", "Annales"];
    expect(pickSplitDivider(all, "S1/Cours")).toBe("S1/TD");
    expect(pickSplitDivider(["S2/TD", "S1/Cours", "Annales"], "S1/Cours")).toBe("S2/TD");
  });

  it("historique : un groupe renomme ou supprime emmene son contenu (D4)", () => {
    const h = new NavHistory();
    h.push(spot("Elec", "E3A/S1/TP 4", 2));
    h.push(spot("Elec", "E3A/S10", 1));
    h.renameDivider("Elec", "E3A/S1", "E3A/Semestre 1");
    expect(h.pop()).toEqual(spot("Elec", "E3A/S10", 1));
    expect(h.pop()).toEqual(spot("Elec", "E3A/Semestre 1/TP 4", 2));
    h.push(spot("Elec", "E3A/S1/TP 4", 2));
    h.drop("Elec", "E3A/S1");
    expect(h.pop()).toBeNull();
  });
});

describe("liste des pages (manque-nav-pages)", () => {
  const now = new Date("2026-11-20T10:00:00");

  it("date courte d'une page", () => {
    expect(dayLabel("2026-10-03T09:12:00", now)).toBe("3 oct.");
    expect(dayLabel("2025-02-14T09:12:00", now)).toBe("14 févr. 2025");
    expect(dayLabel(undefined, now)).toBe("");
    expect(dayLabel("n'importe quoi", now)).toBe("");
  });

  it("premiere ligne lisible, coupee sur un mot", () => {
    expect(firstLineOf("\n\n  Théorème de Rolle  \nsuite")).toBe("Théorème de Rolle");
    const long = "Le critère de Riemann pour les intégrales généralisées dit que l'intégrale converge si et seulement si";
    const line = firstLineOf(long, 40);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(41);
    expect(firstLineOf("")).toBe("");
  });

  it("le resume d'une page porte sa date et sa premiere ligne", () => {
    const page: Page = {
      version: 1, id: "p", created: "2026-10-03T09:00:00.000Z", modified: "2026-10-04T09:00:00.000Z",
      blocks: [
        { id: "i", type: "ink", strokes: [], recognized: "écrit à la main", mode: "raw" },
        { id: "t", type: "text", content: "**Théorème** de Rolle\nsoit f continue" },
      ],
    };
    const idx = indexPage(page);
    expect(idx.created).toBe("2026-10-03T09:00:00.000Z");
    // Le texte tape d'abord, meme pose apres l'encre.
    expect(idx.firstLine).toBe("Théorème de Rolle");
    page.blocks.pop();
    expect(indexPage(page).firstLine).toBe("écrit à la main");
  });

  it("titres et listes (D11) : la liste montre le titre, la recherche le texte sans # ni -", () => {
    const page: Page = {
      version: 1, id: "p", created: "", modified: "",
      blocks: [{ id: "t", type: "text", content: "intro du cours\n# Diode $V_z$\n## Polarisation\n- Vs = Vz\n1. on mesure" }],
    };
    const idx = indexPage(page);
    expect(idx.title).toBe("Diode Vz");
    expect(idx.firstLine).toBe("Diode Vz");
    expect(idx.blocks[0].text).toBe("intro du cours\nDiode Vz\nPolarisation\nVs = Vz\non mesure");
    // Sans titre : la premiere ligne, sans son marqueur.
    page.blocks[0] = { id: "t", type: "text", content: "- premiere puce\nsuite" };
    expect(indexPage(page).title).toBeUndefined();
    expect(indexPage(page).firstLine).toBe("premiere puce");
  });
});

describe("intercalaire glisse dans la bande", () => {
  // Centres des onglets Cours, Exos, TD, TP.
  const centers = [50, 150, 250, 350];

  it("reste a sa place tant qu'il ne depasse aucun centre", () => {
    expect(dropIndex(centers, 1, 120)).toBe(1);
    expect(dropIndex(centers, 1, 240)).toBe(1);
  });

  it("vers la droite : la place du dernier centre depasse", () => {
    expect(dropIndex(centers, 0, 260)).toBe(2);
    expect(dropIndex(centers, 0, 999)).toBe(3);
  });

  it("vers la gauche : la place du premier centre depasse", () => {
    expect(dropIndex(centers, 3, 140)).toBe(1);
    expect(dropIndex(centers, 3, -20)).toBe(0);
  });

  it("moveTo garde l'ordre du reste et borne l'index", () => {
    const list = ["Cours", "Exos", "TD", "TP"];
    expect(moveTo(list, "TP", 1)).toEqual(["Cours", "TP", "Exos", "TD"]);
    expect(moveTo(list, "Cours", 3)).toEqual(["Exos", "TD", "TP", "Cours"]);
    expect(moveTo(list, "Exos", 99)).toEqual(["Cours", "TD", "TP", "Exos"]);
    expect(moveTo(list, "Absent", 0)).toEqual(list);
  });
});
