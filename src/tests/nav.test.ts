import { describe, it, expect } from "vitest";
import { NavHistory, dayLabel, filterByTitle, gridStep, moveItem, pickSplitDivider } from "../core/nav";
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
