import { el } from "./dom";
import { renderTex } from "./tex";
import { insertMathTemplate, type TextDoc } from "./textdoc";
import { orderedSymbols, recordSymbol, symbolName, SYMBOLS_CHANGED } from "../core/symbols";
import { MATH_TEMPLATES } from "../core/templates";

export { MATH_TEMPLATES, type MathTemplate } from "../core/templates";

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
  // Les plus utilises d'abord, comme les emojis frequents. L'ordre se remet
  // a jour des qu'un symbole est utilise (clic ou formule tapee).
  const syms = el("div", { class: "mathsyms" });
  const paintSymbols = () => {
    syms.replaceChildren(...orderedSymbols().map(([label, insert]) => {
      // Infobulle lisible (« alpha », « implique »), pas du LaTeX brut.
      const b = button(label, symbolName(insert), insert);
      b.addEventListener("click", () => recordSymbol(insert));
      return b;
    }));
  };
  paintSymbols();
  // La colonne d'outils est reconstruite a chaque changement d'outil : un
  // ruban qui a quitte l'ecran retire son ecouteur, sinon ils s'accumulent.
  const onChange = () => {
    if (syms.isConnected) paintSymbols();
    else window.removeEventListener(SYMBOLS_CHANGED, onChange);
  };
  window.addEventListener(SYMBOLS_CHANGED, onChange);
  bar.append(syms);
  return bar;
}
