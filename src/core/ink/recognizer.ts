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

export class MyScriptBackend implements RecognitionBackend {
  readonly name = "MyScript iink";
  constructor(private keys: MyScriptKeys) {}

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
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`MyScript ${res.status} ${res.statusText}${detail ? ` : ${detail.slice(0, 160)}` : ""}`);
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
 * Format demande a MyScript.
 *
 * Math : LaTeX direct. Le JIIX math ne contient pas de champ latex, seulement
 * un arbre d'expressions, donc le demander reviendrait a le reconstruire.
 * Consequence assumee : pas de candidats alternatifs sur une formule, la
 * correction se fait a la main.
 *
 * Texte : JIIX, qui porte a la fois le libelle et les candidats par mot,
 * ce qui donne la correction en un geste de la section 4.
 */
export function acceptFor(kind: RecoKind): string {
  return kind === "math" ? "application/x-latex" : "application/vnd.myscript.jiix";
}

/** Corps de requete batch v4. Les traits partent en colonnes x[], y[], t[], p[]. */
export function buildBatchBody(kind: RecoKind, strokes: Stroke[]) {
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
        strokes: strokes.map((s) => ({
          id: s.id,
          x: s.points.map((p) => round(p.x)),
          y: s.points.map((p) => round(p.y)),
          t: s.points.map((p) => Math.round(p.t)),
          p: s.points.map((p) => round(p.p)),
          pointerType: "PEN",
        })),
      },
    ],
  };
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
  // l'echec remonte en "Cannot read properties of undefined".
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "Signature impossible : le contexte n'est pas securise. " +
      "Ouvre l'application installee, ou sers la page en https ou sur localhost.",
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
 * les blocs restent en attente et partiront des que les cles seront la.
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
  /** Cle unique : notebook/divider/page#block. */
  key: string;
  kind: RecoKind;
  strokes: Stroke[];
  /** Nombre d'echecs consecutifs, pour l'attente exponentielle. */
  attempts?: number;
  nextTry?: number;
}

export type QueueListener = (state: QueueState) => void;

export interface QueueState {
  pending: number;
  online: boolean;
  lastError: string | null;
  backendName: string;
  /** false quand aucun moteur n'est configure : rien ne partira jamais. */
  backendReady: boolean;
}

/**
 * File d'attente hors ligne. Un seul envoi a la fois, attente exponentielle
 * en cas d'echec, reprise automatique au retour du reseau.
 */
export class RecognitionQueue {
  private jobs = new Map<string, RecoJob>();
  private listeners = new Set<QueueListener>();
  private running = false;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private backend: RecognitionBackend,
    private onDone: (key: string, result: RecoResult) => Promise<void> | void,
    private clock: () => number = () => Date.now(),
  ) {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.pump());
      window.addEventListener("offline", () => this.notify());
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
    return {
      pending: this.jobs.size,
      online: this.online,
      lastError: this.lastError,
      backendName: this.backend.name,
      backendReady: this.backend.available,
    };
  }

  private notify() { for (const l of this.listeners) l(this.state()); }

  /** Remplace un job existant pour la meme cle : seule la derniere version compte. */
  enqueue(job: RecoJob): void {
    this.jobs.set(job.key, { attempts: 0, nextTry: 0, ...job });
    this.notify();
    this.pump();
  }

  cancel(key: string): void {
    if (this.jobs.delete(key)) this.notify();
  }

  async pump(): Promise<void> {
    if (this.running) return;
    if (!this.backend.available) return;
    if (!this.online) { this.notify(); return; }

    this.running = true;
    try {
      for (;;) {
        const job = this.nextReady();
        if (!job) break;
        try {
          const result = await this.backend.recognize(job.kind, job.strokes);
          this.jobs.delete(job.key);
          this.lastError = null;
          await this.onDone(job.key, result);
          this.notify();
        } catch (e) {
          job.attempts = (job.attempts ?? 0) + 1;
          this.lastError = e instanceof Error ? e.message : String(e);
          // 2 s, 4 s, 8 s... plafonne a 5 min.
          const wait = Math.min(2000 * 2 ** (job.attempts - 1), 300_000);
          job.nextTry = this.clock() + wait;
          this.notify();
          this.schedule(wait);
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private nextReady(): RecoJob | undefined {
    const now = this.clock();
    for (const job of this.jobs.values()) {
      if ((job.nextTry ?? 0) <= now) return job;
    }
    return undefined;
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
