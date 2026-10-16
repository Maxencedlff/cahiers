import { describe, it, expect } from "vitest";
import {
  partBox, emptySchema, addPart, addVoltage, addWire, addText, addArrow, partPorts, wirePts, junctions, freePorts,
  toggleOpen, shortPart, currentOnWire, moveNote, flipNote, moveGroup, extractGroup, pasteGroup, partsIn, nearestOnWire,
} from "../core/schema/model";
import { drawSchema, labelBox, type SchemaLabel } from "../core/schema/render";
import { labelTex, labelWidth } from "../core/schema/label";
import { TEMPLATES, templateByKey } from "../core/schema/templates";
import type { SchemaBlock } from "../core/types";

function fromTemplate(key: string): SchemaBlock {
  const s = emptySchema(key);
  pasteGroup(s, templateByKey(key)!.build(), 0, 0, true);
  return s;
}

type Box = { x: number; y: number; w: number; h: number };
const over = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function segInBox(a: { x: number; y: number }, b: { x: number; y: number }, r: Box): boolean {
  for (let i = 0; i <= 40; i++) {
    const x = a.x + ((b.x - a.x) * i) / 40, y = a.y + ((b.y - a.y) * i) / 40;
    if (x > r.x + 0.05 && x < r.x + r.w - 0.05 && y > r.y + 0.05 && y < r.y + r.h - 0.05) return true;
  }
  return false;
}
/** Paires d'etiquettes qui se chevauchent (texte sur texte). */
function clashes(labels: SchemaLabel[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    if (over(labelBox(labels[i]), labelBox(labels[j]))) out.push(`${labels[i].lines} / ${labels[j].lines}`);
  }
  return out;
}

describe("etiquettes : formule ou texte, jamais de _ visible", () => {
  it("formule entiere, avec mots d'indice et lettre grecque collee", () => {
    expect(labelTex("U_K")).toBe("U_K");
    expect(labelTex("Δi_L")).toBe("\\Delta i_L");
    expect(labelTex("i_L max")).toBe("i_{L\\,max}");
    expect(labelTex("i_L(t_ON) = i_L max")).toBe("i_L\\left(t_{ON}\\right) = i_{L\\,max}");
    expect(labelTex("Δi_L = i_L max − i_L min")).toBe("\\Delta i_L = i_{L\\,max} - i_{L\\,min}");
  });
  it("phrase : mots en texte, grandeurs en formule", () => {
    expect(labelTex("K fermé")).toBe("K\\ \\text{fermé}");
    expect(labelTex("Vs à vide")).toBe("V_s\\ \\text{à}\\ \\text{vide}");
    for (const l of ["phase 1 : K fermé", "D bloquée", "i_L(0) = i_L min"]) expect(labelTex(l)).not.toMatch(/(^|[^\\{])_[^{A-Za-z0-9]/);
  });
  it("reference de composant : texte tel quel", () => {
    expect(labelTex("1N4148")).toBeNull();
  });
  it("largeur estimee : plus large avec plus de caracteres, indices plus petits", () => {
    expect(labelWidth("V_s(t)")).toBeLessThan(labelWidth("Vs(t)x"));
    expect(labelWidth("i_L max")).toBeGreaterThan(labelWidth("i_L"));
  });
});

describe("noms : la lettre seule tant qu'elle est seule", () => {
  it("L, puis L1 / L2 ; la tension par defaut suit", () => {
    const s = emptySchema("n");
    const a = addPart(s, "L", { x: 0, y: 0 });
    addVoltage(s, a);
    expect(a.name).toBe("L");
    const b = addPart(s, "L", { x: 6, y: 0 });
    expect([a.name, b.name]).toEqual(["L1", "L2"]);
    expect(s.notes![0].label).toBe("uL1");
    expect(addPart(s, "L", { x: 12, y: 0 }).name).toBe("L3");
    expect(addPart(s, "V", { x: 0, y: 6 }).name).toBe("E");
    expect(addPart(s, "X", { x: 0, y: 9 }).name).toBeUndefined();
  });
});

describe("chronogramme (seulement des annotations)", () => {
  it("dessine axes, traits et textes ; etiquette d'un axe a la pointe", () => {
    const s = emptySchema("c");
    addArrow(s, { x: 4, y: 16 }, { x: 4, y: 2 });
    s.notes![0].label = "u_L(t)";
    addArrow(s, { x: 4, y: 11 }, { x: 28, y: 11 });
    s.notes![1].label = "t";
    addText(s, { x: 12, y: 10.3 }, "t_ON");
    const d = drawSchema(s);
    expect(d.body).toContain("sch-arrow");
    const ax = d.labels.find((l) => l.note === 0)!;
    expect(ax.y).toBeLessThan(2.5);            // au-dessus de la pointe, pas en bas de l'axe
    const t = d.labels.find((l) => l.note === 1)!;
    expect(t.x).toBeGreaterThan(26);
    expect(d.box.y).toBeLessThan(ax.y - 0.4);  // l'etiquette tient dans le cadre
  });
  it("pointilles : trait en tirets", () => {
    const s = emptySchema("p");
    addArrow(s, { x: 0, y: 0 }, { x: 5, y: 0 }, true);
    s.notes![0].dash = true;
    expect(drawSchema(s).body).toContain("stroke-dasharray");
  });
});

describe("modeles", () => {
  for (const tp of TEMPLATES) {
    it(`${tp.label} : fils droits, etiquettes sans chevauchement, dans le cadre`, () => {
      const s = fromTemplate(tp.key);
      for (const w of s.wires) {
        const p = wirePts(w);
        for (let i = 0; i + 1 < p.length; i++) expect(p[i].x === p[i + 1].x || p[i].y === p[i + 1].y).toBe(true);
      }
      const d = drawSchema(s);
      expect(clashes(d.labels)).toEqual([]);
      for (const l of d.labels) {
        const b = labelBox(l);
        expect(b.x >= d.box.x && b.y >= d.box.y && b.x + b.w <= d.box.x + d.box.w && b.y + b.h <= d.box.y + d.box.h, String(l.lines)).toBe(true);
      }
    });
  }
  it("montages : aucun fil ne passe a travers une piece", () => {
    for (const tp of TEMPLATES.filter((x) => x.group === "Montages")) {
      const s = fromTemplate(tp.key);
      // Borne et masse : le fil arrive en leur milieu ou sur leur bord, normal.
      for (const p of s.parts.filter((x) => x.sym !== "O" && x.sym !== "G")) {
        const b = partBox(p);
        const core = { x: b.x + 0.4, y: b.y + 0.4, w: b.w - 0.8, h: b.h - 0.8 };
        for (const w of s.wires) {
          const q = wirePts(w);
          for (let i = 0; i + 1 < q.length; i++) expect(segInBox(q[i], q[i + 1], core), `${tp.key} : fil sur ${p.name ?? p.sym}`).toBe(false);
        }
      }
    }
  });
  it("montages : chaque dipole est relie des deux cotes (sauf bornes de sortie)", () => {
    for (const tp of TEMPLATES.filter((x) => x.group === "Montages")) {
      const s = fromTemplate(tp.key);
      const free = freePorts(s).filter((f) => f.part.sym !== "O");
      expect(free.map((f) => `${f.part.name ?? f.part.sym}.${f.port.name}`), tp.key).toEqual([]);
    }
  });
  it("buck : comme celui du cours (E, K, D, L, C, R, noeuds), fleches nommees", () => {
    const s = fromTemplate("buck");
    expect(s.parts.map((p) => p.name)).toEqual(["E", "K", "D", "L", "C", "R"]);
    expect(junctions(s).length).toBe(4);
    const d = drawSchema(s);
    const names = Object.fromEntries(d.labels.filter((l) => l.field === "name").map((l) => [l.lines[0], labelBox(l)]));
    // La fleche U_K (du cote du nom) ne passe jamais sur le nom K.
    const uk = d.hits.find((h) => s.notes![h.note].label === "U_K")!;
    expect(segInBox(uk.a, uk.b, names.K)).toBe(false);
    // Aucune etiquette sur un fil ni sur une fleche.
    for (const l of d.labels) {
      const b = labelBox(l);
      for (const h of d.hits) if (h.note !== l.note) expect(segInBox(h.a, h.b, b), `${l.lines} sur fleche ${s.notes![h.note].label}`).toBe(false);
    }
  });
  it("buck : un nom tape a la main reste ; un deuxieme buck colle prend les noms suivants", () => {
    const s = fromTemplate("buck");
    pasteGroup(s, templateByKey("buck")!.build(), 0, 20, true);
    const names = s.parts.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("K1");
    expect(names).toContain("K2");
  });
});

describe("circuit ouvert, court-circuit", () => {
  it("Alt+O : la diode devient deux bornes non reliees, sa tension reste ; encore : elle revient", () => {
    const s = fromTemplate("buck");
    const D = s.parts.find((p) => p.name === "D")!;
    const before = JSON.stringify(partPorts(D));
    expect(toggleOpen(s, D.id)).toBe(true);
    expect(D.sym).toBe("X");
    expect(D.was).toBe("D");
    expect(JSON.stringify(partPorts(D))).toBe(before);
    const d = drawSchema(s);
    expect(d.labels.some((l) => l.part === D.id)).toBe(false);          // plus de nom D
    expect(d.labels.some((l) => l.lines[0] === "U_D(t)")).toBe(true);   // la tension reste
    expect(toggleOpen(s, D.id)).toBe(true);
    expect(D.sym).toBe("D");
    expect(D.was).toBeUndefined();
  });
  it("Alt+F : l'interrupteur ferme devient un fil, le circuit reste ferme", () => {
    const s = fromTemplate("buck");
    const K = s.parts.find((p) => p.name === "K")!;
    const [a, b] = partPorts(K);
    expect(shortPart(s, K.id)).toBe(true);
    expect(s.parts.some((p) => p.id === K.id)).toBe(false);
    expect(s.notes!.some((n) => n.part === K.id)).toBe(false);
    expect(s.wires.some((w) => { const p = wirePts(w); return p[0].x === a.x && p[0].y === a.y && p[p.length - 1].x === b.x; })).toBe(true);
  });
  it("une masse ne se remplace pas", () => {
    const s = emptySchema("g");
    const g = addPart(s, "G", { x: 0, y: 0 });
    expect(toggleOpen(s, g.id)).toBe(false);
  });
});

describe("fleches : poser, glisser, retourner", () => {
  it("courant pose pres d'un fil, dans le sens du geste, glisse le long des fils", () => {
    const s = emptySchema("i");
    addWire(s, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }]);
    const n = currentOnWire(s, { x: 3.2, y: 0.6 }, "left")!;
    expect([n.x, n.y, n.dir]).toEqual([3, 0, "left"]);
    expect(currentOnWire(s, { x: 5, y: 5 })).toBeNull();
    // Glisse sur le segment vertical : le sens suit (gauche -> haut).
    moveNote(s, 0, { x: 10.4, y: 3.1 }, { x: 3, y: 0 });
    expect([n.x, n.y, n.dir]).toEqual([10, 3, "up"]);
    flipNote(s, 0);
    expect(n.dir).toBe("down");
    expect(nearestOnWire(s, { x: 4.7, y: 0.2 })!.at).toEqual({ x: 4.5, y: 0 });
  });
  it("texte et fleche libre suivent le geste ; tension : retourner = flip", () => {
    const s = emptySchema("t");
    addText(s, { x: 2, y: 2 }, "t_ON");
    moveNote(s, 0, { x: 4.1, y: 3 }, { x: 2, y: 2 });
    expect([s.notes![0].x, s.notes![0].y]).toEqual([4, 3]);
    const r = addPart(s, "R", { x: 0, y: 6 });
    addVoltage(s, r);
    flipNote(s, 1);
    expect(s.notes![1].flip).toBe(true);
  });
});

describe("groupe : selection, deplacement, copier-coller", () => {
  it("deplacer un groupe : fils internes en bloc, fils externes recousus a angles droits", () => {
    const s = fromTemplate("diviseur");
    const r = { x: 8, y: 4, w: 8, h: 13 };
    const ids = partsIn(s, r);
    expect(ids.length).toBe(4);                     // R1, R2, deux bornes
    moveGroup(s, ids, r, 3, 0);
    for (const w of s.wires) {
      const p = wirePts(w);
      for (let i = 0; i + 1 < p.length; i++) expect(p[i].x === p[i + 1].x || p[i].y === p[i + 1].y).toBe(true);
    }
    expect(freePorts(s).filter((f) => f.part.sym !== "O")).toEqual([]);
  });
  it("copier-coller : nouveaux ids, noms suivants, annotations rattachees", () => {
    const s = fromTemplate("rc");
    const R = s.parts.find((p) => p.name === "R")!;
    const g = extractGroup(s, [R.id], null);
    const ids = pasteGroup(s, g, 0, 10);
    const copy = s.parts.find((p) => p.id === ids[0])!;
    expect(copy.id).not.toBe(R.id);
    expect([R.name, copy.name]).toEqual(["R1", "R2"]);
    expect(s.notes!.some((n) => n.part === copy.id && n.kind === "u")).toBe(true);
  });
});

describe("compatibilite : un ancien schema se lit tel quel", () => {
  it("bloc ecrit avant (sans was/dash, noms R1) : rendu sans erreur, rien n'est reecrit", () => {
    const old: SchemaBlock = {
      id: "o", type: "schema",
      parts: [{ id: "p1", sym: "R", x: 2, y: 0, name: "R1", value: "10k" }, { id: "p2", sym: "Zz", x: 9, y: 0 }],
      wires: [{ pts: [0, 1, 2, 1] }],
      notes: [{ kind: "u", part: "p1", label: "uR1" }, { kind: "i", x: 1, y: 1, dir: "right", label: "i" }, { kind: "text", x: 0, y: 4, label: "Ve" }],
    };
    const snap = JSON.stringify(old);
    const d = drawSchema(old);
    expect(d.labels.length).toBeGreaterThan(3);
    expect(JSON.stringify(old)).toBe(snap);
  });
});

describe("etiquettes : symboles colles", () => {
  it("∑, ∞, Ω colles deviennent des commandes LaTeX que KaTeX accepte", async () => {
    const { labelTex } = await import("../core/schema/label");
    const katex = (await import("katex")).default;
    for (const l of ["∑", "∑ e(t)", "Σ", "gain ∞", "R = 10 Ω", "≈ 5 V", "somme ∑ des courants"]) {
      const tex = labelTex(l);
      expect(tex, l).not.toBeNull();
      expect(() => katex.renderToString(tex!, { throwOnError: true }), `${l} -> ${tex}`).not.toThrow();
    }
    expect(labelTex("∑")).toContain("\\sum");
  });
});
