import { MathfieldElement } from "mathlive";
import { el } from "./dom";

/**
 * Correction d'une formule reconnue dans un champ MathLive (reco-8).
 *
 * Corriger un dz en dx obligeait a retrouver le bon endroit dans le code
 * LaTeX (\int_0^{+\infty}\frac{...}). Ici la formule s'edite telle qu'elle
 * s'affiche ; le LaTeX reste visible et modifiable dessous pour les cas que
 * l'editeur visuel ne couvre pas. Rend le LaTeX valide, ou null (Annuler).
 */
export function askLatex(title: string, latex: string): Promise<string | null> {
  return new Promise((resolve) => {
    const mf = new MathfieldElement();
    mf.mathVirtualKeyboardPolicy = "manual";
    // Pas de fermeture automatique : [a,+∞[ s'ecrit tel quel en France.
    mf.smartFence = false;
    mf.value = latex;
    mf.classList.add("latex-field");

    const source = el("input", { type: "text", class: "latex-source", spellcheck: "false" });
    source.value = latex;
    // Les deux restent d'accord : on corrige a l'endroit qu'on prefere.
    mf.addEventListener("input", () => { source.value = mf.getValue("latex"); });
    source.addEventListener("input", () => { mf.setValue(source.value, { silenceNotifications: true }); });

    let closed = false;
    const close = (v: string | null) => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const submit = () => close(source.value.trim());
    // En capture : MathLive garde Entree et Echap pour lui sinon.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); submit(); }
    };

    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal math-dialog" },
        el("header", {}, title),
        el("div", { class: "content" },
          mf,
          el("label", { class: "small muted" }, "LaTeX"),
          source,
        ),
        el("footer", {},
          el("button", { onclick: () => close(null) }, "Annuler"),
          el("button", { class: "primary", onclick: submit }, "Valider"),
        ),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    setTimeout(() => mf.focus(), 30);
  });
}
