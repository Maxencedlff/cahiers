import type { FileStat, FsAdapter } from "./fs";
import { joinPath } from "./fs";
import {
  SCHEMA_VERSION, emptyPage, isFutureVersion, pageFileName, parsePageNumber,
  type NotebookMeta, type Page,
} from "../types";
import { uuid, nowIso } from "../id";
import { indexPage, type FlagHit, type PageIndex } from "./search";
import { parseConflictName, renumberConflictName } from "../sync";

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
  /**
   * Toute la matiere (`notebook`), ou seulement son cahier.json (`meta` :
   * dossier rendu aux « Autres dossiers »). Absent : page ou intercalaire.
   */
  kind?: "notebook" | "meta";
  /** Copie de conflit OneDrive seule (nom du fichier), sans sa page. */
  conflict?: string;
  /** Copies de conflit parties avec la page (noms d'origine). */
  copies?: string[];
}

/**
 * Copie de conflit OneDrive d'une page (« 0003.page-LAPTOP-MAX.json »).
 * Jamais une page normale, jamais supprimee sans qu'on le demande.
 */
export interface ConflictCopy {
  /** Nom du fichier dans l'intercalaire. */
  file: string;
  /** Numero de la page dont c'est une copie. */
  page: number;
  /** Origine lue dans le nom (le PC, le plus souvent). */
  label: string;
  /** Aucune page normale sous ce numero : la copie est seule. */
  orphan: boolean;
}

/** Dossier de la racine qui n'est pas une matiere (D5). */
export interface OtherDir {
  dir: string;
  /** Depot git : jamais une matiere, ses dossiers ne sont pas des intercalaires. */
  git: boolean;
}

/** La racine : les matieres, puis le reste (« Autres dossiers »). */
export interface RootListing {
  notebooks: NotebookSummary[];
  others: OtherDir[];
}

/**
 * Une recherche de pages dans un dossier qui n'en a pas est refaite au plus
 * toutes les minutes : le menu s'affiche a chaque Ctrl+M, et un gros dossier
 * (projets, documents) coute des dizaines de lectures.
 */
const PROBE_TTL_MS = 60_000;
/** Dossiers visites au plus pour decider qu'un dossier n'a pas de pages. */
const PROBE_BUDGET = 30;

export interface NotebookSummary {
  /** Nom du dossier sur le disque. C'est l'identite. */
  dir: string;
  meta: NotebookMeta;
  pageCount: number;
  flagCount: number;
  /** Reperes non resolus, lus dans le meme parcours (le menu n'en refait pas un). */
  flags: FlagHit[];
  modified: string;
}

/** Une page d'intercalaire et son resume ; null si elle est illisible. */
export interface ScannedPage {
  n: number;
  index: PageIndex | null;
}

/**
 * Acces aux cahiers. Le disque fait autorite : chaque appel repart d'un
 * listing reel, aucun index n'est conserve entre deux lancements.
 */
export class Repo {
  /**
   * Resumes des pages deja lues pendant la session, par chemin. Ce n'est
   * pas un index : il ne fait jamais foi. Chaque usage revérifie la date et
   * la taille du fichier (une page changee par OneDrive est relue), il n'est
   * jamais ecrit sur le disque, et toute ecriture ou renumerotation faite
   * ici l'oublie.
   */
  private cache = new Map<string, { stamp: string; index: PageIndex }>();
  /**
   * Ecritures de cahier.json, une a la fois par cahier : deux mises a jour
   * entremelees (renommage pendant un reordonnancement) perdaient l'une des
   * deux.
   */
  private metaChain = new Map<string, Promise<unknown>>();
  /** Dossiers de la racine vus sans page, et quand (voir PROBE_TTL_MS). */
  private noPages = new Map<string, number>();

  constructor(private fs: FsAdapter) {}

  /** Oublie les resumes d'un fichier ou de tout un dossier. */
  private forget(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key === prefix || key.startsWith(prefix + "/")) this.cache.delete(key);
    }
  }

  /* ---------------- cahiers ---------------- */

  /**
   * Les matieres : les dossiers de la racine qui ont un cahier.json ou des
   * pages (D5), plus Vrac, toujours present. Le reste (documents, projets,
   * depots git) n'est pas un cahier : l'appli n'y ecrit rien.
   */
  async listNotebookDirs(): Promise<string[]> {
    return (await this.classifyRoot()).notebooks;
  }

  /** Matieres et autres dossiers de la racine, sans rien ecrire. */
  async classifyRoot(): Promise<{ notebooks: string[]; others: OtherDir[] }> {
    const dirs = (await this.fs.listDirs("")).filter((d) => !d.startsWith("."));
    const notebooks: string[] = [];
    const others: OtherDir[] = [];
    for (const d of dirs) {
      if (d === VRAC) { notebooks.push(d); continue; }
      // Un depot git (projets de code) n'est jamais une matiere, meme si une
      // ancienne version y a pose un cahier.json.
      if (await this.isGitRepo(d)) { others.push({ dir: d, git: true }); continue; }
      if (await this.fs.exists(joinPath(d, META_FILE)) || await this.hasPagesCached(d)) notebooks.push(d);
      else others.push({ dir: d, git: false });
    }
    if (!notebooks.includes(VRAC)) notebooks.push(VRAC);
    return { notebooks, others };
  }

  private async hasPagesCached(dir: string): Promise<boolean> {
    const seen = this.noPages.get(dir);
    if (seen != null && Date.now() - seen < PROBE_TTL_MS) return false;
    const found = await this.hasPages(dir);
    if (found) this.noPages.delete(dir); else this.noPages.set(dir, Date.now());
    return found;
  }

  /**
   * Au moins une page dans le dossier, ses intercalaires ou un niveau en
   * dessous. S'arrete a la premiere trouvee, et apres PROBE_BUDGET dossiers.
   */
  async hasPages(rel: string, depth = 3, budget = { left: PROBE_BUDGET }): Promise<boolean> {
    if (budget.left-- <= 0) return false;
    if ((await this.fs.listFiles(rel)).some((f) => parsePageNumber(f) !== null)) return true;
    if (depth <= 1) return false;
    for (const d of await this.fs.listDirs(rel)) {
      if (d.startsWith(".") || d === ASSETS_DIR) continue;
      if (await this.hasPages(joinPath(rel, d), depth - 1, budget)) return true;
    }
    return false;
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

  /**
   * Champs connus remis en forme ; les autres sont gardes tels quels (une
   * version plus recente sur l'autre PC a pu en ajouter).
   */
  private normalizeMeta(dir: string, m: NotebookMeta | null): NotebookMeta {
    const known = m && typeof m === "object" && !Array.isArray(m) ? m : null;
    return {
      ...(known ?? {}),
      version: SCHEMA_VERSION,
      title: (typeof known?.title === "string" && known.title.trim()) || dir,
      color: (typeof known?.color === "string" && known.color) || "#2563eb",
      dividers: Array.isArray(known?.dividers) ? known!.dividers.filter((d) => typeof d === "string") : [],
      viewMode: known?.viewMode && typeof known.viewMode === "object" ? known.viewMode : {},
    };
  }

  async writeMeta(dir: string, meta: NotebookMeta): Promise<void> {
    await this.fs.mkdir(dir);
    await this.fs.writeText(joinPath(dir, META_FILE), JSON.stringify(meta, null, 2));
  }

  /**
   * Lit, modifie et reecrit cahier.json, une mise a jour a la fois par
   * cahier. Seules les actions de l'utilisateur passent ici : lire le menu
   * ou ouvrir un cahier n'ecrit jamais rien.
   */
  private updateMeta(dir: string, change: (m: NotebookMeta) => void): Promise<NotebookMeta> {
    const prev = this.metaChain.get(dir) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const meta = await this.readMeta(dir);
      change(meta);
      await this.writeMeta(dir, meta);
      return meta;
    });
    this.metaChain.set(dir, run.catch(() => undefined));
    return run;
  }

  /** Dossier de la racine qui porte deja ce nom (Windows ignore la casse). */
  async findDir(title: string): Promise<string | null> {
    const key = safeName(title).toLowerCase();
    return (await this.fs.listDirs("")).find((d) => d.toLowerCase() === key) ?? null;
  }

  /** Depot git (projets de code) : jamais une matiere. */
  private isGitRepo(dir: string): Promise<boolean> {
    return this.fs.exists(joinPath(dir, ".git"));
  }

  /** Le dossier est une matiere : il a son cahier.json. */
  async isNotebook(dir: string): Promise<boolean> {
    return this.fs.exists(joinPath(dir, META_FILE));
  }

  /**
   * Nouvelle matiere. Si le dossier existe deja (meme nom, a la casse
   * pres), il est rendu tel quel : recreer « Maths » remettait a zero sa
   * couleur, l'ordre de ses intercalaires et ses modes. Un dossier sans
   * cahier.json (« Autres dossiers ») recoit le sien.
   */
  async createNotebook(title: string, color: string): Promise<string> {
    const existing = await this.findDir(title);
    if (existing) {
      if (await this.isGitRepo(existing)) throw new Error(`${existing} est un dépôt git, jamais une matière`);
      if (!(await this.isNotebook(existing))) await this.adoptNotebook(existing, color, title);
      return existing;
    }
    const dir = safeName(title);
    await this.fs.mkdir(dir);
    await this.writeMeta(dir, {
      version: SCHEMA_VERSION, title: title.trim() || dir, color, dividers: [], viewMode: {},
    });
    return dir;
  }

  /** « En faire une matiere » : un dossier existant recoit son cahier.json. */
  async adoptNotebook(dir: string, color: string, title?: string): Promise<string> {
    // Il resterait invisible (classifyRoot) tout en recevant des pages.
    if (await this.isGitRepo(dir)) throw new Error(`${dir} est un dépôt git, jamais une matière`);
    this.noPages.delete(dir);
    await this.updateMeta(dir, (m) => {
      m.color = color;
      if (title?.trim()) m.title = title.trim();
    });
    return dir;
  }

  /**
   * Renomme la matiere : le titre, et le dossier reel quand le nom change.
   * Un nom deja pris par un autre dossier est refuse (erreur), jamais
   * fusionne. Un changement de casse seul passe par un nom intermediaire.
   * Rend le dossier applique.
   */
  async renameNotebook(dir: string, title: string): Promise<string> {
    const wanted = title.trim();
    if (!wanted) return dir;
    const next = safeName(wanted);
    let target = dir;
    if (next !== dir && dir !== VRAC) {
      const key = next.toLowerCase();
      const taken = (await this.fs.listDirs("")).some((d) => d !== dir && d.toLowerCase() === key);
      if (taken || next.startsWith(".")) throw new Error(`le nom « ${next} » est déjà pris`);
      this.forget(dir);
      if (key === dir.toLowerCase()) {
        const step = `${dir}.renommage`;
        await this.fs.rename(dir, step);
        await this.fs.rename(step, next);
      } else {
        await this.fs.rename(dir, next);
      }
      this.metaChain.delete(dir);
      target = next;
    }
    await this.updateMeta(target, (m) => { m.title = wanted; });
    return target;
  }

  async setNotebookColor(dir: string, color: string): Promise<void> {
    await this.updateMeta(dir, (m) => { m.color = color; });
  }

  /** Met toute la matiere a la corbeille. Vrac reste toujours la. */
  async deleteNotebook(dir: string): Promise<TrashEntry> {
    if (dir === VRAC) throw new Error("Vrac reste toujours là");
    const bin = await this.newBin();
    this.forget(dir);
    this.metaChain.delete(dir);
    await this.fs.rename(dir, joinPath(bin, dir));
    return { bin, dir, divider: "", kind: "notebook" };
  }

  /**
   * Sort une matiere de la corbeille. Si un dossier du meme nom a ete cree
   * entre temps, il n'est pas ecrase : la matiere prend « (restauré) ».
   * Rend le dossier applique.
   */
  async restoreNotebook(entry: TrashEntry): Promise<string> {
    const src = joinPath(entry.bin, entry.dir);
    if (!(await this.fs.exists(src))) throw new Error("introuvable dans la corbeille");
    const taken = (await this.fs.listDirs("")).map((d) => d.toLowerCase());
    let name = entry.dir;
    for (let i = 1; taken.includes(name.toLowerCase()); i++) {
      name = `${entry.dir} (restauré${i > 1 ? ` ${i}` : ""})`;
    }
    this.forget(name);
    await this.fs.rename(src, name);
    await this.dropBinIfEmpty(entry.bin);
    return name;
  }

  /**
   * Matieres qui ont un cahier.json mais aucune page, nulle part : des
   * dossiers ou une ancienne version a pose un cahier.json a la simple
   * lecture du menu. Vrac n'en fait jamais partie.
   */
  async pagelessNotebooks(list: NotebookSummary[]): Promise<string[]> {
    const out: string[] = [];
    for (const nb of list) {
      if (nb.dir === VRAC || nb.pageCount > 0) continue;
      if (!(await this.isNotebook(nb.dir)) || await this.hasPages(nb.dir)) continue;
      out.push(nb.dir);
    }
    return out;
  }

  /**
   * Rend un dossier aux « Autres dossiers » : son cahier.json part a la
   * corbeille (jamais efface), le reste du dossier n'est pas touche.
   */
  async unmarkNotebook(dir: string): Promise<TrashEntry> {
    if (dir === VRAC) throw new Error("Vrac reste toujours là");
    const bin = await this.newBin();
    await this.fs.mkdir(joinPath(bin, dir));
    this.metaChain.delete(dir);
    await this.fs.rename(joinPath(dir, META_FILE), joinPath(bin, dir, META_FILE));
    return { bin, dir, divider: "", kind: "meta" };
  }

  /** Remet le cahier.json retire par unmarkNotebook, s'il n'a pas ete recree. */
  async restoreMeta(entry: TrashEntry): Promise<void> {
    const src = joinPath(entry.bin, entry.dir, META_FILE);
    if (!(await this.fs.exists(src))) throw new Error("introuvable dans la corbeille");
    if (!(await this.fs.exists(joinPath(entry.dir, META_FILE)))) {
      await this.fs.rename(src, joinPath(entry.dir, META_FILE));
    }
    this.noPages.delete(entry.dir);
    await this.dropBinIfEmpty(entry.bin);
  }

  /* ---------------- intercalaires ---------------- */

  /**
   * Ordre = celui de cahier.json, filtre par ce qui existe reellement,
   * puis les dossiers apparus dans l'explorateur Windows, a la fin. Rien
   * n'est ecrit : l'ordre fusionne n'est garde qu'a la prochaine action de
   * l'utilisateur (creation, deplacement d'un intercalaire).
   */
  async listDividers(dir: string): Promise<string[]> {
    const onDisk = await this.subfolders(dir);
    const meta = await this.readMeta(dir);
    const ordered = meta.dividers.filter((d) => onDisk.includes(d));
    for (const d of onDisk) if (!ordered.includes(d)) ordered.push(d);
    return ordered;
  }

  /** Sous-dossiers d'un intercalaire (rangement a plusieurs niveaux, D4). */
  async listSubfolders(dir: string, divider: string): Promise<string[]> {
    return this.subfolders(joinPath(dir, divider));
  }

  private async subfolders(rel: string): Promise<string[]> {
    return (await this.fs.listDirs(rel)).filter((d) => d !== ASSETS_DIR && !d.startsWith("."));
  }

  async createDivider(dir: string, name: string): Promise<string> {
    const d = safeName(name);
    // L'ordre affiche (cahier.json puis le disque) devient celui du fichier.
    const order = await this.listDividers(dir);
    await this.fs.mkdir(joinPath(dir, d));
    await this.updateMeta(dir, (m) => { m.dividers = order.includes(d) ? order : [...order, d]; });
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
    this.forget(joinPath(dir, from));
    if (key === from.toLowerCase()) {
      const step = `${from}.renommage`;
      await this.fs.rename(joinPath(dir, from), joinPath(dir, step));
      await this.fs.rename(joinPath(dir, step), joinPath(dir, next));
    } else {
      await this.fs.rename(joinPath(dir, from), joinPath(dir, next));
    }
    await this.updateMeta(dir, (meta) => {
      meta.dividers = meta.dividers.map((d) => (d === from ? next : d));
      if (meta.lastPosition?.divider === from) meta.lastPosition.divider = next;
      if (meta.viewMode && from in meta.viewMode) {
        meta.viewMode[next] = meta.viewMode[from];
        delete meta.viewMode[from];
      }
    });
    return next;
  }

  async reorderDividers(dir: string, order: string[]): Promise<void> {
    await this.updateMeta(dir, (meta) => { meta.dividers = [...order]; });
  }

  /** Met l'intercalaire et toutes ses pages a la corbeille. */
  async deleteDivider(dir: string, name: string): Promise<TrashEntry> {
    const index = (await this.listDividers(dir)).indexOf(name);
    const bin = await this.newBin();
    await this.fs.mkdir(joinPath(bin, dir));
    this.forget(joinPath(dir, name));
    await this.fs.rename(joinPath(dir, name), joinPath(bin, dir, name));
    await this.updateMeta(dir, (meta) => { meta.dividers = meta.dividers.filter((d) => d !== name); });
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
    this.forget(joinPath(entry.dir, name));
    await this.fs.rename(src, joinPath(entry.dir, name));
    const order = (await this.listDividers(entry.dir)).filter((d) => d !== name);
    await this.updateMeta(entry.dir, (meta) => {
      meta.dividers = order;
      meta.dividers.splice(Math.min(entry.index ?? order.length, order.length), 0, name);
    });
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
    // Garde-fou : une page d'une version plus recente n'est jamais reecrite
    // par celle-ci (elle perdrait ce qu'elle ne connait pas).
    if (isFutureVersion(page)) throw new Error("page créée par une version plus récente de Cahiers, laissée intacte");
    page.modified = nowIso();
    const path = joinPath(dir, divider, pageFileName(n));
    this.forget(path);
    try {
      await this.fs.writeText(path, serializePage(page));
    } finally {
      // Une lecture partie pendant l'ecriture a pu remettre l'ancienne version.
      this.forget(path);
    }
  }

  /* ---------------- copies de conflit OneDrive ---------------- */

  /**
   * Copies de conflit d'un intercalaire, par numero de page. Elles ne sont
   * jamais listees comme pages (parsePageNumber est strict) : ici seulement.
   */
  async listConflicts(dir: string, divider: string): Promise<ConflictCopy[]> {
    let files: string[];
    try { files = await this.fs.listFiles(joinPath(dir, divider)); } catch { return []; }
    const pages = new Set(files.map(parsePageNumber).filter((n): n is number => n !== null));
    const out: ConflictCopy[] = [];
    for (const file of files) {
      const c = parseConflictName(file);
      if (c) out.push({ file, page: c.page, label: c.label, orphan: !pages.has(c.page) });
    }
    return out.sort((a, b) => a.page - b.page || a.file.localeCompare(b.file));
  }

  /** Nombre de copies de conflit par intercalaire (pastilles). */
  async countConflicts(dir: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const d of await this.listDividers(dir)) {
      const n = (await this.listConflicts(dir, d)).length;
      if (n) out.set(d, n);
    }
    return out;
  }

  /** Lit une copie de conflit, comme une page. */
  async readConflict(dir: string, divider: string, file: string): Promise<Page> {
    if (!parseConflictName(file)) throw new Error(`${file} n'est pas une copie de conflit`);
    return migratePage(JSON.parse(await this.fs.readText(joinPath(dir, divider, file))) as Page);
  }

  /** Met une copie de conflit a la corbeille, a la demande seulement. */
  async trashConflict(dir: string, divider: string, file: string): Promise<TrashEntry> {
    const c = parseConflictName(file);
    if (!c) throw new Error(`${file} n'est pas une copie de conflit`);
    const bin = await this.newBin();
    await this.fs.mkdir(joinPath(bin, dir, divider));
    await this.fs.rename(joinPath(dir, divider, file), joinPath(bin, dir, divider, file));
    return { bin, dir, divider, page: c.page, conflict: file };
  }

  /** Remet une copie de conflit (« Annuler »), sans ecraser un fichier recree. */
  async restoreConflict(entry: TrashEntry): Promise<void> {
    if (!entry.conflict) throw new Error("ce n'est pas une copie de conflit");
    const src = joinPath(entry.bin, entry.dir, entry.divider, entry.conflict);
    if (!(await this.fs.exists(src))) throw new Error("introuvable dans la corbeille");
    const dst = joinPath(entry.dir, entry.divider, entry.conflict);
    if (await this.fs.exists(dst)) throw new Error(`${entry.conflict} existe de nouveau`);
    await this.fs.mkdir(joinPath(entry.dir, entry.divider));
    await this.fs.rename(src, dst);
    await this.dropBinIfEmpty(entry.bin);
  }

  /**
   * Copie seule (sa page a disparu, renommee ou supprimee sur l'autre PC) :
   * elle devient une vraie page, en fin d'intercalaire. Rend son numero.
   */
  async adoptConflict(dir: string, divider: string, file: string): Promise<number> {
    if (!parseConflictName(file)) throw new Error(`${file} n'est pas une copie de conflit`);
    const nums = await this.listPageNumbers(dir, divider);
    const conflicts = await this.listConflicts(dir, divider);
    // Un numero sans page ni autre copie : la copie ne s'accroche a personne.
    let target = (nums.length ? nums[nums.length - 1] : 0) + 1;
    while (conflicts.some((c) => c.page === target && c.file !== file)) target++;
    this.forget(joinPath(dir, divider));
    await this.fs.rename(joinPath(dir, divider, file), joinPath(dir, divider, pageFileName(target)));
    return target;
  }

  /**
   * Renumerote une page ET ses copies de conflit : sans cela, apres une
   * insertion, « 0003.page-PC.json » se retrouvait accroche a la mauvaise page.
   */
  private async movePage(rel: string, from: number, to: number, files: string[]): Promise<void> {
    if (files.includes(pageFileName(from))) {
      await this.fs.rename(joinPath(rel, pageFileName(from)), joinPath(rel, pageFileName(to)));
    }
    for (const f of files) {
      if (parseConflictName(f)?.page !== from) continue;
      await this.fs.rename(joinPath(rel, f), joinPath(rel, renumberConflictName(f, to)));
    }
  }

  /**
   * Numeros a decaler lors d'une renumerotation : les pages, et aussi les
   * copies seules, qui gardent ainsi leur place relative.
   */
  private numbersIn(files: string[]): number[] {
    const set = new Set<number>();
    for (const f of files) {
      const n = parsePageNumber(f) ?? parseConflictName(f)?.page ?? null;
      if (n !== null) set.add(n);
    }
    return [...set].sort((a, b) => a - b);
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
    this.forget(joinPath(dir, divider));
    const rel = joinPath(dir, divider);
    const files = await this.fs.listFiles(rel);
    const all = this.numbersIn(files);
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i] >= target) await this.movePage(rel, all[i], all[i] + 1, files);
    }
    await this.writePage(dir, divider, target, emptyPage(uuid(), nowIso()));
    return target;
  }

  /** Met la page a la corbeille et referme le trou de numerotation. */
  async deletePage(dir: string, divider: string, n: number): Promise<TrashEntry> {
    const bin = await this.newBin();
    this.forget(joinPath(dir, divider));
    const rel = joinPath(dir, divider);
    await this.fs.mkdir(joinPath(bin, dir, divider));
    await this.fs.rename(joinPath(rel, pageFileName(n)), joinPath(bin, dir, divider, pageFileName(n)));
    // Ses copies de conflit partent avec elle : restees la, elles
    // s'accrochaient a la page suivante une fois renumerotee.
    const copies = (await this.listConflicts(dir, divider)).filter((c) => c.page === n).map((c) => c.file);
    for (const f of copies) await this.fs.rename(joinPath(rel, f), joinPath(bin, dir, divider, f));
    const files = await this.fs.listFiles(rel);
    for (const num of this.numbersIn(files)) {
      if (num > n) await this.movePage(rel, num, num - 1, files);
    }
    return { bin, dir, divider, page: n, ...(copies.length ? { copies } : {}) };
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
    this.forget(joinPath(entry.dir, entry.divider));
    const nums = await this.listPageNumbers(entry.dir, entry.divider);
    const last = nums.length ? nums[nums.length - 1] : 0;
    const target = Math.max(1, Math.min(entry.page, last + 1));
    const rel = joinPath(entry.dir, entry.divider);
    const files = await this.fs.listFiles(rel);
    const all = this.numbersIn(files);
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i] >= target) await this.movePage(rel, all[i], all[i] + 1, files);
    }
    await this.fs.rename(src, joinPath(rel, pageFileName(target)));
    for (const f of entry.copies ?? []) {
      const from = joinPath(entry.bin, entry.dir, entry.divider, f);
      const to = joinPath(rel, renumberConflictName(f, target));
      if (await this.fs.exists(from) && !(await this.fs.exists(to))) await this.fs.rename(from, to);
    }
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

  /** Montre le dossier d'un intercalaire dans l'explorateur Windows. */
  async revealDir(dir: string, divider: string): Promise<void> {
    await this.fs.reveal?.(joinPath(dir, divider));
  }

  /** Chemin d'une page, tel qu'on le montre a l'utilisateur. */
  pagePath(dir: string, divider: string, n: number): string {
    return joinPath(dir, divider, pageFileName(n));
  }

  /* ---------------- mode et compteurs ---------------- */

  // La derniere position n'est plus ici : elle vit sur chaque machine
  // (core/position.ts, D8), jamais dans le dossier synchronise.

  async setViewMode(dir: string, divider: string, mode: "pages" | "scroll"): Promise<void> {
    await this.updateMeta(dir, (meta) => { meta.viewMode = { ...(meta.viewMode ?? {}), [divider]: mode }; });
  }

  /**
   * Pages d'un intercalaire avec leur resume (texte cherchable, reperes,
   * date). Un seul listing avec dates et tailles ; une page n'est relue que
   * si son fichier a change depuis la derniere lecture. null si `isStale`
   * dit d'arreter (une frappe plus recente dans la recherche).
   */
  async scanDivider(dir: string, divider: string, isStale?: () => boolean): Promise<ScannedPage[] | null> {
    const rel = joinPath(dir, divider);
    const files: { n: number; stamp: string | null }[] = [];
    let stats: FileStat[] | null = null;
    // Sans dates (commande absente ou en echec), tout est relu, comme avant :
    // le menu ne doit jamais tomber pour un cache.
    try { stats = (await this.fs.listFilesStat?.(rel)) ?? null; } catch { stats = null; }
    if (stats) {
      for (const f of stats) {
        const n = parsePageNumber(f.name);
        if (n !== null) files.push({ n, stamp: `${f.mtime}:${f.size}` });
      }
    } else {
      for (const name of await this.fs.listFiles(rel)) {
        const n = parsePageNumber(name);
        if (n !== null) files.push({ n, stamp: null });
      }
    }
    files.sort((a, b) => a.n - b.n);
    const out: ScannedPage[] = [];
    for (const { n, stamp } of files) {
      const path = joinPath(rel, pageFileName(n));
      const known = stamp ? this.cache.get(path) : undefined;
      if (known && known.stamp === stamp) { out.push({ n, index: known.index }); continue; }
      if (isStale?.()) return null;
      try {
        // Lu APRES le listing : au pire plus recent que la date gardee, et
        // alors la prochaine fois la date differe et la page est relue.
        const index = indexPage(await this.readPage(dir, divider, n));
        if (stamp) this.cache.set(path, { stamp, index });
        out.push({ n, index });
      } catch {
        // Page illisible : comptee, jamais resumee.
        this.cache.delete(path);
        out.push({ n, index: null });
      }
    }
    return out;
  }

  async summary(dir: string): Promise<NotebookSummary> {
    const meta = await this.readMeta(dir);
    const dividers = await this.listDividers(dir);
    let pageCount = 0;
    let modified = "";
    const flags: FlagHit[] = [];
    for (const d of dividers) {
      const pages = (await this.scanDivider(dir, d)) ?? [];
      pageCount += pages.length;
      for (const { n, index } of pages) {
        if (!index) continue; // page illisible : on l'ignore pour les compteurs
        if (index.modified > modified) modified = index.modified;
        for (const f of index.flags) {
          flags.push({ notebook: dir, notebookTitle: meta.title, divider: d, page: n, ...f });
        }
      }
    }
    return { dir, meta, pageCount, flagCount: flags.length, flags, modified };
  }

  /**
   * Toutes les matieres, triees par derniere modification (section 5). Vrac
   * est « hors matieres » : toujours en dernier, il ne change pas de place.
   */
  async listNotebooks(): Promise<NotebookSummary[]> {
    return (await this.listRoot()).notebooks;
  }

  /** Les matieres (triees) et les autres dossiers de la racine. */
  async listRoot(): Promise<RootListing> {
    const { notebooks: dirs, others } = await this.classifyRoot();
    const out: NotebookSummary[] = [];
    for (const d of dirs) out.push(await this.summary(d));
    out.sort((a, b) => Number(a.dir === VRAC) - Number(b.dir === VRAC)
      || (b.modified || "").localeCompare(a.modified || ""));
    return { notebooks: out, others };
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
 * Texte d'une page sur le disque. Le JSON reste lisible a la main (un
 * champ par ligne), mais les points d'un trait tiennent sur une seule
 * ligne compacte : indentes, chaque point prenait 6 lignes et une page de
 * cours pesait 189 octets par point, reecrits et renvoyes a OneDrive a
 * chaque pause. Un trait par ligne garde aussi les differences lisibles.
 */
export function serializePage(page: Page): string {
  const compact: string[] = [];
  const text = JSON.stringify(page, (key, value) => {
    if (key === "points" && Array.isArray(value)) {
      compact.push(JSON.stringify(value));
      return `\u0000pts${compact.length - 1}\u0000`;
    }
    return value;
  }, 1);
  return text.replace(/"\\u0000pts(\d+)\\u0000"/g, (_, i: string) => compact[Number(i)]);
}

/**
 * Point d'entree unique des migrations de schema. Aujourd'hui la v1 est la
 * seule version ; la fonction existe pour que la v2 ait un endroit ou aller.
 */
export function migratePage(p: Page): Page {
  // Version plus recente : rendue telle quelle, elle s'ouvre en lecture seule.
  if (!Array.isArray(p.blocks)) p.blocks = [];
  for (const b of p.blocks) {
    if (b.type === "math" && !Array.isArray(b.strokes)) b.strokes = [];
    if (b.type === "ink" && !Array.isArray(b.strokes)) b.strokes = [];
  }
  return p;
}
