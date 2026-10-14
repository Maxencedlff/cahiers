import { describe, it, expect } from "vitest";
import {
  emptySchema, newTurtle, turtleMove, turtlePlace, turtleNode, turtleNextFree, turtleConnect,
  partPorts, junctions, movePart, deletePart, insertOnWire, wirePts, freePorts, addVoltage, schemaBounds,
} from "../core/schema/model";
import { drawSchema } from "../core/schema/render";

describe("schema : saisie au clavier (tortue)", () => {
  it("pont diviseur : fleche, R, noeud, R vers le bas, masse, retour au noeud", () => {
    const s = emptySchema("s1");
    const t = newTurtle({ x: 0, y: 0 });
    turtlePlace(s, t, "O");                 // borne d'entree
    turtleMove(s, t, "right", 2);
    const r1 = turtlePlace(s, t, "R");
    expect(r1.name).toBe("R1");
    expect(t.at).toEqual({ x: 6, y: 0 });   // repart de la borne b
    turtleMove(s, t, "right", 2);
    turtleNode(t);
    turtleMove(s, t, "down", 1);
    const r2 = turtlePlace(s, t, "R");
    expect(r2.name).toBe("R2");
    expect(r2.rot).toBe(90);
    expect(partPorts(r2).map((p) => [p.x, p.y])).toEqual([[8, 1], [8, 5]]);
    turtleMove(s, t, "down", 1);
    turtlePlace(s, t, "G");
    expect(t.at).toEqual({ x: 8, y: 0 });   // la masse ramene au noeud
    turtleMove(s, t, "right", 3);
    turtlePlace(s, t, "O");
    // Le noeud (8,0) relie trois branches : un point de jonction.
    expect(junctions(s)).toEqual([{ x: 8, y: 0 }]);
    expect(freePorts(s)).toEqual([]);
  });

  it("Tab choisit une borne libre, Entree la relie a angles droits", () => {
    const s = emptySchema("s2");
    const t = newTurtle({ x: 0, y: 0 });
    turtlePlace(s, t, "R");
    t.at = { x: 10, y: 4 };
    const pick = turtleNextFree(s, t);
    expect(pick).toBeDefined();
    expect(turtleConnect(s, t)).toBe(true);
    const w = s.wires[s.wires.length - 1];
    const pts = wirePts(w);
    for (let i = 0; i + 1 < pts.length; i++) expect(pts[i].x === pts[i + 1].x || pts[i].y === pts[i + 1].y).toBe(true);
  });
});

describe("schema : edition", () => {
  it("deplacer une piece : les fils suivent, toujours a angles droits", () => {
    const s = emptySchema("s3");
    const t = newTurtle({ x: 0, y: 0 });
    turtleMove(s, t, "right", 2);
    const r = turtlePlace(s, t, "R");
    turtleMove(s, t, "right", 2);
    movePart(s, r.id, 0, 3);
    const ports = partPorts(r);
    const ends = s.wires.flatMap((w) => { const p = wirePts(w); return [p[0], p[p.length - 1]]; });
    for (const q of ports) expect(ends.some((e) => e.x === q.x && e.y === q.y)).toBe(true);
    for (const w of s.wires) {
      const p = wirePts(w);
      for (let i = 0; i + 1 < p.length; i++) expect(p[i].x === p[i + 1].x || p[i].y === p[i + 1].y).toBe(true);
    }
  });

  it("supprimer un dipole relie : un fil le remplace ; ses annotations partent", () => {
    const s = emptySchema("s4");
    const t = newTurtle({ x: 0, y: 0 });
    turtleMove(s, t, "right", 2);
    const r = turtlePlace(s, t, "R");
    turtleMove(s, t, "right", 2);
    addVoltage(s, r);
    deletePart(s, r.id);
    expect(s.parts).toHaveLength(0);
    expect(s.notes).toBeUndefined();
    expect(s.wires.some((w) => { const p = wirePts(w); return p.length === 2 && p[0].x === 2 && p[1].x === 6; })).toBe(true);
  });

  it("poser une piece sur un fil le coupe a ses bornes", () => {
    const s = emptySchema("s5");
    const t = newTurtle({ x: 0, y: 0 });
    turtleMove(s, t, "right", 10);
    const c = insertOnWire(s, "C", 0, 0, { x: 5, y: 0 })!;
    expect(c).toBeTruthy();
    const ports = partPorts(c);
    expect(s.wires).toHaveLength(2);
    expect(freePorts(s)).toEqual([]);
    expect(ports[0].y).toBe(0);
  });
});

describe("schema : rendu", () => {
  it("SVG sans texte brut, etiquettes a poser, fleche de tension", () => {
    const s = emptySchema("s6");
    const t = newTurtle({ x: 0, y: 0 });
    turtleMove(s, t, "right", 2);
    const r = turtlePlace(s, t, "R");
    r.value = "10k";
    addVoltage(s, r);
    const d = drawSchema(s);
    expect(d.body).toContain('data-part="p1"');
    expect(d.body).not.toContain("<text");
    expect(d.labels.filter((l) => l.part === r.id).map((l) => l.lines)).toEqual([["R1"], ["10 kΩ"]]);
    expect(d.labels.some((l) => l.note === 0 && l.lines[0] === "uR1")).toBe(true);
    expect(d.box.w).toBeGreaterThan(0);
    expect(schemaBounds(s).w).toBe(d.box.w);
  });
});
