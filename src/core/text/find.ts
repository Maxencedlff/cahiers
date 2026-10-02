/**
 * Comparaison de texte pour la recherche et pour retrouver un passage dans
 * la page. Logique pure, sans DOM : la recherche globale (storage/search.ts)
 * et le surlignage dans le texte (ui/textdoc.ts) plient le texte de la meme
 * facon, sinon un resultat trouve ne serait pas retrouve sur la page.
 */

import type { ColorKey } from "../types";
import { PALETTE } from "../palette";

/** Lettres grecques par leur nom : « pi » trouve π, « π » trouve « pi ». */
const GREEK: Record<string, string> = {
  "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ϵ": "epsilon",
  "ζ": "zeta", "η": "eta", "θ": "theta", "ϑ": "theta", "ι": "iota", "κ": "kappa",
  "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho", "σ": "sigma",
  "ς": "sigma", "τ": "tau", "υ": "upsilon", "φ": "phi", "ϕ": "phi", "χ": "chi",
  "ψ": "psi", "ω": "omega",
};

const LIGATURES: Record<string, string> = { "œ": "oe", "æ": "ae", "ß": "ss" };

/**
 * Chiffres en exposant et en indice, tapes tels quels (« r² », « x₁ ») :
 * lus comme les formules relues par texToPlain (« r^2 », « x1 »).
 */
const SCRIPTS: Record<string, string> = {};
"⁰¹²³⁴⁵⁶⁷⁸⁹".split("").forEach((c, i) => { SCRIPTS[c] = "^" + i; });
"₀₁₂₃₄₅₆₇₈₉".split("").forEach((c, i) => { SCRIPTS[c] = String(i); });

/**
 * Operateurs d'une formule : les blancs autour ne comptent pas, la
 * formule relue ("(Ve · R2)/(R1 + R2)") et la recherche tapee
 * ("R2/(R1+R2)") se plient de la meme facon.
 */
export const OPS = new Set(["+", "-", "−", "=", "<", ">", "/", "^", ".", "×", "≤", "≥", "≠", "≈", "→", "⇒", "⇔", "∈"]);

/** Blanc inutile dans le texte plie `text` : en tete, double, ou derriere un operateur. */
export function skipBlank(text: string): boolean {
  return text === "" || text.endsWith(" ") || OPS.has(text[text.length - 1]);
}

/**
 * Forme pliee d'un caractere : minuscule, sans accent, grec par son nom,
 * exposants et indices en chiffres, blanc pour tout espace, rien pour l'espace sans largeur des formules.
 */
export function foldChar(c: string): string {
  if (c === "​" || c === "﻿") return "";
  // Produit : "Ve.R2", "Ve*R2" et la formule relue "Ve · R2" se valent.
  if (c === "·" || c === "⋅" || c === "*") return ".";
  if (/\s/.test(c)) return " ";
  const low = c.toLowerCase();
  const named = GREEK[low] ?? LIGATURES[low] ?? SCRIPTS[low];
  if (named) return named;
  return low.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Texte plie, avec pour chaque caractere plie l'indice du caractere
 * d'origine (et map[text.length] = longueur d'origine). Les blancs qui se
 * suivent n'en font qu'un.
 */
export function fold(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = foldChar(ch);
    // Pas de blanc colle a un operateur : "R1 + R2" se cherche "R1+R2".
    if (f === " " && skipBlank(text)) { i += ch.length; continue; }
    if (OPS.has(f[0]) && text.endsWith(" ")) { text = text.slice(0, -1); map.pop(); }
    for (const c of f) { text += c; map.push(i); }
    i += ch.length;
  }
  map.push(s.length);
  return { text, map };
}

/** Insensible a la casse ET aux accents : "theoreme" trouve "Théorème". */
export function normalize(s: string): string {
  return fold(s).text.trim();
}

export interface Query {
  /** Mots (et phrases entre guillemets), plies. Tous obligatoires. */
  terms: string[];
  /** Filtre matiere « @maths », plie. */
  notebook?: string;
  /** Filtre couleur « #theoreme ». */
  color?: ColorKey;
}

/**
 * Requete tapee : mots en ET, "phrase exacte" entre guillemets, @matiere
 * et #couleur en filtres. « rolle riemann » trouve un bloc qui contient
 * les deux mots, dans n'importe quel ordre.
 */
export function parseQuery(raw: string): Query {
  const q: Query = { terms: [] };
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) {
      const phrase = normalize(m[1]);
      if (phrase) q.terms.push(phrase);
      continue;
    }
    const word = m[2];
    if (word.length > 1 && word.startsWith("@")) { q.notebook = normalize(word.slice(1)); continue; }
    if (word.length > 1 && word.startsWith("#")) {
      const c = colorKeyOf(word.slice(1));
      if (c) { q.color = c; continue; }
    }
    const t = normalize(word);
    if (t) q.terms.push(t);
  }
  return q;
}

/** « #theoreme », « #Théorème », « #def » : une cle de la palette, ou rien. */
function colorKeyOf(word: string): ColorKey | undefined {
  const w = normalize(word);
  if (w.length < 3) return undefined;
  const hit = PALETTE.find((p) => normalize(p.key).startsWith(w) || normalize(p.label).startsWith(w));
  return hit?.key;
}

/**
 * Assez pour lancer une recherche : deux lettres au moins, ou un filtre
 * couleur seul (« #theoreme @maths » : tous les theoremes de maths).
 */
export function queryReady(q: Query): boolean {
  return q.terms.join("").length >= 2 || (!!q.color && !q.terms.length);
}

/** La matiere passe-t-elle le filtre @ ? Par le nom du dossier ou le titre. */
export function notebookMatches(q: Query, dir: string, title: string): boolean {
  if (!q.notebook) return true;
  return normalize(dir).startsWith(q.notebook) || normalize(title).startsWith(q.notebook);
}

/** Tous les termes sont-ils dans ce texte deja plie ? (aucun terme : oui) */
export function matchesAll(folded: string, terms: string[]): boolean {
  return terms.every((t) => folded.includes(t));
}

/** Occurrences des termes dans un texte plie, triees et fusionnees. */
export function occurrences(folded: string, terms: string[]): [number, number][] {
  const out: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = folded.indexOf(t); i !== -1; i = folded.indexOf(t, i + 1)) out.push([i, i + t.length]);
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [a, b] of out) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Morceau d'extrait : `mark` = un terme cherche, surligne a l'ecran. */
export interface ExcerptPart { text: string; mark?: boolean }

/**
 * Extrait autour de la premiere occurrence, termes surlignes. Le texte est
 * deja propre (sans markdown ni LaTeX) : l'extrait l'est donc aussi.
 */
export function makeExcerpt(text: string, terms: string[], radius = 40): ExcerptPart[] {
  const f = fold(text);
  const occ = occurrences(f.text, terms);
  if (!occ.length) return [{ text: clip(text, 0, Math.min(text.length, radius * 2), text.length) }];
  // Fenetre en indices d'origine autour de la premiere occurrence.
  const os = f.map[occ[0][0]];
  const oe = f.map[occ[0][1]] ?? text.length;
  let start = Math.max(0, os - radius);
  let end = Math.min(text.length, Math.max(oe, os) + radius);
  // Pas de mot coupe aux bords de l'extrait.
  if (start > 0) {
    const sp = text.slice(start, os).search(/\s/);
    if (sp !== -1) start += sp + 1;
  }
  if (end < text.length) {
    const sp = text.slice(oe, end).search(/\s\S*$/);
    if (sp !== -1) end = oe + sp;
  }
  const parts: ExcerptPart[] = [];
  let at = start;
  for (const [a, b] of occ) {
    const oa = f.map[a], ob = f.map[b] ?? text.length;
    if (ob <= start || oa >= end) continue;
    const s = Math.max(oa, start), e = Math.min(ob, end);
    if (s > at) parts.push({ text: text.slice(at, s) });
    parts.push({ text: text.slice(s, e), mark: true });
    at = e;
  }
  if (at < end) parts.push({ text: text.slice(at, end) });
  // Blancs resserres, points de suspension aux bords coupes.
  const out = parts.map((p) => ({ ...p, text: p.text.replace(/\s+/g, " ") }));
  if (start > 0) out.unshift({ text: "…" });
  if (end < text.length) out.push({ text: "…" });
  return out.filter((p) => p.text);
}

function clip(text: string, start: number, end: number, len: number): string {
  return text.slice(start, end).replace(/\s+/g, " ") + (end < len ? "…" : "");
}

/**
 * Contexte d'un repere « pas compris » : la ligne autour du curseur, a
 * peu pres `max` caracteres, en gardant surtout ce qui precede (ce qu'on
 * venait d'ecrire quand on a appuye). Coupe sur les mots.
 */
export function flagContext(before: string, after: string, max = 80): string {
  const b = before.slice(before.lastIndexOf("\n") + 1).replace(/\s+/g, " ").trimStart();
  const nl = after.indexOf("\n");
  const a = (nl === -1 ? after : after.slice(0, nl)).replace(/\s+/g, " ").trimEnd();
  let left = b;
  if (left.length > max) {
    left = left.slice(left.length - max);
    const sp = left.indexOf(" ");
    if (sp !== -1 && sp < left.length - 1) left = left.slice(sp + 1);
    left = "…" + left;
  }
  let right = a;
  const room = Math.max(0, max - left.length);
  if (right.length > room) {
    right = right.slice(0, room);
    const sp = right.lastIndexOf(" ");
    right = (sp > 0 ? right.slice(0, sp) : right) + "…";
    if (right === "…") right = "";
  }
  return (left + right).trim();
}
