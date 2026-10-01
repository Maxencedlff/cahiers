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
/**
 * Corbeille, a la racine (ESEO/.corbeille). Le point la cache du menu. Une
 * suppression y est deplacee, jamais effacee : OneDrive propagerait
 * l'effacement sur l'autre PC, et perdre un cours est inacceptable.
 */
export const TRASH_DIR = ".corbeille";

/** Ce qu'il faut pour remettre en place un element mis a la corbeille. */
export interface TrashEntry {
  /** Dossier de cette suppression dans la corbeille, un par suppression. */
  bin: string;
  dir: string;
  divider: string;
  /** Numero de la page ; absent quand c'est tout l'intercalaire. */
  page?: number;
  /** Place de l'intercalaire dans cahier.json. */
  index?: number;
}

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

  /**
   * Renomme le dossier reel. Rend le nom applique : `from` quand le nom est
   * deja pris. Windows ne distingue pas la casse : « cours » est pris si
   * « Cours » existe, et un changement de casse seul passe par un nom
   * intermediaire.
   */
  async renameDivider(dir: string, from: string, to: string): Promise<string> {
    const next = safeName(to);
    if (next === from) return from;
    const key = next.toLowerCase();
    const taken = (await this.fs.listDirs(dir)).filter((d) => d !== from);
    if (key === ASSETS_DIR || next.startsWith(".") || taken.some((d) => d.toLowerCase() === key)) {
      return from;
    }
    if (key === from.toLowerCase()) {
      const step = `${from}.renommage`;
      await this.fs.rename(joinPath(dir, from), joinPath(dir, step));
      await this.fs.rename(joinPath(dir, step), joinPath(dir, next));
    } else {
      await this.fs.rename(joinPath(dir, from), joinPath(dir, next));
    }
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

  /** Met l'intercalaire et toutes ses pages a la corbeille. */
  async deleteDivider(dir: string, name: string): Promise<TrashEntry> {
    const meta = await this.readMeta(dir);
    const index = meta.dividers.indexOf(name);
    const bin = await this.newBin();
    await this.fs.mkdir(joinPath(bin, dir));
    await this.fs.rename(joinPath(dir, name), joinPath(bin, dir, name));
    meta.dividers = meta.dividers.filter((d) => d !== name);
    await this.writeMeta(dir, meta);
    return { bin, dir, divider: name, index: index >= 0 ? index : undefined };
  }

  /**
   * Sort un intercalaire de la corbeille, a sa place d'origine. Si un
   * intercalaire du meme nom a ete cree entre temps, il n'est pas ecrase :
   * le restaure prend « (restauré) ». Rend le nom applique.
   */
  async restoreDivider(entry: TrashEntry): Promise<string> {
    const src = joinPath(entry.bin, entry.dir, entry.divider);
    if (!(await this.fs.exists(src))) throw new Error("introuvable dans la corbeille");
    const taken = (await this.fs.listDirs(entry.dir)).map((d) => d.toLowerCase());
    let name = entry.divider;
    for (let i = 1; taken.includes(name.toLowerCase()); i++) {
      name = `${entry.divider} (restauré${i > 1 ? ` ${i}` : ""})`;
    }
    await this.fs.mkdir(entry.dir);
    await this.fs.rename(src, joinPath(entry.dir, name));
    const meta = await this.readMeta(entry.dir);
    if (!meta.dividers.includes(name)) {
      const at = Math.min(entry.index ?? meta.dividers.length, meta.dividers.length);
      meta.dividers.splice(at, 0, name);
    }
    await this.writeMeta(entry.dir, meta);
    await this.dropBinIfEmpty(entry.bin);
    return name;
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

  /** Met la page a la corbeille et referme le trou de numerotation. */
  async deletePage(dir: string, divider: string, n: number): Promise<TrashEntry> {
    const bin = await this.newBin();
    await this.fs.mkdir(joinPath(bin, dir, divider));
    await this.fs.rename(
      joinPath(dir, divider, pageFileName(n)),
      joinPath(bin, dir, divider, pageFileName(n)),
    );
    const nums = await this.listPageNumbers(dir, divider);
    for (const num of nums) {
      if (num > n) {
        await this.fs.rename(
          joinPath(dir, divider, pageFileName(num)),
          joinPath(dir, divider, pageFileName(num - 1)),
        );
      }
    }
    return { bin, dir, divider, page: n };
  }

  /**
   * Remet une page de la corbeille a son numero d'origine ; les suivantes
   * sont decalees comme pour une insertion. Rend le numero applique.
   */
  async restorePage(entry: TrashEntry): Promise<number> {
    if (entry.page == null) throw new Error("ce n'est pas une page");
    const src = joinPath(entry.bin, entry.dir, entry.divider, pageFileName(entry.page));
    if (!(await this.fs.exists(src))) throw new Error("introuvable dans la corbeille");
    await this.fs.mkdir(joinPath(entry.dir, entry.divider));
    const nums = await this.listPageNumbers(entry.dir, entry.divider);
    const last = nums.length ? nums[nums.length - 1] : 0;
    const target = Math.max(1, Math.min(entry.page, last + 1));
    for (let i = nums.length - 1; i >= 0; i--) {
      if (nums[i] >= target) {
        await this.fs.rename(
          joinPath(entry.dir, entry.divider, pageFileName(nums[i])),
          joinPath(entry.dir, entry.divider, pageFileName(nums[i] + 1)),
        );
      }
    }
    await this.fs.rename(src, joinPath(entry.dir, entry.divider, pageFileName(target)));
    await this.dropBinIfEmpty(entry.bin);
    return target;
  }

  /** Un dossier de corbeille par suppression, date a la milliseconde. */
  private async newBin(): Promise<string> {
    const stamp = trashStamp(new Date());
    let bin = joinPath(TRASH_DIR, stamp);
    for (let i = 2; await this.fs.exists(bin); i++) bin = joinPath(TRASH_DIR, `${stamp}-${i}`);
    await this.fs.mkdir(bin);
    return bin;
  }

  /** Apres une restauration, le dossier de corbeille vide s'en va. */
  private async dropBinIfEmpty(bin: string): Promise<void> {
    const hasFile = async (rel: string): Promise<boolean> => {
      if ((await this.fs.listFiles(rel)).length) return true;
      for (const d of await this.fs.listDirs(rel)) if (await hasFile(joinPath(rel, d))) return true;
      return false;
    };
    try {
      if (!(await hasFile(bin))) await this.fs.remove(bin);
    } catch { /* un dossier vide de plus dans la corbeille, sans gravite */ }
  }

  /** Montre la page dans l'explorateur Windows. Absent en mode navigateur. */
  get canReveal(): boolean { return !!this.fs.reveal; }

  async revealPage(dir: string, divider: string, n: number): Promise<void> {
    await this.fs.reveal?.(joinPath(dir, divider, pageFileName(n)));
  }

  /** Chemin d'une page, tel qu'on le montre a l'utilisateur. */
  pagePath(dir: string, divider: string, n: number): string {
    return joinPath(dir, divider, pageFileName(n));
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

  /* ---------------- pieces jointes ---------------- */

  /**
   * Enregistre une image ou un PDF dans `assets/` de l'intercalaire et rend
   * le chemin a stocker dans le bloc, relatif a la page qui le reference.
   */
  async writeAsset(
    dir: string, divider: string, name: string, dataUrl: string,
  ): Promise<string> {
    const rel = joinPath(dir, divider, ASSETS_DIR, name);
    await this.fs.mkdir(joinPath(dir, divider, ASSETS_DIR));
    await this.fs.writeDataUrl(rel, dataUrl);
    return `${ASSETS_DIR}/${name}`;
  }

  async readAsset(dir: string, divider: string, src: string): Promise<string> {
    return this.fs.readDataUrl(joinPath(dir, divider, src));
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

/** Horodatage lisible et triable d'une suppression : 2026-10-01_14-03-22-123. */
export function trashStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_`
    + `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
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
