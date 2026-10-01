import { el } from "./dom";

export interface PageRow {
  n: number;
  /** « 3 oct. » ; vide si la page n'a pas de date. */
  day: string;
  /** Premiere ligne lisible de la page. */
  line: string;
  unreadable?: boolean;
}

/**
 * Liste des pages d'un intercalaire : numero, date, premiere ligne. Un
 * appui ouvre la page ; le champ du haut prend un numero (« 12 », « p12 »).
 * Clavier : fleches, Entree, Echap. Rend le numero choisi, ou null.
 */
export function pageListDialog(opts: {
  title: string;
  current: number;
  pages: PageRow[];
  /** Ctrl+G : le curseur est dans le champ, on tape le numero. */
  typeNumber?: boolean;
  parse: (input: string) => { page: number } | { error: string };
}): Promise<number | null> {
  return new Promise((resolve) => {
    const input = el("input", {
      type: "text", inputmode: "numeric",
      placeholder: opts.pages.length ? `Numéro de page, de 1 à ${opts.pages[opts.pages.length - 1].n}` : "Numéro de page",
      "aria-label": "Numéro de page",
    });
    const note = el("p", { class: "form-note", role: "status", hidden: true });
    const list = el("div", { class: "hits page-list" });
    let sel = Math.max(0, opts.pages.findIndex((p) => p.n === opts.current));

    const rows = opts.pages.map((p, i) => {
      const row = el("button", {
        class: `hit page-row${p.n === opts.current ? " current" : ""}`,
        tabindex: "-1",
        onclick: () => close(p.n),
      },
        el("span", { class: "pn" }, `p. ${p.n}`),
        el("span", { class: "day" }, p.day),
        el("span", { class: `line${p.line ? "" : " muted"}` },
          p.unreadable ? "Page illisible" : p.line || "Page sans texte (encre ou schéma)"),
      );
      if (p.n === opts.current) row.setAttribute("aria-current", "page");
      row.addEventListener("mouseenter", () => select(i, false));
      return row;
    });
    list.append(...rows);

    const select = (i: number, scroll = true) => {
      if (!rows.length) return;
      sel = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((r, k) => r.classList.toggle("sel", k === sel));
      if (scroll) rows[sel].scrollIntoView({ block: "nearest" });
    };

    let closed = false;
    const close = (v: number | null) => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };

    // Un numero tape montre sa ligne ; Entree y va.
    input.addEventListener("input", () => {
      note.hidden = true;
      const r = opts.parse(input.value);
      if ("page" in r) select(opts.pages.findIndex((p) => p.n === r.page));
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        select(sel + (e.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (input.value.trim()) {
          const r = opts.parse(input.value);
          if ("error" in r) { note.textContent = r.error; note.hidden = false; return; }
          close(r.page);
        } else if (rows.length) {
          close(opts.pages[sel].n);
        }
      }
    };

    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal page-list-modal" },
        el("header", {}, `${opts.title} · ${opts.pages.length} page${opts.pages.length > 1 ? "s" : ""}`),
        el("div", { class: "content" }, input, note, list),
        el("footer", {}, el("button", { onclick: () => close(null) }, "Fermer")),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    select(sel);
    setTimeout(() => {
      if (opts.typeNumber) input.focus();
      rows[sel]?.scrollIntoView({ block: "center" });
    }, 30);
  });
}
