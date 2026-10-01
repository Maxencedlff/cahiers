import type { InkWord, Stroke } from "../types";
import { RECO_DPI, wordsFromJiix } from "./words";

/**
 * Reconnaissance manuscrite (section 4).
 *
 * Point cle : la reconnaissance se fait cote serveur, donc l'ecriture ne doit
 * JAMAIS l'attendre. Les traits partent dans une file ; en amphi sans reseau
 * ils s'empilent, la conversion part au retour de la connexion.
 */

export type RecoKind = "math" | "text";

export interface RecoResult {
  /** LaTeX pour math, texte brut pour text. */
  value: string;
  /** Candidats alternatifs, pour la correction en un geste. */
  candidates: string[];
  /** Texte seulement : chaque mot avec sa position et ses traits. */
  words?: InkWord[];
}

export interface RecognitionBackend {
  readonly name: string;
  readonly available: boolean;
  recognize(kind: RecoKind, strokes: Stroke[]): Promise<RecoResult>;
}

/* ------------------------------------------------------------------ */
/* Backend MyScript (API batch iink v4)                                */
/* ------------------------------------------------------------------ */

export interface MyScriptKeys {
  applicationKey: string;
  hmacKey: string;
  /** Surchargeable pour pointer un serveur europeen. */
  endpoint?: string;
}

/**
 * Pourquoi un envoi a echoue. La file ne traite pas tout pareil :
 * - network : reseau, delai depasse, serveur en panne -> nouvel essai ;
 * - keys : cles refusees (401/403) -> la file s'arrete jusqu'a de nouvelles cles ;
 * - quota : quota atteint (429) -> la file s'arrete un moment ;
 * - refused : requete refusee (autre 4xx) -> ce bloc seul est abandonne,
 *   marque « non reconnu », les autres continuent.
 */
export type RecoFailure = "network" | "keys" | "quota" | "refused";

export class RecoError extends Error {
  constructor(message: string, readonly kind: RecoFailure, readonly status = 0) {
    super(message);
    this.name = "RecoError";
  }
}

/** Classe une reponse HTTP en echec. Le message est celui de la barre d'etat. */
export function errorForStatus(status: number, detail = ""): RecoError {
  if (status === 401 || status === 403) {
    return new RecoError("Clés MyScript refusées", "keys", status);
  }
  if (status === 429) return new RecoError("Quota MyScript atteint", "quota", status);
  if (status >= 400 && status < 500) {
    return new RecoError(`Refusé par MyScript (${status})${detail ? ` : ${detail.slice(0, 120)}` : ""}`,
      "refused", status);
  }
  return new RecoError(`MyScript indisponible (${status})`, "network", status);
}

/** Toute erreur ramenee a une RecoError : ce qui n'est pas classe est du reseau. */
export function classifyError(e: unknown): RecoError {
  if (e instanceof RecoError) return e;
  const name = (e as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new RecoError("MyScript ne répond pas", "network");
  }
  // fetch leve une TypeError quand le reseau manque ("Failed to fetch").
  if (e instanceof TypeError) return new RecoError("Réseau indisponible", "network");
  return new RecoError(e instanceof Error ? e.message : String(e), "network");
}

/**
 * Au-dela, un envoi est abandonne et repart en file. Sans limite, un fetch
 * pendu sur un Wi-Fi faible gelait toute la file pour la session.
 */
export const FETCH_TIMEOUT_MS = 15_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

export class MyScriptBackend implements RecognitionBackend {
  readonly name = "MyScript iink";
  /** `onRequest` est appele a chaque reponse du service : compteur mensuel du quota. */
  constructor(private keys: MyScriptKeys, private onRequest?: () => void) {}

  get available(): boolean {
    return Boolean(this.keys.applicationKey && this.keys.hmacKey);
  }

  async recognize(kind: RecoKind, strokes: Stroke[]): Promise<RecoResult> {
    const endpoint = this.keys.endpoint ?? "https://cloud.myscript.com";
    const body = JSON.stringify(buildBatchBody(kind, strokes));
    const hmac = await computeHmac(this.keys.applicationKey + this.keys.hmacKey, body);

    const res = await fetch(`${endpoint}/api/v4.0/iink/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": acceptFor(kind),
        "applicationKey": this.keys.applicationKey,
        "hmac": hmac,
      },
      body,
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
    });
    // Compte seulement ce que le service a recu : un envoi hors ligne ne
    // consomme pas le quota.
    this.onRequest?.();
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw errorForStatus(res.status, detail);
    }
    if (kind === "math") {
      // Le JIIX des maths ne porte AUCUN champ latex : le LaTeX ne s'obtient
      // qu'en le demandant explicitement, et arrive en texte brut.
      return { value: (await res.text()).trim(), candidates: [] };
    }
    return parseJiix(kind, await res.json(), strokes);
  }
}

/**
 * Essaie des cles avant de les enregistrer : un petit trait envoye en texte.
 * Une cle incomplete se voyait sinon des heures plus tard, par un « 401 »
 * dans la barre d'etat. Rend null si les cles sont bonnes.
 */
export async function testKeys(keys: MyScriptKeys, onRequest?: () => void): Promise<RecoError | null> {
  const backend = new MyScriptBackend(keys, onRequest);
  const probe: Stroke = {
    id: "essai", color: "normal", width: 2, tool: "pen", startedAt: Date.now(),
    points: [0, 1, 2, 3, 4].map((i) => ({ x: 100, y: 100 + i * 8, p: 0.5, t: i * 12 })),
  };
  try {
    await backend.recognize("text", [probe]);
    return null;
  } catch (e) {
    return classifyError(e);
  }
}

/**
 * Format demande a MyScript.
 *
 * Math : LaTeX direct. Le JIIX math ne contient pas de champ latex, seulement
 * un arbre d'expressions, donc le demander reviendrait a le reconstruire.
 * Les autres lectures d'une formule viennent donc d'une table de confusions
 * locale (confusions.ts), plus la correction dans un champ MathLive.
 *
 * Texte : JIIX, qui porte a la fois le libelle et les candidats par mot,
 * ce qui donne la correction en un geste de la section 4.
 */
export function acceptFor(kind: RecoKind): string {
  return kind === "math" ? "application/x-latex" : "application/vnd.myscript.jiix";
}

/** Corps de requete batch v4. Les traits partent en colonnes x[], y[], t[], p[]. */
export function buildBatchBody(kind: RecoKind, strokes: Stroke[]) {
  const times = strokeTimes(strokes);
  return {
    configuration: {
      lang: "fr_FR",
      math: {
        mimeTypes: ["application/x-latex", "application/vnd.myscript.jiix"],
        solver: { enable: false },
        // Le LaTeX doit rester brut : c'est l'utilisateur qui juge.
        "undo-redo": { mode: "stroke" },
      },
      text: {
        mimeTypes: ["text/plain", "application/vnd.myscript.jiix"],
        guides: { enable: false },
        // Le modele unifie gere plusieurs langues latines a la fois :
        // utile pour du francais truffe de termes techniques anglais.
        margin: { top: 0, left: 0, right: 0 },
      },
      // Les boites des mots servent a poser le texte tape a la place de
      // l'encre. Les traits eux-memes ne sont pas renvoyes : on les a deja.
      export: { jiix: { "bounding-box": kind === "text", strokes: false, text: { chars: false, words: true } } },
    },
    xDPI: RECO_DPI,
    yDPI: RECO_DPI,
    contentType: kind === "math" ? "Math" : "Text",
    // Verifie sur le service reel : en DIGITAL_EDIT, MyScript remet le texte
    // en page et les boites ne correspondent plus a l'encre. Sans conversion,
    // elles tombent exactement sur les mots ecrits.
    ...(kind === "math" ? { conversionState: "DIGITAL_EDIT" } : {}),
    strokeGroups: [
      {
        strokes: strokes.map((s, i) => ({
          id: s.id,
          x: s.points.map((p) => round(p.x)),
          y: s.points.map((p) => round(p.y)),
          t: times[i],
          p: s.points.map((p) => round(p.p)),
          pointerType: "PEN",
        })),
      },
    ],
  };
}

/**
 * Temps absolus des points, trait par trait. Les `t` d'un trait partent de
 * 0 : envoyes tels quels, tous les traits d'une page semblaient ecrits au
 * meme instant. Un trait sans `startedAt` (ancienne page) est pose 100 ms
 * apres la fin du precedent, ce qui garde au moins l'ordre.
 */
export function strokeTimes(strokes: Stroke[]): number[][] {
  let cursor = 0;
  return strokes.map((s) => {
    const start = s.startedAt ?? cursor;
    const t = s.points.map((p) => Math.round(start + p.t));
    cursor = (t.length ? t[t.length - 1] : start) + 100;
    return t;
  });
}

function round(v: number): number { return Math.round(v * 100) / 100; }

export function parseJiix(kind: RecoKind, jiix: any, strokes: Stroke[] = []): RecoResult {
  if (kind === "math") {
    // Chemin de secours : si un jour le JIIX porte un latex, on le prend.
    const expressions: string[] = Array.isArray(jiix?.expressions)
      ? jiix.expressions.map((e: any) => e?.latex).filter(Boolean)
      : [];
    const value = jiix?.latex ?? expressions[0] ?? "";
    return { value, candidates: expressions.filter((c) => c !== value) };
  }

  const label: string = jiix?.label ?? "";
  // Les candidats vivent par mot. Sur un mot unique, ils s'appliquent tels
  // quels ; sur une phrase, proposer des variantes entieres n'aurait pas
  // de sens, on s'en tient a la correction manuelle.
  const words: any[] = Array.isArray(jiix?.words) ? jiix.words : [];
  const candidates: string[] = words.length === 1 && Array.isArray(words[0]?.candidates)
    ? words[0].candidates
    : Array.isArray(jiix?.candidates) ? jiix.candidates : [];
  const result: RecoResult = { value: label, candidates: candidates.filter((c) => c !== label) };
  if (words.some((w) => w?.["bounding-box"])) result.words = wordsFromJiix(jiix, strokes);
  return result;
}

async function computeHmac(key: string, message: string): Promise<string> {
  // crypto.subtle n'existe qu'en contexte securise. L'application installee
  // en est un ; une page servie en HTTP sur une IP, non. Sans ce controle,
  // l'echec remonte en "Cannot read properties of undefined". Rien a
  // retenter : la file s'arrete comme sur des cles refusees.
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new RecoError(
      "Signature impossible : le contexte n'est pas sécurisé. " +
      "Ouvre l'application installée, ou sers la page en https ou sur localhost.",
      "keys",
    );
  }
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Backend de repli, sans reseau ni compte                             */
/* ------------------------------------------------------------------ */

/**
 * Utilise tant qu'aucune cle MyScript n'est configuree. Ne reconnait rien,
 * mais laisse toute l'application fonctionner : l'encre brute est conservee,
 * les blocs restent en attente. Les cles saisies remplacent ce moteur sans
 * relancer l'appli (RecognitionQueue.setBackend), et la file part.
 */
export class NoBackend implements RecognitionBackend {
  readonly name = "aucun (cles MyScript absentes)";
  readonly available = false;
  async recognize(): Promise<RecoResult> {
    throw new Error("Aucun moteur de reconnaissance configure");
  }
}

/* ------------------------------------------------------------------ */
/* File d'attente                                                      */
/* ------------------------------------------------------------------ */

export interface RecoJob {
  /** Cle unique : cahier/intercalaire/id de page#id de bloc (recokey.ts). */
  key: string;
  kind: RecoKind;
  strokes: Stroke[];
  /** Nombre d'echecs consecutifs, pour l'attente exponentielle. */
  attempts?: number;
  nextTry?: number;
  /** Dernier echec de CE job : un succes ailleurs ne l'efface pas. */
  error?: string;
}

export type QueueListener = (state: QueueState) => void;

export interface QueueState {
  pending: number;
  online: boolean;
  lastError: string | null;
  backendName: string;
  /** false quand aucun moteur n'est configure : rien ne partira jamais. */
  backendReady: boolean;
  /**
   * File arretee : cles refusees (jusqu'a de nouvelles cles) ou quota
   * atteint (pour QUOTA_PAUSE_MS). null quand elle tourne.
   */
  blocked: "keys" | "quota" | null;
}

/** Attente maximale entre deux essais d'un meme job (reseau absent). */
export const MAX_RETRY_MS = 30_000;
/** Pause de la file apres un « quota atteint ». */
export const QUOTA_PAUSE_MS = 10 * 60_000;

/**
 * File d'attente hors ligne. Un seul envoi a la fois, attente exponentielle
 * par job en cas d'echec, reprise automatique au retour du reseau, au retour
 * sur la fenetre et a l'arrivee de nouvelles cles.
 */
export class RecognitionQueue {
  private jobs = new Map<string, RecoJob>();
  private listeners = new Set<QueueListener>();
  private running = false;
  /** Cle du job parti chez MyScript, le temps de l'aller-retour. */
  private inflight: string | null = null;
  private blocked: { kind: "keys" | "quota"; message: string; until: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `onDone` recoit chaque resultat, meme celui d'une version deja remplacee
   * (il reste bon a afficher en attendant) : `has(key)` dit s'il en vient un
   * autre. `onFailed` recoit un bloc abandonne (requete refusee).
   */
  constructor(
    private backend: RecognitionBackend,
    private onDone: (key: string, result: RecoResult) => Promise<void> | void,
    private clock: () => number = () => Date.now(),
    private onFailed?: (key: string, message: string) => Promise<void> | void,
  ) {
    if (typeof window !== "undefined") {
      // Un portail captif laisse navigator.onLine a true : aucun evenement
      // « online » au retour d'Internet. Revenir sur la fenetre relance aussi.
      window.addEventListener("online", () => this.wake());
      window.addEventListener("offline", () => this.notify());
      window.addEventListener("focus", () => this.wake());
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.wake();
      });
    }
  }

  get size(): number { return this.jobs.size; }

  get online(): boolean {
    if (typeof navigator === "undefined") return true;
    // navigator.onLine n'existe pas partout (Node recent, WebView bridee).
    // Inconnu vaut "on tente" : mieux vaut un envoi qui echoue et repart en
    // file qu'une file gelee alors que le reseau est la.
    const status = (navigator as Navigator & { onLine?: boolean }).onLine;
    return status !== false;
  }

  subscribe(l: QueueListener): () => void {
    this.listeners.add(l);
    l(this.state());
    return () => this.listeners.delete(l);
  }

  state(): QueueState {
    let lastError: string | null = this.blocked?.message ?? null;
    if (!lastError) {
      for (const j of this.jobs.values()) if (j.error) { lastError = j.error; break; }
    }
    return {
      pending: this.jobs.size,
      online: this.online,
      lastError,
      backendName: this.backend.name,
      backendReady: this.backend.available,
      blocked: this.blocked?.kind ?? null,
    };
  }

  private notify() { for (const l of this.listeners) l(this.state()); }

  /** Un job attend ou part pour cette cle : un autre resultat va suivre. */
  has(key: string): boolean {
    return this.jobs.has(key) || this.inflight === key;
  }

  /** Remplace un job existant pour la meme cle : seule la derniere version compte. */
  enqueue(job: RecoJob): void {
    this.jobs.set(job.key, { ...job, attempts: 0, nextTry: 0, error: undefined });
    this.notify();
    void this.pump();
  }

  /** Retire un job en attente. Vrai s'il y en avait un. */
  cancel(key: string): boolean {
    const had = this.jobs.delete(key);
    if (had) this.notify();
    return had;
  }

  /**
   * Nouvelles cles : elles servent tout de suite, sans relancer l'appli (la
   * relance vidait justement la file). Les jobs repartent de zero.
   */
  setBackend(backend: RecognitionBackend): void {
    this.backend = backend;
    this.blocked = null;
    for (const j of this.jobs.values()) { j.attempts = 0; j.nextTry = 0; j.error = undefined; }
    this.notify();
    void this.pump();
  }

  /**
   * Retour du reseau ou de la fenetre : les jobs en attente d'un nouvel
   * essai partent tout de suite, sans finir leur attente (jusqu'a 30 s).
   * Un quota atteint reste en pause.
   */
  wake(): void {
    for (const j of this.jobs.values()) j.nextTry = 0;
    this.notify();
    void this.pump();
  }

  async pump(): Promise<void> {
    if (this.running) return;
    if (!this.backend.available) return;
    if (!this.online) { this.notify(); return; }
    if (this.blocked) {
      const left = this.blocked.until - this.clock();
      if (left > 0) {
        if (Number.isFinite(left)) this.schedule(left);
        return;
      }
      this.blocked = null;
    }

    this.running = true;
    try {
      for (;;) {
        const job = this.nextReady();
        if (!job) break;
        this.inflight = job.key;
        let result: RecoResult;
        try {
          result = await this.backend.recognize(job.kind, job.strokes);
        } catch (e) {
          this.inflight = null;
          const err = classifyError(e);
          if (err.kind === "keys" || err.kind === "quota") {
            // Rien ne passera pour personne : la file s'arrete, le job reste.
            this.blocked = {
              kind: err.kind, message: err.message,
              until: err.kind === "quota" ? this.clock() + QUOTA_PAUSE_MS : Infinity,
            };
            this.notify();
            break;
          }
          // Remplace pendant l'envoi : la version plus recente part ensuite.
          if (this.jobs.get(job.key) !== job) continue;
          if (err.kind === "refused") {
            // Ce bloc ne passera jamais tel quel : il est marque « non
            // reconnu » et les autres continuent.
            this.jobs.delete(job.key);
            this.notify();
            await this.onFailed?.(job.key, err.message);
            continue;
          }
          job.attempts = (job.attempts ?? 0) + 1;
          job.error = err.message;
          // 2 s, 4 s, 8 s... plafonne a 30 s : le reseau d'un amphi revient
          // souvent, et wake() relance des le retour.
          job.nextTry = this.clock() + Math.min(2000 * 2 ** (job.attempts - 1), MAX_RETRY_MS);
          this.notify();
          // Un job en echec ne retient plus les autres.
          continue;
        }
        this.inflight = null;
        // Seule la version envoyee quitte la file : une version plus recente,
        // posee pendant l'aller-retour, attend son tour.
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        await this.onDone(job.key, result);
        this.notify();
      }
    } finally {
      this.running = false;
      this.inflight = null;
    }
    this.scheduleNext();
  }

  private nextReady(): RecoJob | undefined {
    const now = this.clock();
    for (const job of this.jobs.values()) {
      if ((job.nextTry ?? 0) <= now) return job;
    }
    return undefined;
  }

  /** Reveil au plus proche des nouveaux essais. */
  private scheduleNext(): void {
    if (this.blocked) {
      const left = this.blocked.until - this.clock();
      if (Number.isFinite(left)) this.schedule(Math.max(0, left));
      return;
    }
    let soonest = Infinity;
    for (const j of this.jobs.values()) soonest = Math.min(soonest, j.nextTry ?? 0);
    if (soonest === Infinity) return;
    this.schedule(Math.max(0, soonest - this.clock()));
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, ms);
  }
}

/**
 * Delai avant envoi apres le lever du stylet (section 4).
 * Divise les allers-retours reseau par dix et economise la batterie.
 */
export const SEND_DEBOUNCE_MS = 500;

/**
 * Meme delai en conversion au fil de la plume (D14). Chaque envoi part avec
 * toute la page : a 500 ms, un cours de 1 h 30 coutait des centaines de
 * requetes et le quota mensuel partait en quelques cours.
 */
export const AUTO_DEBOUNCE_MS = 1500;
