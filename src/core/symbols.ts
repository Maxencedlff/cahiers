/**
 * Symboles du ruban Maths, ranges par usage comme les emojis frequents d'un
 * telephone : les plus utilises recemment passent devant.
 *
 * Score "frecence" : chaque usage ajoute 1, le score perd la moitie de sa
 * valeur toutes les deux semaines. Un symbole tres utilise l'an dernier
 * finit par laisser la place a celui de ce semestre.
 *
 * Reglage local a la machine (localStorage), comme settings.ts : il n'a
 * rien a faire dans le dossier synchronise.
 */
import { ALL_KEYS, isTemplate, keyFor } from "./mathcatalog";

/**
 * [rendu, insertion] des symboles seuls du catalogue (core/mathcatalog.ts),
 * ceux qu'une formule tapee peut contenir ; l'ordre sert pour les symboles
 * jamais utilises. Les modeles (cases a remplir) comptent seulement au clic.
 */
export const SYMBOLS: [string, string][] = ALL_KEYS
  .filter((k) => !isTemplate(k.insert))
  .map((k) => [k.label ?? k.insert, k.insert]);

const KEY = "cahiers.symbols.v1";
const HALF_LIFE_MS = 14 * 24 * 3600 * 1000;

type Usage = Record<string, { s: number; t: number }>;

function load(): Usage {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Usage; } catch { return {}; }
}

/** Evenement emis sur window a chaque usage : le ruban se reordonne. */
export const SYMBOLS_CHANGED = "cahiers:symbols";

function save(u: Usage): void {
  try { localStorage.setItem(KEY, JSON.stringify(u)); } catch { /* stockage indisponible */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SYMBOLS_CHANGED));
}

function current(entry: { s: number; t: number } | undefined, now: number): number {
  if (!entry) return 0;
  return entry.s * Math.pow(0.5, (now - entry.t) / HALF_LIFE_MS);
}

/** Un usage de ce symbole (son LaTeX d'insertion). */
export function recordSymbol(insert: string, now = Date.now()): void {
  const u = load();
  bump(u, insert, now);
  save(u);
}

function bump(u: Usage, insert: string, now: number): void {
  u[insert] = { s: current(u[insert], now) + 1, t: now };
}

/**
 * Symboles de la liste presents dans une formule mise en forme. `before` :
 * la meme formule avant qu'on la prolonge, deja comptee.
 */
export function recordLatex(latex: string, before = "", now = Date.now()): void {
  const u = load();
  let changed = false;
  for (const [insert, re] of SYMBOL_PATTERNS) {
    const added = (latex.match(re)?.length ?? 0) - (before.match(re)?.length ?? 0);
    for (let k = 0; k < added; k++) { bump(u, insert, now); changed = true; }
  }
  // Une seule ecriture (et un seul reordonnancement du volet) par formule.
  if (changed) save(u);
}

/** Motif de chaque symbole ; \in ne doit pas compter dans \infty : pas de lettre juste apres. */
const SYMBOL_PATTERNS: [string, RegExp][] = SYMBOLS.map(([, insert]) => [
  insert, new RegExp(`${insert.replace(/[\\^$.*+?()[\]{}|]/g, (c) => `\\${c}`)}(?![A-Za-z])`, "g"),
]);

/**
 * Score d'usage de chaque touche (symbole ou modele, par son LaTeX
 * d'insertion) : sert a faire passer devant les plus utilisees.
 */
export function usageScores(now = Date.now()): (insert: string) => number {
  const u = load();
  return (insert) => current(u[insert], now);
}

/** Symboles tries : les plus utilises recemment d'abord, puis l'ordre d'origine. */
export function orderedSymbols(now = Date.now()): [string, string][] {
  const u = load();
  return SYMBOLS
    .map((sym, i) => ({ sym, i, score: current(u[sym[1]], now) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.sym);
}

/**
 * Nom lisible d'un symbole, pour l'infobulle du ruban : au survol on lit
 * « alpha » ou « implique », pas « \alpha ».
 */
export function symbolName(insert: string): string {
  return keyFor(insert)?.name ?? insert.replace(/^\\/, "");
}
