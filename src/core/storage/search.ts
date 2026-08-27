import type { Repo } from "./repo";
import type { Block, Page } from "../types";

export interface SearchHit {
  notebook: string;
  notebookTitle: string;
  divider: string;
  page: number;
  blockId: string;
  blockType: Block["type"];
  /** Extrait avec le terme en contexte. */
  excerpt: string;
}

export interface FlagHit {
  notebook: string;
  notebookTitle: string;
  divider: string;
  page: number;
  blockId: string;
  note: string;
}

/**
 * Recherche plein texte sur tous les cahiers (priorite 1).
 * Parcourt le disque : pas d'index persistant qui pourrait mentir apres
 * une modification faite dans l'explorateur ou par la synchro OneDrive.
 */
export async function searchAll(repo: Repo, query: string): Promise<SearchHit[]> {
  const q = normalize(query);
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];

  for (const dir of await repo.listNotebookDirs()) {
    const meta = await repo.readMeta(dir);
    for (const divider of await repo.listDividers(dir)) {
      for (const n of await repo.listPageNumbers(dir, divider)) {
        let page: Page;
        try { page = await repo.readPage(dir, divider, n); } catch { continue; }
        for (const b of page.blocks) {
          const text = searchableText(b);
          if (!text) continue;
          const idx = normalize(text).indexOf(q);
          if (idx === -1) continue;
          hits.push({
            notebook: dir,
            notebookTitle: meta.title,
            divider,
            page: n,
            blockId: b.id,
            blockType: b.type,
            excerpt: excerptAround(text, idx, q.length),
          });
        }
      }
    }
  }
  return hits;
}

/** Tous les reperes "pas compris" non resolus, par matiere (section 6). */
export async function listFlags(repo: Repo, notebook?: string): Promise<FlagHit[]> {
  const out: FlagHit[] = [];
  const dirs = notebook ? [notebook] : await repo.listNotebookDirs();
  for (const dir of dirs) {
    const meta = await repo.readMeta(dir);
    for (const divider of await repo.listDividers(dir)) {
      for (const n of await repo.listPageNumbers(dir, divider)) {
        let page: Page;
        try { page = await repo.readPage(dir, divider, n); } catch { continue; }
        for (const b of page.blocks) {
          if (b.type === "flag" && !b.resolved) {
            out.push({
              notebook: dir, notebookTitle: meta.title, divider,
              page: n, blockId: b.id, note: b.note,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Texte indexable d'un bloc. Une image sans OCR est un trou noir dans la
 * recherche (section 6) : c'est pour ca que le champ ocr existe.
 */
export function searchableText(b: Block): string {
  switch (b.type) {
    case "text":  return b.content;
    case "math":  return b.latex ?? "";
    case "ink":   return b.recognized ?? "";
    case "image": return b.ocr ?? "";
    case "calc":  return `${b.expr} = ${b.result ?? ""}`;
    case "graph": return `y = ${b.fn}`;
    case "link":  return b.label;
    case "flag":  return b.note;
    case "pdf":   return "";
  }
}

/** Insensible a la casse ET aux accents : "theoreme" trouve "theoreme". */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function excerptAround(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 40);
  return (start > 0 ? "..." : "") + text.slice(start, end).replace(/\s+/g, " ") +
    (end < text.length ? "..." : "");
}
