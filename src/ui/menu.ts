import { el, askFields, toast } from "./dom";
import { NOTEBOOK_COLORS } from "../core/palette";
import type { Repo, NotebookSummary } from "../core/storage/repo";
import { listFlags } from "../core/storage/search";

export interface MenuHost {
  repo: Repo;
  openNotebook: (dir: string, divider?: string, page?: number) => void;
  openSearch: () => void;
  openFlags: () => void;
  openProbe: () => void;
  rootLabel: string;
}

/**
 * Ecran d'accueil (section 5). L'application s'ouvre directement ici,
 * pas d'ecran de demarrage.
 */
export async function buildMenu(host: MenuHost): Promise<HTMLElement> {
  const notebooks = await host.repo.listNotebooks();
  const flags = await listFlags(host.repo);
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
      el("button", { class: "resume", onclick: host.openFlags },
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
    node.append(el("span", { class: "badge" }, `${nb.flagCount} pas compris`));
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

/** Vue des reperes "pas compris", par matiere. */
export async function buildFlagsView(host: MenuHost, onBack: () => void): Promise<HTMLElement> {
  const flags = await listFlags(host.repo);
  const inner = el("div", { class: "screen-inner" });
  inner.append(
    el("div", { class: "row" },
      el("button", { onclick: onBack }, "Retour"),
      el("h1", { style: { margin: "0 0 0 8px" } }, "Pas compris"),
    ),
  );

  if (!flags.length) {
    inner.append(el("div", { class: "empty" }, "Aucun repère en attente."));
    return el("div", { class: "screen" }, inner);
  }

  const byNotebook = new Map<string, typeof flags>();
  for (const f of flags) {
    const list = byNotebook.get(f.notebookTitle) ?? [];
    list.push(f);
    byNotebook.set(f.notebookTitle, list);
  }

  for (const [title, list] of byNotebook) {
    inner.append(el("h2", {}, title));
    inner.append(el("div", { class: "hits" },
      ...list.map((f) => el("button", {
        class: "hit",
        onclick: () => host.openNotebook(f.notebook, f.divider, f.page),
      },
        el("div", {}, f.note),
        el("div", { class: "where" }, `${f.divider}, page ${f.page}`),
      )),
    ));
  }
  return el("div", { class: "screen" }, inner);
}

/** Recherche plein texte sur tous les cahiers. */
export function buildSearchView(
  host: MenuHost,
  onBack: () => void,
  search: (q: string) => Promise<{ notebook: string; notebookTitle: string; divider: string; page: number; blockId: string; blockType: string; excerpt: string }[]>,
): HTMLElement {
  const input = el("input", { type: "text", placeholder: "Chercher dans tous les cahiers…" });
  const results = el("div", { class: "hits" });
  const info = el("div", { class: "muted small" });

  let token = 0;
  const run = async () => {
    const q = input.value.trim();
    const mine = ++token;
    if (q.length < 2) {
      results.replaceChildren();
      info.textContent = "Tape au moins deux caractères.";
      return;
    }
    info.textContent = "Recherche…";
    const hits = await search(q);
    if (mine !== token) return; // une frappe plus recente a pris la main
    results.replaceChildren();
    info.textContent = hits.length
      ? `${hits.length} résultat${hits.length > 1 ? "s" : ""}`
      : "Aucun résultat.";
    for (const h of hits.slice(0, 200)) {
      results.append(el("button", {
        class: "hit",
        onclick: () => host.openNotebook(h.notebook, h.divider, h.page),
      },
        el("div", {}, h.excerpt),
        el("div", { class: "where" },
          `${h.notebookTitle} · ${h.divider} p.${h.page} · ${h.blockType}`),
      ));
    }
  };

  input.addEventListener("input", debounce(run, 220));
  const inner = el("div", { class: "screen-inner" },
    el("div", { class: "row" },
      el("button", { onclick: onBack }, "Retour"),
      el("h1", { style: { margin: "0 0 0 8px" } }, "Recherche"),
    ),
    input, info, results,
  );
  setTimeout(() => input.focus(), 40);
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
