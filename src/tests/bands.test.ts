import { describe, it, expect } from "vitest";
import {
  groupBands, planIncremental, invalidateStrokes, orderWords, dirtyStrokes,
  pointCount, sendSignature, AUTO_IDLE_MS, type RecoInk,
} from "../core/ink/bands";
import { RecognitionQueue, parseJiix, AUTO_DEBOUNCE_MS, type RecoResult } from "../core/ink/recognizer";
import { applyToBlock } from "../core/ink/recokey";
import { newStroke, strokeBounds, unionBounds } from "../core/ink/stroke";
import type { InkWord, Stroke } from "../core/types";

let seq = 0;
/** Trait en zigzag dans la boite (x, y, w, h), n points. */
function glyph(x: number, y: number, w: number, h: number, n = 12, tool: Stroke["tool"] = "pen"): Stroke {
  const s = newStroke("normal", 2, tool, 1000 + seq++ * 50);
  s.points = Array.from({ length: n }, (_, i) => ({
    x: x + (w * i) / (n - 1),
    y: y + (i % 2 ? h : 0),
    p: 0.5, t: i * 8,
  }));
  return s;
}

/** Lettre de x-height posee sur la ligne de base `base`. */
const letter = (x: number, base: number) => glyph(x, base - 14, 9, 14);
/** Mot de n lettres. */
function word(x: number, base: number, n = 4): Stroke[] {
  return Array.from({ length: n }, (_, i) => letter(x + i * 11, base));
}

const ink = (strokes: Stroke[]): RecoInk =>
  ({ id: "i", type: "ink", mode: "raw", strokes, recognized: null });

const bandOf = (bands: ReturnType<typeof groupBands>, s: Stroke) => bands.findIndex((b) => b.ids.includes(s.id));

describe("bandes de lignes", () => {
  it("trois lignes ecrites donnent trois bandes, dans l'ordre", () => {
    const l1 = [...word(50, 100), ...word(110, 100)];
    const l2 = word(50, 134);
    const l3 = word(60, 168, 6);
    const bands = groupBands([...l1, ...l2, ...l3]);
    expect(bands).toHaveLength(3);
    expect(bands.map((b) => b.ids.length)).toEqual([8, 4, 6]);
  });

  it("indices, exposants et lettres hautes restent sur leur ligne", () => {
    const base = word(50, 100, 3);
    const sub = glyph(84, 96, 6, 9);   // indice
    const sup = glyph(92, 78, 6, 9);   // exposant
    const tall = glyph(100, 78, 6, 30); // f, avec hampe et jambage
    const next = word(50, 140);
    const bands = groupBands([...base, sub, sup, tall, ...next]);
    expect(bands).toHaveLength(2);
    for (const s of [sub, sup, tall]) expect(bandOf(bands, s)).toBe(0);
  });

  it("une fraction haute (numerateur, barre, denominateur) est une seule bande", () => {
    const num = word(60, 92, 2);
    const bar = glyph(55, 98, 30, 2, 6);
    const den = word(60, 120, 2);
    const left = word(10, 106, 2); // « f = » au niveau de la barre
    const below = word(10, 170, 3);
    const bands = groupBands([...left, ...num, bar, ...den, ...below]);
    expect(bands).toHaveLength(2);
    expect(new Set([...num, bar, ...den, ...left].map((s) => bandOf(bands, s)))).toEqual(new Set([0]));
  });

  it("une integrale et ses bornes forment une bande", () => {
    const sign = glyph(40, 70, 8, 46);
    const top = glyph(52, 62, 10, 8);
    const bottom = glyph(50, 118, 6, 8);
    const body = word(62, 100, 3);
    const bands = groupBands([sign, top, bottom, ...body]);
    expect(bands).toHaveLength(1);
  });

  it("le point d'un i et un accent vont a leur ligne, meme poses dans le jambage du dessus", () => {
    const l1 = word(50, 100);
    const desc = glyph(95, 90, 8, 24); // g avec jambage jusqu'a 114
    const l2 = word(50, 134);
    const dot = glyph(62, 112, 2, 2, 3);   // point du i de la ligne 2
    const accent = glyph(74, 113, 4, 3, 3);
    const bands = groupBands([...l1, desc, ...l2, dot, accent]);
    expect(bands).toHaveLength(2);
    expect(bandOf(bands, dot)).toBe(1);
    expect(bandOf(bands, accent)).toBe(1);
    expect(bandOf(bands, desc)).toBe(0);
  });

  it("un jambage qui touche la hampe de la ligne suivante ne colle pas les lignes", () => {
    const l1 = [...word(50, 100), glyph(100, 88, 8, 26)]; // jambage jusqu'a 114
    const l2 = [...word(50, 130), glyph(102, 108, 8, 22)]; // hampe des 108
    expect(groupBands([...l1, ...l2])).toHaveLength(2);
  });

  it("une fleche verticale sur plusieurs lignes ne les fusionne pas", () => {
    const lines = [100, 134, 168, 202].map((y) => word(50, y));
    const arrow = glyph(300, 80, 3, 130, 4);
    const bands = groupBands([...lines.flat(), arrow]);
    expect(bands).toHaveLength(4);
    expect(bandOf(bands, arrow)).toBeGreaterThanOrEqual(0);
  });
});

/* ---------------- simulation du moteur ---------------- */

/** Boite JIIX en millimetres a partir d'une boite en unites de page. */
function mm(b: { x: number; y: number; w: number; h: number }) {
  const k = 25.4 / 96;
  return { x: b.x * k, y: b.y * k, width: b.w * k, height: b.h * k };
}

/**
 * Faux MyScript : lit chaque mot connu dont des traits sont envoyes ; un
 * trait hors de tout mot connu (schema) n'est lu nulle part.
 */
function fakeJiix(sent: Stroke[], labels: Map<string, string>) {
  const groups = new Map<string, Stroke[]>();
  for (const s of sent) {
    const label = labels.get(s.id);
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }
  const words: any[] = [];
  for (const [label, strokes] of groups) {
    if (words.length) words.push({ label: " " });
    words.push({ label: label.replace(/#\d+$/, ""), "bounding-box": mm(unionBounds(strokes.map((s) => strokeBounds(s)))) });
  }
  return { label: words.map((w) => w.label).join(""), words };
}

function recognize(sent: Stroke[], labels: Map<string, string>, partial = true): RecoResult {
  const r = parseJiix("text", fakeJiix(sent, labels), sent);
  return partial ? { ...r, scope: sent.map((s) => s.id) } : r;
}

describe("envoi incremental", () => {
  it("seule la nouvelle ligne part ; les mots convertis ne bougent pas", () => {
    const labels = new Map<string, string>();
    const w1 = word(50, 100), w2 = word(110, 100);
    w1.forEach((s) => labels.set(s.id, "loi#1"));
    w2.forEach((s) => labels.set(s.id, "d'Ohm#2"));
    const b = ink([...w1, ...w2]);
    applyToBlock(b, recognize(b.strokes, labels));
    expect(b.recognized).toBe("loi d'Ohm");
    const before = b.words!.find((w) => w.label === "loi")!;

    const w3 = word(50, 134);
    w3.forEach((s) => labels.set(s.id, "U=RI#3"));
    b.strokes.push(...w3);
    const plan = planIncremental(b);
    expect(plan.all.map((s) => s.id)).toEqual(w3.map((s) => s.id));
    applyToBlock(b, recognize(plan.all, labels));
    expect(b.recognized).toBe("loi d'Ohm\nU=RI");
    // Meme objet : jamais relu ni modifie.
    expect(b.words!.find((w) => w.label === "loi")).toBe(before);
    expect(b.pending).toBe(false);
    expect(dirtyStrokes(b)).toEqual([]);
  });

  it("la ligne en cours attend ; elle part a la pause longue ou en changeant de ligne", () => {
    const l1 = word(50, 100), l2 = word(50, 134);
    const b = ink([...l1, ...l2]);
    const last = l2[l2.length - 1];
    const p = planIncremental(b, { current: strokeBounds(last) });
    expect(p.now.map((s) => s.id)).toEqual(l1.map((s) => s.id));
    expect(p.all).toHaveLength(8);
  });

  it("un ajout colle a un mot converti renvoie ce mot (contexte), pas les autres", () => {
    const labels = new Map<string, string>();
    const a = word(50, 100), t = word(110, 100, 7);
    a.forEach((s) => labels.set(s.id, "la#1"));
    t.forEach((s) => labels.set(s.id, "tension#2"));
    const b = ink([...a, ...t]);
    applyToBlock(b, recognize(b.strokes, labels));
    // Corrigee a la main, puis prolongee d'un « s ».
    const tw = b.words!.find((w) => w.label === "tension")!;
    tw.label = "tensión"; tw.edited = true; tw.misread = "tension";
    const s = letter(110 + 7 * 11, 100);
    labels.set(s.id, "tension#2");
    for (const id of t.map((x) => x.id)) labels.set(id, "tension#2");
    b.strokes.push(s);
    const plan = planIncremental(b);
    expect(new Set(plan.all.map((x) => x.id))).toEqual(new Set([...t, s].map((x) => x.id)));
    const la = b.words!.find((w) => w.label === "la");
    applyToBlock(b, recognize(plan.all, labels));
    expect(b.words!.find((w) => w.label === "la")).toBe(la);
    expect(b.words!.filter((w) => w.box)).toHaveLength(2);
  });

  it("un mot loin sur la meme ligne ne renvoie pas les mots deja lus", () => {
    const b = ink(word(50, 100));
    const labels = new Map(b.strokes.map((s) => [s.id, "un"] as [string, string]));
    applyToBlock(b, recognize(b.strokes, labels));
    const far = word(200, 100);
    b.strokes.push(...far);
    expect(planIncremental(b).all.map((s) => s.id)).toEqual(far.map((s) => s.id));
  });

  it("un trait lu sans mot (schema) ne repart plus ; un trait gomme pendant l'envoi ne revient pas", () => {
    const w = word(50, 100);
    const schema = glyph(300, 90, 60, 12);
    const labels = new Map(w.map((s) => [s.id, "mot"] as [string, string]));
    const b = ink([...w, schema]);
    const sent = [...b.strokes];
    // Pendant l'aller-retour, une lettre est gommee.
    b.strokes = b.strokes.filter((s) => s.id !== w[0].id);
    applyToBlock(b, recognize(sent, labels));
    expect(b.recoSkip).toEqual([schema.id]);
    expect(b.words![0].strokeIds).not.toContain(w[0].id);
    expect(planIncremental(b).all).toEqual([]);
  });

  it("gomme partielle, coupe ou lasso : le mot est relu, il reste affiche d'ici la", () => {
    const w = word(50, 100), v = word(120, 100);
    const labels = new Map<string, string>([...w.map((s) => [s.id, "abc"]), ...v.map((s) => [s.id, "def"])] as [string, string][]);
    const b = ink([...w, ...v]);
    applyToBlock(b, recognize(b.strokes, labels));
    expect(invalidateStrokes(b, [w[1].id])).toBe(true);
    expect(b.recognized).toBe("abc def");
    const plan = planIncremental(b);
    expect(plan.all.map((s) => s.id)).toEqual(w.map((s) => s.id));
    applyToBlock(b, recognize(plan.all, labels));
    expect(b.words!.some((x) => (x as { stale?: boolean }).stale)).toBe(false);
    expect(planIncremental(b).all).toEqual([]);
  });

  it("une reponse vide garde les mots en place", () => {
    const w = word(50, 100);
    const labels = new Map(w.map((s) => [s.id, "mot"] as [string, string]));
    const b = ink([...w]);
    applyToBlock(b, recognize(b.strokes, labels));
    const scribble = glyph(52, 86, 40, 14);
    b.strokes.push(scribble);
    applyToBlock(b, { value: "", candidates: [], scope: [scribble.id, ...w.map((s) => s.id)] });
    expect(b.recognized).toBe("mot");
    expect(b.recoSkip).toEqual([scribble.id]);
  });

  it("la reconversion demandee renvoie toute la page", () => {
    const b = ink(word(50, 100));
    expect(planIncremental(b, { full: true }).all).toHaveLength(4);
    expect(planIncremental({ ...b, strokes: [...b.strokes, glyph(0, 0, 9, 9, 4, "highlighter")] }, { full: true }).all)
      .toHaveLength(4);
  });

  it("le bloc reste en attente tant qu'une ligne n'est pas lue", () => {
    const l1 = word(50, 100), l2 = word(50, 134);
    const labels = new Map(l1.map((s) => [s.id, "un"] as [string, string]));
    const b = ink([...l1, ...l2]);
    applyToBlock(b, recognize(l1, labels));
    expect(b.pending).toBe(true);
  });

  it("separateurs refaits dans l'ordre de lecture", () => {
    const box = (x: number, y: number) => ({ x, y, w: 30, h: 20 });
    const ws: InkWord[] = [
      { label: "c", box: box(10, 60), strokeIds: ["c"] },
      { label: "b", box: box(60, 22), strokeIds: ["b"] },
      { label: "a", box: box(10, 20), strokeIds: ["a"] },
    ];
    expect(orderWords(ws).map((w) => w.label).join("")).toBe("a b\nc");
  });

  it("la file recopie l'etendue de l'envoi dans le resultat", async () => {
    const got: RecoResult[] = [];
    const q = new RecognitionQueue(
      { name: "t", available: true, async recognize() { return { value: "x", candidates: [] }; } },
      (_k, r) => { got.push(r); },
    );
    q.enqueue({ key: "a/b/p#i", kind: "text", strokes: [], scope: ["s1"] });
    q.enqueue({ key: "a/b/p#z", kind: "text", strokes: [] });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(got[0].scope).toEqual(["s1"]);
    expect(got[1].scope).toBeUndefined();
  });
});

/* ---------------- mesure : une page de 30 lignes ---------------- */

interface Ev { at: number; stroke?: Stroke }

/**
 * Cours ecrit au fil de la plume : 30 lignes de 6 mots (4 a 7 lettres),
 * une hesitation de 2 s apres le 2e et le 4e mot de chaque ligne, 0,8 s
 * pour passer a la ligne. Fin : on pose le stylet.
 */
function lecture(labels: Map<string, string>): Ev[] {
  const evs: Ev[] = [];
  let t = 0, n = 0;
  for (let line = 0; line < 30; line++) {
    const base = 100 + line * 34;
    let x = 40;
    for (let w = 0; w < 6; w++) {
      const len = 4 + ((line + w) % 4);
      const strokes = word(x, base, len);
      const label = `m${n++}`;
      for (const s of strokes) {
        labels.set(s.id, label);
        t += 260;
        evs.push({ at: t, stroke: s });
      }
      x += len * 11 + 14;
      t += w === 1 || w === 3 ? 2000 : 350;
    }
    t += 800;
  }
  evs.push({ at: t + 60_000 });
  return evs;
}

/**
 * Rejoue le cours. `before` : chaque lever de stylet repose toute la page
 * (pause 1,5 s, comme avant reco-3). `after` : politique de la vue
 * (pageview.ts) : bandes hors ligne en cours apres 1,5 s, ligne en cours a
 * la pause longue. Le moteur repond tout de suite.
 */
function replay(policy: "before" | "after") {
  const labels = new Map<string, string>();
  const evs = lecture(labels);
  const b = ink([]);
  let requests = 0, points = 0;
  let timer = null as { at: number; strokes: Stroke[]; partial: boolean } | null;
  let idleAt = Infinity;
  let lastSig = "";
  const request = (strokes: Stroke[], at: number, partial: boolean) => {
    timer = { at: at + AUTO_DEBOUNCE_MS, strokes, partial };
  };
  const fire = () => {
    const job = timer!;
    timer = null;
    requests++;
    points += pointCount(job.strokes);
    applyToBlock(b, recognize(job.strokes, labels, job.partial));
  };
  for (const ev of evs) {
    // Minuteries echues avant cet evenement, dans l'ordre.
    for (;;) {
      const tAt = timer ? timer.at : Infinity;
      const next = Math.min(tAt, idleAt);
      if (next > ev.at) break;
      if (tAt <= idleAt) fire();
      else {
        idleAt = Infinity;
        const all = planIncremental(b).all;
        if (all.length && sendSignature(all) !== lastSig) { lastSig = sendSignature(all); request(all, next, true); }
      }
    }
    if (!ev.stroke) continue;
    b.strokes.push(ev.stroke);
    if (policy === "before") { request(b.strokes.filter((s) => s.tool === "pen"), ev.at, false); continue; }
    const plan = planIncremental(b, { current: strokeBounds(ev.stroke) });
    if (plan.now.length && sendSignature(plan.now) !== lastSig) {
      lastSig = sendSignature(plan.now);
      request(plan.now, ev.at, true);
    }
    idleAt = ev.at + AUTO_IDLE_MS - AUTO_DEBOUNCE_MS;
  }
  return { requests, points, text: b.recognized ?? "", pending: dirtyStrokes(b).length };
}

describe("mesure du quota : page de 30 lignes", () => {
  it("bien moins de requetes et de points, meme texte final", () => {
    const before = replay("before");
    const after = replay("after");
    // Chiffres du compte rendu.
    console.log(`30 lignes - avant : ${before.requests} requetes, ${before.points} points ; `
      + `apres : ${after.requests} requetes, ${after.points} points`);
    expect(after.text.split("\n")).toHaveLength(30);
    expect(after.text.replace(/\s+/g, " ")).toBe(before.text.replace(/\s+/g, " "));
    expect(after.pending).toBe(0);
    expect(after.requests).toBeLessThanOrEqual(before.requests / 2);
    expect(after.points).toBeLessThanOrEqual(before.points / 10);
  });
});
