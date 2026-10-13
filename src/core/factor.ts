/**
 * Factorisation proposee en grise, logique pure (DOM : TextDoc.suggester,
 * branche dans pageview.ts avant les formules deja ecrites).
 *
 * « 3p + 4p = p( » : le facteur tape devant la parenthese est retire de
 * chaque terme de la somme a gauche du dernier « = », et la suite
 * « 3 + 4) » est proposee. Facteur lettre(s) (« p », « RC », « x^2 ») ou
 * entier (« 6x + 9 = 3( » -> « 2x + 3) »).
 */

/** Suite proposee : `insert` tape au curseur (markdown du texte), rien de remplace. */
export interface FactorSuggestion { insert: string; replace: number }

/** Signes qui separent les termes d'une somme. */
const SIGNS = new Set(["+", "-", "−"]);

/**
 * Suite a proposer pour la ligne `line` (relue jusqu'au curseur, formules
 * converties par leur source tapee), ou null.
 */
export function factorSuggest(line: string): FactorSuggestion | null {
  const m = /=\s*([A-Za-zα-ωΑ-Ω][A-Za-z0-9α-ωΑ-Ω]*(?:\^\d+)?|\d+)\s*\($/u.exec(line);
  if (!m) return null;
  const factor = m[1];
  const left = line.slice(0, m.index);
  // Membre de gauche : apres le « = » (ou la fleche) precedent.
  const lhs = left.split(/=|⇒|⇔|→/).pop()!;
  const parts = splitSum(lhs);
  if (!parts || parts.terms.length < 2) return null;
  const out: string[] = [];
  for (let i = 0; i < parts.terms.length; i++) {
    let term = parts.terms[i].trim();
    // Premier terme : le dernier mot seulement (« On a 3p » -> « 3p »).
    if (i === 0) term = term.split(/\s+/).pop() ?? "";
    const rest = removeFactor(term, factor);
    if (rest === null) return null;
    out.push(i === 0 ? (parts.signs[0] === "-" || parts.signs[0] === "−" ? `-${rest}` : rest) : `${parts.signs[i]} ${rest}`);
  }
  const insert = `${out.join(" ")})`.replace(/[\\$*[\]`]/g, (c) => `\\${c}`);
  return { insert, replace: 0 };
}

/** Termes d'une somme (signes au niveau des parentheses seulement). `signs[0]` : signe de tete eventuel. */
function splitSum(src: string): { terms: string[]; signs: string[] } | null {
  const terms: string[] = [], signs: string[] = [];
  let depth = 0, cur = "", sign = "";
  const s = src.trim();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth < 0) return null;
    // Un signe de tete (« -3p + … ») ou apres « ^ »/« e » d'exposant reste dans le terme.
    if (depth === 0 && SIGNS.has(c) && cur.trim() && !/[\^*·×/]\s*$/.test(cur)) {
      terms.push(cur); signs.push(sign);
      sign = c; cur = "";
      continue;
    }
    if (depth === 0 && SIGNS.has(c) && !cur.trim() && !terms.length) { sign = c; continue; }
    cur += c;
  }
  if (depth !== 0 || !cur.trim()) return null;
  terms.push(cur); signs.push(sign);
  return { terms, signs };
}

/** Le terme sans le facteur, ou null s'il ne le contient pas. */
function removeFactor(term: string, factor: string): string | null {
  const t = term.replace(/\s+/g, "");
  if (!t) return null;
  if (/^\d+$/.test(factor)) {
    const f = Number(factor);
    const n = /^(\d+)(.*)$/.exec(t);
    if (!n || f === 0 || Number(n[1]) % f !== 0) return null;
    const q = Number(n[1]) / f;
    const tail = n[2].replace(/^[*·×]/, "");
    return q === 1 && tail ? tail : `${q}${n[2]}`;
  }
  const [base, powS] = factor.split("^");
  const pow = powS ? Number(powS) : 1;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Facteur a la fin (« 3p », « 3*p », « 3p^2 ») ou au debut (« p/2 », « p*3 »).
  const end = new RegExp(`^(.*?)[*·×]?${esc}(?:\\^(\\d+))?$`, "u").exec(t);
  const start = new RegExp(`^${esc}(?:\\^(\\d+))?(?![A-Za-z0-9])(.*)$`, "u").exec(t);
  const left = (have: number) => (have > pow ? `${base}${have - pow > 1 ? `^${have - pow}` : ""}` : have === pow ? "" : null);
  if (end) {
    const rest = left(end[2] ? Number(end[2]) : 1);
    if (rest !== null) {
      const coef = end[1];
      if (!coef) return rest || "1";
      return rest ? `${coef}${rest}` : coef;
    }
  }
  if (start) {
    const rest = left(start[1] ? Number(start[1]) : 1);
    if (rest !== null) {
      const tail = start[2];
      if (!tail) return rest || "1";
      if (tail.startsWith("/")) return `${rest || "1"}${tail}`;
      return `${rest}${tail.replace(/^[*·×]/, "")}` || null;
    }
  }
  return null;
}
