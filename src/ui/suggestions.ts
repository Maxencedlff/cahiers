/**
 * Corpus des suggestions de formules (core/suggest.ts) : les formules des
 * pages, lues par Repo.scanDivider (cache de session, une page n'est relue
 * que si son fichier a change ; rien n'est ecrit sur le disque). Le cahier
 * ouvert d'abord, les autres ensuite, sans bloquer la frappe.
 */
import type { Repo } from "../core/storage/repo";
import { SuggestIndex, type CorpusPage, type Suggestion } from "../core/suggest";

/** Relecture au plus toutes les 20 s (les pages enregistrees entre-temps y entrent). */
const REFRESH_MS = 20_000;

let index = new SuggestIndex();
let builtAt = 0;
let building: Promise<void> | null = null;
let focus = "";

async function build(repo: Repo, notebook: string): Promise<void> {
  const pages: CorpusPage[] = [];
  const notebooks = [notebook, ...(await repo.listNotebookDirs().catch(() => [] as string[])).filter((n) => n !== notebook)];
  for (const nb of notebooks) {
    const dividers = await repo.listDividers(nb).catch(() => [] as string[]);
    for (const d of dividers) {
      const scanned = (await repo.scanDivider(nb, d).catch(() => null)) ?? [];
      for (const { index: ix } of scanned) {
        if (ix?.formulas?.length) pages.push({ notebook: nb, divider: d, modified: ix.modified, formulas: ix.formulas });
      }
    }
    // Le cahier ouvert sert tout de suite, les autres suivent.
    if (nb === notebook) { index = new SuggestIndex(pages); builtAt = Date.now(); }
    await new Promise((r) => setTimeout(r, 0));
  }
  index = new SuggestIndex(pages);
  builtAt = Date.now();
}

/** Relit le corpus si besoin (en fond). */
export function refreshSuggestions(repo: Repo, notebook: string, force = false): void {
  if (building) return;
  if (!force && focus === notebook && Date.now() - builtAt < REFRESH_MS) return;
  focus = notebook;
  building = build(repo, notebook).catch(() => undefined).finally(() => { building = null; });
}

/** Suggestion pour la ligne tapee (synchrone : index en memoire). */
export function suggestFor(repo: Repo, notebook: string, divider: string, line: string): Suggestion | null {
  refreshSuggestions(repo, notebook);
  return index.suggest(line, { notebook, divider });
}
