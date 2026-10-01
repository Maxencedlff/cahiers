import { el, askFields, toast } from "./dom";
import { NOTEBOOK_COLORS } from "../core/palette";
import type { Repo, NotebookSummary } from "../core/storage/repo";
import {
  listFlags, sortFlags, DEFAULT_FLAG_NOTE,
  type FlagHit, type SearchHit, type SearchOptions,
} from "../core/storage/search";
import { parseQuery, queryReady, type ExcerptPart } from "../core/text/find";
import type { Block } from "../core/types";

export interface MenuHost {
  repo: Repo;
  openNotebook: (dir: string, divider?: string, page?: number) => void;
  /** Ouvre la page et va au bloc ; `query` surligne le passage trouve. */
  openAt: (dir: string, divider: string, page: number, blockId: string, query?: string) => void;
  openSearch: () => void;
  /** Vue des reperes, de toutes les matieres ou d'une seule. */
  openFlags: (notebook?: string) => void;
  /** Marque un repere compris (true) ou le rend (false). false si rien n'a change. */
  setFlagResolved: (f: FlagHit, resolved: boolean) => Promise<boolean>;
  openProbe: () => void;
  rootLabel: string;
}

/**
 * Ecran d'accueil (section 5). L'application s'ouvre directement ici,
 * pas d'ecran de demarrage.
 */
export async function buildMenu(host: MenuHost): Promise<HTMLElement> {
  const notebooks = await host.repo.listNotebooks();
  // Les reperes viennent du meme parcours que les compteurs : un seul.
  const flags = notebooks.flatMap((n) => n.flags);
  const inner = el("div", { class: "screen-inner" });
  const screen = el("div", { class: "screen" }, inner);

  inner.append(
    el("div", { class: "row" },
      el("div", {},
        el("h1", {}, "Cahiers"),
        el("div", { class: "muted small" }, host.rootLabel),
      ),
      el("div", { class: "spacer" }),
      el("button", { onclick: host.openSearch }, "Rechercher"),
      el("button", { onclick: host.openProbe, title: "Diagnostic du stylet" }, "Sonde stylet"),
    ),
  );

  // Bloc "Reprendre" en haut : derniere position, un clic.
  const resume = await lastPosition(notebooks);
  if (resume) {
    inner.append(
      el("h2", {}, "Reprendre"),
      el("button", {
        class: "resume",
        onclick: () => host.openNotebook(resume.dir, resume.divider, resume.page),
      },
        el("div", { class: "bar", style: { background: resume.color, width: "6px", height: "42px", borderRadius: "3px" } }),
        el("div", {},
          el("div", { class: "big" }, resume.title),
          el("div", { class: "muted small" }, `${resume.divider}, page ${resume.page}`),
        ),
      ),
    );
  }

  // Compteur de marqueurs "pas compris" en attente.
  if (flags.length) {
    inner.append(
      el("h2", {}, "Pas compris"),
      el("button", { class: "resume", onclick: () => host.openFlags() },
        el("span", { class: "badge" }, `${flags.length}`),
        el("div", {},
          el("div", { class: "big" }, flags.length > 1 ? "repères en attente" : "repère en attente"),
          el("div", { class: "muted small" },
            [...new Set(flags.map((f) => f.notebookTitle))].join(", ")),
        ),
      ),
    );
  }

  inner.append(el("h2", {}, "Matières"));
  const grid = el("div", { class: "grid" });
  inner.append(grid);

  for (const nb of notebooks) grid.append(card(host, nb));

  grid.append(el("button", {
    class: "card add",
    onclick: async () => {
      const r = await askFields("Nouvelle matière", [
        { name: "title", label: "Nom", placeholder: "Maths, Élec, Info…" },
      ], "Créer");
      if (!r?.title) return;
      const color = NOTEBOOK_COLORS[Math.floor(Math.random() * NOTEBOOK_COLORS.length)];
      const dir = await host.repo.createNotebook(r.title, color);
      await host.repo.createDivider(dir, "Cours");
      host.openNotebook(dir);
    },
  }, "+ Nouvelle matière"));

  return screen;
}

function card(host: MenuHost, nb: NotebookSummary): HTMLElement {
  const node = el("button", {
    class: "card",
    onclick: () => host.openNotebook(nb.dir, nb.meta.lastPosition?.divider, nb.meta.lastPosition?.page),
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
  return node;
}

/** La matiere la plus recemment modifiee qui a une position memorisee. */
async function lastPosition(notebooks: NotebookSummary[]) {
  for (const nb of notebooks) {
    if (nb.meta.lastPosition) {
      return {
        dir: nb.dir,
        title: nb.meta.title,
        color: nb.meta.color,
        divider: nb.meta.lastPosition.divider,
        page: nb.meta.lastPosition.page,
      };
    }
  }
  return null;
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
  const run = async (): Promise<void> => {
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
      return;
    }
    info.textContent = "Recherche…";
    const found = await search(q, {
      // Une frappe plus recente arrete la lecture du disque, pas seulement l'affichage.
      isStale: () => mine !== token,
      notebook: only ? opts.notebook?.dir : undefined,
    });
    if (mine !== token) return; // une frappe plus recente a pris la main
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
      if (shownFor !== key()) void run().then(() => open(hits[0], input.value.trim()));
      else open(hits[sel], input.value.trim());
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

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

export { toast };
