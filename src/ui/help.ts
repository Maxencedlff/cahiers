import { el } from "./dom";
import { GROUPS, SHORTCUTS } from "../core/shortcuts";

/**
 * Fiche des raccourcis (F1 ou Ctrl+/), generee depuis la table unique
 * SHORTCUTS : elle ne peut pas mentir sur ce que fait le clavier. Au doigt
 * et au stylet, aucune infobulle ne s'affiche : c'est le seul endroit ou
 * tout est ecrit.
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
  const sections = GROUPS.map((g) => el("section", { class: "shortcuts-group" },
    el("h3", {}, g),
    el("table", {},
      ...SHORTCUTS.filter((s) => s.group === g).map((s) =>
        el("tr", {},
          el("td", {}, ...s.keys.split(" ou ").flatMap((k, i) =>
            [i ? " ou " : null, el("kbd", {}, k)])),
          el("td", {}, s.label),
        )),
    ),
  ));
  const backdrop = el("div", { class: "backdrop" },
    el("div", { class: "modal shortcuts-sheet" },
      el("header", {}, "Raccourcis clavier"),
      el("div", { class: "content" },
        el("p", { class: "small muted" },
          "Les lettres seules tapent du texte, comme dans Word : les raccourcis passent par Ctrl ou Alt."),
        el("div", { class: "shortcuts-cols" }, ...sections),
      ),
      el("footer", {}, el("button", { class: "primary", onclick: close }, "Fermer")),
    ),
  );
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
}
