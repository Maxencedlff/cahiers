import { el } from "./dom";
import { buildFormulaPanel } from "./mathbar";
import type { TextDoc } from "./textdoc";
import { clampFormulaSplit } from "../core/chrome";

export interface FormulaDockHost {
  /** Texte qui recoit les touches (page ou case de tableau). */
  getDoc: () => TextDoc | undefined;
  /** Boutons de l'en-tete (fermer), construits par l'appli comme les autres. */
  actions: HTMLElement[];
  /** Separateur relache : part de la colonne a retenir (null = automatique). */
  onSplit: (ratio: number | null) => void;
}

/**
 * Volet des formules ancre dans la colonne de droite (`.inspector`), au-dessus
 * de la calculatrice quand elle y est aussi : il retrecit la zone des pages,
 * il ne la couvre jamais. Seul, il prend toute la hauteur ; avec la
 * calculatrice, la calculatrice garde sa hauteur naturelle et le volet le
 * reste ; le separateur fixe une part `--fp-split` (double-clic : de nouveau
 * automatique). La disposition elle-meme est en CSS (`.inspector.both`).
 */
export function buildFormulaDock(host: FormulaDockHost): HTMLElement {
  const split = el("div", {
    class: "fp-split", role: "separator", "aria-orientation": "horizontal",
    title: "Glisser pour partager la colonne avec la calculatrice (double-clic : automatique)",
  });
  const root = el("section", { class: "formula-dock", "aria-label": "Formules" },
    el("header", { class: "math-head" },
      el("span", { class: "math-title" }, "Formules"),
      el("div", { class: "spacer" }),
      ...host.actions,
    ),
    buildFormulaPanel(host.getDoc),
    split,
  );

  const column = () => root.parentElement;
  const apply = (ratio: number) => {
    column()?.classList.add("split");
    column()?.style.setProperty("--fp-split", String(ratio));
  };
  const ratioAt = (y: number) => {
    const r = column()!.getBoundingClientRect();
    return clampFormulaSplit((y - r.top) / Math.max(1, r.height)) ?? 0.5;
  };
  split.addEventListener("pointerdown", (e) => {
    if (!column()) return;
    // Jamais le focus : le curseur reste dans le texte.
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add("dragging");
    const move = (m: PointerEvent) => apply(ratioAt(m.clientY));
    const up = (u: PointerEvent) => {
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      split.removeEventListener("pointercancel", up);
      split.classList.remove("dragging");
      host.onSplit(ratioAt(u.clientY));
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
    split.addEventListener("pointercancel", up);
  });
  split.addEventListener("dblclick", () => host.onSplit(null));
  return root;
}
