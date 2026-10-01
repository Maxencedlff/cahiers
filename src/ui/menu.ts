import { el, askText, onLongPress, pick, toast } from "./dom";
import { NOTEBOOK_COLORS } from "../core/palette";
import { VRAC, type Repo, type NotebookSummary, type OtherDir } from "../core/storage/repo";
import {
  listFlags, sortFlags, DEFAULT_FLAG_NOTE,
  type FlagHit, type SearchHit, type SearchOptions,
} from "../core/storage/search";
import { parseQuery, queryReady, type ExcerptPart } from "../core/text/find";
import { filterByTitle, gridStep } from "../core/nav";
import type { Spot } from "../core/position";
import type { Block } from "../core/types";

export interface MenuHost {
  repo: Repo;
  /** Ouvre le cahier ; sans intercalaire, la ou on l'avait laisse. */
  openNotebook: (dir: string, divider?: string, page?: number) => void;
  /** Ouvre la page et va au bloc ; `query` surligne le passage trouve. */
  openAt: (dir: string, divider: string, page: number, blockId: string, query?: string) => void;
  openSearch: () => void;
  /** Vue des reperes, de toutes les matieres ou d'une seule. */
  openFlags: (notebook?: string) => void;
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

/** Le menu et ce qu'il fait du clavier (l'appli lui passe les touches). */
export interface MenuScreen {
  root: HTMLElement;
  /** true si la touche est prise. */
  onKey: (e: KeyboardEvent) => boolean;
}

/** Noms des couleurs de matiere, au doigt (aucune infobulle). */
const COLOR_NAMES: Record<string, string> = {
  "#2563eb": "Bleu", "#dc2626": "Rouge", "#059669": "Vert", "#d97706": "Orange",
  "#7c3aed": "Violet", "#0891b2": "Cyan", "#db2777": "Rose", "#65a30d": "Olive",
};

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

/**
 * Ecran d'accueil (section 5). L'application s'ouvre directement ici,
 * pas d'ecran de demarrage. Clavier : Entree reprend, des lettres filtrent
 * les matieres (Entree ouvre la premiere), les fleches passent de l'une a
 * l'autre.
 */
export async function buildMenu(host: MenuHost): Promise<MenuScreen> {
  const { notebooks, others } = await host.repo.listRoot();
  // Les reperes viennent du meme parcours que les compteurs : un seul.
  const flags = notebooks.flatMap((n) => n.flags);
  const inner = el("div", { class: "screen-inner" });
  const screen = el("div", { class: "screen menu-screen" }, inner);
  const usedColors = notebooks.map((n) => n.meta.color);

  inner.append(
    el("div", { class: "row" },
      el("div", {},
        el("h1", {}, "Cahiers"),
        el("div", { class: "muted small" }, host.rootLabel),
      ),
      el("div", { class: "spacer" }),
      el("button", { onclick: host.openSearch, title: "Recherche dans tous les cahiers (Ctrl+K)" }, "Rechercher"),
    ),
  );

  // Bloc "Reprendre" en haut : derniere position, un clic (ou Entree).
  const resume = resumeSpot(host, notebooks);
  let resumeBtn: HTMLButtonElement | null = null;
  if (resume) {
    resumeBtn = el("button", {
      class: "resume",
      title: "Reprendre (Entrée)",
      onclick: () => host.openNotebook(resume.dir, resume.divider, resume.page),
    },
      el("div", { class: "bar", style: { background: resume.color, width: "6px", height: "42px", borderRadius: "3px" } }),
      el("div", {},
        el("div", { class: "big" }, resume.title),
        el("div", { class: "muted small" }, `${resume.divider}, page ${resume.page}`),
      ),
      el("div", { class: "spacer" }),
      el("span", { class: "muted small key-hint" }, "Entrée"),
    );
    inner.append(el("h2", {}, "Reprendre"), resumeBtn);
  }

  // Compteur de marqueurs "pas compris" en attente.
  if (flags.length) {
    inner.append(
      el("h2", {}, "Pas compris"),
      el("button", { class: "resume flags", onclick: () => host.openFlags() },
        el("span", { class: "badge" }, `${flags.length}`),
        el("div", {},
          el("div", { class: "big" }, flags.length > 1 ? "repères en attente" : "repère en attente"),
          el("div", { class: "muted small" },
            [...new Set(flags.map((f) => f.notebookTitle))].join(", ")),
        ),
      ),
    );
  }

  const filterNote = el("span", { class: "filter-note small", hidden: true });
  inner.append(el("div", { class: "row matieres-head" }, el("h2", {}, "Matières"), filterNote));

  // Dossiers ou une ancienne version a pose un cahier.json sans qu'il y ait
  // la moindre page : on propose de les rendre, jamais d'office.
  const keep = readKeep();
  const pageless = (await host.repo.pagelessNotebooks(notebooks)).filter((d) => !keep.includes(d));
  if (pageless.length && host.unmarkNotebooks) {
    const titles = pageless.map((d) => notebooks.find((n) => n.dir === d)?.meta.title ?? d);
    const banner = el("div", { class: "cleanup" },
      el("div", {},
        el("strong", {}, pageless.length > 1
          ? `${pageless.length} dossiers sans aucune page sont affichés comme matières`
          : "Un dossier sans aucune page est affiché comme matière"),
        el("div", { class: "small muted" },
          `${titles.join(", ")}. Une ancienne version y a posé un cahier.json. `
            + "Les ranger dans « Autres dossiers » met ce fichier à la corbeille, rien d'autre."),
      ),
      el("div", { class: "spacer" }),
      el("button", {
        onclick: () => { writeKeep([...keep, ...pageless]); banner.remove(); },
      }, "Garder"),
      el("button", { class: "primary", onclick: () => void host.unmarkNotebooks!(pageless) }, "Ranger"),
    );
    inner.append(banner);
  }

  const grid = el("div", { class: "grid" });
  inner.append(grid);
  const cards: { nb: NotebookSummary; wrap: HTMLElement; button: HTMLButtonElement }[] = [];
  for (const nb of notebooks) {
    const c = card(host, nb, usedColors);
    cards.push({ nb, ...c });
    grid.append(c.wrap);
  }

  const addCard = el("button", {
    class: "card add",
    onclick: async () => {
      const r = await notebookDialog({ title: "Nouvelle matière", name: "", askName: true, color: freeColor(usedColors), ok: "Créer" });
      if (!r?.name) return;
      if (host.createNotebook) { await host.createNotebook(r.name, r.color); return; }
      const dir = await host.repo.createNotebook(r.name, r.color);
      host.openNotebook(dir);
    },
  }, "+ Nouvelle matière");
  grid.append(addCard);

  if (others.length) inner.append(othersSection(host, others, usedColors));

  /* -- clavier -- */

  let filter = "";
  const visibleCards = () => [...grid.querySelectorAll<HTMLButtonElement>(".card")]
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
      const i = list.indexOf(focused as HTMLButtonElement);
      const top = list[0].getBoundingClientRect().top;
      const cols = list.filter((b) => Math.abs(b.getBoundingClientRect().top - top) < 4).length;
      const next = list[gridStep(i, e.key, cols, list.length)];
      next.focus();
      next.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (e.key === "Enter") {
      // Une carte ou un bouton a le clavier : Entree l'appuie, nativement.
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

  return { root: screen, onKey };
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

function card(host: MenuHost, nb: NotebookSummary, usedColors: string[]): { wrap: HTMLElement; button: HTMLButtonElement } {
  const node = el("button", {
    class: "card",
    // Sans intercalaire : l'appli rouvre la ou on l'avait laisse (D8).
    onclick: () => host.openNotebook(nb.dir),
  },
    el("div", { class: "bar", style: { background: nb.meta.color } }),
    el("div", { class: "title" }, nb.meta.title),
    el("div", { class: "muted small" },
      `${nb.pageCount} page${nb.pageCount > 1 ? "s" : ""}`,
      nb.modified ? ` · ${relative(nb.modified)}` : " · jamais ouverte"),
  );
  if (nb.flagCount > 0) {
    // Le badge mene a la liste de cette matiere (section 6 : une vue par
    // matiere), le reste de la carte ouvre le cahier.
    const badge = el("span", {
      class: "badge link", role: "button", tabindex: "0",
      title: `Voir les repères « pas compris » de ${nb.meta.title}`,
    }, `${nb.flagCount} pas compris`);
    const open = (e: Event) => { e.stopPropagation(); e.preventDefault(); host.openFlags(nb.dir); };
    badge.addEventListener("click", open);
    badge.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(e); });
    node.append(badge);
  }
  const wrap = el("div", { class: "card-wrap" }, node);
  if (host.renameNotebook) {
    const openMenu = () => void notebookMenu(host, nb, usedColors);
    // Appui long ou clic droit sur la carte, ou le bouton ⋯ : au doigt comme a la souris.
    onLongPress(node, openMenu);
    wrap.append(el("button", {
      class: "ghost card-more",
      title: `Renommer, couleur, supprimer : ${nb.meta.title}`,
      "aria-label": `Actions sur ${nb.meta.title}`,
      onclick: openMenu,
    }, "⋯"));
  }
  return { wrap, button: node };
}

/** Menu d'une matiere : renommer, couleur, supprimer (vers la corbeille). */
async function notebookMenu(host: MenuHost, nb: NotebookSummary, usedColors: string[]): Promise<void> {
  const vrac = nb.dir === VRAC;
  const choice = await pick(nb.meta.title, [
    ...(vrac ? [] : [{ value: "rename", label: "Renommer" }]),
    { value: "color", label: "Couleur" },
    ...(vrac ? [] : [{ value: "delete", label: "Supprimer la matière" }]),
  ]);
  if (choice === "rename") {
    const next = await askText("Renommer la matière", "Nouveau nom (le dossier est renommé aussi)", nb.meta.title);
    if (next?.trim() && next.trim() !== nb.meta.title) await host.renameNotebook?.(nb.dir, next.trim());
  } else if (choice === "color") {
    const r = await notebookDialog({
      title: `Couleur de ${nb.meta.title}`, askName: false, color: nb.meta.color, ok: "Valider",
      used: usedColors.filter((c) => c !== nb.meta.color),
    });
    if (r && r.color !== nb.meta.color) await host.setNotebookColor?.(nb.dir, r.color);
  } else if (choice === "delete") {
    await host.deleteNotebook?.(nb.dir);
  }
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
        title: `${COLOR_NAMES[c] ?? c}${opts.used?.includes(c) ? " (déjà prise)" : ""}`,
        "aria-label": COLOR_NAMES[c] ?? c,
        onclick: () => { color = c; paint(); },
      }, el("i", { style: { background: c } }))));
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

/** Nom du type de bloc, en francais, sous un resultat. */
const BLOCK_LABEL: Record<Block["type"], string> = {
  text: "texte", ink: "écriture", math: "formule", image: "photo", pdf: "PDF",
  calc: "calcul", graph: "courbe", link: "lien", flag: "repère",
};

/** Extrait avec les termes cherches en surbrillance. */
function excerptNode(parts: ExcerptPart[]): HTMLElement {
  return el("div", { class: "what" }, ...parts.map((p) => (p.mark ? el("mark", {}, p.text) : p.text)));
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
export async function buildFlagsView(host: MenuHost, onBack: () => void, notebook?: string): Promise<HTMLElement> {
  const flags = sortFlags(await listFlags(host.repo, notebook));
  const inner = el("div", { class: "screen-inner" });
  const screen = el("div", { class: "screen" }, inner);
  const title = notebook ? flags[0]?.notebookTitle ?? (await host.repo.readMeta(notebook)).title : "";
  inner.append(
    el("div", { class: "row" },
      el("button", { onclick: onBack }, "Retour"),
      el("h1", { style: { margin: "0 0 0 8px" } }, notebook ? `Pas compris · ${title}` : "Pas compris"),
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
        `${f.divider}, page ${f.page}`
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

/** Nombre de resultats affiches ; le reste est annonce, jamais coupe en silence. */
const MAX_HITS = 200;

export interface SearchViewOptions {
  /** Derniere recherche, reproposee (selectionnee : on tape par-dessus). */
  initial?: string;
  onQuery?: (q: string) => void;
  /** Cahier d'ou part la recherche : elle commence dans cette matiere. */
  notebook?: { dir: string; title: string };
}

/**
 * Recherche plein texte sur tous les cahiers. Pilotable au clavier :
 * fleches pour choisir, Entree pour ouvrir, Echap pour revenir a la page.
 */
export function buildSearchView(
  host: MenuHost,
  onBack: () => void,
  search: (q: string, opts: SearchOptions & { notebook?: string }) => Promise<SearchHit[]>,
  opts: SearchViewOptions = {},
): HTMLElement {
  const input = el("input", {
    type: "text",
    placeholder: "Chercher dans les cahiers… (mots, \"phrase exacte\", @matière, #couleur)",
  });
  input.value = opts.initial ?? "";
  const results = el("div", { class: "hits" });
  const info = el("div", { class: "muted small" });
  const infoRow = el("div", { class: "search-info" }, info);
  let only = !!opts.notebook;
  const scope = opts.notebook
    ? el("button", {
        class: "on",
        title: "Chercher seulement dans ce cahier, ou dans tous",
        onclick: () => { only = !only; paintScope(); void run(); input.focus(); },
      })
    : null;
  const paintScope = () => {
    if (!scope || !opts.notebook) return;
    scope.classList.toggle("on", only);
    scope.textContent = only ? `Dans ${opts.notebook.title} seulement` : "Dans tous les cahiers";
  };
  paintScope();

  let hits: SearchHit[] = [];
  let sel = 0;
  /** Requete des resultats affiches : Entree attend les bons. */
  let shownFor: string | null = null;
  let token = 0;

  const rows = () => [...results.querySelectorAll<HTMLElement>(".hit")];
  const select = (i: number) => {
    const list = rows();
    if (!list.length) return;
    sel = Math.max(0, Math.min(list.length - 1, i));
    list.forEach((r, k) => r.classList.toggle("sel", k === sel));
    list[sel].scrollIntoView({ block: "nearest" });
  };
  const open = (h: SearchHit | undefined, q: string) => {
    if (h) host.openAt(h.notebook, h.divider, h.page, h.blockId, q);
  };

  const key = () => `${only ? opts.notebook?.dir ?? "" : ""}|${input.value.trim()}`;
  /** true si ses resultats sont affiches (pas remplaces par une frappe plus recente). */
  const run = async (): Promise<boolean> => {
    const q = input.value.trim();
    opts.onQuery?.(input.value);
    const mine = ++token;
    const k = key();
    if (!queryReady(parseQuery(q))) {
      results.replaceChildren();
      hits = [];
      shownFor = k;
      info.textContent = "Tape au moins deux caractères.";
      infoRow.replaceChildren(info);
      return true;
    }
    info.textContent = "Recherche…";
    const found = await search(q, {
      // Une frappe plus recente arrete la lecture du disque, pas seulement l'affichage.
      isStale: () => mine !== token,
      notebook: only ? opts.notebook?.dir : undefined,
    });
    if (mine !== token) return false; // une frappe plus recente a pris la main
    hits = found;
    shownFor = k;
    results.replaceChildren();
    const where = only && opts.notebook ? ` dans ${opts.notebook.title}` : "";
    info.textContent = !hits.length ? `Aucun résultat${where}.`
      : hits.length > MAX_HITS ? `${MAX_HITS} premiers résultats sur ${hits.length}${where}, les plus récents d'abord`
      : `${hits.length} résultat${hits.length > 1 ? "s" : ""}${where}`;
    infoRow.replaceChildren(info);
    if (!hits.length && only && opts.notebook) {
      infoRow.append(el("button", {
        onclick: () => { only = false; paintScope(); void run(); input.focus(); },
      }, "Chercher dans tous les cahiers"));
    }
    hits.slice(0, MAX_HITS).forEach((h, i) => {
      const row = el("button", {
        class: "hit",
        tabindex: "-1",
        onclick: () => open(h, q),
      },
        excerptNode(h.parts),
        el("div", { class: "where" },
          `${h.notebookTitle} · ${h.divider} p.${h.page} · ${BLOCK_LABEL[h.blockType] ?? h.blockType}`),
      );
      row.addEventListener("mouseenter", () => select(i));
      results.append(row);
    });
    select(0);
    return true;
  };

  const later = debounce(() => void run(), 220);
  input.addEventListener("input", later);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select(sel + (e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Resultats pas encore a jour (frappe dans les 220 ms) : on cherche
      // d'abord, puis on ouvre le premier.
      // La recherche differee est annulee : partie apres, elle rendrait
      // celle-ci perimee, et l'on ouvrirait les resultats de l'ancienne.
      if (shownFor !== key()) {
        later.cancel();
        const q = input.value.trim();
        void run().then((ok) => { if (ok && shownFor === key()) open(hits[0], q); });
      } else open(hits[sel], input.value.trim());
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); onBack(); }
  });

  const inner = el("div", { class: "screen-inner" },
    el("div", { class: "row" },
      el("button", { onclick: onBack }, "Retour"),
      el("h1", { style: { margin: "0 0 0 8px" } }, "Recherche"),
    ),
    el("div", { class: "search-bar" }, input, scope),
    infoRow, results,
  );
  setTimeout(() => { input.focus(); input.select(); }, 40);
  if (input.value.trim()) void run();
  return el("div", { class: "screen" }, inner);
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T & { cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  const call = ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  }) as T & { cancel: () => void };
  call.cancel = () => { if (t) clearTimeout(t); t = null; };
  return call;
}

export { toast };
