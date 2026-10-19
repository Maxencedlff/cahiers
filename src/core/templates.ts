/**
 * Modeles de formules du ruban Maths. Donnees pures : la fiche des
 * raccourcis (shortcuts.ts) les lit aussi, sans dependre de l'interface.
 * #@ = mot pris avant le curseur, #? = case a remplir.
 * `key` : raccourci Alt+touche (lu sur e.code, touche physique : meme place en
 * AZERTY et QWERTY, marche aussi avec Option sur Mac). Six seulement, les
 * plus frequents (F, P, I, R, B, et Alt+= dans app.ts) ; les autres modeles
 * restent dans le ruban.
 * Bornes (integrale, somme) : MathLive parcourt la case du haut avant celle
 * du bas ; textdoc.ts (lowerBoundFirst, switchBound) remet la basse d'abord.
 */
export interface MathTemplate {
  label: string;      // apercu KaTeX sur le bouton
  insert: string;     // LaTeX insere par MathLive
  title: string;
  key?: string;
  /** Raccourci de frappe qui l'ouvre aussi (bulle d'aide, core/text/hint.ts). */
  typed?: string;
}

export const MATH_TEMPLATES: MathTemplate[] = [
  { label: "\\frac{a}{b}", insert: "\\frac{#@}{#?}", title: "Fraction", key: "f" },
  { label: "x^{n}", insert: "#@^{#?}", title: "Puissance", key: "p" },
  { label: "x_{i}", insert: "#@_{#?}", title: "Indice", key: "i" },
  { label: "\\sqrt{x}", insert: "\\sqrt{#?}", title: "Racine", key: "r", typed: "sqrt" },
  { label: "\\sqrt[n]{x}", insert: "\\sqrt[#?]{#?}", title: "Racine n-ième" },
  { label: "\\int_a^b", insert: "\\int_{#?}^{#?}#?\\,\\mathrm{d}\\,#?", title: "Intégrale : borne basse, Tab, borne haute, Tab, fonction, Tab, variable", typed: "int" },
  { label: "\\sum", insert: "\\sum_{#?}^{#?}#?", title: "Somme : borne basse, Tab, borne haute, Tab, terme", typed: "sum" },
  { label: "\\lim", insert: "\\lim_{#?\\to#?}#?", title: "Limite", typed: "lim" },
  { label: "\\frac{\\mathrm{d}}{\\mathrm{d}x}", insert: "\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}", title: "Dérivée" },
  { label: "\\vec{u}", insert: "\\vec{#?}", title: "Vecteur" },
  // Barre sur ce qui precede le curseur (« alpha » puis Alt+B : ᾱ) : conjugue, moyenne.
  { label: "\\overline{z}", insert: "\\overline{#@}", title: "Barre (conjugué, moyenne) sur ce qui précède le curseur", key: "b" },
  { label: "\\binom{n}{k}", insert: "\\binom{#?}{#?}", title: "Coefficient binomial" },
  { label: "|x|", insert: "\\left|#?\\right|", title: "Valeur absolue, module |z|" },
  { label: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", insert: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}", title: "Matrice 2×2" },
  { label: "\\begin{cases}\\cdot\\\\\\cdot\\end{cases}", insert: "\\begin{cases}#?\\\\#?\\end{cases}", title: "Système" },
];

/**
 * Raccourci de MathLive ("alt+p", "alt+[KeyP]") deja pris par un Alt+lettre
 * de l'appli : retire du champ, sinon MathLive pose aussi le sien (pi pour
 * Alt+P, racine pour Alt+V, d droit pour Alt+D) avant le modele.
 */
export function appAltKey(binding: string): boolean {
  const m = /^alt\+(?:\[Key([A-Z])\]|([a-z]))$/.exec(binding);
  const k = (m?.[1] ?? m?.[2] ?? "").toLowerCase();
  return !!k && (MATH_TEMPLATES.some((t) => t.key === k) || "ehgaztnsldvm".includes(k));
}
