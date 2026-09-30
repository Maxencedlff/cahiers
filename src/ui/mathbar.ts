import { el } from "./dom";
import { renderTex } from "./tex";
import { insertMathTemplate, type TextDoc } from "./textdoc";

/**
 * Modeles de formules. #@ = mot pris avant le curseur, #? = case a remplir.
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
  { label: "\\sqrt[n]{x}", insert: "\\sqrt[#?]{#?}", title: "Racine n-ieme" },
  { label: "\\int_a^b", insert: "\\int_{#?}^{#?}#?\\,\\mathrm{d}\\,#?", title: "Integrale : borne haute, Tab, borne basse, Tab, fonction", key: "n" },
  { label: "\\sum", insert: "\\sum_{#?}^{#?}#?", title: "Somme : borne haute, Tab, borne basse", key: "s" },
  { label: "\\lim", insert: "\\lim_{#?\\to#?}#?", title: "Limite", key: "l" },
  { label: "\\frac{\\mathrm{d}}{\\mathrm{d}x}", insert: "\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}", title: "Derivee", key: "d" },
  { label: "\\vec{u}", insert: "\\vec{#?}", title: "Vecteur", key: "v" },
  { label: "\\binom{n}{k}", insert: "\\binom{#?}{#?}", title: "Coefficient binomial" },
  { label: "|x|", insert: "\\left|#?\\right|", title: "Valeur absolue" },
  { label: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", insert: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}", title: "Matrice 2x2", key: "m" },
  { label: "\\begin{cases}\\cdot\\\\\\cdot\\end{cases}", insert: "\\begin{cases}#?\\\\#?\\end{cases}", title: "Systeme" },
];

/** Symboles frequents : un clic, sans quitter le clavier longtemps. */
const SYMBOLS: [string, string][] = [
  ["\\alpha", "\\alpha"], ["\\beta", "\\beta"], ["\\lambda", "\\lambda"], ["\\pi", "\\pi"],
  ["\\theta", "\\theta"], ["\\omega", "\\omega"], ["\\Delta", "\\Delta"], ["\\infty", "\\infty"],
  ["\\to", "\\to"], ["\\Rightarrow", "\\Rightarrow"], ["\\Leftrightarrow", "\\Leftrightarrow"],
  ["\\leq", "\\leq"], ["\\geq", "\\geq"], ["\\neq", "\\neq"], ["\\approx", "\\approx"],
  ["\\in", "\\in"], ["\\forall", "\\forall"], ["\\exists", "\\exists"], ["\\mathbb{R}", "\\mathbb{R}"],
  ["\\times", "\\times"], ["\\pm", "\\pm"], ["\\partial", "\\partial"], ["\\Omega", "\\Omega"], ["\\eta", "\\eta"],
];

/**
 * Ruban Maths. Les boutons ne prennent jamais le focus : le curseur reste
 * dans le texte ou la formule, on enchaine au clavier sans recliquer.
 */
export function buildMathBar(getDoc: () => TextDoc | undefined): HTMLElement {
  const bar = el("div", { class: "mathbar" });
  const button = (label: string, title: string, insert: string) => {
    const b = el("button", { class: "mathkey", title }, renderTex(label));
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => insertMathTemplate(insert, getDoc()));
    return b;
  };

  const eq = el("button", { class: "mathkey eq", title: "Nouvelle formule (Alt+=)" }, "Équation");
  eq.addEventListener("pointerdown", (e) => e.preventDefault());
  eq.addEventListener("mousedown", (e) => e.preventDefault());
  eq.addEventListener("click", () => getDoc()?.insertMath(""));
  bar.append(eq, el("div", { class: "sep" }));

  for (const t of MATH_TEMPLATES) {
    bar.append(button(t.label, t.key ? `${t.title} (Alt+${t.key.toUpperCase()})` : t.title, t.insert));
  }
  bar.append(el("div", { class: "sep" }));
  for (const [label, insert] of SYMBOLS) bar.append(button(label, insert, insert));
  return bar;
}
