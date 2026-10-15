/**
 * Etiquettes d'un schema (noms, valeurs, annotations) : lecture en formule
 * et encombrement estime (logique pure, sans DOM). Une etiquette qui n'est
 * pas une formule entiere (« i_L(t_ON) = i_L max », « Vs à vide ») est lue
 * morceau par morceau : les mots de phrase en texte, le reste en formule,
 * jamais de « _ » visible.
 */
import { forceFormula } from "../text/automath";

/**
 * Reference de composant (« 1N4148 », « BC547 », « TL081 ») ou parametre
 * LTspice (« {R1/2} ») : du texte, jamais une formule (1 N_4148).
 */
export function isPartRef(line: string): boolean {
  const t = line.trim();
  return /[{}]/.test(t) || /^\d?[A-Za-z]{1,4}\d{2,}[A-Za-z0-9-]*$/.test(t) && !/^[A-Za-z]\d{1,2}$/.test(t);
}

/** Mots d'indice ecrits apres un espace : « i_L max » = i_{L max}. */
const SUB_WORDS = "max|min|moy|eff|ON|OFF|on|off|crete|crête|pp|0";
const GREEK = "ΔδαβγεθλμπρστφωΩ";

/** Mots de maths qui ne sont jamais du texte. */
const MATH_WORDS = new Set(["sin", "cos", "tan", "exp", "ln", "log", "lim", "max", "min", "moy", "eff", "sqrt", "Cte", "cte", "arg", "det"]);

/** Mot de phrase : lettres seules (accents compris), au moins 3, ou un mot accentue. */
function proseWord(w: string): boolean {
  if (MATH_WORDS.has(w)) return false;
  if (/^[a-zà-ÿœç']+$/i.test(w) && /[à-ÿœç]/i.test(w)) return true;
  if (/^[a-zœç']{3,}$/.test(w)) return true;
  // Majuscule en tete : un mot (« Phase »), pas une grandeur (« Vbatt », « Vref »).
  return /^[A-Z][a-zœç']{4,}$/.test(w) && !/^[VIUEP]/.test(w);
}

function prepare(line: string): string {
  return line
    // « Δi_L » : la lettre grecque collee a la grandeur.
    .replace(new RegExp(`([${GREEK}])(?=[A-Za-z])`, "g"), "$1 ")
    // « i_L max » -> « i_Lmax » (relu i_{L max}).
    .replace(new RegExp(`(_[A-Za-z0-9]+) (${SUB_WORDS})\\b`, "g"), "$1$2");
}

/** Indice « Lmax » : un petit espace avant max, min, moy, eff. */
function finish(tex: string): string {
  return tex.replace(/_\{([A-Za-z0-9]+?)(max|min|moy|eff)\}/g, (_m, a: string, b: string) => `_{${a}\\,${b}}`);
}

function texEsc(s: string): string {
  return s.replace(/[\\{}#$%&^_~]/g, (c) => (c === "\\" ? "\\backslash " : `\\${c}`));
}

/**
 * LaTeX d'une etiquette : formule entiere si elle en est une, sinon mots de
 * phrase en texte et le reste en formule ; null : texte tel quel (reference
 * de composant, etiquette vide).
 */
export function labelTex(line: string): string | null {
  const t = line.trim();
  if (!t || isPartRef(t)) return null;
  const p = prepare(t);
  const whole = forceFormula(p);
  if (whole) return finish(whole);
  // Morceaux : suites de mots qui ne sont pas des mots de phrase.
  const words = p.split(/\s+/);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    const src = run.join(" ");
    const f = forceFormula(src);
    out.push(f ? finish(f) : `\\text{${texEsc(src)}}`);
    run = [];
  };
  for (const w of words) {
    if (proseWord(w) || /^[:;,!?]$/.test(w)) { flush(); out.push(`\\text{${texEsc(w)}}`); }
    else run.push(w);
  }
  flush();
  return out.join("\\ ");
}

/**
 * Encombrement estime d'une ligne d'etiquette, en cases de grille (le texte
 * fait 0,95 case de haut) : sert a placer les etiquettes sans chevauchement.
 */
export function labelWidth(line: string): number {
  const t = line.trim();
  if (!t) return 0;
  // Indices : plus petits ; « (t) » et operateurs comptes normalement.
  let w = 0;
  let sub = false, depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "_") { sub = true; depth = 0; continue; }
    if (sub && (c === " " || c === "=" || c === "+" || c === ")" && depth === 0 || c === "−" || c === "-")) sub = false;
    if (sub && c === "(") depth++;
    if (sub && c === ")") depth--;
    w += c === " " ? 0.3 : /[=+−<>-]/.test(c) ? 0.95 : sub ? 0.36 : /[mwMW]/.test(c) ? 0.7 : 0.5;
  }
  return w;
}
