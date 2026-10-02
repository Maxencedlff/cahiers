import { CalcEngine } from "./engine";
import { stripY } from "./plot";

/**
 * Rendu LaTeX des blocs vivants calc et graph (section 2). L'expression
 * est relue par le moteur (toLatex), comme la ligne « Lu par le moteur » :
 * « 7*6 » s'affiche 7·6, « sqrt(2) » s'affiche √2, jamais le texte mathjs brut.
 */

const reader = new CalcEngine();

/** Point decimal des nombres mis en virgule francaise ({,} : sans espace en TeX). */
function frDecimal(tex: string): string {
  return tex.replace(/(\d)\.(\d)/g, "$1{,}$2");
}

/** Texte quelconque dans un \text{} sans casser le TeX. */
function textTex(s: string): string {
  return `\\text{${s.replace(/[\\{}$&#^_%~]/g, (c) => `\\${c}`)}}`;
}

/**
 * Resultat stocke (texte de format() : « 7234.31559568 », « 1.5e-12 »,
 * « 2 + 3i », « [[1, 2], [3, 4]] », « 5 V ») en LaTeX.
 */
export function resultTex(result: string | number | null | undefined): string {
  const s = String(result ?? "").trim();
  if (!s) return "";
  const m = /^(-?\d+(?:\.\d+)?)e([+-]?\d+)$/i.exec(s);
  if (m) return `${frDecimal(m[1])} \\cdot 10^{${Number(m[2])}}`;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return frDecimal(s);
  // « f(x) définie », « Variables définies » : une phrase, pas une expression.
  if (/[^\x00-\x7F]/.test(s)) return textTex(s);
  const tex = reader.toLatex(s);
  return tex ? frDecimal(tex) : textTex(s);
}

/** Expression d'un calcul telle que le moteur l'a lue (prefixes 2,2k compris). */
export function exprTex(expr: string): string {
  const tex = reader.toLatex(expr, true);
  return tex ? frDecimal(tex) : textTex(expr);
}

/** Ligne complete d'un bloc calc : « \frac{1}{2\pi ...} = 7234{,}3 ». */
export function calcTex(expr: string, result: string | number | null | undefined): string {
  const r = resultTex(result);
  return r ? `${exprTex(expr)} = ${r}` : exprTex(expr);
}

/** Titre d'un bloc courbe : « y = \frac{x\sin x}{2} ». */
export function graphTex(fn: string): string {
  const src = stripY(fn);
  const tex = reader.toLatex(src);
  return `y = ${tex ? frDecimal(tex) : textTex(src)}`;
}
