import { describe, it, expect } from "vitest";
import { PageHistory, restoreBlocks } from "../core/history";
import type { Block } from "../core/types";

const ink = (n: number): Block => ({
  id: "ink", type: "ink", recognized: null, mode: "raw",
  strokes: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })) as never[],
});
const body = (content: string): Block => ({ id: "body", type: "text", content });
const photo: Block = { id: "img1", type: "image", src: "assets/img1.png", ocr: "loi d'Ohm" };

describe("annulation par page", () => {
  it("chaque page a ses propres piles", () => {
    const h = new PageHistory();
    h.push("p1", "a");
    h.push("p1", "b");
    h.push("p2", "x");
    expect(h.undo("p1", "c")).toBe("b");
    expect(h.undo("p2", "y")).toBe("x");
    expect(h.undo("p1", "b")).toBe("a");
  });

  it("une page sans historique ne consomme rien ailleurs", () => {
    const h = new PageHistory();
    h.push("p1", "a");
    h.push("p1", "b");
    // Ctrl+Z sur la p.2 : rien, et la p.1 garde ses deux pas.
    expect(h.undo("p2", "z")).toBeNull();
    expect(h.canUndo("p1")).toBe(true);
    expect(h.undo("p1", "c")).toBe("b");
    expect(h.undo("p1", "b")).toBe("a");
    expect(h.undo("p1", "a")).toBeNull();
  });

  it("retablir puis une nouvelle modification vide le retablir", () => {
    const h = new PageHistory();
    h.push("p1", "a");
    expect(h.undo("p1", "b")).toBe("a");
    expect(h.redo("p1", "a")).toBe("b");
    expect(h.undo("p1", "b")).toBe("a");
    h.push("p1", "a");
    expect(h.canRedo("p1")).toBe(false);
    expect(h.redo("p1", "x")).toBeNull();
  });

  it("une page supprimee perd son historique", () => {
    const h = new PageHistory();
    h.push("p1", "a");
    h.drop("p1");
    expect(h.undo("p1", "b")).toBeNull();
  });

  it("limite la profondeur", () => {
    const h = new PageHistory(3);
    for (const s of ["1", "2", "3", "4"]) h.push("p", s);
    expect(h.undo("p", "5")).toBe("4");
    expect(h.undo("p", "4")).toBe("3");
    expect(h.undo("p", "3")).toBe("2");
    expect(h.undo("p", "2")).toBeNull();
  });
});

describe("restauration des blocs", () => {
  it("trait, photo, annuler : la photo reste", () => {
    // Instantane pris avant le 2e trait, donc avant la photo.
    const snapshot = [ink(1)];
    const current = [ink(2), body("Le tableau ![](img:img1)"), photo];
    const out = restoreBlocks(current, JSON.parse(JSON.stringify(snapshot)));
    const types = out.map((b) => b.type);
    expect(types).toContain("image");
    expect(out.find((b) => b.type === "image")).toEqual(photo);
    expect((out.find((b) => b.type === "ink") as { strokes: unknown[] }).strokes).toHaveLength(1);
    expect(out.find((b) => b.type === "text")).toEqual(body("Le tableau ![](img:img1)"));
  });

  it("le texte tape n'est pas ramene en arriere", () => {
    const out = restoreBlocks([ink(2), body("nouveau")], [ink(1), body("ancien")]);
    expect(out.filter((b) => b.type === "text")).toEqual([body("nouveau")]);
  });

  it("les blocs poses sur la page suivent l'annulation", () => {
    const flag: Block = { id: "f", type: "flag", note: "A revoir", rect: { x: 1, y: 1, w: 30, h: 30 } };
    const out = restoreBlocks([ink(1), flag], [ink(1)]);
    expect(out.some((b) => b.type === "flag")).toBe(false);
  });

  it("pas de doublon d'une ancienne photo flottante rangee dans le texte", () => {
    const floating: Block = { ...photo, rect: { x: 0, y: 0, w: 100, h: 100 } } as Block;
    const out = restoreBlocks([body("![](img:img1)"), photo], [floating]);
    expect(out.filter((b) => b.id === "img1")).toHaveLength(1);
  });
});
