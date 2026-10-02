import { describe, expect, it } from "vitest";
import {
  BLOCK_MAX_H, CLUSTER_GAP, INK_LIMIT, TEXT_LIMIT, TEXT_ROWS, clusterInk, composeFlowText, groupRows,
  inkItems, isLongPage, lineCount, moveFlowBlocks, pageBreaks, planFlow, type Span,
} from "../core/paginate";
import { LINE, TEXT_TOP } from "../core/textlayout";
import { PAGE_H } from "../core/ink/sheet";
import { cachedBounds } from "../core/ink/stroke";
import type { Block, FlagBlock, InkBlock, MathBlock, Page, Stroke } from "../core/types";

let seq = 0;
const nid = () => `n${++seq}`;

function vline(id: string, x: number, y0: number, y1: number): Stroke {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x, y: y0 + ((y1 - y0) * i) / 10, p: 0.5, t: i });
  return { id, color: "normal", width: 2, tool: "pen", points: pts };
}

function ink(strokes: Stroke[], extra: Partial<InkBlock> = {}): InkBlock {
  return { id: "ink", type: "ink", strokes, recognized: null, mode: "raw", ...extra };
}

/** Rangee de texte numero i (glyphes de 4 a 30 dans la ligne de 34). */
function row(i: number): Span {
  const top = TEXT_TOP + i * LINE;
  return { top: top + 4, bottom: top + 30 };
}

function rows(n: number, from = 0): Span[] {
  return Array.from({ length: n }, (_, i) => row(from + i));
}

function page(blocks: Block[], id = nid()): Page {
  return { version: 2, id, created: "2026-10-01T10:00:00Z", modified: "2026-10-01T10:00:00Z", blocks };
}

describe("pagination : constantes", () => {
  it("33 rangees tiennent sous la marge du bas, la 34e deborde", () => {
    expect(TEXT_ROWS).toBe(33);
    expect(row(TEXT_ROWS - 1).bottom).toBeLessThan(TEXT_LIMIT);
    expect(row(TEXT_ROWS).bottom).toBeGreaterThan(TEXT_LIMIT);
    expect(TEXT_LIMIT).toBeLessThan(PAGE_H - LINE);
    expect(INK_LIMIT).toBe(PAGE_H);
  });

  it("une photo de hauteur maximale tient sur une page avec ses marges", () => {
    expect(TEXT_TOP + BLOCK_MAX_H + LINE).toBeLessThanOrEqual(TEXT_LIMIT + 1e-6);
  });

  it("page longue et reperes de saut tous les A4", () => {
    expect(isLongPage(PAGE_H)).toBe(false);
    expect(isLongPage(PAGE_H + 200)).toBe(true);
    expect(pageBreaks(PAGE_H)).toEqual([]);
    expect(pageBreaks(PAGE_H * 2.5)).toEqual([PAGE_H, PAGE_H * 2]);
  });
});

describe("pagination : rangees et amas", () => {
  it("une formule haute et le texte de sa ligne font une seule rangee", () => {
    const r = groupRows([row(0), { top: TEXT_TOP + LINE + 2, bottom: TEXT_TOP + 3 * LINE - 2 }, row(2), row(3)]);
    expect(r.map((x) => x.members.length)).toEqual([1, 2, 1]);
  });

  it("deux lignes voisines restent deux rangees", () => {
    expect(groupRows(rows(5))).toHaveLength(5);
  });

  it("le point du i rejoint sa lettre, deux lignes ecrites restent separees", () => {
    const items = inkItems([ink([
      vline("i", 100, 300, 320), vline("dot", 100, 292, 294),
      vline("l2", 100, 300 + LINE, 320 + LINE),
    ])]);
    const c = clusterInk(items);
    expect(c).toHaveLength(2);
    expect(c[0].items.map((x) => x.strokeIds[0]).sort()).toEqual(["dot", "i"]);
    expect(CLUSTER_GAP).toBeLessThan(LINE / 2);
  });

  it("une zone math est un seul morceau", () => {
    const zone: MathBlock = { id: "z", type: "math", strokes: [vline("a", 10, 100, 120), vline("b", 30, 140, 160)],
      latex: "x", mode: "math", rect: { x: 0, y: 95, w: 50, h: 70 } };
    const items = inkItems([zone]);
    expect(items).toHaveLength(1);
    expect(items[0].zone).toBe("z");
    expect(items[0].strokeIds).toEqual(["a", "b"]);
  });
});

describe("pagination : planFlow", () => {
  it("rien ne deborde : pas de plan", () => {
    expect(planFlow(rows(TEXT_ROWS), [])).toBeNull();
  });

  it("la 34e rangee part seule en haut de la page suivante", () => {
    const p = planFlow(rows(TEXT_ROWS + 1), [])!;
    expect(p.firstRow).toBe(TEXT_ROWS);
    expect(p.cutGrid).toBeCloseTo(TEXT_TOP + TEXT_ROWS * LINE, 6);
    expect(p.dy).toBeCloseTo(-TEXT_ROWS * LINE, 6);
    expect(p.lead).toBe(0);
    expect(p.textLines).toBe(1);
    expect(p.inkLines).toBe(0);
  });

  it("un titre ne reste jamais seul en bas de page : il part avec la ligne qui le suit", () => {
    const r: Span[] = rows(TEXT_ROWS + 1);
    r[TEXT_ROWS - 1] = { ...r[TEXT_ROWS - 1], keep: true };
    r[TEXT_ROWS - 2] = { ...r[TEXT_ROWS - 2], keep: true };
    const p = planFlow(groupRows(r), [])!;
    expect(p.firstRow).toBe(TEXT_ROWS - 2);
    expect(p.textLines).toBe(3);
  });

  it("une page faite de titres ne se vide pas", () => {
    const r: Span[] = rows(TEXT_ROWS + 1).map((x) => ({ ...x, keep: true }));
    const p = planFlow(groupRows(r), [])!;
    expect(p.firstRow).toBe(1);
  });

  it("jamais au milieu d'une formule : la fraction a cheval part entiere", () => {
    const r = rows(TEXT_ROWS - 1);
    // Fraction sur les rangees 32 et 33 : elle chevauche la limite.
    r.push({ top: TEXT_TOP + 32 * LINE + 3, bottom: TEXT_TOP + 34 * LINE - 3 });
    const p = planFlow(groupRows(r), [])!;
    expect(p.firstRow).toBe(TEXT_ROWS - 1);
    expect(p.textLines).toBe(2);
  });

  it("une photo plus haute que la page reste (la feuille s'allonge, rien n'est perdu)", () => {
    expect(planFlow([{ top: TEXT_TOP + 5, bottom: TEXT_TOP + 1400 }], [])).toBeNull();
  });

  it("l'encre sous le texte qui part le suit, au meme endroit relatif", () => {
    const r = rows(TEXT_ROWS + 2);
    const below = vline("s", 200, TEXT_TOP + 33.2 * LINE, TEXT_TOP + 33.8 * LINE);
    const above = vline("t", 200, TEXT_TOP + 10 * LINE, TEXT_TOP + 11 * LINE);
    const blocks: Block[] = [ink([above, below])];
    const p = planFlow(r, blocks)!;
    expect(p.strokeIds).toEqual(["s"]);
    expect(p.firstRow).toBe(TEXT_ROWS);
    // Decalage par lignes entieres : l'encre reste calee sur le fond.
    expect(Math.abs(p.dy / LINE - Math.round(p.dy / LINE))).toBeLessThan(1e-9);
    expect(p.inkLines).toBe(1);
  });

  it("schema pousse sous le bas de la feuille : il part entier, le texte au-dessus reste", () => {
    const r = rows(20);
    // Schema de 6 traits qui se touchent, du bas de la rangee 26 au-dela du bord.
    const y0 = TEXT_TOP + 26 * LINE + 2;
    const s = [0, 1, 2, 3, 4, 5].map((i) => vline(`w${i}`, 100 + 20 * i, y0 + i * 20, y0 + i * 20 + 60));
    s.push(vline("long", 300, y0 + 100, PAGE_H + 20));
    const p = planFlow(r, [ink(s)])!;
    expect(p.strokeIds.sort()).toEqual(["long", "w0", "w1", "w2", "w3", "w4", "w5"]);
    expect(p.firstRow).toBe(r.length);
    expect(p.textLines).toBe(0);
    expect(p.cut).toBeCloseTo(cachedBounds(s[0]).y, 6);
    // Le schema arrive en haut de la page suivante, sans remonter au-dessus de la marge.
    expect(cachedBounds(s[0]).y + p.dy).toBeGreaterThanOrEqual(TEXT_TOP - 1e-6);
  });

  it("schema a cheval qui ne deborde pas : il reste, seul le texte en dessous part", () => {
    const r = rows(TEXT_ROWS + 1);
    const s = vline("sch", 600, TEXT_TOP + 30 * LINE, TEXT_TOP + 33.5 * LINE);
    const p = planFlow(r, [ink([s])])!;
    expect(p.strokeIds).toEqual([]);
    expect(p.firstRow).toBe(TEXT_ROWS);
  });

  it("texte a cote d'un schema qui deborde : la coupe remonte au haut du schema", () => {
    const r = rows(TEXT_ROWS + 1);
    const s = vline("sch", 600, TEXT_TOP + 30 * LINE + 2, PAGE_H + 10);
    const p = planFlow(r, [ink([s])])!;
    expect(p.strokeIds).toEqual(["sch"]);
    expect(p.firstRow).toBe(30);
    expect(p.lead).toBe(0);
    expect(p.textLines).toBe(4);
  });

  it("schema pousse entre deux paragraphes : sur la page d'arrivee, le texte qui le suivait reste dessous, jamais dessus", () => {
    // Texte rangees 0-20, schema sous le texte (rangees 26 a 35, pousse
    // au-dela du bord), texte qui le suit rangees 36-37.
    const r = [...rows(21), ...rows(2, 36)];
    const top = TEXT_TOP + 26 * LINE + 3, bottom = TEXT_TOP + 35 * LINE + 30;
    const s = [vline("a", 150, top, TEXT_TOP + 30 * LINE), vline("b", 500, top + 40, bottom)];
    const p = planFlow(r, [ink(s)])!;
    expect(p.strokeIds.sort()).toEqual(["a", "b"]);
    expect(p.firstRow).toBe(21);
    const inkBottom = cachedBounds(s[1]).y + cachedBounds(s[1]).h + p.dy;
    const textTop = TEXT_TOP + p.lead * LINE;
    expect(cachedBounds(s[0]).y + p.dy).toBeGreaterThanOrEqual(TEXT_TOP - 1e-6);
    // Le texte qui suivait le schema arrive sous lui (rangee entiere), pas dessus.
    expect(textTop).toBeGreaterThanOrEqual(inkBottom - 1e-6);
    expect(textTop - inkBottom).toBeCloseTo(row(36).top - (bottom + 1) - 4, 0);
    // Le texte deja present sur la page d'arrivee passe sous l'encre et le texte deplaces.
    const c = composeFlowText("suite 1\nsuite 2", p.lead, "ancien", p.textLines, p.inkLines);
    expect(c.shift).toBeGreaterThanOrEqual(inkBottom - TEXT_TOP - 1e-6);
    expect(c.shift).toBeGreaterThanOrEqual(p.textLines * LINE - 1e-6);
  });

  it("reperes sous la coupe : ils partent", () => {
    const flag: FlagBlock = { id: "f", type: "flag", note: "?", rect: { x: 850, y: TEXT_TOP + 33 * LINE, w: 30, h: 30 } };
    const flag2: FlagBlock = { id: "g", type: "flag", note: "?", rect: { x: 850, y: 200, w: 30, h: 30 } };
    const p = planFlow(rows(TEXT_ROWS + 1), [flag, flag2])!;
    expect(p.flagIds).toEqual(["f"]);
  });

  it("ecriture serree (amas qui couvre toute la page) : retente trait par trait", () => {
    // Lignes manuscrites qui se touchent toutes (jambages) jusque sous le bord.
    const s: Stroke[] = [];
    for (let y = 60; y < PAGE_H + 20; y += 30) s.push(vline(`h${y}`, 100, y, y + 32));
    const p = planFlow([], [ink(s)])!;
    expect(p).not.toBeNull();
    expect(p.strokeIds.length).toBeGreaterThan(0);
    expect(p.strokeIds.length).toBeLessThan(s.length);
  });
});

describe("pagination : texte de la page d'arrivee", () => {
  it("page neuve : le texte deplace seul", () => {
    expect(composeFlowText("a\nb", 0, "", 2)).toEqual({ text: "a\nb", shift: 2 * LINE });
  });

  it("page de suite : le texte deplace avant l'ancien texte", () => {
    const r = composeFlowText("fin du paragraphe", 0, "suite\nencore", 1);
    expect(r.text).toBe("fin du paragraphe\nsuite\nencore");
    expect(r.shift).toBeCloseTo(LINE, 6);
    expect(lineCount(r.text)).toBe(3);
  });

  it("paragraphe replie sur 3 rangees : l'ancien contenu descend de 3 lignes", () => {
    const r = composeFlowText("un long paragraphe", 0, "suite", 3);
    expect(r.text).toBe("un long paragraphe\nsuite");
    expect(r.shift).toBeCloseTo(3 * LINE, 6);
  });

  it("lignes vides avant le texte quand de l'encre est au-dessus", () => {
    expect(composeFlowText("x", 2, "", 3).text).toBe("\n\nx");
  });

  it("l'ancien texte passe sous l'encre deplacee", () => {
    const r = composeFlowText("x", 0, "y", 1, 4);
    expect(r.text).toBe("x\n\n\n\ny");
    expect(lineCount(r.text) - 1).toBe(4);
    expect(r.shift).toBeCloseTo(4 * LINE, 6);
  });

  it("encre seule : l'ancien texte descend sous elle", () => {
    const r = composeFlowText("", 0, "y", 0, 3);
    expect(r.text).toBe("\n\n\ny");
    expect(r.shift).toBeCloseTo(3 * LINE, 6);
  });

  it("encre seule, page sans texte : rien a ecrire, l'encre de la page descend", () => {
    expect(composeFlowText("", 0, "", 0, 2)).toEqual({ text: "", shift: 2 * LINE });
  });

  it("ligne vide finale du texte deplace : comptee", () => {
    const r = composeFlowText("abc\n", 0, "y", 2);
    expect(r.text).toBe("abc\n\ny");
    expect(r.shift).toBeCloseTo(2 * LINE, 6);
  });
});

describe("pagination : deplacement des blocs", () => {
  it("traits, mots, zones, reperes et photos passent, ids gardes", () => {
    const keep = vline("k", 100, 100, 120);
    const go = vline("g", 100, 1150, 1170);
    const from = page([
      ink([keep, go], {
        words: [
          { label: "garde", box: { x: 90, y: 100, w: 30, h: 20 }, strokeIds: ["k"] },
          { label: " ", strokeIds: [] },
          { label: "part", box: { x: 90, y: 1150, w: 30, h: 20 }, strokeIds: ["g"] },
        ],
        recognized: "garde part",
      }),
      { id: "z", type: "math", strokes: [vline("zs", 300, 1160, 1180)], latex: "y", mode: "math", rect: { x: 290, y: 1155, w: 30, h: 30 } },
      { id: "f", type: "flag", note: "?", rect: { x: 850, y: 1160, w: 30, h: 30 } },
      { id: "img", type: "image", src: "assets/a.png", ocr: null },
      { id: "t", type: "text", content: "texte" },
    ]);
    const old = vline("o", 100, 80, 100);
    const to = page([ink([old], { id: "ink2" }), { id: "f2", type: "flag", note: "?", rect: { x: 850, y: 90, w: 30, h: 30 } }]);
    const n = moveFlowBlocks(from, to, { strokeIds: ["g"], zoneIds: ["z"], flagIds: ["f"], blockIds: ["img"] }, -1100, 2 * LINE, nid);
    expect(n).toBe(2);
    const src = from.blocks.find((b) => b.type === "ink") as InkBlock;
    expect(src.strokes.map((s) => s.id)).toEqual(["k"]);
    expect(src.recognized).toBe("garde");
    expect(from.blocks.map((b) => b.id).sort()).toEqual(["ink", "t"]);
    const dst = to.blocks.find((b) => b.id === "ink2") as InkBlock;
    expect(dst.strokes.map((s) => s.id)).toEqual(["o", "g"]);
    // L'ancien contenu descend de 2 lignes, ce qui arrive monte de 1100.
    expect(cachedBounds(dst.strokes[0]).y).toBeCloseTo(cachedBounds(old).y, 6);
    expect(dst.strokes[0].points[0].y).toBeCloseTo(80 + 2 * LINE, 1);
    expect(dst.strokes[1].points[0].y).toBeCloseTo(50, 1);
    expect(dst.words?.[0].label).toBe("part");
    expect(dst.recognized).toBe("part");
    const z = to.blocks.find((b) => b.id === "z") as MathBlock;
    expect(z.rect!.y).toBeCloseTo(55, 6);
    expect(z.strokes[0].points[0].y).toBeCloseTo(60, 1);
    expect((to.blocks.find((b) => b.id === "f") as FlagBlock).rect!.y).toBeCloseTo(60, 6);
    expect((to.blocks.find((b) => b.id === "f2") as FlagBlock).rect!.y).toBeCloseTo(90 + 2 * LINE, 6);
    expect(to.blocks.some((b) => b.id === "img")).toBe(true);
  });

  it("page d'arrivee sans encre : un fond d'encre est cree", () => {
    const from = page([ink([vline("a", 1, 1200, 1210)])]);
    const to = page([]);
    moveFlowBlocks(from, to, { strokeIds: ["a"], zoneIds: [], flagIds: [], blockIds: [] }, -1150, 0, () => "neuf");
    const dst = to.blocks[0] as InkBlock;
    expect(dst.id).toBe("neuf");
    expect(dst.strokes[0].id).toBe("a");
    expect((from.blocks[0] as InkBlock).strokes).toEqual([]);
  });
});
