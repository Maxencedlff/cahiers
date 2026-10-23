import { el } from "./dom";
import { icon } from "./icons";
import { keysOf } from "../core/shortcuts";
import { dropIndex } from "../core/nav";
import { isUnder, type DividerNode } from "../core/dividers";

/**
 * Barre laterale (facon Notes), deux visages :
 * - sur un cahier : la matiere (bascule), ses intercalaires en liste,
 *   groupes depliables, et sous l'intercalaire ouvert ses pages en
 *   vignettes avec leur vrai titre et leur date ; « + Page », « + Intercalaire » ;
 * - a l'accueil : Rechercher, Récents, Pas compris, Réviser, les matières, Réglages.
 * DOM seulement : l'appli fournit les donnees et les actions (host).
 */

/* ---------------- cahier ---------------- */

export interface SidebarPage {
  n: number;
  /** Titre de la page (premier titre, sinon premiere ligne), formules en clair. */
  title: string;
  /** « 6 oct. » ; vide si la page n'a pas de date. */
  day: string;
  /** Le titre est un vrai titre (#) : en gras. */
  heading: boolean;
  /** Reperes « pas compris » en attente sur la page. */
  flags: number;
  unreadable?: boolean;
  /** Ecrite par une version plus recente de Cahiers : lisible, en lecture seule. */
  future?: boolean;
}

export interface NotebookSidebarModel {
  notebook: string;
  title: string;
  color: string;
  tree: DividerNode[];
  /** Intercalaire ouvert dans le panneau vise. */
  divider: string;
  /**
   * Groupes deplies a la main (en plus de ceux qui contiennent l'intercalaire
   * ouvert) ; « !chemin » = replie a la main bien qu'il le contienne.
   */
  expanded: ReadonlySet<string>;
  /** Nombre de pages par intercalaire (absent : pas encore compte). */
  counts: ReadonlyMap<string, number>;
  /** Pages de l'intercalaire ouvert ; null pendant la lecture. */
  pages: SidebarPage[] | null;
  current: number;
}

export interface NotebookSidebarHost {
  home(): void;
  search(): void;
  switchNotebook(anchor: HTMLElement): void;
  openDivider(path: string): void;
  toggleGroup(path: string): void;
  dividerMenu(path: string, at: { x: number; y: number }): void;
  /** Intercalaire glisse a la place `index` parmi ses voisins. */
  reorder(path: string, index: number): void;
  openPage(n: number): void;
  pageMenu(n: number, at: { x: number; y: number }): void;
  newPage(): void;
  newDivider(): void;
  /** Echap dans la liste : le clavier retourne a la page. */
  leave(): void;
}

/** Vignette schematique d'une page : un trait de titre, des lignes. */
export function pageThumb(color: string, heading: boolean, small = true): HTMLElement {
  return el("div", { class: `thumb${small ? " small" : ""}`, "aria-hidden": "true" },
    el("i", { class: "t", style: { background: heading ? color : "" } }),
    el("i", {}), el("i", { style: { width: "80%" } }), el("i", {}), el("i", { style: { width: "62%" } }),
    small ? null : el("i", {}), small ? null : el("i", { style: { width: "86%" } }));
}

/** Carre de couleur d'une matiere (jamais rond : rond = couleur semantique). */
export function notebookSquare(color: string, size = 12): HTMLElement {
  return el("i", { class: "nb-sq", style: { background: color, width: `${size}px`, height: `${size}px` }, "aria-hidden": "true" });
}

export function buildNotebookSidebar(m: NotebookSidebarModel, host: NotebookSidebarHost): HTMLElement {
  const side = el("aside", { class: "sidebar nb-side", "aria-label": `Intercalaires de ${m.title}` });
  side.append(el("div", { class: "sb-top" },
    el("button", {
      class: "icon-btn sb-home", "aria-label": "Accueil", "data-tip": "Accueil", "data-keys": keysOf("menu"),
      "data-tip-side": "bottom", onclick: () => host.home(),
    }, icon("home", 19)),
    searchField(host.search),
  ));

  const nbBtn = el("button", {
    class: "sb-nb", "aria-haspopup": "menu", "data-tip": "Changer de matière", "data-tip-side": "bottom",
    onclick: () => host.switchNotebook(nbBtn),
  }, notebookSquare(m.color, 14), el("span", { class: "sb-nb-name" }, m.title), icon("chevronDown", 16));
  side.append(nbBtn);

  const list = el("nav", { class: "sb-list", "aria-label": "Intercalaires" });
  const addNodes = (nodes: DividerNode[], depth: number) => {
    const sibs = nodes.map((n) => n.path);
    for (const n of nodes) {
      const group = n.children.length > 0;
      const open = group && !m.expanded.has(`!${n.path}`) && (m.expanded.has(n.path) || isUnder(m.divider, n.path));
      const active = m.divider === n.path;
      const row = el("button", {
        class: `sb-row sb-div${active ? " active" : ""}${group ? " group" : ""}${open ? " open" : ""}`,
        dataset: { divider: n.path, ...(group ? { group: "1" } : {}) },
        style: { "--d": String(depth) },
        ...(group ? { "aria-expanded": String(open) } : { "aria-current": active ? "true" : null }),
        title: group ? `${n.name} : groupe d'intercalaires` : n.name,
        onclick: () => (group ? host.toggleGroup(n.path) : host.openDivider(n.path)),
      },
      group ? el("span", { class: "sb-chev", "aria-hidden": "true" }, icon(open ? "chevronDown" : "chevronRight", 14)) : null,
      el("span", { class: "sb-name" }, n.name),
      !group && m.counts.has(n.path) ? el("span", { class: "sb-count" }, String(m.counts.get(n.path))) : null);
      wireRow(row, list, n.path, sibs, host);
      list.append(row);
      if (active) list.append(pageList(m, host, depth));
      if (group && open) {
        // Le groupe a aussi ses propres pages : elles restent un intercalaire.
        if (n.pages) {
          const own = m.divider === n.path;
          const r = el("button", {
            class: `sb-row sb-div own${own ? " active" : ""}`, dataset: { divider: n.path },
            style: { "--d": String(depth + 1) }, onclick: () => host.openDivider(n.path),
          }, el("span", { class: "sb-name" }, `Pages de ${n.name}`),
          m.counts.has(n.path) ? el("span", { class: "sb-count" }, String(m.counts.get(n.path))) : null);
          list.append(r);
          if (own) list.append(pageList(m, host, depth + 1));
        }
        addNodes(n.children, depth + 1);
      }
    }
  };
  addNodes(m.tree, 0);
  side.append(list);
  side.append(el("button", {
    class: "sb-row sb-add", "data-tip": "Nouvel intercalaire", "data-keys": keysOf("newDivider"),
    onclick: () => host.newDivider(),
  }, icon("plus", 17), el("span", { class: "sb-name" }, "Intercalaire")));
  return side;
}

/** Pages de l'intercalaire ouvert, sous sa ligne. */
function pageList(m: NotebookSidebarModel, host: NotebookSidebarHost, depth: number): HTMLElement {
  const box = el("div", { class: "sb-pages", role: "list", style: { "--d": String(depth) } });
  if (!m.pages) {
    box.append(el("div", { class: "sb-loading" }, "Lecture des pages…"));
    return box;
  }
  for (const p of m.pages) {
    const current = p.n === m.current;
    const row = el("button", {
      class: `sb-page${current ? " current" : ""}`, role: "listitem", dataset: { n: String(p.n) },
      ...(current ? { "aria-current": "page" } : {}),
      onclick: () => host.openPage(p.n),
    },
    pageThumb(m.color, p.heading),
    el("span", { class: "sb-page-text" },
      el("span", { class: `sb-page-title${p.heading ? " heading" : ""}${p.title ? "" : " untitled"}` },
        p.unreadable ? "Page illisible" : p.title || (p.future ? "Version plus récente" : "Sans titre")),
      el("span", { class: "sb-page-meta" },
        `p. ${p.n}${p.day ? ` · ${p.day}` : ""}${p.future && p.title ? " · version plus récente" : ""}`,
        p.flags ? el("span", { class: "sb-flag" }, icon("flag", 12), String(p.flags)) : null)));
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); host.pageMenu(p.n, { x: e.clientX, y: e.clientY }); });
    longPress(row, (at) => host.pageMenu(p.n, at));
    box.append(row);
  }
  box.append(el("button", {
    class: "sb-page sb-add-page", "data-tip": "Nouvelle page à la fin", "data-keys": keysOf("newPage"),
    onclick: () => host.newPage(),
  }, icon("plus", 16), el("span", { class: "sb-page-title" }, "Page")));

  // Clavier (Ctrl+G) : fleches, Entree, un numero tape y va, Echap rend la page.
  let typed = "";
  let typedAt = 0;
  box.addEventListener("keydown", (e) => {
    const rows = [...box.querySelectorAll<HTMLElement>(".sb-page")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? rows[0] : rows[rows.length - 2] ?? rows[0])?.focus();
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); host.leave(); return; }
    if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const now = performance.now();
      typed = now - typedAt < 900 ? typed + e.key : e.key;
      typedAt = now;
      const target = box.querySelector<HTMLElement>(`.sb-page[data-n="${Number(typed)}"]`);
      if (target) { target.focus(); target.scrollIntoView({ block: "nearest" }); }
    }
  });
  return box;
}

/** Donne le clavier a la liste des pages (Ctrl+G), sur la page courante. */
export function focusPageList(side: HTMLElement | null): boolean {
  const row = side?.querySelector<HTMLElement>(".sb-page.current") ?? side?.querySelector<HTMLElement>(".sb-page");
  if (!row) return false;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "center" });
  return true;
}

/** Appui long au doigt ou au stylet (le clic droit est gere a part). */
function longPress(node: HTMLElement, run: (at: { x: number; y: number }) => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  node.addEventListener("pointerdown", (e) => {
    fired = false;
    if (e.pointerType === "mouse" || e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    const at = start;
    timer = setTimeout(() => { timer = null; fired = true; run(at); }, 480);
  });
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; start = null; };
  node.addEventListener("pointermove", (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) node.addEventListener(t, cancel);
  node.addEventListener("click", (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

/**
 * Ligne d'intercalaire : clic droit ou appui long = son menu ; glisser
 * (souris tout de suite, doigt et stylet apres un appui long) = le changer
 * de place parmi ses voisins (meme groupe).
 */
function wireRow(row: HTMLElement, list: HTMLElement, path: string, sibs: string[], host: NotebookSidebarHost): void {
  const HOLD_MS = 450, SLOP = 6;
  let st: { id: number; type: string; x: number; y: number; armed: boolean; dragging: boolean; timer: ReturnType<typeof setTimeout> | null } | null = null;
  let swallow = false;
  const rows = () => sibs.map((p) => list.querySelector<HTMLElement>(`.sb-div[data-divider="${CSS.escape(p)}"]:not(.own)`)).filter((r): r is HTMLElement => !!r);
  const from = () => sibs.indexOf(path);
  const target = (y: number) => dropIndex(rows().map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; }), from(), y);
  const paint = (y: number) => {
    const to = target(y);
    rows().forEach((r, i) => {
      r.classList.toggle("drop-before", i === to && to < from());
      r.classList.toggle("drop-after", i === to && to > from());
    });
  };
  const end = () => {
    if (st?.timer) clearTimeout(st.timer);
    st = null;
    row.classList.remove("lifted", "dragging");
    row.style.transform = "";
    for (const r of rows()) r.classList.remove("drop-before", "drop-after");
  };
  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    swallow = false;
    st = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, armed: false, dragging: false, timer: null };
    const mine = st;
    st.timer = setTimeout(() => {
      if (st !== mine) return;
      mine.timer = null;
      mine.armed = true;
      row.classList.add("lifted");
    }, HOLD_MS);
  });
  row.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dy = e.clientY - st.y;
    if (!st.dragging) {
      if (Math.hypot(e.clientX - st.x, dy) <= SLOP) return;
      if (st.type === "mouse" || st.armed) {
        st.dragging = true;
        row.classList.add("dragging");
        try { row.setPointerCapture(e.pointerId); } catch { /* deja parti */ }
      } else {
        // Le doigt bouge avant l'appui long : il fait defiler la liste.
        if (st.timer) clearTimeout(st.timer);
        st = null;
        return;
      }
    }
    row.style.transform = `translateY(${dy}px)`;
    paint(e.clientY);
  });
  row.addEventListener("pointerup", (e) => {
    if (!st || e.pointerId !== st.id) return;
    const { dragging, armed } = st;
    const to = dragging ? target(e.clientY) : from();
    end();
    if (dragging) {
      swallow = true;
      if (to !== from()) host.reorder(path, to);
    } else if (armed) {
      swallow = true;
      host.dividerMenu(path, { x: e.clientX, y: e.clientY });
    }
  });
  row.addEventListener("pointercancel", () => end());
  row.addEventListener("click", (e) => {
    if (!swallow) return;
    swallow = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (st && st.type !== "mouse") return;
    end();
    host.dividerMenu(path, { x: e.clientX, y: e.clientY });
  });
}

/* ---------------- accueil ---------------- */

export type HomeEntry = "recent" | "flags" | "review" | null;

export interface HomeSidebarModel {
  active: HomeEntry;
  flagCount: number;
  notebooks: { dir: string; title: string; color: string; pages: number }[];
}

export interface HomeSidebarHost {
  search(): void;
  recent(): void;
  flags(): void;
  review(): void;
  openNotebook(dir: string): void;
  notebookMenu(dir: string, at: { x: number; y: number }): void;
  newNotebook(): void;
  settings(): void;
}

export function buildHomeSidebar(m: HomeSidebarModel, host: HomeSidebarHost): HTMLElement {
  const side = el("aside", { class: "sidebar home-side", "aria-label": "Navigation" });
  const entry = (id: Exclude<HomeEntry, null>, name: Parameters<typeof icon>[0], label: string, run: () => void, count?: number, keys?: string) =>
    el("button", {
      class: `sb-row sb-entry${m.active === id ? " active" : ""}`, onclick: run,
      ...(m.active === id ? { "aria-current": "page" } : {}),
      ...(keys ? { "data-tip": label, "data-keys": keys } : {}),
    }, icon(name, 18), el("span", { class: "sb-name" }, label),
    count ? el("span", { class: `sb-count${id === "flags" ? " flag" : ""}` }, String(count)) : null);

  side.append(el("div", { class: "sb-top" }, searchField(host.search)));
  side.append(
    entry("recent", "clock", "Récents", host.recent),
    entry("flags", "flag", "Pas compris", host.flags, m.flagCount),
    entry("review", "review", "Réviser", host.review, undefined, keysOf("review")),
    el("div", { class: "sb-section" }, "Matières"),
  );
  const list = el("nav", { class: "sb-list", "aria-label": "Matières" });
  for (const nb of m.notebooks) {
    const row = el("button", {
      class: "sb-row sb-nb-row", dataset: { dir: nb.dir }, onclick: () => host.openNotebook(nb.dir),
    }, notebookSquare(nb.color), el("span", { class: "sb-name" }, nb.title),
    el("span", { class: "sb-count" }, String(nb.pages)));
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); host.notebookMenu(nb.dir, { x: e.clientX, y: e.clientY }); });
    longPress(row, (at) => host.notebookMenu(nb.dir, at));
    list.append(row);
  }
  list.append(el("button", { class: "sb-row sb-add", onclick: () => host.newNotebook() },
    icon("plus", 17), el("span", { class: "sb-name" }, "Nouvelle matière")));
  side.append(list,
    el("button", {
      class: "sb-row sb-settings", onclick: () => host.settings(),
    }, icon("settings", 18), el("span", { class: "sb-name" }, "Réglages"), el("kbd", { class: "sb-keys" }, keysOf("settings"))));
  return side;
}

/** Champ-bouton « Rechercher » : ouvre la recherche par-dessus l'ecran. */
function searchField(run: () => void): HTMLElement {
  return el("button", {
    class: "sb-search", "aria-label": "Rechercher", onclick: () => run(),
  }, icon("search", 16), el("span", { class: "sb-search-ph" }, "Rechercher"), el("kbd", {}, keysOf("search")));
}
