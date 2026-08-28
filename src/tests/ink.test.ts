import { describe, it, expect, vi } from "vitest";
import { newStroke, simplify, strokeBounds, unionBounds, boundsIntersect, widthAt, strokeHitsCircle } from "../core/ink/stroke";
import { RecognitionQueue, buildBatchBody, parseJiix, type RecognitionBackend } from "../core/ink/recognizer";
import type { InkPoint, Stroke } from "../core/types";

function line(n: number, y = 0): InkPoint[] {
  return Array.from({ length: n }, (_, i) => ({ x: i, y, p: 0.5, t: i * 5 }));
}

function stroke(points: InkPoint[]): Stroke {
  const s = newStroke("theoreme", 2, "pen");
  s.points = points;
  return s;
}

describe("traits", () => {
  it("la pression module l'epaisseur", () => {
    expect(widthAt(2, 1)).toBeGreaterThan(widthAt(2, 0.2));
    // Un stylet sans pression renvoie 0, on retombe sur l'epaisseur nominale.
    expect(widthAt(2, 0)).toBe(widthAt(2, 0.5));
  });

  it("simplifie une droite sans la deformer", () => {
    const pts = line(100);
    const out = simplify(pts, 0.6);
    expect(out.length).toBeLessThan(pts.length);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("garde les points d'un angle", () => {
    const pts: InkPoint[] = [
      { x: 0, y: 0, p: 0.5, t: 0 },
      { x: 10, y: 0, p: 0.5, t: 10 },
      { x: 10, y: 10, p: 0.5, t: 20 },
    ];
    expect(simplify(pts, 0.6)).toHaveLength(3);
  });

  it("boite englobante avec la demi-epaisseur", () => {
    const b = strokeBounds(stroke(line(10)));
    expect(b.x).toBe(-1);
    expect(b.w).toBe(11);
  });

  it("union et intersection de boites", () => {
    const u = unionBounds([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 5, w: 10, h: 10 },
    ]);
    expect(u).toEqual({ x: 0, y: 0, w: 30, h: 15 });
    expect(boundsIntersect(u, { x: 5, y: 5, w: 1, h: 1 })).toBe(true);
    expect(boundsIntersect(u, { x: 100, y: 100, w: 1, h: 1 })).toBe(false);
  });

  it("la gomme touche un trait proche", () => {
    const s = stroke(line(10));
    expect(strokeHitsCircle(s, 5, 0, 1)).toBe(true);
    expect(strokeHitsCircle(s, 5, 50, 1)).toBe(false);
  });
});

describe("requete MyScript", () => {
  it("envoie les traits en colonnes x, y, t, p", () => {
    const body = buildBatchBody("math", [stroke(line(3))]) as any;
    expect(body.contentType).toBe("Math");
    expect(body.strokeGroups[0].strokes[0].x).toEqual([0, 1, 2]);
    expect(body.strokeGroups[0].strokes[0].p).toEqual([0.5, 0.5, 0.5]);
  });

  it("demande le francais pour le texte", () => {
    const body = buildBatchBody("text", [stroke(line(2))]) as any;
    expect(body.contentType).toBe("Text");
    expect(body.configuration.lang).toBe("fr_FR");
  });

  it("lit le LaTeX et les candidats", () => {
    const r = parseJiix("math", { latex: "x^2", expressions: [{ latex: "x^2" }, { latex: "x^z" }] });
    expect(r.value).toBe("x^2");
    expect(r.candidates).toEqual(["x^z"]);
  });
});

describe("file d'attente hors ligne", () => {
  const okBackend = (calls: string[]): RecognitionBackend => ({
    name: "test", available: true,
    async recognize(kind) { calls.push(kind); return { value: "x^2", candidates: [] }; },
  });

  it("convertit et rend le resultat", async () => {
    const calls: string[] = [];
    const done: string[] = [];
    const q = new RecognitionQueue(okBackend(calls), (key) => { done.push(key); });
    q.enqueue({ key: "a", kind: "math", strokes: [stroke(line(3))] });
    await q.pump();
    expect(done).toEqual(["a"]);
    expect(q.size).toBe(0);
  });

  it("une seule entree par bloc : seule la derniere version compte", async () => {
    const calls: string[] = [];
    const q = new RecognitionQueue(okBackend(calls), () => {});
    q.enqueue({ key: "a", kind: "math", strokes: [stroke(line(3))] });
    q.enqueue({ key: "a", kind: "math", strokes: [stroke(line(5))] });
    expect(q.size).toBe(1);
  });

  it("garde les traits quand le backend echoue et reessaie plus tard", async () => {
    let attempts = 0;
    const flaky: RecognitionBackend = {
      name: "flaky", available: true,
      async recognize() {
        attempts++;
        if (attempts < 2) throw new Error("reseau indisponible");
        return { value: "ok", candidates: [] };
      },
    };
    let now = 0;
    const done: string[] = [];
    const q = new RecognitionQueue(flaky, (k) => { done.push(k); }, () => now);
    q.enqueue({ key: "a", kind: "math", strokes: [] });
    await q.pump();
    // Premier essai echoue : le travail reste en file, rien n'est perdu.
    expect(q.size).toBe(1);
    expect(done).toEqual([]);
    expect(q.state().lastError).toContain("reseau");

    now += 10_000; // l'attente exponentielle est ecoulee
    await q.pump();
    expect(done).toEqual(["a"]);
    expect(q.size).toBe(0);
  });

  it("ne tente rien sans backend configure", async () => {
    const none: RecognitionBackend = {
      name: "aucun", available: false,
      async recognize() { throw new Error("jamais appele"); },
    };
    const q = new RecognitionQueue(none, () => {});
    q.enqueue({ key: "a", kind: "math", strokes: [] });
    await q.pump();
    // Le bloc reste en attente : l'ecriture n'est pas bloquee pour autant.
    expect(q.size).toBe(1);
  });

  it("previent l'interface de l'etat de la file", async () => {
    const listener = vi.fn();
    const q = new RecognitionQueue(okBackend([]), () => {});
    q.subscribe(listener);
    q.enqueue({ key: "a", kind: "math", strokes: [] });
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)![0].pending).toBeGreaterThan(0);
  });
});

describe("etat du reseau", () => {
  const backend: RecognitionBackend = {
    name: "test", available: true,
    async recognize() { return { value: "x", candidates: [] }; },
  };

  it("tente l'envoi quand l'etat du reseau est inconnu", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: {}, configurable: true, writable: true,
    });
    try {
      const done: string[] = [];
      const q = new RecognitionQueue(backend, (k) => { done.push(k); });
      expect(q.online).toBe(true);
      q.enqueue({ key: "a", kind: "math", strokes: [] });
      await q.pump();
      expect(done).toEqual(["a"]);
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
    }
  });

  it("attend quand le navigateur se declare hors ligne", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false }, configurable: true, writable: true,
    });
    try {
      const done: string[] = [];
      const q = new RecognitionQueue(backend, (k) => { done.push(k); });
      expect(q.online).toBe(false);
      q.enqueue({ key: "a", kind: "math", strokes: [] });
      await q.pump();
      // Rien n'est perdu : le travail reste en file jusqu'au retour du reseau.
      expect(done).toEqual([]);
      expect(q.size).toBe(1);
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
    }
  });
});

describe("deux moteurs, un seul flux", () => {
  it("distingue la requete math de la requete texte", () => {
    const s = newStroke("definition", 2, "pen");
    s.points = line(4);
    const m = buildBatchBody("math", [s]) as any;
    const t = buildBatchBody("text", [s]) as any;
    expect(m.contentType).toBe("Math");
    expect(t.contentType).toBe("Text");
    // Le francais est demande dans les deux cas : un cours de maths est
    // truffe de mots, et un texte de notation mathematique.
    expect(m.configuration.lang).toBe("fr_FR");
    expect(t.configuration.lang).toBe("fr_FR");
  });

  it("lit le texte reconnu et ses candidats", () => {
    const r = parseJiix("text", { label: "Riemann", candidates: ["Riemann", "Riemarn"] });
    expect(r.value).toBe("Riemann");
    expect(r.candidates).toEqual(["Riemarn"]);
  });

  it("rend une valeur vide plutot que de casser sur une reponse inattendue", () => {
    expect(parseJiix("text", {}).value).toBe("");
    expect(parseJiix("math", {}).value).toBe("");
  });
});
