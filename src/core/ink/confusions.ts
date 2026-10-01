/**
 * Autres lectures d'une formule manuscrite (section 4 : « dx / dz, a / α »).
 *
 * MyScript ne renvoie qu'un LaTeX par formule, sans candidats. Les erreurs
 * d'une formule ecrite a la main sont pourtant toujours les memes : on les
 * propose a partir d'une table de confusions, un geste au lieu d'aller
 * corriger le code LaTeX. Logique pure.
 */

/** Paires de lectures qui se confondent a la main, dans les deux sens. */
export const CONFUSIONS: [string, string][] = [
  ["dz", "dx"],
  // Le z lu pour un x l'est partout : f(z)dz -> f(x)dx, pas f(z)dx seul.
  ["z", "x"],
  ["a", "\\alpha"],
  ["x", "\\times"],
  ["v", "\\nu"],
  ["u", "\\mu"],
  ["e", "\\varepsilon"],
];

/**
 * Decoupe un LaTeX en jetons : une commande (`\alpha`), un caractere, ou
 * une commande d'un symbole (`\{`). Une lettre a l'interieur d'une commande
 * (le « a » de `\frac`) n'est donc jamais prise pour une variable.
 */
export function tokenize(latex: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < latex.length;) {
    if (latex[i] === "\\") {
      const m = /^\\([a-zA-Z]+|.)/.exec(latex.slice(i));
      const tok = m ? m[0] : "\\";
      out.push(tok);
      i += tok.length;
    } else {
      out.push(latex[i]);
      i++;
    }
  }
  return out;
}

/** Recolle des jetons. Une commande suivie d'une lettre garde une espace. */
function join(tokens: string[]): string {
  let s = "";
  for (const t of tokens) {
    if (/\\[a-zA-Z]+$/.test(s) && /^[a-zA-Z]/.test(t)) s += " ";
    s += t;
  }
  return s;
}

/** Jetons d'une lecture : « dz » = d puis z ; « \alpha » = un jeton. */
function pieces(form: string): string[] {
  return tokenize(form);
}

/**
 * Remplace toutes les occurrences de la suite `from` par `to`. Les espaces
 * qui suivent une commande remplacee sont absorbes (`\times y` -> `xy`).
 */
function replaceSeq(tokens: string[], from: string[], to: string[]): string[] | null {
  const out: string[] = [];
  let hit = false;
  for (let i = 0; i < tokens.length;) {
    if (from.every((f, k) => tokens[i + k] === f)) {
      out.push(...to);
      i += from.length;
      hit = true;
      if (from[from.length - 1].startsWith("\\")) while (tokens[i] === " ") i++;
      continue;
    }
    out.push(tokens[i]);
    i++;
  }
  return hit ? out : null;
}

/**
 * Jusqu'a `max` autres lectures de `latex`, une confusion a la fois
 * (toutes ses occurrences). Jamais la lecture d'origine, jamais deux fois
 * la meme.
 */
export function confusionCandidates(latex: string, max = 5): string[] {
  const tokens = tokenize(latex);
  const seen = new Set([latex.trim()]);
  const out: string[] = [];
  for (const [a, b] of CONFUSIONS) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const swapped = replaceSeq(tokens, pieces(from), pieces(to));
      if (!swapped) continue;
      const cand = join(swapped).trim();
      if (seen.has(cand)) continue;
      seen.add(cand);
      out.push(cand);
      if (out.length >= max) return out;
    }
  }
  return out;
}
