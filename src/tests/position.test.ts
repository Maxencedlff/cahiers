import { describe, it, expect } from "vitest";
import {
  Positions, POSITIONS_KEY, dropDividerIn, latestSpot, lastDivider, parsePositions,
  recordPosition, renameDividerIn, renameNotebookIn, startPage, type PositionMap,
} from "../core/position";

const T1 = "2026-10-01T08:00:00.000Z";
const T2 = "2026-10-01T09:00:00.000Z";

describe("derniere position par intercalaire (nav-3, D8)", () => {
  it("Cours p.4, Exos p.1, retour sur Cours : p.4", () => {
    let m: PositionMap = {};
    m = recordPosition(m, "Maths", "Cours", 4, T1);
    m = recordPosition(m, "Maths", "Exos", 1, T2);
    expect(startPage(m, "Maths", "Cours")).toBe(4);
    expect(startPage(m, "Maths", "Exos")).toBe(1);
    expect(m.Maths.divider).toBe("Exos");
  });

  it("un intercalaire jamais ouvert n'a pas de page retenue", () => {
    const m = recordPosition({}, "Maths", "Cours", 4, T1);
    expect(startPage(m, "Maths", "TD")).toBeUndefined();
  });

  it("l'ancienne position de cahier.json ne vaut que pour son intercalaire", () => {
    const legacy = { divider: "Exos", page: 4 };
    expect(startPage({}, "Maths", "Exos", legacy)).toBe(4);
    expect(startPage({}, "Maths", "Cours", legacy)).toBeUndefined();
    // La position de la machine passe devant.
    const m = recordPosition({}, "Maths", "Exos", 2, T1);
    expect(startPage(m, "Maths", "Exos", legacy)).toBe(2);
  });

  it("ignore une page invalide", () => {
    expect(recordPosition({}, "Maths", "Cours", 0, T1)).toEqual({});
    expect(recordPosition({}, "", "Cours", 3, T1)).toEqual({});
  });

  it("rouvre le dernier intercalaire s'il existe encore", () => {
    const m = recordPosition({}, "Maths", "TD", 3, T1);
    expect(lastDivider(m, "Maths", ["Cours", "TD"])).toBe("TD");
    expect(lastDivider(m, "Maths", ["Cours"])).toBeUndefined();
    expect(lastDivider({}, "Maths", ["Cours", "Exos"], { divider: "Exos", page: 1 })).toBe("Exos");
  });

  it("suit le renommage et la suppression d'un intercalaire", () => {
    let m = recordPosition({}, "Maths", "Exos", 5, T1);
    m = recordPosition(m, "Maths", "Cours", 2, T2);
    m = renameDividerIn(m, "Maths", "Exos", "Exercices");
    expect(startPage(m, "Maths", "Exercices")).toBe(5);
    expect(startPage(m, "Maths", "Exos")).toBeUndefined();
    m = dropDividerIn(m, "Maths", "Cours");
    expect(m.Maths.divider).toBe("Exercices");
    m = dropDividerIn(m, "Maths", "Exercices");
    expect(m.Maths).toBeUndefined();
  });

  it("un groupe renomme, deplace ou supprime emmene ses intercalaires (D4)", () => {
    let m = recordPosition({}, "Elec", "E3A/S10", 2, T1);
    m = recordPosition(m, "Elec", "E3A/S1/Chapitre 1", 4, T1);
    m = renameDividerIn(m, "Elec", "E3A/S1", "E3A/Semestre 1");
    expect(m.Elec.divider).toBe("E3A/Semestre 1/Chapitre 1");
    expect(startPage(m, "Elec", "E3A/Semestre 1/Chapitre 1")).toBe(4);
    expect(startPage(m, "Elec", "E3A/S10")).toBe(2);
    m = dropDividerIn(m, "Elec", "E3A/Semestre 1");
    expect(m.Elec.divider).toBe("E3A/S10");
    expect(startPage(m, "Elec", "E3A/Semestre 1/Chapitre 1")).toBeUndefined();
  });

  it("suit le renommage d'une matiere", () => {
    const m = renameNotebookIn(recordPosition({}, "Elec", "Cours", 3, T1), "Elec", "Électronique");
    expect(startPage(m, "Électronique", "Cours")).toBe(3);
    expect(m.Elec).toBeUndefined();
  });

  it("Reprendre = la visite la plus recente parmi les matieres qui existent", () => {
    let m = recordPosition({}, "Maths", "Cours", 4, T1);
    m = recordPosition(m, "Elec", "TP", 2, T2);
    expect(latestSpot(m, ["Maths", "Elec"])).toEqual({ notebook: "Elec", divider: "TP", page: 2 });
    expect(latestSpot(m, ["Maths"])).toEqual({ notebook: "Maths", divider: "Cours", page: 4 });
    expect(latestSpot(m, [])).toBeNull();
  });

  it("relit le stockage sans tomber sur un contenu abime", () => {
    expect(parsePositions(null)).toEqual({});
    expect(parsePositions("{ pas du json")).toEqual({});
    expect(parsePositions("[1,2]")).toEqual({});
    const m = parsePositions(JSON.stringify({
      Maths: { divider: "Cours", pages: { Cours: 3, Exos: -1, TD: "x" }, at: T1 },
      Bad: { pages: {} },
    }));
    expect(m).toEqual({ Maths: { divider: "Cours", pages: { Cours: 3 }, at: T1 } });
  });
});

describe("Positions (stockage local)", () => {
  const memory = () => {
    const data = new Map<string, string>();
    let writes = 0;
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { writes++; data.set(k, v); },
      get writes() { return writes; },
    };
  };

  it("garde la position d'une seance a l'autre", () => {
    const store = memory();
    const a = new Positions(store, () => T1);
    a.record("Maths", "Cours", 4);
    a.record("Maths", "Exos", 2);
    const b = new Positions(store);
    expect(b.pageFor("Maths", "Cours")).toBe(4);
    expect(b.dividerFor("Maths", ["Cours", "Exos"])).toBe("Exos");
  });

  it("n'ecrit pas deux fois la meme position (defilement)", () => {
    const store = memory();
    const p = new Positions(store, () => T1);
    p.record("Maths", "Cours", 4);
    p.record("Maths", "Cours", 4);
    expect(store.writes).toBe(1);
    expect(JSON.parse(store.getItem(POSITIONS_KEY)!).Maths.pages.Cours).toBe(4);
  });

  it("revenir sur la meme page apres une autre matiere fait avancer Reprendre", () => {
    let t = T1;
    const p = new Positions(memory(), () => t);
    p.record("Maths", "Cours", 4);
    t = "2026-10-02T10:00:00.000Z";
    p.record("Elec", "TD", 1);
    t = "2026-10-03T10:00:00.000Z";
    p.record("Maths", "Cours", 4);
    expect(p.latest(["Maths", "Elec"])).toEqual({ notebook: "Maths", divider: "Cours", page: 4 });
  });

  it("marche sans stockage, ou avec un stockage qui refuse", () => {
    const none = new Positions(null);
    none.record("Maths", "Cours", 2);
    expect(none.pageFor("Maths", "Cours")).toBe(2);
    const broken = new Positions({
      getItem: () => { throw new Error("bloque"); },
      setItem: () => { throw new Error("plein"); },
    });
    broken.record("Maths", "Cours", 3);
    expect(broken.pageFor("Maths", "Cours")).toBe(3);
  });
});
