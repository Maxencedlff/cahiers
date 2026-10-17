import { describe, it, expect } from "vitest";
import type { SchemaBlock } from "../core/types";
import { SYMBOLS, fitWidth, presetByKey, symbolByLetter, symbolFor, portsAt } from "../core/schema/symbols";
import {
  addPart, addWire, emptySchema, freePorts, insertOnWire, newTurtle, partBox, partPorts, routeAround, setPartValue,
  stretchPart, sumSigns, toggleSign, turtleMove, turtlePlace, wirePts, type Pt,
} from "../core/schema/model";
import { drawSchema } from "../core/schema/render";
import { templateByKey, TEMPLATES } from "../core/schema/templates";
import { labelTex, labelWidth } from "../core/schema/label";
import { schemaSvgString } from "../ui/schema-view";

const port = (s: SchemaBlock, id: string, name: string) => partPorts(s.parts.find((p) => p.id === id)!).find((q) => q.name === name)!;
/** Bornes libres, sans les entrees inutilisees d'un comparateur (il en a trois, on n'en relie souvent que deux). */
const loose = (s: SchemaBlock) => freePorts(s).filter((f) => !(f.part.sym === "S" && (f.port.name === "in2" || f.port.name === "in3")));
const ortho = (pts: Pt[]) => pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);

describe("gain (triangle)", () => {
  it("Maj+G, sans lettre a lui, entree a gauche et sortie a la pointe", () => {
    expect(symbolByLetter("G")?.key).toBe("Gain");
    expect(symbolByLetter("g")?.key).toBe("G");
    const d = SYMBOLS.Gain;
    expect(d.letter).toBe("");
    expect(d.through).toEqual(["in", "out"]);
    expect(d.ports).toEqual([{ name: "in", x: 0, y: 2 }, { name: "out", x: 4, y: 2 }]);
    expect(d.body).toContain("<path");
  });

  it("trace vers la gauche (retour) : tourne d'un demi-tour, entree a droite", () => {
    const s = emptySchema("x");
    const t = newTurtle({ x: 20, y: 10 });
    turtleMove(s, t, "left", 2);
    const g = turtlePlace(s, t, "Gain");
    expect(g.rot).toBe(180);
    expect(port(s, g.id, "in")).toMatchObject({ x: 18, y: 10 });
    expect(port(s, g.id, "out")).toMatchObject({ x: 14, y: 10 });
    expect(t.at).toEqual({ x: 14, y: 10 });
  });

  it("le texte reste dans le triangle, aussi tourne", () => {
    const s = emptySchema("x");
    const g = addPart(s, "Gain", { x: 0, y: 0 });
    g.value = "K";
    const l0 = drawSchema(s).labels.find((l) => l.part === g.id)!;
    expect(l0.x).toBeCloseTo(1.6);
    g.rot = 180;
    const l1 = drawSchema(s).labels.find((l) => l.part === g.id)!;
    expect(l1.x).toBeCloseTo(2.4);
    expect(l1.anchor).toBe("middle");
  });

  it("pas de circuit ouvert ni de nom automatique pour un gain", () => {
    const s = emptySchema("x");
    const g = addPart(s, "Gain", { x: 0, y: 0 });
    expect(g.name).toBeUndefined();
  });
});

describe("bloc a la largeur de son texte", () => {
  it("fitWidth : au moins 4, le texte tient", () => {
    expect(fitWidth("B", labelWidth("∫dt") * 0.95)).toBe(4);
    const long = fitWidth("B", labelWidth("τ dy/dt + y(t) = K e(t)") * 0.95);
    expect(long).toBeGreaterThanOrEqual(11);
    expect(fitWidth("Gain", labelWidth("K") * 0.95)).toBe(4);
    expect(fitWidth("Gain", labelWidth("ω_0^2") * 0.95)).toBe(4);
    expect(fitWidth("Gain", labelWidth("2mω_0") * 0.95)).toBe(5);
    expect(fitWidth("Gain", labelWidth("K/(1+τp)") * 0.95)).toBeGreaterThan(4);
  });

  it("symbolFor : sortie, dessin et texte suivent la largeur ; sans w = la table", () => {
    expect(symbolFor("B")).toBe(SYMBOLS.B);
    expect(symbolFor("R", 9)).toBe(SYMBOLS.R);
    const d = symbolFor("B", 12);
    expect(d.w).toBe(12);
    expect(d.ports.find((p) => p.name === "out")).toEqual({ name: "out", x: 12, y: 2 });
    expect(d.labelAt.x).toBe(6);
    expect(d.body).toContain('width="12"');
    expect(portsAt("B", 0, 0, 180, false, 12).find((p) => p.name === "in")).toEqual({ name: "in", x: 12, y: 2 });
  });

  it("ancien bloc (sans w) lu tel quel : 6 cases", () => {
    const s: SchemaBlock = { id: "x", type: "schema", parts: [{ id: "p1", sym: "B", x: 5, y: 2, value: "Σ" }], wires: [{ pts: [0, 4, 5, 4] }, { pts: [11, 4, 17, 4] }] };
    expect(partBox(s.parts[0]).w).toBe(6);
    expect(freePorts(s).length).toBe(0);
  });

  it("texte long : le bloc s'elargit, ce qui suit glisse, le retour s'allonge", () => {
    const s = emptySchema("x");
    addWire(s, [{ x: 0, y: 6 }, { x: 4, y: 6 }]);
    const b = addPart(s, "B", { x: 4, y: 4 });
    addWire(s, [{ x: 10, y: 6 }, { x: 16, y: 6 }]);
    addWire(s, [{ x: 13, y: 6 }, { x: 13, y: 10 }, { x: 2, y: 10 }, { x: 2, y: 6 }]);
    (s.notes ??= []).push({ kind: "text", x: 14, y: 5, label: "y(t)" });
    const moved = setPartValue(s, b.id, "τ dy/dt + y(t) = K e(t)");
    const w = b.w!;
    expect(w).toBeGreaterThan(6);
    expect(moved).toEqual({ from: { x: 10, y: 6 }, to: { x: 4 + w, y: 6 } });
    expect(port(s, b.id, "in")).toMatchObject({ x: 4, y: 6 });
    // Fil de sortie et retour decales, toujours accroches.
    expect(s.wires[1].pts).toEqual([4 + w, 6, 16 + w - 6, 6]);
    expect(s.wires[2].pts).toEqual([13 + w - 6, 6, 13 + w - 6, 10, 2, 10, 2, 6]);
    expect(s.notes![0].x).toBe(14 + w - 6);
    expect(freePorts(s).length).toBe(0);
  });

  it("texte court : il retrecit si la place liberee est vide", () => {
    const s = emptySchema("x");
    const b = addPart(s, "B", { x: 4, y: 4 });
    addWire(s, [{ x: 10, y: 6 }, { x: 16, y: 6 }]);
    setPartValue(s, b.id, "∫dt");
    expect(partBox(b).w).toBe(4);
    expect(s.wires[0].pts).toEqual([8, 6, 14, 6]);
    // Un fil vertical dans la bande : on ne retrecit pas.
    const s2 = emptySchema("y");
    const b2 = addPart(s2, "B", { x: 4, y: 4 });
    b2.w = 10;
    addWire(s2, [{ x: 12, y: 0 }, { x: 12, y: 3 }]);
    expect(stretchPart(s2, b2.id, 4)).toBeNull();
    expect(b2.w).toBe(10);
  });

  it("gain de retour (pointe a gauche) : s'allonge vers la gauche, l'entree reste", () => {
    const s = emptySchema("x");
    addWire(s, [{ x: 30, y: 10 }, { x: 10, y: 10 }]);
    const g = insertOnWire(s, "Gain", 0, 0, { x: 20, y: 10 })!;
    expect(g.rot).toBe(180);
    const inB = port(s, g.id, "in");
    setPartValue(s, g.id, "K/(1+τp)");
    expect(port(s, g.id, "in")).toEqual(inB);
    expect(freePorts(s).length).toBe(0);
    for (const w of s.wires) expect(ortho(wirePts(w))).toBe(true);
  });

  it("Maj+B : integrateur pret (bloc ∫dt)", () => {
    expect(presetByKey("B")).toMatchObject({ sym: "B", value: "∫dt" });
    expect(presetByKey("b")).toBeUndefined();
  });
});

describe("comparateur : signes", () => {
  it("+ a gauche, − sur les entrees du haut et du bas, la valeur les choisit", () => {
    expect(sumSigns({ id: "p", sym: "S", x: 0, y: 0 })).toEqual({ in: "+", in2: "−", in3: "−" });
    expect(sumSigns({ id: "p", sym: "S", x: 0, y: 0, value: "++" })).toEqual({ in: "+", in2: "+", in3: "−" });
  });

  it("un signe par entree reliee, pres de l'entree ; un clic l'inverse", () => {
    const s = emptySchema("x");
    const S = addPart(s, "S", { x: 10, y: 5 });
    addWire(s, [{ x: 6, y: 6 }, { x: 10, y: 6 }]);
    addWire(s, [{ x: 11, y: 10 }, { x: 11, y: 7 }]);
    const signs = drawSchema(s).labels.filter((l) => l.sign);
    expect(signs.map((l) => [l.sign, l.lines[0]])).toEqual([["in", "+"], ["in2", "−"]]);
    const minus = signs.find((l) => l.sign === "in2")!;
    expect(minus.x).toBeLessThan(11);
    expect(minus.y).toBeGreaterThan(7);
    toggleSign(s, S.id, "in2");
    expect(S.value).toBe("++-");
    expect(drawSchema(s).labels.find((l) => l.sign === "in2")!.lines[0]).toBe("+");
    toggleSign(s, S.id, "in");
    expect(S.value).toBe("-+-");
  });

  it("comparateur tourne : le signe reste du cote de l'entree", () => {
    const s = emptySchema("x");
    const S = addPart(s, "S", { x: 10, y: 5 }, 180);
    const inP = port(s, S.id, "in");
    addWire(s, [{ x: inP.x + 3, y: inP.y }, inP]);
    const l = drawSchema(s).labels.find((x) => x.sign === "in")!;
    expect(l.x).toBeGreaterThan(inP.x);
  });
});

describe("boucle de retour en un geste", () => {
  /** e -> S -> B -> sortie, comme au tableau. */
  const chain = () => {
    const s = emptySchema("x");
    addWire(s, [{ x: 0, y: 6 }, { x: 10, y: 6 }]);
    const S = addPart(s, "S", { x: 10, y: 5 });
    addWire(s, [{ x: 12, y: 6 }, { x: 16, y: 6 }]);
    const B = addPart(s, "B", { x: 16, y: 4 });
    addWire(s, [{ x: 22, y: 6 }, { x: 30, y: 6 }]);
    return { s, S, B };
  };

  it("de la sortie vers l'entree − du bas : par-dessous, 3 cases sous les pieces", () => {
    const { s } = chain();
    const r = routeAround(s, { x: 27, y: 6 }, { x: 11, y: 7 });
    expect(r).toEqual([{ x: 27, y: 6 }, { x: 27, y: 11 }, { x: 11, y: 11 }, { x: 11, y: 7 }]);
  });

  it("vers l'entree du haut : par-dessus", () => {
    const { s } = chain();
    const r = routeAround(s, { x: 27, y: 6 }, { x: 11, y: 5 });
    expect(r).toEqual([{ x: 27, y: 6 }, { x: 27, y: 1 }, { x: 11, y: 1 }, { x: 11, y: 5 }]);
  });

  it("depuis une borne de sortie libre : sort d'abord vers la droite, ne traverse aucune piece", () => {
    const s = emptySchema("x");
    const S = addPart(s, "S", { x: 10, y: 5 });
    const B = addPart(s, "B", { x: 16, y: 4 });
    addWire(s, [{ x: 12, y: 6 }, { x: 16, y: 6 }]);
    const r = routeAround(s, port(s, B.id, "out"), port(s, S.id, "in2"));
    expect(ortho(r)).toBe(true);
    expect(r[1]).toEqual({ x: 23, y: 6 });
    expect(r[r.length - 1]).toEqual({ x: 11, y: 7 });
    expect(Math.max(...r.map((p) => p.y))).toBe(11);
  });

  it("vers l'entree gauche d'un bloc depuis la droite : contourne et arrive par la gauche", () => {
    const s = emptySchema("x");
    const B = addPart(s, "B", { x: 10, y: 4 });
    const r = routeAround(s, { x: 20, y: 6 }, port(s, B.id, "in"));
    expect(ortho(r)).toBe(true);
    const n = r.length;
    expect(r[n - 2]).toEqual({ x: 9, y: 6 });
  });

  it("vers l'avant sans obstacle : fil droit", () => {
    const s = emptySchema("x");
    const B = addPart(s, "B", { x: 10, y: 4 });
    expect(routeAround(s, { x: 2, y: 6 }, port(s, B.id, "in"))).toEqual([{ x: 2, y: 6 }, { x: 10, y: 6 }]);
  });
});

describe("modeles de schemas-blocs", () => {
  const block = (key: string): SchemaBlock => ({ id: "x", type: "schema", ...templateByKey(key)!.build() });

  it("trois modeles dans le groupe Schemas-blocs", () => {
    expect(TEMPLATES.filter((t) => t.group === "Schémas-blocs").map((t) => t.key)).toEqual(["transfert", "ordre1", "ordre2"]);
  });

  for (const key of ["transfert", "ordre1", "ordre2"]) {
    it(`${key} : fils a angles droits, tout est relie, aucun fil ne traverse une piece`, () => {
      const s = block(key);
      for (const w of s.wires) expect(ortho(wirePts(w))).toBe(true);
      // Seules bornes libres : aucune (e(t) et y(t) sont des bouts de fil).
      expect(loose(s)).toEqual([]);
      const d = drawSchema(s);
      expect(d.body).not.toContain("NaN");
    });
  }

  it("1er ordre : e -> K -> comparateur (+,−) -> 1/τ -> ∫dt -> y, retour par-dessous", () => {
    const s = block("ordre1");
    expect(s.parts.map((p) => [p.sym, p.value])).toEqual([["Gain", "K"], ["S", "+-"], ["Gain", "1/τ"], ["B", "∫dt"]]);
    const labels = (s.notes ?? []).map((n) => n.label);
    expect(labels).toEqual(["e(t)", "dy/dt", "y(t)"]);
    const S = s.parts[1];
    const fb = s.wires[s.wires.length - 1];
    const p = wirePts(fb);
    expect(port(s, S.id, "in2")).toMatchObject(p[p.length - 1]);
    expect(Math.max(...p.map((q) => q.y))).toBeGreaterThan(8);
    const signs = drawSchema(s).labels.filter((l) => l.sign).map((l) => l.lines[0]);
    expect(signs).toEqual(["+", "−"]);
  });

  it("2e ordre : comparateur (+,−,−), deux integrateurs, retours 2mω₀ (dessous) et ω₀² (dessus) en gains pointes a gauche", () => {
    const s = block("ordre2");
    const gains = s.parts.filter((p) => p.sym === "Gain");
    expect(gains.map((g) => g.value)).toEqual(["K", "2mω_0", "ω_0^2"]);
    expect(gains[1].rot).toBe(180);
    expect(partBox(gains[1]).w).toBe(5);
    expect(gains[2].rot).toBe(180);
    expect(partBox(gains[1]).y).toBeGreaterThan(6);
    expect(partBox(gains[2]).y + partBox(gains[2]).h).toBeLessThan(6);
    expect(s.parts.filter((p) => p.sym === "B").length).toBe(2);
    expect(s.parts.find((p) => p.sym === "S")!.value).toBe("+--");
    expect((s.notes ?? []).map((n) => n.label)).toEqual(["e(t)", "d²y/dt²", "dy/dt", "y(t)"]);
    const signs = drawSchema(s).labels.filter((l) => l.sign).map((l) => l.lines[0]);
    expect(signs.sort()).toEqual(["+", "−", "−"]);
  });

  it("bloc de transfert : e(t) -> [H(p)] -> s(t), fleche en sortie", () => {
    const s = block("transfert");
    expect(s.parts.map((p) => [p.sym, p.value])).toEqual([["B", "H(p)"]]);
    expect(drawSchema(s).body).toContain("sch-out");
  });

  it("au plus 30 gestes a la main pour le 1er ordre (modele = 2 clics)", () => {
    // Clavier : fleche, Maj+G, K, Entree, 2 fleches, s, 2 fleches, Maj+G, 1/τ, Entree, 2 fleches, Maj+B, 3 fleches = ~20 touches + 1 geste de retour.
    const s = emptySchema("x");
    const t = newTurtle({ x: 0, y: 6 });
    turtleMove(s, t, "right", 4);
    setPartValue(s, turtlePlace(s, t, "Gain").id, "K");
    turtleMove(s, t, "right", 3);
    turtlePlace(s, t, "S");
    turtleMove(s, t, "right", 4);
    setPartValue(s, turtlePlace(s, t, "Gain").id, "1/τ");
    turtleMove(s, t, "right", 4);
    const I = turtlePlace(s, t, "B");
    const moved = setPartValue(s, I.id, "∫dt");
    // L'editeur fait suivre le curseur : de l'ancienne sortie a la nouvelle.
    expect(moved?.from).toEqual(t.at);
    t.at = moved!.to;
    expect(port(s, I.id, "out")).toMatchObject(t.at);
    turtleMove(s, t, "right", 6);
    const S = s.parts[1];
    addWire(s, routeAround(s, { x: t.at.x - 3, y: 6 }, port(s, S.id, "in2")));
    expect(loose(s)).toEqual([]);
    expect(sumSigns(S)).toMatchObject({ in: "+", in2: "−" });
  });
});

describe("etiquettes et export Word", () => {
  it("« 2mω_0 » : une formule (2 m ω₀), plus de « _ » ; une unite reste une unite", () => {
    expect(labelTex("2mω_0")).toBe("2\\,m\\,\\omega_0");
    expect(labelTex("10 kΩ")).toContain("\\mathrm{k}");
    expect(labelTex("2 m")).toBe("2\\,\\mathrm{m}");
  });

  it("Word : triangle du gain, signes du comparateur et fleches dans l'image", () => {
    const s: SchemaBlock = { id: "x", type: "schema", ...templateByKey("ordre2")!.build() };
    const { svg } = schemaSvgString(s, 16);
    expect(svg).toMatch(/<path d="M0 0.2 L0 3.8 L[\d.]+ 2 Z"/);
    expect((svg.match(/>−</g) ?? []).length).toBe(2);
    expect(svg).toContain(">+<");
    expect(svg).toContain("sch-in");
    expect(svg).not.toContain("NaN");
  });
});
