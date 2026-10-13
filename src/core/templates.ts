/**
 * Modeles de formules du ruban Maths. Donnees pures : la fiche des
 * raccourcis (shortcuts.ts) les lit aussi, sans dependre de l'interface.
 * #@ = mot pris avant le curseur, #? = case a remplir.
 * `key` : raccourci Alt+touche, choisi pour tomber sous les doigts en AZERTY.
 * Bornes (integrale, somme) : MathLive parcourt la case du haut avant celle
 * du bas ; textdoc.ts (lowerBoundFirst, switchBound) remet la basse d'abord.
 */
export interface MathTemplate {
  label: string;      // apercu KaTeX sur le bouton
  insert: string;     // LaTeX insere par MathLive
  title: string;
  key?: string;
}

export const MATH_TEMPLATES: MathTemplate[] = [
  { label: "\\frac{a}{b}", insert: "\\frac{#@}{#?}", title: "Fraction", key: "f" },
  { label: "x^{n}", insert: "#@^{#?}", title: "Puissance", key: "p" },
  { label: "x_{i}", insert: "#@_{#?}", title: "Indice", key: "i" },
  { label: "\\sqrt{x}", insert: "\\sqrt{#?}", title: "Racine", key: "r" },
  { label: "\\sqrt[n]{x}", insert: "\\sqrt[#?]{#?}", title: "Racine n-ième" },
  { label: "\\int_a^b", insert: "\\int_{#?}^{#?}#?\\,\\mathrm{d}\\,#?", title: "Intégrale : borne basse, Tab, borne haute, Tab, fonction, Tab, variable", key: "n" },
  { label: "\\sum", insert: "\\sum_{#?}^{#?}#?", title: "Somme : borne basse, Tab, borne haute, Tab, terme", key: "s" },
  { label: "\\lim", insert: "\\lim_{#?\\to#?}#?", title: "Limite", key: "l" },
  { label: "\\frac{\\mathrm{d}}{\\mathrm{d}x}", insert: "\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}", title: "Dérivée", key: "d" },
  { label: "\\vec{u}", insert: "\\vec{#?}", title: "Vecteur", key: "v" },
  // Barre sur ce qui precede le curseur (« alpha » puis Alt+B : ᾱ) : conjugue, moyenne.
  { label: "\\overline{z}", insert: "\\overline{#@}", title: "Barre (conjugué, moyenne) sur ce qui précède le curseur", key: "b" },
  { label: "\\binom{n}{k}", insert: "\\binom{#?}{#?}", title: "Coefficient binomial" },
  { label: "|x|", insert: "\\left|#?\\right|", title: "Valeur absolue" },
  { label: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", insert: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}", title: "Matrice 2×2", key: "m" },
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
  return !!k && (MATH_TEMPLATES.some((t) => t.key === k) || "ehgazt".includes(k));
}
