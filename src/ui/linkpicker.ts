/**
 * Selecteur de lien ouvert par `[[` dans le texte tape : recherche floue
 * sur les titres des pages, leurs titres #, formules et zones, filtres par
 * matiere et intercalaire (core/links.ts). Fleches + Entree, Echap annule,
 * un appui (souris, doigt, stylet) choisit.
 */

import { el } from "./dom";
import { candidateWhere, rankCandidates, type Backlink, type LinkCandidate } from "../core/links";
import type { DocLinks } from "./textdoc";

/** Ce que l'appli donne aux pages pour leurs liens (PageViewHost.links). */
export interface PageLinks extends Omit<DocLinks, "pageId"> {
  /** Pages qui citent celle-ci, calculees a la volee (jamais stockees). */
  backlinks: (pageId: string) => Promise<Backlink[]>;
  openBacklink: (b: Backlink) => void;
}

export type PickResult =
  | { kind: "pick"; candidate: LinkCandidate }
  /** Echap ou appui a cote : `typed` = ce qui avait ete tape apres `[[`. */
  | { kind: "cancel"; typed: string }
  /** Retour arriere sur une saisie vide : on rend un seul "[". */
  | { kind: "back" };

const KIND_TAG: Record<LinkCandidate["kind"], string> = {
  page: "page", heading: "titre", math: "formule", zone: "zone",
};

/** Le selecteur ouvert, s'il y en a un (un seul a la fois). */
let current: { close: (r: PickResult) => void } | null = null;

/**
 * Ouvre le selecteur sous `at` (rectangle du curseur, coordonnees ecran).
 * `load` donne les choix (lus a la demande) ; `exclude` : id de la page
 * courante, qu'on ne lie pas a elle-meme.
 */
export function pickLink(
  at: DOMRect | null, load: () => Promise<LinkCandidate[]>, exclude?: string,
): Promise<PickResult> {
  current?.close({ kind: "cancel", typed: "" });
  return new Promise((resolve) => {
    const input = el("input", {
      type: "text", class: "link-picker-input", placeholder: "Lier à une page, un titre, une formule…",
      "aria-label": "Lier à", autocomplete: "off", spellcheck: "false",
    });
    const list = el("div", { class: "link-picker-list", role: "listbox" });
    const hint = el("div", { class: "link-picker-hint" }, "Chargement…");
    const box = el("div", { class: "link-picker", role: "dialog", "aria-label": "Insérer un lien" },
      input, list, hint);

    let all: LinkCandidate[] | null = null;
    let shown: LinkCandidate[] = [];
    let sel = 0;
    let done = false;

    const close = (r: PickResult) => {
      if (done) return;
      done = true;
      current = null;
      document.removeEventListener("pointerdown", outside, true);
      box.remove();
      resolve(r);
    };
    current = { close };

    const select = (i: number) => {
      const rows = [...list.querySelectorAll<HTMLElement>(".link-pick")];
      if (!rows.length) return;
      sel = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((r, k) => { r.classList.toggle("sel", k === sel); r.setAttribute("aria-selected", String(k === sel)); });
      rows[sel].scrollIntoView({ block: "nearest" });
    };

    const paint = () => {
      if (!all) return;
      shown = rankCandidates(input.value, all, 30);
      list.replaceChildren(...shown.map((c, i) => {
        const row = el("button", {
          class: "link-pick", type: "button", role: "option", tabindex: "-1",
          // pointerdown : le texte ne doit pas reprendre le focus avant le choix.
          onpointerdown: (e: PointerEvent) => { e.preventDefault(); },
          onclick: () => close({ kind: "pick", candidate: c }),
        },
          el("span", { class: "link-pick-label" }, c.label),
          el("span", { class: "link-pick-where" }, `${KIND_TAG[c.kind]} · ${candidateWhere(c)}`),
        );
        row.addEventListener("mouseenter", () => select(i));
        return row;
      }));
      hint.textContent = shown.length
        ? "↑↓ choisir · Entrée lier · Échap annuler"
        : input.value.trim() ? "Aucune page ne correspond." : "Tape le titre d'une page.";
      select(0);
    };

    input.addEventListener("input", paint);
    input.addEventListener("keydown", (e) => {
      // Rien ne remonte a la page ni a l'appli (Echap, Entree, fleches).
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        select(sel + (e.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const c = shown[sel];
        if (c) close({ kind: "pick", candidate: c });
        else if (e.key === "Enter" && all) close({ kind: "cancel", typed: input.value });
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); close({ kind: "cancel", typed: input.value }); return; }
      if (e.key === "Backspace" && !input.value) { e.preventDefault(); close({ kind: "back" }); }
    });
    const outside = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) close({ kind: "cancel", typed: input.value });
    };
    document.addEventListener("pointerdown", outside, true);

    document.body.append(box);
    place(box, at);
    input.focus();

    void load().then((c) => {
      if (done) return;
      all = exclude ? c.filter((x) => x.ref.pageId !== exclude) : c;
      paint();
      // Entree tapee avant la fin du chargement : elle est rejouee ici.
      if (pendingEnter && shown[0]) close({ kind: "pick", candidate: shown[0] });
    }, () => { hint.textContent = "Impossible de lire les cahiers."; });
    // Entree avant que les choix soient lus : on attend le chargement.
    let pendingEnter = false;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !all) pendingEnter = true; });
  });
}

/** Sous le curseur, sinon au-dessus ; toujours dans la fenetre. */
function place(box: HTMLElement, at: DOMRect | null): void {
  const w = Math.min(460, window.innerWidth - 16);
  box.style.width = `${w}px`;
  const r = at ?? new DOMRect(window.innerWidth / 2 - w / 2, window.innerHeight / 3, 0, 0);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const h = Math.min(360, window.innerHeight - 16);
  const below = r.bottom + 6;
  const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, r.top - h - 6);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.maxHeight = `${h}px`;
}

/**
 * « Mentionné dans… » sous une page : les pages qui la citent, un appui
 * les ouvre (Alt+← revient). Rien si aucune page ne la cite.
 */
export function buildBacklinks(list: Backlink[], open: (b: Backlink) => void): HTMLElement {
  return el("div", { class: "backlinks" },
    el("span", { class: "backlinks-title" }, "Mentionné dans"),
    ...list.map((b) => el("button", {
      class: "backlink", type: "button",
      title: `Ouvrir ${b.notebookTitle ?? b.notebook} › ${b.divider} p. ${b.number}`,
      onclick: () => open(b),
    },
      el("span", { class: "backlink-where" }, `${b.notebookTitle ?? b.notebook} › ${b.divider.split("/").join(" › ")} p. ${b.number}`),
      b.title ? el("span", { class: "backlink-title" }, b.title) : null,
      el("span", { class: "backlink-labels" }, b.labels.map((l) => `« ${l} »`).join(", ")),
    )),
  );
}
