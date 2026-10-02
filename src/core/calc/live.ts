import { CalcEngine, displayTex, frTexDecimal, isRounded, typedJ, type ImagUnit } from "./engine";
import { stripY } from "./plot";

/**
 * Rendu LaTeX des blocs vivants calc et graph (section 2). L'expression
 * est relue par le moteur (toLatex), comme la ligne « Lu par le moteur » :
 * « 7*6 » s'affiche 7·6, « sqrt(2) » s'affiche √2, jamais le texte mathjs brut.
 */

const reader = new CalcEngine();

const frDecimal = frTexDecimal;

/** Texte quelconque dans un \text{} sans casser le TeX. */
function textTex(s: string): string {
  return `\\text{${s.replace(/[\\{}$&#^_%~]/g, (c) => `\\${c}`)}}`;
}

/**
 * Resultat stocke (texte de format() : « 7234.31559568 », « 1.5e-12 »,
 * « 2 + 3i », « [[1, 2], [3, 4]] », « 5 V ») en LaTeX.
 */
export function resultTex(result: string | number | null | undefined, imag: ImagUnit = "i"): string {
  return readResult(result, imag).tex;
}

/**
 * Resultat stocke relu : nombre a 6 chiffres significatifs (`rounded` : la
 * valeur stockee est plus longue, la ligne dit ≈), complexe avec j, unite
 * en lecture ingenieur, ∞ et « non défini » en francais.
 */
function readResult(result: string | number | null | undefined, imag: ImagUnit): { tex: string; rounded: boolean } {
  const s = String(result ?? "").trim();
  if (!s) return { tex: "", rounded: false };
  const opts = { imag, angle: "RAD" as const };
  if (/^-?Infinity$/.test(s)) return { tex: s[0] === "-" ? "-\\infty" : "\\infty", rounded: false };
  if (s === "NaN") return { tex: "\\text{non défini}", rounded: false };
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s)) {
    const x = Number(s);
    return { tex: displayTex(x, opts), rounded: isRounded(x) };
  }
  // « f(x) définie », « Variables définies » : une phrase, pas une expression.
  if (/[^\x00-\x7F]/.test(s)) return { tex: textTex(s), rounded: false };
  try {
    const v = reader.math.evaluate(s);
    if (typeof v === "object" && v !== null && ((v as any).isComplex || (v as any).isUnit)) {
      const tex = displayTex(v, opts);
      return { tex, rounded: (v as any).isUnit || isRounded((v as any).re ?? 0) || isRounded((v as any).im ?? 0) };
    }
  } catch { /* pas une valeur : relue comme expression */ }
  const tex = reader.toLatex(s);
  return { tex: tex ? frDecimal(tex) : textTex(s), rounded: false };
}

/** Expression d'un calcul telle que le moteur l'a lue (prefixes 2,2k compris). */
export function exprTex(expr: string): string {
  const tex = reader.toLatex(expr, true);
  return tex ? frDecimal(tex) : textTex(expr);
}

/** Ligne complete d'un bloc calc : « \frac{1}{2\pi ...} = 7234{,}3 ». */
export function calcTex(expr: string, result: string | number | null | undefined): string {
  // Complexe affiche avec j si le calcul l'utilisait, sinon avec i.
  const r = readResult(result, typedJ(expr) ? "j" : "i");
  return r.tex ? `${exprTex(expr)} ${r.rounded ? "\\approx" : "="} ${r.tex}` : exprTex(expr);
}

/** Titre d'un bloc courbe : « y = \frac{x\sin x}{2} ». */
export function graphTex(fn: string): string {
  const src = stripY(fn);
  const tex = reader.toLatex(src);
  return `y = ${tex ? frDecimal(tex) : textTex(src)}`;
}
