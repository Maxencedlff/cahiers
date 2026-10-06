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

/** [rendu, insertion] ; l'ordre sert pour les symboles jamais utilises. */
export const SYMBOLS: [string, string][] = [
  ["\\alpha", "\\alpha"], ["\\mathrm{A}", "\\mathrm{A}"], ["\\beta", "\\beta"], ["\\gamma", "\\gamma"], ["\\lambda", "\\lambda"], ["\\pi", "\\pi"],
  ["\\theta", "\\theta"], ["\\omega", "\\omega"], ["\\Delta", "\\Delta"], ["\\infty", "\\infty"],
  ["\\to", "\\to"], ["\\Rightarrow", "\\Rightarrow"], ["\\Leftrightarrow", "\\Leftrightarrow"],
  ["\\leq", "\\leq"], ["\\geq", "\\geq"], ["\\neq", "\\neq"], ["\\approx", "\\approx"],
  ["\\in", "\\in"], ["\\forall", "\\forall"], ["\\exists", "\\exists"], ["\\mathbb{R}", "\\mathbb{R}"],
  ["\\times", "\\times"], ["\\pm", "\\pm"], ["\\partial", "\\partial"], ["\\Omega", "\\Omega"], ["\\eta", "\\eta"],
  ["\\varepsilon", "\\varepsilon"], ["\\mathcal{L}", "\\mathcal{L}"],
];

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
  u[insert] = { s: current(u[insert], now) + 1, t: now };
  save(u);
}

/**
 * Symboles de la liste presents dans une formule mise en forme. `before` :
 * la meme formule avant qu'on la prolonge, deja comptee.
 */
export function recordLatex(latex: string, before = "", now = Date.now()): void {
  for (const [, insert] of SYMBOLS) {
    const esc = insert.replace(/[\\{}]/g, (c) => `\\${c}`);
    // \in ne doit pas compter dans \infty : pas de lettre juste apres.
    const re = new RegExp(`${esc}(?![A-Za-z])`, "g");
    const added = (latex.match(re)?.length ?? 0) - (before.match(re)?.length ?? 0);
    for (let k = 0; k < added; k++) recordSymbol(insert, now);
  }
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
const SYMBOL_NAMES: Record<string, string> = {
  "\\alpha": "alpha", "\\mathrm{A}": "Alpha majuscule", "\\beta": "bêta", "\\gamma": "gamma", "\\lambda": "lambda", "\\pi": "pi",
  "\\theta": "thêta", "\\omega": "oméga", "\\Delta": "Delta majuscule", "\\infty": "infini",
  "\\to": "flèche, tend vers", "\\Rightarrow": "implique", "\\Leftrightarrow": "équivalent à",
  "\\leq": "inférieur ou égal", "\\geq": "supérieur ou égal", "\\neq": "différent de",
  "\\approx": "environ égal", "\\in": "appartient à", "\\forall": "pour tout",
  "\\exists": "il existe", "\\mathbb{R}": "ensemble des réels", "\\times": "multiplié par",
  "\\pm": "plus ou moins", "\\partial": "dérivée partielle", "\\Omega": "Oméga majuscule (ohm)",
  "\\eta": "êta", "\\varepsilon": "epsilon",
  "\\mathcal{L}": "transformée de Laplace",
};

export function symbolName(insert: string): string {
  return SYMBOL_NAMES[insert] ?? insert.replace(/^\\/, "");
}
