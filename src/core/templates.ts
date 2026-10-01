/**
 * Modeles de formules du ruban Maths. Donnees pures : la fiche des
 * raccourcis (shortcuts.ts) les lit aussi, sans dependre de l'interface.
 * #@ = mot pris avant le curseur, #? = case a remplir.
 * `key` : raccourci Alt+touche, choisi pour tomber sous les doigts en AZERTY.
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
  { label: "\\int_a^b", insert: "\\int_{#?}^{#?}#?\\,\\mathrm{d}\\,#?", title: "Intégrale : borne haute, Tab, borne basse, Tab, fonction", key: "n" },
  { label: "\\sum", insert: "\\sum_{#?}^{#?}#?", title: "Somme : borne haute, Tab, borne basse", key: "s" },
  { label: "\\lim", insert: "\\lim_{#?\\to#?}#?", title: "Limite", key: "l" },
  { label: "\\frac{\\mathrm{d}}{\\mathrm{d}x}", insert: "\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}", title: "Dérivée", key: "d" },
  { label: "\\vec{u}", insert: "\\vec{#?}", title: "Vecteur", key: "v" },
  { label: "\\binom{n}{k}", insert: "\\binom{#?}{#?}", title: "Coefficient binomial" },
  { label: "|x|", insert: "\\left|#?\\right|", title: "Valeur absolue" },
  { label: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", insert: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}", title: "Matrice 2×2", key: "m" },
  { label: "\\begin{cases}\\cdot\\\\\\cdot\\end{cases}", insert: "\\begin{cases}#?\\\\#?\\end{cases}", title: "Système" },
];
