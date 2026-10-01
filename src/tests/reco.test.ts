import { describe, it, expect } from "vitest";
import {
  RecognitionQueue, RecoError, classifyError, errorForStatus, buildBatchBody, strokeTimes,
  MAX_RETRY_MS, QUOTA_PAUSE_MS, type RecognitionBackend, type RecoResult,
} from "../core/ink/recognizer";
import {
  blockKey, parseBlockKey, applyToBlock, markFailed, isPending, findBlockOnDisk, updateBlockOnDisk,
} from "../core/ink/recokey";
import { confusionCandidates, tokenize } from "../core/ink/confusions";
import { bumpUsage, currentUsage, monthOf, shouldWarn, usageLabel, MONTHLY_QUOTA } from "../core/ink/usage";
import { newStroke } from "../core/ink/stroke";
import { MemoryFs } from "../core/storage/fs";
import { Repo } from "../core/storage/repo";
import type { InkBlock, MathBlock, Stroke } from "../core/types";

function stroke(n = 3, startedAt?: number): Stroke {
  const s = newStroke("normal", 2, "pen", startedAt);
  s.points = Array.from({ length: n }, (_, i) => ({ x: i, y: 0, p: 0.5, t: i * 10 }));
  if (startedAt === undefined) delete s.startedAt;
  return s;
}

/** Promesse que le test resout a la main : un aller-retour reseau en cours. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("file : une version plus recente posee pendant l'envoi", () => {
  it("n'est pas effacee par la reponse de l'ancienne (reco-1)", async () => {
    const sent: number[] = [];
    const calls: ReturnType<typeof deferred<RecoResult>>[] = [];
    const backend: RecognitionBackend = {
      name: "lent", available: true,
      recognize(_kind, strokes) {
        sent.push(strokes.length);
        const d = deferred<RecoResult>();
        calls.push(d);
        return d.promise;
      },
    };
    const done: { key: string; value: string; more: boolean }[] = [];
    const q: RecognitionQueue = new RecognitionQueue(backend, (key, r) => {
      done.push({ key, value: r.value, more: q.has(key) });
    });
    q.enqueue({ key: "p#b", kind: "text", strokes: [stroke(), stroke(), stroke()] });
    await tick();
    expect(sent).toEqual([3]);
    // Pendant l'aller-retour, la fin de la ligne est ecrite.
    q.enqueue({ key: "p#b", kind: "text", strokes: [stroke(), stroke(), stroke(), stroke(), stroke()] });
    expect(q.has("p#b")).toBe(true);
    calls[0].resolve({ value: "debut", candidates: [] });
    await tick();
    // L'ancienne reponse s'affiche, mais le bloc reste en attente...
    expect(done[0]).toEqual({ key: "p#b", value: "debut", more: true });
    // ... et la version a 5 traits part ensuite.
    expect(sent).toEqual([3, 5]);
    calls[1].resolve({ value: "debut et fin", candidates: [] });
    await tick();
    expect(done[1]).toEqual({ key: "p#b", value: "debut et fin", more: false });
    expect(q.size).toBe(0);
  });
});

describe("file : echecs", () => {
  it("un job en echec ne retient plus les autres, et garde son erreur (reco-12)", async () => {
    const calls: string[] = [];
    const backend: RecognitionBackend = {
      name: "test", available: true,
      async recognize(kind) {
        calls.push(kind);
        if (kind === "math") throw new TypeError("Failed to fetch");
        return { value: "ok", candidates: [] };
      },
    };
    const now = 0;
    const done: string[] = [];
    const q = new RecognitionQueue(backend, (k) => { done.push(k); }, () => now);
    q.enqueue({ key: "math", kind: "math", strokes: [] });
    q.enqueue({ key: "texte", kind: "text", strokes: [] });
    await q.pump();
    await tick();
    expect(done).toEqual(["texte"]);
    expect(q.size).toBe(1);
    // Le succes du texte n'efface pas l'echec de la formule.
    expect(q.state().lastError).toBe("Réseau indisponible");
  });

  it("attend au plus 30 s entre deux essais", async () => {
    let now = 0;
    const backend: RecognitionBackend = {
      name: "test", available: true,
      async recognize() { throw new TypeError("Failed to fetch"); },
    };
    const q = new RecognitionQueue(backend, () => {}, () => now);
    q.enqueue({ key: "a", kind: "text", strokes: [] });
    for (let i = 0; i < 8; i++) {
      await q.pump();
      now += MAX_RETRY_MS;
    }
    const job = (q as unknown as { jobs: Map<string, { nextTry: number; attempts: number }> }).jobs.get("a")!;
    expect(job.attempts).toBe(8);
    expect(job.nextTry - (now - MAX_RETRY_MS)).toBeLessThanOrEqual(MAX_RETRY_MS);
  });

  it("au retour du reseau, les jobs repartent sans finir leur attente", async () => {
    let fail = true;
    const backend: RecognitionBackend = {
      name: "test", available: true,
      async recognize() {
        if (fail) throw new TypeError("Failed to fetch");
        return { value: "ok", candidates: [] };
      },
    };
    const done: string[] = [];
    const q = new RecognitionQueue(backend, (k) => { done.push(k); }, () => 0);
    q.enqueue({ key: "a", kind: "text", strokes: [] });
    await tick();
    expect(done).toEqual([]);
    fail = false;
    q.wake();
    await tick();
    expect(done).toEqual(["a"]);
  });

  it("des cles refusees arretent la file jusqu'aux nouvelles cles", async () => {
    let calls = 0;
    const refused: RecognitionBackend = {
      name: "mauvaises cles", available: true,
      async recognize() { calls++; throw errorForStatus(401); },
    };
    const done: string[] = [];
    const q = new RecognitionQueue(refused, (k) => { done.push(k); }, () => 0);
    q.enqueue({ key: "a", kind: "text", strokes: [] });
    q.enqueue({ key: "b", kind: "text", strokes: [] });
    await tick();
    // Un seul essai : b n'est pas envoye pour rien.
    expect(calls).toBe(1);
    expect(q.state().blocked).toBe("keys");
    expect(q.state().lastError).toBe("Clés MyScript refusées");
    q.wake();
    await tick();
    expect(calls).toBe(1);
    // De bonnes cles : tout part, sans relancer l'appli.
    q.setBackend({ name: "ok", available: true, async recognize() { return { value: "x", candidates: [] }; } });
    await tick();
    expect(done.sort()).toEqual(["a", "b"]);
    expect(q.state().blocked).toBeNull();
  });

  it("un quota atteint met la file en pause, puis elle reprend", async () => {
    let now = 0;
    let quota = true;
    const backend: RecognitionBackend = {
      name: "test", available: true,
      async recognize() {
        if (quota) throw errorForStatus(429);
        return { value: "x", candidates: [] };
      },
    };
    const done: string[] = [];
    const q = new RecognitionQueue(backend, (k) => { done.push(k); }, () => now);
    q.enqueue({ key: "a", kind: "text", strokes: [] });
    await tick();
    expect(q.state().blocked).toBe("quota");
    expect(q.state().lastError).toBe("Quota MyScript atteint");
    quota = false;
    q.wake();
    await tick();
    expect(done).toEqual([]);
    now += QUOTA_PAUSE_MS;
    await q.pump();
    expect(done).toEqual(["a"]);
  });

  it("une requete refusee abandonne ce bloc seul (« non reconnu »)", async () => {
    const backend: RecognitionBackend = {
      name: "test", available: true,
      async recognize(kind) {
        if (kind === "math") throw errorForStatus(400, "payload invalide");
        return { value: "x", candidates: [] };
      },
    };
    const failed: string[] = [];
    const done: string[] = [];
    const q = new RecognitionQueue(backend, (k) => { done.push(k); }, () => 0,
      (k, msg) => { failed.push(`${k}: ${msg}`); });
    q.enqueue({ key: "m", kind: "math", strokes: [] });
    q.enqueue({ key: "t", kind: "text", strokes: [] });
    await tick();
    await tick();
    expect(failed).toEqual(["m: Refusé par MyScript (400) : payload invalide"]);
    expect(done).toEqual(["t"]);
    expect(q.size).toBe(0);
  });

  it("classe les erreurs", () => {
    expect(errorForStatus(403).kind).toBe("keys");
    expect(errorForStatus(429).kind).toBe("quota");
    expect(errorForStatus(413).kind).toBe("refused");
    expect(errorForStatus(503).kind).toBe("network");
    expect(classifyError(new TypeError("Failed to fetch")).kind).toBe("network");
    const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    expect(classifyError(timeout).message).toBe("MyScript ne répond pas");
    const keys = new RecoError("x", "keys", 401);
    expect(classifyError(keys)).toBe(keys);
  });
});

describe("horodatage des traits (reco-13)", () => {
  it("envoie des temps absolus", () => {
    const a = stroke(3, 1_000_000), b = stroke(2, 1_000_500);
    const body = buildBatchBody("text", [a, b]) as any;
    expect(body.strokeGroups[0].strokes[0].t).toEqual([1_000_000, 1_000_010, 1_000_020]);
    expect(body.strokeGroups[0].strokes[1].t).toEqual([1_000_500, 1_000_510]);
  });

  it("garde l'ordre des anciens traits, sans heure de debut", () => {
    const t = strokeTimes([stroke(3), stroke(2)]);
    expect(t[0]).toEqual([0, 10, 20]);
    // 100 ms apres la fin du precedent.
    expect(t[1]).toEqual([120, 130]);
  });

  it("un nouveau trait porte son heure de debut", () => {
    const s = newStroke("normal", 2, "pen");
    expect(Math.abs((s.startedAt ?? 0) - Date.now())).toBeLessThan(1000);
  });
});

describe("cle d'un bloc", () => {
  it("porte l'id de la page, pas son numero", () => {
    const key = blockKey("Maths", "Cours", "page-1", "bloc-1");
    expect(parseBlockKey(key)).toEqual({ notebook: "Maths", divider: "Cours", pageId: "page-1", blockId: "bloc-1" });
  });

  it("supporte un « # » dans le nom et un cahier en chemin", () => {
    const key = blockKey("S5/Info", "C# avancé", "p", "b");
    expect(parseBlockKey(key)).toEqual({ notebook: "S5/Info", divider: "C# avancé", pageId: "p", blockId: "b" });
    expect(parseBlockKey("sans-diese")).toBeNull();
  });
});

describe("rangement d'un resultat", () => {
  const math = (): MathBlock => ({ id: "m", type: "math", mode: "math", strokes: [stroke()], latex: null, pending: true });

  it("un resultat provisoire laisse le bloc en attente", () => {
    const b = math();
    applyToBlock(b, { value: "x^2", candidates: [] }, true);
    expect(b.latex).toBe("x^2");
    expect(b.pending).toBe(true);
    applyToBlock(b, { value: "x^3", candidates: [] });
    expect(b.pending).toBe(false);
  });

  it("un refus garde l'encre et le dit ; un succes l'efface", () => {
    const b = math();
    markFailed(b, "Refusé par MyScript (400)");
    expect(b.pending).toBe(false);
    expect(b.recoError).toContain("400");
    expect(b.strokes).toHaveLength(1);
    expect(isPending(b)).toBe(false);
    applyToBlock(b, { value: "y", candidates: [] });
    expect(b.recoError).toBeUndefined();
  });

  it("un trait deplace dans une zone pendant l'envoi ne revient pas dans un mot", () => {
    const kept = stroke(), moved = stroke();
    const ink: InkBlock = { id: "i", type: "ink", mode: "raw", strokes: [kept], recognized: null, pending: true };
    applyToBlock(ink, {
      value: "un deux", candidates: [],
      words: [
        { label: "un", box: { x: 0, y: 0, w: 10, h: 10 }, strokeIds: [kept.id] },
        { label: " ", strokeIds: [] },
        { label: "deux", box: { x: 20, y: 0, w: 10, h: 10 }, strokeIds: [moved.id] },
      ],
    });
    expect(ink.recognized).toBe("un");
  });
});

describe("resultat ecrit sur le disque", () => {
  it("retrouve le bloc apres une insertion de page (numero decale)", async () => {
    const repo = new Repo(new MemoryFs());
    await repo.ensureRootLayout();
    await repo.createPage("Maths", "Cours");
    const page = await repo.readPage("Maths", "Cours", 1);
    page.blocks.push({ id: "m1", type: "math", mode: "math", strokes: [stroke()], latex: null, pending: true });
    await repo.writePage("Maths", "Cours", 1, page);
    const key = blockKey("Maths", "Cours", page.id, "m1");
    // Une page inseree avant : la page du bloc devient la 2.
    await repo.createPage("Maths", "Cours", 1);
    const ref = parseBlockKey(key)!;
    expect((await findBlockOnDisk(repo, ref))?.number).toBe(2);
    const ok = await updateBlockOnDisk(repo, ref, (b) => applyToBlock(b, { value: "\\int f", candidates: [] }));
    expect(ok).toBe(true);
    const back = (await repo.readPage("Maths", "Cours", 2)).blocks.find((b) => b.id === "m1") as MathBlock;
    expect(back.latex).toBe("\\int f");
    expect(back.pending).toBe(false);
  });

  it("ne cree rien quand le bloc a disparu", async () => {
    const repo = new Repo(new MemoryFs());
    await repo.ensureRootLayout();
    await repo.createPage("Maths", "Cours");
    const ok = await updateBlockOnDisk(repo, { notebook: "Maths", divider: "Cours", pageId: "x", blockId: "absent" }, () => {});
    expect(ok).toBe(false);
  });
});

describe("autres lectures d'une formule (reco-8)", () => {
  it("decoupe sans toucher l'interieur des commandes", () => {
    expect(tokenize("\\frac{a}{b}")).toEqual(["\\frac", "{", "a", "}", "{", "b", "}"]);
  });

  it("propose dx pour dz, et alpha pour a", () => {
    const c = confusionCandidates("\\int_0^1 f(z)\\,dz");
    expect(c).toContain("\\int_0^1 f(z)\\,dx");
    expect(confusionCandidates("a+b")).toContain("\\alpha+b");
    expect(confusionCandidates("\\alpha t")).toContain("at");
  });

  it("ne lit pas le a de \\frac comme une variable", () => {
    const c = confusionCandidates("\\frac{1}{2}");
    expect(c.every((x) => x.includes("\\frac"))).toBe(true);
  });

  it("garde une espace entre une commande et une lettre", () => {
    expect(confusionCandidates("2xy")).toContain("2\\times y");
  });

  it("au plus 5, sans doublon ni la lecture d'origine", () => {
    const c = confusionCandidates("a x v u e dz");
    expect(c.length).toBeLessThanOrEqual(5);
    expect(new Set(c).size).toBe(c.length);
    expect(c).not.toContain("a x v u e dz");
    expect(confusionCandidates("")).toEqual([]);
  });
});

describe("compteur mensuel (reco-3)", () => {
  const oct = new Date(2026, 9, 12), nov = new Date(2026, 10, 2);

  it("compte les envois du mois et repart a zero au mois suivant", () => {
    let u = bumpUsage(null, oct);
    u = bumpUsage(u, oct);
    expect(u).toEqual({ month: "2026-10", count: 2 });
    expect(bumpUsage(u, nov)).toEqual({ month: "2026-11", count: 1 });
    expect(currentUsage(u, nov).count).toBe(0);
    expect(monthOf(oct)).toBe("2026-10");
  });

  it("previent une fois, a 80 % du quota", () => {
    const at = Math.ceil(MONTHLY_QUOTA * 0.8);
    expect(shouldWarn({ month: "2026-10", count: at - 1 })).toBe(false);
    expect(shouldWarn({ month: "2026-10", count: at })).toBe(true);
    expect(shouldWarn({ month: "2026-10", count: at, warned: true })).toBe(false);
  });

  it("affiche le compte avec le quota", () => {
    expect(usageLabel({ month: "2026-10", count: 312 }, 2000)).toBe("312 / 2 000 ce mois");
  });
});
