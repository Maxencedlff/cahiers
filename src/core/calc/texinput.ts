/**
 * LaTeX -> saisie de calculatrice, lisible et modifiable a la main.
 *
 * Une formule copiee (editeur de formule, page, ChatGPT, Word...) arrive en
 * LaTeX : « \frac{1}{2\pi RC} ». La calculatrice doit afficher ce qu'on
 * aurait tape au pave : « 1/(2π·R·C) », jamais une commande « \... ».
 *
 * Deux temps, pour garder la priorite des operations juste :
 * 1. `texparse.ts` lit le LaTeX en un petit arbre (fractions, racines,
 *    puissances, appels de fonction, parentheses, suites de facteurs) ;
 * 2. `texprint.ts` le reecrit avec les parentheses minimales mais suffisantes
 *    (numerateur somme, denominateur produit, exposant compose).
 *
 * Conventions (toutes lues par CalcEngine.normalizeInput) :
 * - produit implicite entre lettres : « · » (R·C) ; \cdot, \times : « × » ;
 *   un nombre colle a une lettre reste colle (2π, 3p) ;
 * - lettres grecques en lettres (τ, ω), π pour \pi, √(x) pour \sqrt{x} ;
 * - indice aplati comme dans le reste de l'appli : V_{be} -> Vbe, R_{1} -> R1 ;
 * - virgule decimale gardee (2{,}5 -> 2,5) ;
 * - unites ecrites en \text/\mathrm separees du nombre par une espace (« 50 Ω »).
 *
 * Ce qui ne se calcule pas (integrale, somme, ≈, ⇔, systeme...) est retire
 * et nomme dans `dropped`, pour un message clair : la saisie ne montre jamais
 * de commande brute.
 */

import { DOC_CLIP_TYPE, parseDoc } from "../text/doc";
import { cutAtRelations, Parser, tokenize, withoutDifferential } from "./texparse";
import { printSeq } from "./texprint";

export interface CalcText {
  /** Expression a poser dans la calculatrice. */
  expr: string;
  /** Ce qui a ete laisse de cote, en clair (« intégrale », « ≈ »). Vide si tout est passe. */
  dropped: string[];
}

/** Le texte contient-il du LaTeX (commande, groupe d'indice, delimiteur $) ? */
export function looksLikeTex(text: string): boolean {
  return /\\[A-Za-z]|\\[,;:! %{}]|[_^]\{|\{,\}|\$/.test(text);
}

/**
 * Texte colle : morceaux $...$, $$...$$, \(...\), \[...\] convertis, texte
 * autour garde ; sans delimiteur, le tout est lu comme du LaTeX s'il en a l'air.
 */
export function pastedToCalc(text: string): CalcText {
  const dropped: string[] = [];
  const delim = /\$\$([\s\S]+?)\$\$|\$([^$]+)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  if (!delim.test(text)) {
    return looksLikeTex(text) ? texToCalc(text) : { expr: text.trim(), dropped };
  }
  delim.lastIndex = 0;
  const expr = text.replace(delim, (_m, a?: string, b?: string, c?: string, d?: string) => {
    const r = texToCalc(a ?? b ?? c ?? d ?? "");
    dropped.push(...r.dropped);
    return r.expr;
  });
  return { expr: tidy(expr), dropped: unique(dropped) };
}

/**
 * Morceau copie d'une page (format du document) : texte garde, formules
 * converties. Plus fidele que le text/plain du presse-papiers, deja aplati
 * pour les autres logiciels (« RC » y reste un seul nom).
 */
export function docToCalc(doc: string): CalcText {
  const dropped: string[] = [];
  const expr = parseDoc(doc).map((t) => {
    if (t.kind === "text") return t.text;
    if (t.kind === "math") { const r = texToCalc(t.latex); dropped.push(...r.dropped); return r.expr; }
    return t.kind === "br" ? " " : "";
  }).join("");
  return { expr: tidy(expr), dropped: unique(dropped) };
}

/**
 * Ce qu'un collage apporte a la calculatrice, du plus fidele au moins fidele :
 * morceau de page, LaTeX de l'editeur de formule (MathLive), texte simple.
 * `converted` : faux si le texte etait deja une saisie ordinaire (rien a reecrire).
 */
export function clipboardToCalc(get: (type: string) => string): CalcText & { converted: boolean } {
  const doc = get(DOC_CLIP_TYPE);
  if (doc.trim()) return { ...docToCalc(doc), converted: true };
  const latex = get("application/x-latex");
  if (latex.trim()) return { ...texToCalc(latex), converted: true };
  const plain = get("text/plain");
  return looksLikeTex(plain) ? { ...pastedToCalc(plain), converted: true } : { expr: plain.trim(), dropped: [], converted: false };
}

/** Message pour ce qui n'a pas pu passer dans la calculatrice. */
export function droppedMessage(dropped: string[]): string | null {
  return dropped.length ? `Non calculable ici, laissé de côté : ${dropped.join(", ")}` : null;
}

/** Une formule LaTeX (sans delimiteurs) en saisie de calculatrice. */
export function texToCalc(tex: string): CalcText {
  const p = new Parser(tokenize(tex));
  const seq = p.sequence(() => false);
  const kept = cutAtRelations(p.integral ? withoutDifferential(seq) : seq, p.dropped);
  return { expr: tidy(printSeq(kept).s), dropped: unique(p.dropped) };
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}
