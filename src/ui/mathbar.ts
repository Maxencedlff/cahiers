import { el } from "./dom";
import { renderTex } from "./tex";
import { insertMathTemplate, type TextDoc } from "./textdoc";
import { orderedSymbols, recordSymbol, symbolName, SYMBOLS_CHANGED } from "../core/symbols";
import { MATH_TEMPLATES } from "../core/templates";

export { MATH_TEMPLATES, type MathTemplate } from "../core/templates";

/** Sections du volet des formules : chaque symbole du ruban y a sa place. */
const SECTIONS: { title: string; symbols: string[] }[] = [
  { title: "Grec", symbols: ["\\alpha", "\\beta", "\\gamma", "\\lambda", "\\pi", "\\theta", "\\omega", "\\eta", "\\varepsilon", "\\Delta", "\\Omega"] },
  { title: "Relations", symbols: ["\\to", "\\Rightarrow", "\\Leftrightarrow", "\\leq", "\\geq", "\\neq", "\\approx", "\\times", "\\pm"] },
  { title: "Ensembles", symbols: ["\\in", "\\forall", "\\exists", "\\mathbb{R}", "\\infty"] },
];

/**
 * Volet des formules (Σ de la barre du haut) : sections titrees,
 * Structures (Équation et modeles), Grec, Relations, Ensembles. Dans chaque
 * section, les symboles les plus utilises passent devant. Les boutons ne
 * prennent jamais le focus : le curseur reste dans le texte.
 */
export function buildFormulaPanel(getDoc: () => TextDoc | undefined): HTMLElement {
  const root = el("div", { class: "formula-panel" });
  const keep = (b: HTMLElement) => {
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  };
  const key = (label: string, title: string, insert: string, record = false) => {
    const b = keep(el("button", { class: "mathkey", title, "aria-label": title }, renderTex(label)));
    b.addEventListener("click", () => {
      insertMathTemplate(insert, getDoc());
      if (record) recordSymbol(insert);
    });
    return b;
  };
  const section = (title: string, ...keys: HTMLElement[]) =>
    el("section", { class: "fp-section" }, el("h4", { class: "fp-title" }, title), el("div", { class: "fp-keys" }, ...keys));

  const eq = keep(el("button", { class: "mathkey eq", title: "Nouvelle formule (Alt+=)" }, "Équation"));
  eq.addEventListener("click", () => getDoc()?.insertMath(""));
  const extras: [string, string][] = [["\\partial", "\\partial"], ["\\mathcal{L}", "\\mathcal{L}"], ["\\mathrm{A}", "\\mathrm{A}"]];
  const paint = () => {
    const order = orderedSymbols().map(([, insert]) => insert);
    const rank = (x: string) => { const i = order.indexOf(x); return i < 0 ? 999 : i; };
    root.replaceChildren(
      section("Structures", eq,
        ...MATH_TEMPLATES.map((t) => key(t.label, t.key ? `${t.title} (Alt+${t.key.toUpperCase()})` : t.title, t.insert)),
        ...extras.map(([label, insert]) => key(label, symbolName(insert), insert, true))),
      ...SECTIONS.map((sct) => section(sct.title,
        ...[...sct.symbols].sort((a, b) => rank(a) - rank(b)).map((insert) => key(insert, symbolName(insert), insert, true)))),
    );
  };
  paint();
  const onChange = () => {
    if (root.isConnected) paint();
    else window.removeEventListener(SYMBOLS_CHANGED, onChange);
  };
  window.addEventListener(SYMBOLS_CHANGED, onChange);
  return root;
}
