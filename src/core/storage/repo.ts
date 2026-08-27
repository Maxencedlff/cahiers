import type { FsAdapter } from "./fs";
import { joinPath } from "./fs";
import {
  SCHEMA_VERSION, emptyPage, pageFileName, parsePageNumber,
  type NotebookMeta, type Page,
} from "../types";
import { uuid, nowIso } from "../id";

export const VRAC = "Vrac";
export const META_FILE = "cahier.json";
export const ASSETS_DIR = "assets";

export interface NotebookSummary {
  /** Nom du dossier sur le disque. C'est l'identite. */
  dir: string;
  meta: NotebookMeta;
  pageCount: number;
  flagCount: number;
  modified: string;
}

/**
 * Acces aux cahiers. Le disque fait autorite : chaque appel repart d'un
 * listing reel, aucun index n'est conserve entre deux lancements.
 */
export class Repo {
  constructor(private fs: FsAdapter) {}

  /* ---------------- cahiers ---------------- */

  async listNotebookDirs(): Promise<string[]> {
    const dirs = (await this.fs.listDirs("")).filter((d) => !d.startsWith("."));
    if (!dirs.includes(VRAC)) dirs.push(VRAC);
    return dirs;
  }

  async readMeta(dir: string): Promise<NotebookMeta> {
    const path = joinPath(dir, META_FILE);
    if (await this.fs.exists(path)) {
      try {
        const parsed = JSON.parse(await this.fs.readText(path)) as NotebookMeta;
        return this.normalizeMeta(dir, parsed);
      } catch {
        // Fichier illisible : on ne perd pas le cahier pour autant,
        // le disque reste la source de verite.
      }
    }
    return this.normalizeMeta(dir, null);
  }

  private normalizeMeta(dir: string, m: NotebookMeta | null): NotebookMeta {
    return {
      version: SCHEMA_VERSION,
      title: m?.title?.trim() || dir,
      color: m?.color || "#2563eb",
      dividers: Array.isArray(m?.dividers) ? m!.dividers : [],
      lastPosition: m?.lastPosition,
      viewMode: m?.viewMode ?? {},
    };
  }

  async writeMeta(dir: string, meta: NotebookMeta): Promise<void> {
    await this.fs.mkdir(dir);
    await this.fs.writeText(joinPath(dir, META_FILE), JSON.stringify(meta, null, 2));
  }

  async createNotebook(title: string, color: string): Promise<string> {
    const dir = safeName(title);
    await this.fs.mkdir(dir);
    await this.writeMeta(dir, {
      version: SCHEMA_VERSION, title, color, dividers: [], viewMode: {},
    });
    return dir;
  }

  async renameNotebook(dir: string, title: string): Promise<string> {
    const next = safeName(title);
    const meta = await this.readMeta(dir);
    meta.title = title;
    if (next !== dir && !(await this.fs.exists(next))) {
      await this.fs.rename(dir, next);
      await this.writeMeta(next, meta);
      return next;
    }
    await this.writeMeta(dir, meta);
    return dir;
  }

  /* ---------------- intercalaires ---------------- */

  /**
   * Ordre = celui de cahier.json, filtre par ce qui existe reellement,
   * puis les dossiers apparus dans l'explorateur Windows, a la fin.
   */
  async listDividers(dir: string): Promise<string[]> {
    const onDisk = (await this.fs.listDirs(dir)).filter(
      (d) => d !== ASSETS_DIR && !d.startsWith("."),
    );
    const meta = await this.readMeta(dir);
    const ordered = meta.dividers.filter((d) => onDisk.includes(d));
    for (const d of onDisk) if (!ordered.includes(d)) ordered.push(d);
    if (ordered.join("|") !== meta.dividers.join("|")) {
      meta.dividers = ordered;
      await this.writeMeta(dir, meta);
    }
    return ordered;
  }

  async createDivider(dir: string, name: string): Promise<string> {
    const d = safeName(name);
    await this.fs.mkdir(joinPath(dir, d));
    const meta = await this.readMeta(dir);
    if (!meta.dividers.includes(d)) meta.dividers.push(d);
    await this.writeMeta(dir, meta);
    return d;
  }

  async renameDivider(dir: string, from: string, to: string): Promise<string> {
    const next = safeName(to);
    if (next === from) return from;
    if (await this.fs.exists(joinPath(dir, next))) return from;
    await this.fs.rename(joinPath(dir, from), joinPath(dir, next));
    const meta = await this.readMeta(dir);
    meta.dividers = meta.dividers.map((d) => (d === from ? next : d));
    if (meta.lastPosition?.divider === from) meta.lastPosition.divider = next;
    if (meta.viewMode && from in meta.viewMode) {
      meta.viewMode[next] = meta.viewMode[from];
      delete meta.viewMode[from];
    }
    await this.writeMeta(dir, meta);
    return next;
  }

  async reorderDividers(dir: string, order: string[]): Promise<void> {
    const meta = await this.readMeta(dir);
    meta.dividers = order;
    await this.writeMeta(dir, meta);
  }

  async deleteDivider(dir: string, name: string): Promise<void> {
    await this.fs.remove(joinPath(dir, name));
    const meta = await this.readMeta(dir);
    meta.dividers = meta.dividers.filter((d) => d !== name);
    await this.writeMeta(dir, meta);
  }

  /* ---------------- pages ---------------- */

  /** Numeros presents, tries. Numerotation PAR INTERCALAIRE (section 2). */
  async listPageNumbers(dir: string, divider: string): Promise<number[]> {
    const files = await this.fs.listFiles(joinPath(dir, divider));
    return files
      .map(parsePageNumber)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
  }

  async readPage(dir: string, divider: string, n: number): Promise<Page> {
    const path = joinPath(dir, divider, pageFileName(n));
    const raw = await this.fs.readText(path);
    const p = JSON.parse(raw) as Page;
    return migratePage(p);
  }

  async writePage(dir: string, divider: string, n: number, page: Page): Promise<void> {
    page.modified = nowIso();
    await this.fs.writeText(
      joinPath(dir, divider, pageFileName(n)),
      JSON.stringify(page, null, 2),
    );
  }

  /**
   * Cree une page. `at` = numero souhaite ; les pages suivantes sont
   * renumerotees en descendant pour ne jamais ecraser un fichier.
   */
  async createPage(dir: string, divider: string, at?: number): Promise<number> {
    await this.fs.mkdir(joinPath(dir, divider));
    const nums = await this.listPageNumbers(dir, divider);
    const last = nums.length ? nums[nums.length - 1] : 0;
    const target = at == null ? last + 1 : Math.max(1, Math.min(at, last + 1));

    for (let i = nums.length - 1; i >= 0; i--) {
      const n = nums[i];
      if (n >= target) {
        await this.fs.rename(
          joinPath(dir, divider, pageFileName(n)),
          joinPath(dir, divider, pageFileName(n + 1)),
        );
      }
    }
    await this.writePage(dir, divider, target, emptyPage(uuid(), nowIso()));
    return target;
  }

  /** Supprime et referme le trou de numerotation. */
  async deletePage(dir: string, divider: string, n: number): Promise<void> {
    await this.fs.remove(joinPath(dir, divider, pageFileName(n)));
    const nums = await this.listPageNumbers(dir, divider);
    for (const num of nums) {
      if (num > n) {
        await this.fs.rename(
          joinPath(dir, divider, pageFileName(num)),
          joinPath(dir, divider, pageFileName(num - 1)),
        );
      }
    }
  }

  /* ---------------- position et compteurs ---------------- */

  async setLastPosition(dir: string, divider: string, page: number): Promise<void> {
    const meta = await this.readMeta(dir);
    meta.lastPosition = { divider, page };
    await this.writeMeta(dir, meta);
  }

  async setViewMode(dir: string, divider: string, mode: "pages" | "scroll"): Promise<void> {
    const meta = await this.readMeta(dir);
    meta.viewMode = { ...(meta.viewMode ?? {}), [divider]: mode };
    await this.writeMeta(dir, meta);
  }

  async summary(dir: string): Promise<NotebookSummary> {
    const meta = await this.readMeta(dir);
    const dividers = await this.listDividers(dir);
    let pageCount = 0;
    let flagCount = 0;
    let modified = "";
    for (const d of dividers) {
      const nums = await this.listPageNumbers(dir, d);
      pageCount += nums.length;
      for (const n of nums) {
        try {
          const page = await this.readPage(dir, d, n);
          if (page.modified > modified) modified = page.modified;
          flagCount += page.blocks.filter(
            (b) => b.type === "flag" && !b.resolved,
          ).length;
        } catch { /* page illisible : on l'ignore pour le compteur */ }
      }
    }
    return { dir, meta, pageCount, flagCount, modified };
  }

  /** Toutes les matieres, triees par derniere modification (section 5). */
  async listNotebooks(): Promise<NotebookSummary[]> {
    const dirs = await this.listNotebookDirs();
    const out: NotebookSummary[] = [];
    for (const d of dirs) out.push(await this.summary(d));
    out.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
    return out;
  }

  async ensureRootLayout(): Promise<void> {
    if (!(await this.fs.exists(VRAC))) {
      await this.fs.mkdir(joinPath(VRAC, "Notes"));
      await this.writeMeta(VRAC, {
        version: SCHEMA_VERSION, title: "Vrac", color: "#64748b",
        dividers: ["Notes"], viewMode: {},
      });
    }
  }
}

/** Nom de dossier valide : ni separateur, ni caractere interdit par Windows. */
export function safeName(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned || "Sans titre";
}

/**
 * Point d'entree unique des migrations de schema. Aujourd'hui la v1 est la
 * seule version ; la fonction existe pour que la v2 ait un endroit ou aller.
 */
export function migratePage(p: Page): Page {
  if (!Array.isArray(p.blocks)) p.blocks = [];
  for (const b of p.blocks) {
    if (b.type === "math" && !Array.isArray(b.strokes)) b.strokes = [];
    if (b.type === "ink" && !Array.isArray(b.strokes)) b.strokes = [];
  }
  return p;
}
