import { describe, it, expect } from "vitest";
import { isTap, isWantedDot, TAP_MS, TOUCH_TAP_MS, DOT_WINDOW_MS } from "../core/ink/pointer";
import { isScribble, reversals, scribbleTargets, straighten } from "../core/ink/gestures";
import { Fling, VelocityTracker, MAX_MS } from "../core/kinetic";
import { pickAt, selBarTop } from "../core/ink/selection";
import { recoStrokes, planIncremental, dirtyStrokes } from "../core/ink/bands";
import type { Block, InkBlock, InkPoint, Stroke } from "../core/types";

/* Lot stylet : appui court, point voulu, appui long, gestes, inertie. */

const pts = (list: [number, number][]): InkPoint[] => list.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 8 }));

function stroke(id: string, list: [number, number][], tool: Stroke["tool"] = "pen"): Stroke {
  return { id, color: "normal", width: 2, tool, points: pts(list) };
}

function line(id: string, x0: number, y0: number, x1: number, y1: number, n = 12): Stroke {
  const l: [number, number][] = [];
  for (let i = 0; i < n; i++) l.push([x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1)]);
  return stroke(id, l);
}

function ink(strokes: Stroke[], extra: Partial<InkBlock> = {}): InkBlock {
  return { id: "ink", type: "ink", strokes, recognized: null, mode: "raw", ...extra };
}

/** Zigzag : `passes` allers-retours horizontaux de largeur w, descendant de dy en tout. */
function zigzag(x: number, y: number, w: number, passes: number, dy: number, steps = 6): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < passes; k++) {
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const px = k % 2 === 0 ? x + f * w : x + w - f * w;
      out.push([px, y + ((k + f) / passes) * dy]);
    }
  }
  return out;
}

describe("appui court : jamais de l'encre", () => {
  it("moins de 3 px et moins de 200 ms = appui", () => {
    expect(isTap(0, 50)).toBe(true);
    expect(isTap(2.5, TAP_MS - 1)).toBe(true);
    expect(isTap(3, 50)).toBe(false);
    expect(isTap(1, TAP_MS)).toBe(false);
  });

  it("le doigt a plus de marge (largeur, lenteur)", () => {
    expect(isTap(5, 300, "touch")).toBe(true);
    expect(isTap(7, 100, "touch")).toBe(false);
    expect(isTap(0, TOUCH_TAP_MS, "touch")).toBe(false);
  });

  it("point voulu : un trait pose tout pres dans les 1,5 s", () => {
    const recent = [{ bounds: { x: 100, y: 100, w: 4, h: 20 }, endedAt: 1000 }];
    // Point du i, juste au-dessus du jambage.
    expect(isWantedDot({ x: 102, y: 90 }, 1500, recent)).toBe(true);
    // Trop tard.
    expect(isWantedDot({ x: 102, y: 90 }, 1000 + DOT_WINDOW_MS + 1, recent)).toBe(false);
    // Trop loin (ailleurs sur la page).
    expect(isWantedDot({ x: 300, y: 400 }, 1500, recent)).toBe(false);
    // Rien d'ecrit avant : appui isole.
    expect(isWantedDot({ x: 102, y: 90 }, 1500, [])).toBe(false);
  });
});

describe("reconnaissance : appuis isoles jamais envoyes", () => {
  const word = line("w", 100, 100, 160, 100);
  const tapFar = stroke("tap", [[400, 600], [400.6, 600]]);
  const dotNear = stroke("dot", [[130, 85], [130.6, 85]]);

  it("un trait d'1 ou 2 points isole est retire, un point pres d'un mot reste", () => {
    const ids = recoStrokes([word, tapFar, dotNear]).map((s) => s.id);
    expect(ids).toEqual(["w", "dot"]);
  });

  it("le surligneur n'est jamais envoye", () => {
    expect(recoStrokes([line("h", 0, 0, 50, 0)].map((s) => ({ ...s, tool: "highlighter" as const })))).toEqual([]);
  });

  it("fond de page : l'appui isole ne part pas et ne reste pas « a lire »", () => {
    const b = ink([word, tapFar]);
    expect(planIncremental(b).all.map((s) => s.id)).toEqual(["w"]);
    expect(dirtyStrokes(b).map((s) => s.id)).toEqual(["w"]);
    // Le mot lu : plus rien a lire, l'appui isole ne retient pas le bloc.
    const read = ink([word, tapFar], { words: [{ label: "le", strokeIds: ["w"], box: { x: 100, y: 90, w: 60, h: 20 } }] });
    expect(dirtyStrokes(read)).toEqual([]);
  });
});

describe("gribouillage", () => {
  it("zigzag dense sur place : gribouillage", () => {
    expect(isScribble(zigzag(100, 100, 60, 8, 12).map(([x, y]) => ({ x, y })))).toBe(true);
  });

  it("trop peu d'allers-retours : non", () => {
    expect(isScribble(zigzag(100, 100, 60, 3, 12).map(([x, y]) => ({ x, y })))).toBe(false);
  });

  it("resistance en zigzag (elle avance) : non", () => {
    const r: { x: number; y: number }[] = [];
    for (let i = 0; i <= 12; i++) r.push({ x: 100 + i * 5, y: 100 + (i % 2 ? 8 : -8) });
    expect(isScribble(r)).toBe(false);
  });

  it("« mmm » ou « www » ecrits : non", () => {
    const m: { x: number; y: number }[] = [];
    for (let i = 0; i <= 18; i++) m.push({ x: 100 + i * 4, y: 100 + (i % 2 ? 0 : 14) });
    expect(isScribble(m)).toBe(false);
  });

  it("une ligne droite ou un cercle : non", () => {
    expect(isScribble(line("l", 0, 0, 100, 0, 30).points)).toBe(false);
    const c = Array.from({ length: 40 }, (_, i) => ({ x: 50 + 20 * Math.cos(i / 6), y: 50 + 20 * Math.sin(i / 6) }));
    expect(isScribble(c)).toBe(false);
  });

  it("demi-tours comptes avec une hysteresis", () => {
    expect(reversals([0, 10, 0, 10, 0], 4)).toBe(3);
    expect(reversals([0, 10, 9, 10, 0], 4)).toBe(1); // le tremblement ne compte pas
  });

  it("efface les traits recouverts, pas les voisins", () => {
    const under = line("u", 110, 104, 150, 104);
    const neighbour = line("n", 200, 104, 260, 104);
    const half = line("h", 140, 104, 230, 104); // a peine touche
    const scr = zigzag(100, 98, 60, 8, 12).map(([x, y]) => ({ x, y }));
    expect(scribbleTargets(scr, [under, neighbour, half])).toEqual(["u"]);
  });
});

describe("pointe tenue : redressement", () => {
  it("trait presque droit = segment entre ses bouts", () => {
    const wobbly = stroke("s", [[0, 0], [20, 1.5], [40, -1], [60, 1], [80, 0]]).points;
    const s = straighten(wobbly);
    expect(s?.kind).toBe("line");
    expect(s?.points.map((p) => [p.x, p.y])).toEqual([[0, 0], [80, 0]]);
  });

  it("trait ferme quasi rectangulaire = rectangle", () => {
    const r: [number, number][] = [];
    for (let x = 0; x <= 100; x += 10) r.push([x, 0.8]);
    for (let y = 0; y <= 60; y += 10) r.push([99, y]);
    for (let x = 100; x >= 0; x -= 10) r.push([x, 59.5]);
    for (let y = 60; y >= 4; y -= 10) r.push([1, y]);
    const s = straighten(pts(r));
    expect(s?.kind).toBe("rect");
    expect(s?.points).toHaveLength(5);
    expect(s?.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(s?.points[2]).toMatchObject({ x: 100, y: 60 });
  });

  it("ecriture (courbe) ou cercle : rien", () => {
    const curve = Array.from({ length: 20 }, (_, i) => [i * 5, 30 * Math.sin(i / 3)] as [number, number]);
    expect(straighten(pts(curve))).toBeNull();
    const circle = Array.from({ length: 41 }, (_, i) => [50 + 30 * Math.cos((i / 40) * 2 * Math.PI), 50 + 30 * Math.sin((i / 40) * 2 * Math.PI)] as [number, number]);
    expect(straighten(pts(circle))).toBeNull();
  });

  it("trop court : rien", () => {
    expect(straighten(pts([[0, 0], [5, 0], [10, 0]]))).toBeNull();
  });
});

describe("appui long : selection directe", () => {
  const a = line("a", 100, 100, 120, 100);
  const b = line("b", 122, 100, 140, 100);
  const c = line("c", 300, 100, 340, 100);
  const blocks: Block[] = [
    ink([a, b, c], { words: [{ label: "le", strokeIds: ["a", "b"], box: { x: 100, y: 90, w: 40, h: 20 } }] }),
  ];

  it("sur un mot lu : tous ses traits", () => {
    expect([...pickAt(blocks, 110, 101)].sort()).toEqual(["a", "b"]);
    // Dans la boite du mot, entre deux traits.
    expect([...pickAt(blocks, 121, 95)].sort()).toEqual(["a", "b"]);
  });

  it("sur un trait sans mot : ce trait", () => {
    expect([...pickAt(blocks, 320, 102)]).toEqual(["c"]);
  });

  it("dans le blanc : rien", () => {
    expect(pickAt(blocks, 600, 600).size).toBe(0);
  });

  it("zone reconnue : entiere", () => {
    const z1 = line("z1", 500, 500, 520, 500), z2 = line("z2", 500, 540, 520, 540);
    const zone: Block = { id: "z", type: "math", mode: "math", strokes: [z1, z2], latex: "x", rect: { x: 495, y: 495, w: 30, h: 50 } };
    expect([...pickAt([...blocks, zone], 510, 500)].sort()).toEqual(["z1", "z2"]);
  });
});

describe("barre du lasso : jamais sur une ligne de texte", () => {
  const base = { left: 100, width: 300, height: 50, frameTop: 300, frameBottom: 360, sheetHeight: 1200 };

  it("au-dessus du cadre quand c'est libre", () => {
    expect(selBarTop([], base)).toBe(300 - 50 - 8);
  });

  it("une ligne de texte au-dessus : la barre passe au-dessus d'elle", () => {
    const lines = [{ top: 230, bottom: 260, left: 0, right: 800 }];
    const top = selBarTop(lines, base);
    expect(top + 50).toBeLessThanOrEqual(230);
  });

  it("texte serre au-dessus : dessous, hors des lignes", () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ top: i * 25, bottom: i * 25 + 22, left: 0, right: 800 }));
    const top = selBarTop(lines, base);
    expect(top).toBeGreaterThanOrEqual(360);
    for (const l of lines) expect(l.bottom <= top || l.top >= top + 50).toBe(true);
  });

  it("texte a cote (hors de la largeur de la barre) : ne gene pas", () => {
    const lines = [{ top: 240, bottom: 260, left: 600, right: 800 }];
    expect(selBarTop(lines, base)).toBe(242);
  });
});

describe("defilement avec inertie", () => {
  it("vitesse mesuree sur les dernieres ~100 ms", () => {
    const v = new VelocityTracker();
    // Lent au debut, puis 2 px/ms vers le haut.
    v.add(0, 0, 500);
    v.add(200, 0, 490);
    for (let t = 210; t <= 300; t += 10) v.add(t, 0, 490 - (t - 200) * 2);
    const s = v.velocity(305);
    expect(s.vx).toBe(0);
    expect(s.vy).toBeCloseTo(-2, 1);
  });

  it("doigt arrete avant le lever : aucune glisse", () => {
    const v = new VelocityTracker();
    v.add(0, 0, 0);
    v.add(50, 0, 100);
    expect(v.velocity(400)).toEqual({ vx: 0, vy: 0 });
  });

  it("decroissance exponentielle, arret en temps borne", () => {
    const f = new Fling(0, 3);
    const a = f.step(16), b = f.step(16);
    expect(a.dy).toBeGreaterThan(b.dy);
    expect(b.dy / a.dy).toBeCloseTo(Math.exp(-16 / 325), 3);
    let total = a.dy + b.dy, t = 32;
    while (!f.done) { total += f.step(16).dy; t += 16; }
    expect(t).toBeLessThanOrEqual(MAX_MS + 16);
    // Distance totale ~ v0 * tau (glisse courte, pas de boucle sans fin).
    expect(total).toBeGreaterThan(800);
    expect(total).toBeLessThan(3 * 325 + 1);
    expect(f.step(16)).toEqual({ dx: 0, dy: 0 });
  });

  it("un appui sans elan ne lance rien", () => {
    expect(Fling.worth(0.05, 0.1)).toBe(false);
    expect(Fling.worth(0, 1)).toBe(true);
  });
});
