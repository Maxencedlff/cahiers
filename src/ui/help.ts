import { el } from "./dom";
import { GROUPS, SHORTCUTS, keyLabel } from "../core/shortcuts";

/**
 * Fiche des raccourcis (F1 ou Ctrl+/), generee depuis la table unique
 * SHORTCUTS : elle ne peut pas mentir sur ce que fait le clavier. D'abord
 * l'essentiel (une douzaine de raccourcis), puis « Tous les raccourcis ».
 * Touches ecrites selon la plateforme (⌘ ⇧ ⌥ sur Mac). Au doigt et au
 * stylet, aucune infobulle ne s'affiche : c'est le seul endroit ou tout
 * est ecrit.
 */
export function showShortcuts(): void {
  if (document.querySelector(".shortcuts-sheet")) return;
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "F1" || ((e.ctrlKey || e.metaKey) && e.key === "/")) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const keysCell = (keys: string) => el("td", {}, ...keys.split(" ou ").flatMap((k, i) =>
    [i ? " ou " : null, el("kbd", {}, keyLabel(k))]));
  const essential = el("table", { class: "shortcuts-essential" },
    ...SHORTCUTS.filter((s) => s.essential).map((s) => el("tr", {}, keysCell(s.keys), el("td", {}, s.label))));
  const all = el("div", { class: "shortcuts-cols", hidden: true }, ...GROUPS.map((g) => el("section", { class: "shortcuts-group" },
    el("h3", {}, g),
    el("table", {}, ...SHORTCUTS.filter((s) => s.group === g).map((s) =>
      el("tr", {}, keysCell(s.keys), el("td", {}, s.label)))),
  )));
  const modal = el("div", { class: "modal shortcuts-sheet" });
  const toggle: HTMLButtonElement = el("button", {
    onclick: () => {
      const showAll = all.hidden;
      all.hidden = !showAll;
      essential.hidden = showAll;
      modal.classList.toggle("all", showAll);
      toggle.textContent = showAll ? "L'essentiel" : "Tous les raccourcis";
    },
  }, "Tous les raccourcis");
  modal.append(
    el("header", {}, "Raccourcis clavier"),
    el("div", { class: "content" },
      el("p", { class: "small muted" },
        "Les lettres seules tapent du texte, comme dans Word : les raccourcis passent par Ctrl ou Alt."),
      essential, all),
    el("footer", {}, toggle, el("button", { class: "primary", onclick: close }, "Fermer")),
  );
  const backdrop = el("div", { class: "backdrop" }, modal);
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
}
