import { el, askText, toast, contextMenu, type MenuEntry } from "./dom";
import { icon } from "./icons";
import { NOTEBOOK_COLORS, NOTEBOOK_COLOR_NAMES } from "../core/palette";
import { VRAC, type Repo, type NotebookSummary, type OtherDir } from "../core/storage/repo";
import {
  listFlags, sortFlags, DEFAULT_FLAG_NOTE,
  type FlagHit,
} from "../core/storage/search";
import { filterByTitle, gridStep } from "../core/nav";
import { dividerLabel, leafName, openableDividers, type DividerNode } from "../core/dividers";
import type { Spot } from "../core/position";
import type { ColorKey } from "../core/types";
import { notebookSquare, pageThumb } from "./sidebar";

export interface MenuHost {
  repo: Repo;
  /** Ouvre le cahier ; sans intercalaire, la ou on l'avait laisse. */
  openNotebook: (dir: string, divider?: string, page?: number) => void;
  /** Ouvre la page et va au bloc ; `query` surligne le passage trouve. */
  openAt: (dir: string, divider: string, page: number, blockId: string, query?: string) => void;
  openSearch: () => void;
  /** Vue des reperes, de toutes les matieres ou d'une seule. */
  openFlags: (notebook?: string) => void;
  /** Vue Reviser (extraits par couleur) ; `notebook: null` = toutes les matieres. */
  openReview?: (o?: { notebook?: string | null; colors?: ColorKey[] }) => void;
  /** Marque un repere compris (true) ou le rend (false). false si rien n'a change. */
  setFlagResolved: (f: FlagHit, resolved: boolean) => Promise<boolean>;
  rootLabel: string;
  /** Derniere position de cette machine parmi ces matieres (D8). */
  lastSpot?: (dirs: string[]) => Spot | null;
  /** Gestion des matieres : l'appli s'occupe des onglets ouverts. */
  createNotebook?: (title: string, color: string) => Promise<void>;
  renameNotebook?: (dir: string, title: string) => Promise<void>;
  setNotebookColor?: (dir: string, color: string) => Promise<void>;
  deleteNotebook?: (dir: string) => Promise<void>;
  adoptNotebook?: (dir: string, title: string, color: string) => Promise<void>;
  /** Rend ces dossiers aux « Autres dossiers » (leur cahier.json part a la corbeille). */
  unmarkNotebooks?: (dirs: string[]) => Promise<void>;
}

/** L'accueil, ce qu'il fait du clavier, et ce que la barre laterale montre. */
export interface MenuScreen {
  root: HTMLElement;
  /** true si la touche est prise. */
  onKey: (e: KeyboardEvent) => boolean;
  notebooks: NotebookSummary[];
  flagCount: number;
}

/** Dossiers dont on a dit « Garder » au nettoyage, sur cette machine. */
const KEEP_KEY = "cahiers.menu.keep.v1";

function readKeep(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEEP_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

function writeKeep(dirs: string[]): void {
  try { localStorage.setItem(KEEP_KEY, JSON.stringify(dirs)); } catch { /* stockage indisponible */ }
}

/** Premiere couleur qu'aucune matiere n'a encore, pour en distinguer une nouvelle. */
export function freeColor(used: string[]): string {
  return NOTEBOOK_COLORS.find((c) => !used.includes(c)) ?? NOTEBOOK_COLORS[used.length % NOTEBOOK_COLORS.length];
}

/** Une page modifiee recemment (« Cette semaine »). */
interface RecentPage {
  dir: string; title: string; color: string; divider: string; page: number; total: number;
  line: string; heading: boolean; modified: string; flags: number;
}

/** Pages modifiees ces 7 derniers jours, de la plus recente a la plus ancienne. */
async function recentPages(repo: Repo, notebooks: NotebookSummary[], now = Date.now()): Promise<RecentPage[]> {
  const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const out: RecentPage[] = [];
  for (const nb of notebooks) {
    if (!nb.modified || nb.modified < since) continue;
    for (const d of await repo.listDividers(nb.dir)) {
      const pages = (await repo.scanDivider(nb.dir, d)) ?? [];
      for (const { n, index } of pages) {
        if (!index || !index.modified || index.modified < since) continue;
        out.push({
          dir: nb.dir, title: nb.meta.title, color: nb.meta.color, divider: d, page: n, total: pages.length,
          line: index.title || index.firstLine, heading: !!index.title, modified: index.modified, flags: index.flags.length,
        });
      }
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Accueil (section 5). L'application s'ouvre directement ici, pas d'ecran
 * de demarrage. « Reprendre » en grande carte, « Cette semaine » en
 * vignettes, puis les matieres avec leurs intercalaires cliquables. La
 * barre laterale (Récents, Pas compris, Réviser, matieres) est posee par
 * l'appli. Clavier : Entree reprend, des lettres filtrent les matieres
 * (Entree ouvre la premiere), les fleches passent de l'une a l'autre.
 */
export async function buildMenu(host: MenuHost): Promise<MenuScreen> {
  const { notebooks, others } = await host.repo.listRoot();
  const flags = notebooks.flatMap((n) => n.flags);
  const inner = el("div", { class: "screen-inner home" });
  const screen = el("div", { class: "screen menu-screen" }, inner);
  const usedColors = notebooks.map((n) => n.meta.color);

  // « Reprendre » : derniere position, un clic (ou Entree).
  const resume = resumeSpot(host, notebooks);
  const recent = await recentPages(host.repo, notebooks);
  let resumeBtn: HTMLElement | null = null;
  if (resume) {
    const nb = notebooks.find((n) => n.dir === resume.dir)!;
    const scanned = (await host.repo.scanDivider(resume.dir, resume.divider).catch(() => null)) ?? [];
    const here = scanned.find((p) => p.n === resume.page)?.index ?? null;
    const pageTitle = here?.title || here?.firstLine || `Page ${resume.page}`;
    const open = () => host.openNotebook(resume.dir, resume.divider, resume.page);
    resumeBtn = el("button", { class: "primary resume-open", onclick: open }, "Ouvrir", el("kbd", {}, "Entrée"));
    const pf = here?.flags.length ?? 0;
    inner.append(el("h2", { class: "home-h1" }, "Reprendre"),
      el("div", { class: "hero" },
        pageThumb(resume.color, !!here?.title, false),
        el("div", { class: "hero-text" },
          el("div", { class: "hero-where" }, notebookSquare(resume.color, 10),
            `${resume.title} › ${dividerLabel(resume.divider)} · p. ${resume.page}${scanned.length ? ` sur ${scanned.length}` : ""}`),
          el("div", { class: "hero-title" }, pageTitle),
          el("div", { class: "hero-meta" },
            here?.modified ? `Modifiée ${relative(here.modified)}` : nb.modified ? `Matière modifiée ${relative(nb.modified)}` : "",
            pf ? el("span", { class: "flag-text" }, ` · ${pf} repère${pf > 1 ? "s" : ""} pas compris`) : null),
          resumeBtn)));
  }

  // Pages de la semaine (sans celle de « Reprendre »).
  const week = recent.filter((r) => !(resume && r.dir === resume.dir && r.divider === resume.divider && r.page === resume.page)).slice(0, 8);
  if (week.length) {
    inner.append(el("h3", { class: "home-h3" }, "Aujourd'hui et cette semaine"),
      el("div", { class: "week-row" }, ...week.map((r) => el("button", {
        class: "mini", title: `${r.title} › ${dividerLabel(r.divider)}, page ${r.page}`,
        onclick: () => host.openNotebook(r.dir, r.divider, r.page),
      }, pageThumb(r.color, r.heading, false),
      el("span", { class: "mini-title" }, r.line || `Page ${r.page}`),
      el("span", { class: "mini-where" }, `${r.title} › ${leafName(r.divider)} · p. ${r.page}`)))));
  }

  const filterNote = el("span", { class: "filter-note small", hidden: true });
  inner.append(el("div", { class: "row matieres-head" }, el("h3", { class: "home-h3" }, "Matières"), filterNote));

  const grid = el("div", { class: "grid" });
  inner.append(grid);
  const trees = await Promise.all(notebooks.map((nb) => host.repo.listDividerTree(nb.dir).catch(() => [] as DividerNode[])));
  const cards: { nb: NotebookSummary; wrap: HTMLElement; button: HTMLElement }[] = [];
  notebooks.forEach((nb, i) => {
    const c = card(host, nb, trees[i], usedColors);
    cards.push({ nb, ...c });
    grid.append(c.wrap);
  });

  const addCard = el("button", {
    class: "card add",
    onclick: () => void newNotebook(host, usedColors),
  }, icon("plus", 18), "Nouvelle matière");
  grid.append(addCard);

  if (others.length) inner.append(othersSection(host, others, usedColors));

  /* -- clavier -- */

  let filter = "";
  const visibleCards = () => [...grid.querySelectorAll<HTMLElement>(".card")]
    .filter((b) => !b.closest("[hidden]") && !b.hidden);
  const setFilter = (next: string) => {
    filter = next;
    const shown = filterByTitle(cards, filter, (c) => [c.nb.meta.title, c.nb.dir]);
    // Ordre du filtre : la premiere est celle qu'ouvre Entree.
    for (const c of cards) {
      c.wrap.hidden = !shown.includes(c);
      c.wrap.classList.remove("first");
    }
    // Sans filtre, l'ordre d'origine (derniere modification, Vrac a la fin).
    const order = filter ? [...shown, ...cards.filter((c) => !shown.includes(c))] : cards;
    for (const c of order) grid.insertBefore(c.wrap, addCard);
    addCard.hidden = !!filter;
    if (filter && shown[0]) shown[0].wrap.classList.add("first");
    filterNote.hidden = !filter;
    filterNote.replaceChildren(
      el("span", {}, "Filtre : "), el("strong", {}, filter),
      shown.length ? ` · Entrée ouvre ${shown[0].nb.meta.title}` : " · aucune matière", " · Échap efface",
    );
    if (filter) grid.scrollIntoView({ block: "nearest" });
    const active = document.activeElement as HTMLElement | null;
    if (active && screen.contains(active) && active.closest("[hidden]")) active.blur();
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const active = document.activeElement as HTMLElement | null;
    const focused = active && screen.contains(active) ? active : null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const list = visibleCards();
      if (!list.length) return false;
      const i = list.indexOf(focused as HTMLElement);
      const top = list[0].getBoundingClientRect().top;
      const cols = list.filter((b) => Math.abs(b.getBoundingClientRect().top - top) < 4).length;
      const next = list[gridStep(i, e.key, cols, list.length)];
      next.focus();
      next.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (e.key === "Enter") {
      // Une carte ou un bouton a le clavier : Entree l'appuie.
      if (focused?.classList.contains("card") && focused.tagName !== "BUTTON") { focused.click(); return true; }
      if (focused && (focused.tagName === "BUTTON" || focused.tagName === "SUMMARY")) return false;
      if (filter) { visibleCards()[0]?.click(); return true; }
      if (resumeBtn) { resumeBtn.click(); return true; }
      return false;
    }
    if (e.key === "Escape" && filter) { setFilter(""); return true; }
    if (e.key === "Backspace" && filter) { setFilter(filter.slice(0, -1)); return true; }
    // Une lettre filtre ; l'espace aussi, mais seulement au milieu d'un nom.
    if (e.key.length === 1 && (e.key !== " " || filter) && !(focused?.tagName === "SUMMARY" && e.key === " ")) {
      setFilter(filter + e.key);
      return true;
    }
    return false;
  };

  return { root: screen, onKey, notebooks, flagCount: flags.length };
}

/**
 * Dossiers ou une ancienne version a pose un cahier.json sans qu'il y ait
 * la moindre page : proposes au rangement dans les Reglages, jamais d'office.
 */
export async function cleanupSection(host: MenuHost, notebooks: NotebookSummary[]): Promise<HTMLElement | null> {
  const keep = readKeep();
  const pageless = (await host.repo.pagelessNotebooks(notebooks)).filter((d) => !keep.includes(d));
  if (!pageless.length || !host.unmarkNotebooks) return null;
  const titles = pageless.map((d) => notebooks.find((n) => n.dir === d)?.meta.title ?? d);
  const box: HTMLElement = el("div", { class: "cleanup" },
    el("div", {},
      el("strong", {}, pageless.length > 1
        ? `${pageless.length} dossiers sans aucune page sont affichés comme matières`
        : "Un dossier sans aucune page est affiché comme matière"),
      el("div", { class: "small muted" },
        `${titles.join(", ")}. Une ancienne version y a posé un cahier.json. `
          + "Les ranger dans « Autres dossiers » met ce fichier à la corbeille, rien d'autre."),
    ),
    el("div", { class: "cleanup-actions" },
      el("button", { onclick: () => { writeKeep([...keep, ...pageless]); box.remove(); } }, "Garder"),
      el("button", { class: "primary", onclick: () => { box.remove(); void host.unmarkNotebooks!(pageless); } }, "Ranger")),
  );
  return box;
}

/** Ou reprendre : la derniere position de cette machine, sinon l'ancienne de cahier.json. */
function resumeSpot(host: MenuHost, notebooks: NotebookSummary[]) {
  const spot = host.lastSpot?.(notebooks.map((n) => n.dir));
  const nb = spot ? notebooks.find((n) => n.dir === spot.notebook) : notebooks.find((n) => n.meta.lastPosition);
  if (!nb) return null;
  const divider = spot?.divider ?? nb.meta.lastPosition!.divider;
  const page = spot?.page ?? nb.meta.lastPosition!.page;
  return { dir: nb.dir, title: nb.meta.title, color: nb.meta.color, divider, page };
}

/** Carte de matiere : bande de couleur, compteurs, intercalaires cliquables ; ⋯ au survol ou clic droit. */
function card(host: MenuHost, nb: NotebookSummary, tree: DividerNode[], usedColors: string[]): { wrap: HTMLElement; button: HTMLElement } {
  const open = () => host.openNotebook(nb.dir);
  const node = el("div", {
    class: "card nb-card", role: "button", tabindex: "0", "aria-label": `Ouvrir ${nb.meta.title}`,
    onclick: (e: Event) => { if (!(e.target as HTMLElement).closest(".chip, .flag-link")) open(); },
  },
    el("div", { class: "nb-band", style: { background: nb.meta.color } }),
    el("div", { class: "nb-body" },
      el("div", { class: "title" }, nb.meta.title),
      el("div", { class: "nb-meta" },
        `${nb.pageCount} page${nb.pageCount > 1 ? "s" : ""}`,
        nb.modified ? ` · ${relative(nb.modified)}` : " · jamais ouverte",
        nb.flagCount > 0 ? el("button", {
          class: "flag-link", title: `Voir les repères « pas compris » de ${nb.meta.title}`,
          onclick: (e: Event) => { e.stopPropagation(); host.openFlags(nb.dir); },
        }, ` · ${nb.flagCount} pas compris`) : null),
    ),
  );
  // Intercalaires du premier niveau : un appui ouvre celui-la directement.
  const firstOpenable = (n: DividerNode) => (n.pages ? n.path : openableDividers(n.children)[0]);
  const top = tree.filter((n) => firstOpenable(n));
  if (top.length) {
    const chips = el("div", { class: "chips" });
    for (const n of top.slice(0, 6)) {
      chips.append(el("button", {
        class: "chip", title: `Ouvrir ${dividerLabel(n.path)}`,
        onclick: (e: Event) => { e.stopPropagation(); host.openNotebook(nb.dir, firstOpenable(n)); },
      }, n.name));
    }
    if (top.length > 6) chips.append(el("span", { class: "chip more" }, `+${top.length - 6}`));
    node.querySelector(".nb-body")!.append(chips);
  }
  const wrap = el("div", { class: "card-wrap" }, node);
  if (host.renameNotebook) {
    const openMenu = (at: { x: number; y: number } | HTMLElement) => notebookMenu(host, nb.dir, nb.meta.title, nb.meta.color, usedColors, at);
    node.addEventListener("contextmenu", (e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }); });
    const more: HTMLButtonElement = el("button", {
      class: "ghost card-more", "aria-label": `Actions sur ${nb.meta.title}`, title: "Réviser, renommer, couleur, supprimer",
      onclick: (e: Event) => { e.stopPropagation(); openMenu(more); },
    }, icon("more", 18));
    wrap.append(more);
  }
  node.addEventListener("keydown", (e) => { if (e.key === " ") { e.preventDefault(); open(); } });
  return { wrap, button: node };
}

/** Nouvelle matiere : nom et couleur (une teinte libre parmi les huit). */
export async function newNotebook(host: MenuHost, usedColors: string[]): Promise<void> {
  const r = await notebookDialog({ title: "Nouvelle matière", name: "", askName: true, color: freeColor(usedColors), ok: "Créer", used: usedColors });
  if (!r?.name) return;
  if (host.createNotebook) { await host.createNotebook(r.name, r.color); return; }
  const dir = await host.repo.createNotebook(r.name, r.color);
  host.openNotebook(dir);
}

/** Menu d'une matiere (carte, barre laterale) : ouvrir, réviser, renommer, couleur, supprimer. */
export function notebookMenu(
  host: MenuHost, dir: string, title: string, color: string, usedColors: string[],
  at: { x: number; y: number } | HTMLElement,
): void {
  const vrac = dir === VRAC;
  const colors = [...NOTEBOOK_COLORS] as string[];
  if (!colors.includes(color)) colors.unshift(color);
  const entries: MenuEntry[] = [
    { label: "Ouvrir", icon: "fileText", run: () => host.openNotebook(dir) },
    ...(host.openReview ? [{ label: "Réviser", icon: "review" as const, run: () => host.openReview?.({ notebook: dir }) }] : []),
    { label: "Pas compris", icon: "flag", run: () => host.openFlags(dir) },
    "sep",
    ...(vrac ? [] : [{
      label: "Renommer…", icon: "rename" as const, run: () => void (async () => {
        const next = await askText("Renommer la matière", "Nouveau nom (le dossier est renommé aussi)", title);
        if (next?.trim() && next.trim() !== title) await host.renameNotebook?.(dir, next.trim());
      })(),
    }]),
    {
      label: "Couleur", icon: "palette", sub: colors.map((c) => ({
        label: `${NOTEBOOK_COLOR_NAMES[c] ?? c}${c !== color && usedColors.includes(c) ? " (déjà prise)" : ""}`,
        swatch: c, checked: c === color ? true : undefined,
        run: () => { if (c !== color) void host.setNotebookColor?.(dir, c); },
      })),
    },
    ...(vrac ? [] : ["sep" as const, { label: "Supprimer la matière…", icon: "trash" as const, danger: true, run: () => void host.deleteNotebook?.(dir) }]),
  ];
  contextMenu(at, entries, { label: title, align: "end" });
}

/**
 * Dossiers de la racine qui ne sont pas des matieres (D5) : documents,
 * projets, depots git. Replies par defaut ; un appui en fait une matiere.
 */
function othersSection(host: MenuHost, others: OtherDir[], usedColors: string[]): HTMLElement {
  const rows = others.map((o) => el("div", { class: "other-row" },
    el("span", { class: "other-name" }, o.dir),
    el("div", { class: "spacer" }),
    o.git
      ? el("span", { class: "small muted" }, "dépôt git, ignoré")
      : el("button", {
          onclick: async () => {
            const r = await notebookDialog({
              title: `Faire de ${o.dir} une matière`, name: o.dir, askName: true,
              color: freeColor(usedColors), ok: "En faire une matière",
            });
            if (r) await host.adoptNotebook?.(o.dir, r.name || o.dir, r.color);
          },
        }, "En faire une matière"),
  ));
  const details = el("details", { class: "others" },
    el("summary", {}, `Autres dossiers (${others.length})`),
    el("p", { class: "small muted" },
      "Dossiers sans cahier.json ni page : Cahiers n'y écrit rien. "
        + "Les dépôts git ne sont jamais des matières."),
    ...rows,
  );
  return details;
}

/**
 * Nom et couleur d'une matiere : a la creation, et pour changer sa couleur.
 * Huit couleurs, au doigt (44 px) ; celles deja prises par une autre
 * matiere sont signalees, pas interdites.
 */
function notebookDialog(opts: {
  title: string; name?: string; askName: boolean; color: string; ok: string; used?: string[];
}): Promise<{ name: string; color: string } | null> {
  return new Promise((resolve) => {
    let color: string = opts.color;
    const input = el("input", { type: "text", placeholder: "Maths, Élec, Info…" });
    input.value = opts.name ?? "";
    const swatches = el("div", { class: "color-row", role: "radiogroup" });
    const paint = () => {
      swatches.replaceChildren(...NOTEBOOK_COLORS.map((c) => el("button", {
        class: `swatch${c === color ? " on" : ""}`,
        role: "radio",
        "aria-checked": String(c === color),
        title: `${NOTEBOOK_COLOR_NAMES[c] ?? c}${c !== opts.color && opts.used?.includes(c) ? " (déjà prise)" : ""}`,
        "aria-label": NOTEBOOK_COLOR_NAMES[c] ?? c,
        onclick: () => { color = c; paint(); },
      }, el("i", { class: "nb-sq", style: { background: c } }))));
    };
    paint();
    const close = (v: { name: string; color: string } | null) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const submit = () => {
      const name = input.value.trim();
      if (opts.askName && !name) { input.focus(); return; }
      close({ name, color });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal" },
        el("header", {}, opts.title),
        el("div", { class: "content" },
          opts.askName ? el("label", { class: "small muted" }, "Nom") : null,
          opts.askName ? input : null,
          el("label", { class: "small muted" }, "Couleur"),
          swatches,
        ),
        el("footer", {},
          el("button", { onclick: () => close(null) }, "Annuler"),
          el("button", { class: "primary", onclick: submit }, opts.ok),
        ),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    setTimeout(() => (opts.askName ? input : swatches.querySelector<HTMLElement>(".on"))?.focus(), 30);
  });
}

export function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

/**
 * Fleches haut/bas entre les lignes d'une liste, Entree ouvre (le bouton
 * a le focus). `rows` est relu a chaque appui : la liste change.
 */
function arrowNav(e: KeyboardEvent, rows: () => HTMLElement[]): boolean {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return false;
  const list = rows();
  if (!list.length) return false;
  const i = list.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
  list[next].focus();
  list[next].scrollIntoView({ block: "nearest" });
  return true;
}

/**
 * Vue des reperes "pas compris", par matiere (section 6). Chaque ligne dit
 * ce qui n'etait pas compris (la ligne ou le repere a ete pose), mene a
 * l'endroit exact, et se marque « Compris » sans ouvrir la page.
 * Clavier : fleches, Entree ouvre, Suppr = compris, Echap = retour.
 */
export async function buildFlagsView(host: MenuHost, notebook?: string): Promise<HTMLElement> {
  const flags = sortFlags(await listFlags(host.repo, notebook));
  const inner = el("div", { class: "screen-inner" });
  const screen = el("div", { class: "screen" }, inner);
  const title = notebook ? flags[0]?.notebookTitle ?? (await host.repo.readMeta(notebook)).title : "";
  inner.append(
    el("div", { class: "row" },
      el("h2", { class: "home-h1" }, notebook ? `Pas compris · ${title}` : "Pas compris"),
      el("div", { class: "spacer" }),
      notebook ? el("button", { onclick: () => host.openFlags() }, "Toutes les matières") : null,
    ),
  );
  const list = el("div", { style: { marginTop: "14px" } });
  inner.append(list);

  const rows = () => [...list.querySelectorAll<HTMLElement>(".flag-row .hit")];
  const paint = (focusAt?: number) => {
    list.replaceChildren();
    if (!flags.length) {
      list.append(el("div", { class: "empty" }, "Aucun repère en attente."));
      return;
    }
    const byNotebook = new Map<string, FlagHit[]>();
    for (const f of flags) {
      const l = byNotebook.get(f.notebookTitle) ?? [];
      l.push(f);
      byNotebook.set(f.notebookTitle, l);
    }
    for (const [name, group] of byNotebook) {
      if (!notebook) list.append(el("h2", {}, name));
      list.append(el("div", { class: "hits" }, ...group.map((f) => flagRow(f))));
    }
    if (focusAt != null) {
      const all = rows();
      all[Math.min(focusAt, all.length - 1)]?.focus();
    }
  };

  const resolve = async (f: FlagHit) => {
    const at = flags.indexOf(f);
    // Place de la ligne a l'ecran (groupee par matiere) : le focus y reste.
    const rowAt = rows().findIndex((r) => r.dataset.id === f.blockId);
    if (at === -1 || !(await host.setFlagResolved(f, true))) return;
    flags.splice(flags.indexOf(f), 1);
    paint(Math.max(0, rowAt));
    toast("Repère marqué compris", "info", 6000, {
      label: "Annuler",
      run: () => void host.setFlagResolved(f, false).then((ok) => {
        if (!ok) return;
        flags.splice(Math.min(at, flags.length), 0, f);
        paint(Math.max(0, rowAt));
      }),
    }, "flag-done");
  };

  const flagRow = (f: FlagHit): HTMLElement => {
    const said = f.context || (f.note !== DEFAULT_FLAG_NOTE ? f.note : "");
    const open = el("button", {
      class: "hit",
      dataset: { id: f.blockId },
      onclick: () => host.openAt(f.notebook, f.divider, f.page, f.blockId),
    },
      el("div", { class: said ? "what" : "what muted" }, said || "Pas de texte à cet endroit (schéma, ou repère ancien)"),
      el("div", { class: "where" },
        // La matiere est deja en titre du groupe.
        `${dividerLabel(f.divider)}, page ${f.page}`
          + (f.created ? ` · ${relative(f.created)}` : "")),
    );
    open.addEventListener("keydown", (e) => {
      if (e.key === "Delete") { e.preventDefault(); void resolve(f); }
    });
    return el("div", { class: "flag-row" },
      open,
      el("button", {
        class: "done-btn",
        title: "Compris : le repère disparaît de la liste (Suppr)",
        onclick: () => void resolve(f),
      }, "Compris"),
    );
  };

  screen.addEventListener("keydown", (e) => {
    if (arrowNav(e, rows)) e.preventDefault();
  });
  paint();
  // Le clavier est tout de suite sur la premiere ligne.
  setTimeout(() => rows()[0]?.focus({ preventScroll: true }), 40);
  return screen;
}

export { toast };
