import type { FileStamp, FileStat, FsAdapter } from "./fs";
import { joinPath, sameStamp } from "./fs";
import {
  META_VERSION, SCHEMA_VERSION, emptyPage, isFutureVersion, pageFileName, parsePageNumber,
  type NotebookMeta, type Page, type PaperKind, type Stroke,
} from "../types";
import { uuid, nowIso } from "../id";
import { decodeStroke, encodeStroke, isMemoryStroke } from "../ink/stroke";
import { joinWords } from "../ink/words";
import { indexPage, type FlagHit, type PageIndex } from "./search";
import { parseConflictName, renumberConflictName } from "../sync";
import {
  conflictCopyName, diskBaseOf, hashText, mergeText, mergedPage, planExternal, type DiskBase,
} from "../writeguard";
import {
  VERSIONS_DIR, parseVersionName, planVersionPurge, shouldSnapshot, trashToPurge, versionFileName,
} from "../versions";
import {
  MAX_DEPTH, buildTree, childPath, depthOf, findNode, flattenTree, leafName, moveRefusal, parentPath,
  remapKeys, renamePrefix, subtreeHeight, type DividerNode, type RawDir,
} from "../dividers";

export const VRAC = "Vrac";
export const META_FILE = "cahier.json";
/** Copie de secours de cahier.json, refaite avant chaque mise a jour (R5). */
export const META_BAK = "cahier.json.bak";
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

/**
 * Resultat de l'ecriture d'une page (R1, R2). `n` : numero reellement
 * ecrit (different du numero demande si la page avait change de numero sur
 * le disque : la vue doit se relire).
 *  - written  : ecrite, rien d'autre a faire ;
 *  - merged   : le disque avait change (encre seulement) : son encre a ete
 *               ajoutee a la notre ; la vue reprend les traits de `disk` ;
 *  - replaced : nous n'avions change que l'encre, le disque autre chose :
 *               `page` (celle du disque + notre encre) est ecrite, la vue
 *               la recharge ;
 *  - conflict : les deux ont change : notre version est dans la copie
 *               `copy`, rien n'est ecrase ; `page` = celle du disque
 *               (null : la page a disparu ou est illisible), la vue recharge.
 */
export type WriteOutcome =
  | { kind: "written"; n: number }
  | { kind: "merged"; n: number; disk: Page; added: number }
  | { kind: "replaced"; n: number; page: Page; textMerged?: boolean }
  | { kind: "conflict"; n: number; copy: string; page: Page | null };

/** Version gardee d'une page (`.versions/<id>/<horodatage>.json`). */
export interface PageVersion {
  file: string;
  /** Date de la version (ms). */
  at: number;
}

/** Ce que Repo sait du fichier d'une page lue ou ecrite. */
interface Base extends DiskBase {
  stat: FileStat | null;
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
  /**
   * Version du disque de chaque page en memoire (R1) : date, taille et
   * empreinte du fichier a la lecture ou a la derniere ecriture. Attachee a
   * l'objet Page lui-meme : une page lue pour la recherche n'a aucune
   * influence sur celle que la vue ecrit.
   */
  private bases = new WeakMap<Page, Base>();
  /** Dernier instantane de chaque page (matiere + id), en ms. */
  private lastSnap = new Map<string, number>();
  private trashChecked = false;

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
   * Au moins une page dans le dossier ou ses intercalaires, jusqu'a
   * MAX_DEPTH niveaux (E3A/S1/Chapitre 1). S'arrete a la premiere trouvee,
   * et apres PROBE_BUDGET dossiers.
   */
  async hasPages(rel: string, depth = MAX_DEPTH + 1, budget = { left: PROBE_BUDGET }): Promise<boolean> {
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
    for (const name of [META_FILE, META_BAK]) {
      const path = joinPath(dir, name);
      if (!(await this.fs.exists(path))) continue;
      try {
        return this.normalizeMeta(dir, parseMetaText(await this.fs.readText(path)));
      } catch {
        // Fichier illisible : on ne perd pas le cahier pour autant (la copie
        // de secours d'abord, sinon les valeurs par defaut), le disque reste
        // la source de verite.
      }
    }
    return this.normalizeMeta(dir, null);
  }

  /**
   * cahier.json pour une mise a jour : un fichier present mais illisible
   * (JSON tronque, OneDrive pas fini) n'est jamais remplace par des valeurs
   * par defaut (R5) : l'ordre des intercalaires, les modes et les fonds
   * seraient perdus. Rend aussi le texte lu, pour la copie de secours.
   */
  private async readMetaForUpdate(dir: string): Promise<{ meta: NotebookMeta; raw: string | null }> {
    const path = joinPath(dir, META_FILE);
    if (!(await this.fs.exists(path))) return { meta: this.normalizeMeta(dir, null), raw: null };
    let raw: string;
    let parsed: NotebookMeta;
    try {
      raw = await this.fs.readText(path);
      parsed = parseMetaText(raw);
    } catch (e) {
      throw new Error(`cahier.json de « ${dir} » est illisible (${e instanceof Error ? e.message : String(e)}) : `
        + "rien n'a été modifié. Vérifie que OneDrive a fini de le télécharger ; "
        + `une copie de secours est dans ${META_BAK} si elle existe.`);
    }
    return { meta: this.normalizeMeta(dir, parsed), raw };
  }

  /**
   * Champs connus remis en forme ; les autres sont gardes tels quels (une
   * version plus recente sur l'autre PC a pu en ajouter).
   */
  private normalizeMeta(dir: string, m: NotebookMeta | null): NotebookMeta {
    const known = m && typeof m === "object" && !Array.isArray(m) ? m : null;
    return {
      ...(known ?? {}),
      version: META_VERSION,
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
      const { meta, raw } = await this.readMetaForUpdate(dir);
      change(meta);
      // Copie de secours de la version lue (lisible), avant de la remplacer.
      if (raw != null) await this.fs.writeText(joinPath(dir, META_BAK), raw).catch(() => undefined);
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
      version: META_VERSION, title: title.trim() || dir, color, dividers: [], viewMode: {},
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
   * Les intercalaires en arbre (D4, palier 2) : un intercalaire peut etre
   * un groupe (E3A, S1) qui en contient d'autres, jusqu'a MAX_DEPTH
   * niveaux sous la matiere. Ordre = celui de cahier.json (chemins
   * relatifs), filtre par ce qui existe reellement, puis les dossiers
   * apparus dans l'explorateur Windows. Rien n'est ecrit : l'ordre
   * fusionne n'est garde qu'a la prochaine action de l'utilisateur.
   */
  async listDividerTree(dir: string): Promise<DividerNode[]> {
    const meta = await this.readMeta(dir);
    return buildTree(await this.readLevel(dir, 1), meta.dividers);
  }

  /**
   * Tous les intercalaires, chemins relatifs (« E3A/S1/Chapitre 1 »), un
   * groupe avant son contenu. Un cahier a 2 niveaux rend exactement les
   * memes noms qu'avant.
   */
  async listDividers(dir: string): Promise<string[]> {
    return flattenTree(await this.listDividerTree(dir));
  }

  /**
   * Un niveau de dossiers d'intercalaires, et ce qu'il y a dessous. Un
   * dossier qui contient un depot git (projet de code) n'est pas lu. Les
   * pages ne sont cherchees que dans les groupes : une feuille est toujours
   * un intercalaire.
   */
  private async readLevel(rel: string, depth: number): Promise<RawDir[]> {
    const out: RawDir[] = [];
    for (const name of await this.subfolders(rel)) {
      const path = joinPath(rel, name);
      if (depth >= MAX_DEPTH) { out.push({ name }); continue; }
      let inner: string[];
      try { inner = await this.fs.listDirs(path); } catch { inner = []; }
      if (inner.includes(".git")) continue;
      const children = inner.some((d) => d !== ASSETS_DIR && !d.startsWith("."))
        ? await this.readLevel(path, depth + 1) : [];
      const pages = children.length
        ? (await this.fs.listFiles(path).catch(() => [] as string[])).some((f) => parsePageNumber(f) !== null)
        : true;
      out.push({ name, children, pages });
    }
    return out;
  }

  /** Sous-dossiers d'un intercalaire (rangement a plusieurs niveaux, D4). */
  async listSubfolders(dir: string, divider: string): Promise<string[]> {
    return this.subfolders(joinPath(dir, divider));
  }

  private async subfolders(rel: string): Promise<string[]> {
    return (await this.fs.listDirs(rel)).filter((d) => d !== ASSETS_DIR && !d.startsWith("."));
  }

  /**
   * Nouvel intercalaire, au premier niveau ou dans le groupe `parent`
   * (« E3A/S1 »). Rend son chemin. Un nom deja pris (a la casse pres)
   * rend l'intercalaire existant.
   */
  async createDivider(dir: string, name: string, parent = ""): Promise<string> {
    if (parent && depthOf(parent) >= MAX_DEPTH) throw new Error(`au plus ${MAX_DEPTH} niveaux sous la matière`);
    const wanted = safeName(name);
    if (wanted.toLowerCase() === ASSETS_DIR || wanted.startsWith(".")) throw new Error("ce nom est réservé");
    const same = (await this.fs.listDirs(joinPath(dir, parent)).catch(() => [] as string[]))
      .find((x) => x.toLowerCase() === wanted.toLowerCase());
    const d = childPath(parent, same ?? wanted);
    // L'ordre affiche (cahier.json puis le disque) devient celui du fichier.
    const order = await this.listDividers(dir);
    await this.fs.mkdir(joinPath(dir, d));
    await this.updateMeta(dir, (m) => { m.dividers = order.includes(d) ? order : [...order, d]; });
    return d;
  }

  /**
   * Renomme le dossier reel (le dernier niveau du chemin). Rend le chemin
   * applique : `from` quand le nom est deja pris. Windows ne distingue pas
   * la casse : « cours » est pris si « Cours » existe, et un changement de
   * casse seul passe par un nom intermediaire. Un groupe renomme emmene
   * son contenu : ordre, modes et fonds suivent.
   */
  async renameDivider(dir: string, from: string, to: string): Promise<string> {
    const parent = parentPath(from);
    const old = leafName(from);
    const nextName = safeName(to);
    if (nextName === old) return from;
    const key = nextName.toLowerCase();
    const taken = (await this.fs.listDirs(joinPath(dir, parent))).filter((d) => d !== old);
    if (key === ASSETS_DIR || nextName.startsWith(".") || taken.some((d) => d.toLowerCase() === key)) {
      return from;
    }
    const next = childPath(parent, nextName);
    this.forget(joinPath(dir, from));
    if (key === old.toLowerCase()) {
      const step = childPath(parent, `${old}.renommage`);
      await this.fs.rename(joinPath(dir, from), joinPath(dir, step));
      await this.fs.rename(joinPath(dir, step), joinPath(dir, next));
    } else {
      await this.fs.rename(joinPath(dir, from), joinPath(dir, next));
    }
    await this.updateMeta(dir, (meta) => remapMeta(meta, from, next));
    return next;
  }

  /**
   * Range l'intercalaire (ou le groupe, avec son contenu) dans le groupe
   * `toParent`, ou au premier niveau avec "". Deplace le dossier reel.
   * Rend le nouveau chemin ; refuse (erreur) un nom deja pris a l'arrivee,
   * un dossier dans lui-meme, ou plus de MAX_DEPTH niveaux.
   */
  async moveDivider(dir: string, from: string, toParent: string): Promise<string> {
    const node = findNode(await this.listDividerTree(dir), from);
    if (!node) throw new Error(`${from} est introuvable`);
    if (toParent && !(await this.fs.exists(joinPath(dir, toParent)))) throw new Error(`${toParent} est introuvable`);
    const refused = moveRefusal(from, toParent, subtreeHeight(node));
    if (refused) throw new Error(refused);
    const name = leafName(from);
    const there = await this.fs.listDirs(joinPath(dir, toParent));
    if (there.some((d) => d.toLowerCase() === name.toLowerCase())) {
      throw new Error(`un intercalaire « ${name} » existe déjà à cet endroit`);
    }
    const next = childPath(toParent, name);
    this.forget(joinPath(dir, from));
    await this.fs.rename(joinPath(dir, from), joinPath(dir, next));
    await this.updateMeta(dir, (meta) => {
      remapMeta(meta, from, next);
      // Arrive en dernier dans son nouveau groupe.
      meta.dividers = meta.dividers.filter((d) => d !== next);
      meta.dividers.push(next);
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
    // Un intercalaire imbrique garde son chemin dans la corbeille.
    await this.fs.mkdir(joinPath(bin, dir, parentPath(name)));
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
    // Son groupe d'origine (recree s'il a disparu entre temps).
    const parent = parentPath(entry.divider);
    const leaf = leafName(entry.divider);
    await this.fs.mkdir(joinPath(entry.dir, parent));
    const taken = (await this.fs.listDirs(joinPath(entry.dir, parent))).map((d) => d.toLowerCase());
    let short = leaf;
    for (let i = 1; taken.includes(short.toLowerCase()); i++) {
      short = `${leaf} (restauré${i > 1 ? ` ${i}` : ""})`;
    }
    const name = childPath(parent, short);
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

  /**
   * Lit une page et retient la version du disque (date, taille, empreinte)
   * pour l'ecriture conditionnelle (R1). `track` faux : lecture pour la
   * recherche, rien n'est retenu.
   */
  async readPage(dir: string, divider: string, n: number, track = true): Promise<Page> {
    const path = joinPath(dir, divider, pageFileName(n));
    if (!track || !this.fs.readTextStat) return migratePage(JSON.parse(await this.fs.readText(path)) as Page);
    const { content, stat } = await this.fs.readTextStat(path);
    const page = migratePage(JSON.parse(content) as Page);
    this.bases.set(page, { stat, ...diskBaseOf(page, hashText(content)) });
    return page;
  }

  /**
   * `to` remplace `from` (copie de travail, version restauree) : il est
   * ecrit comme la suite de la meme lecture du disque.
   */
  shareBase(from: Page, to: Page): void {
    const b = this.bases.get(from);
    if (b) this.bases.set(to, { ...b });
  }

  /**
   * Le fichier de la page a-t-il change sur le disque depuis sa lecture (ou
   * sa derniere ecriture) ici ? Faux si on n'en sait rien. Un fichier
   * seulement touche (meme contenu) n'est pas un changement.
   */
  async diskChanged(dir: string, divider: string, n: number, page: Page): Promise<boolean> {
    const base = this.bases.get(page);
    if (!base?.stat || !this.fs.stat || !this.fs.readTextStat) return false;
    const path = joinPath(dir, divider, pageFileName(n));
    const cur = await this.fs.stat(path);
    if (sameStamp(cur, base.stat)) return false;
    if (!cur) return true;
    const { content, stat } = await this.fs.readTextStat(path);
    if (hashText(content) !== base.hash) return true;
    base.stat = stat;
    return false;
  }

  /**
   * Ecrit une page sans jamais ecraser autre chose qu'elle-meme (R1, R2) :
   *  - le fichier vise doit etre celui lu (date + taille), sinon il est relu :
   *    meme contenu = simple touche, on ecrit ; autre page (autre id) = la
   *    page est cherchee par son id ; meme page changee ailleurs = fusion de
   *    l'encre si rien d'autre n'a change d'un cote, sinon copie de conflit ;
   *  - avant d'ecraser, la version du disque est gardee dans `.versions`
   *    (au plus une toutes les 10 minutes par page).
   * Voir WriteOutcome. Sans ecriture conditionnelle (adaptateur minimal),
   * ecrit comme avant.
   */
  async writePage(dir: string, divider: string, n: number, page: Page): Promise<WriteOutcome> {
    // Garde-fou : une page d'une version plus recente n'est jamais reecrite
    // par celle-ci (elle perdrait ce qu'elle ne connait pas).
    if (isFutureVersion(page)) throw new Error("page créée par une version plus récente de Cahiers, laissée intacte");
    page.modified = nowIso();
    const path = joinPath(dir, divider, pageFileName(n));
    this.forget(path);
    try {
      if (!this.fs.writeTextIf || !this.fs.readTextStat || !this.fs.stat) {
        await this.snapshotBefore(dir, page.id, path, true);
        await this.fs.writeText(path, serializePage(page));
        return { kind: "written", n };
      }
      return await this.guardedWrite(dir, divider, n, page, 0);
    } finally {
      // Une lecture partie pendant l'ecriture a pu remettre l'ancienne version.
      this.forget(path);
    }
  }

  private async guardedWrite(dir: string, divider: string, n: number, page: Page, depth: number): Promise<WriteOutcome> {
    const fs = this.fs as Required<Pick<FsAdapter, "writeTextIf" | "readTextStat" | "stat">> & FsAdapter;
    const path = joinPath(dir, divider, pageFileName(n));
    const base = this.bases.get(page) ?? null;
    // Date et taille attendues ; undefined : page jamais lue ici, a regarder.
    let expect: FileStamp | null | undefined = base?.stat ?? undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (expect === undefined) {
        const cur = await fs.stat(path);
        if (cur) {
          const seen = await this.inspect(dir, divider, n, page, base, depth);
          if (seen.outcome) return seen.outcome;
          expect = seen.stat;
        } else {
          expect = null;
        }
      }
      const content = serializePage(page);
      if (expect) await this.snapshotBefore(dir, page.id, path, false);
      const res = await fs.writeTextIf(path, content, expect);
      if (res.ok) {
        this.bases.set(page, { stat: res.stat, ...diskBaseOf(page, hashText(content)) });
        return { kind: "written", n };
      }
      if (!res.stat) {
        // Le fichier n'est plus la (renumerote ou supprime ailleurs).
        if (!base) { expect = null; continue; }
        return this.relocate(dir, divider, n, page, depth);
      }
      const seen = await this.inspect(dir, divider, n, page, base, depth);
      if (seen.outcome) return seen.outcome;
      expect = seen.stat;
    }
    throw new Error(`${path} change sans arrêt sur le disque : écriture reportée`);
  }

  /**
   * Le fichier de la page n'est pas celui attendu : on le lit. Rend soit
   * une issue (fusion, copie de conflit, page retrouvee ailleurs), soit la
   * date a attendre pour reessayer (meme contenu, simplement touche).
   */
  private async inspect(
    dir: string, divider: string, n: number, page: Page, base: Base | null, depth: number,
  ): Promise<{ outcome?: WriteOutcome; stat: FileStamp | null }> {
    const fs = this.fs as Required<Pick<FsAdapter, "writeTextIf" | "readTextStat">> & FsAdapter;
    const path = joinPath(dir, divider, pageFileName(n));
    let raw: string, stat: FileStat | null;
    try {
      ({ content: raw, stat } = await fs.readTextStat(path));
    } catch {
      // Disparu entre-temps : on recommence (le fichier sera absent).
      return { stat: null };
    }
    if (!stat) return { stat: null };
    if (base && hashText(raw) === base.hash) return { stat };
    let disk: Page | null = null;
    try { disk = migratePage(JSON.parse(raw) as Page); } catch { disk = null; }
    if (disk && disk.id !== page.id) return { outcome: await this.relocate(dir, divider, n, page, depth), stat };
    if (!disk) {
      // Fichier illisible (telechargement OneDrive pas fini) : jamais ecrase.
      const copy = await this.writeConflictCopy(dir, divider, n, page);
      return { outcome: { kind: "conflict", n, copy, page: null }, stat };
    }
    if (isFutureVersion(disk)) {
      const copy = await this.writeConflictCopy(dir, divider, n, page);
      return { outcome: { kind: "conflict", n, copy, page: disk }, stat };
    }
    const diskBase: Base = { stat, ...diskBaseOf(disk, hashText(raw)) };
    const plan = planExternal(base, page, disk);
    // Les deux ont tape : texte fusionne ligne par ligne s'ils n'ont pas
    // touche aux memes lignes (mergeText), sinon copie de conflit.
    const textMerged = plan === "conflict" ? mergeText(base, page, disk) : null;
    if (textMerged) {
      textMerged.page.modified = nowIso();
      const content = serializePage(textMerged.page);
      await this.snapshotBefore(dir, page.id, path, false);
      const res = await fs.writeTextIf(path, content, stat);
      if (!res.ok) return { stat: res.stat };
      this.bases.set(textMerged.page, { stat: res.stat, ...diskBaseOf(textMerged.page, hashText(content)) });
      return { outcome: { kind: "replaced", n, page: textMerged.page, textMerged: true }, stat };
    }
    if (plan === "conflict") {
      const copy = await this.writeConflictCopy(dir, divider, n, page);
      this.bases.set(disk, diskBase);
      return { outcome: { kind: "conflict", n, copy, page: disk }, stat };
    }
    const merged = mergedPage(plan, page, disk);
    merged.page.modified = nowIso();
    const content = serializePage(merged.page);
    await this.snapshotBefore(dir, page.id, path, false);
    const res = await fs.writeTextIf(path, content, stat);
    // Change encore entre-temps : on recommence depuis le debut.
    if (!res.ok) return { stat: res.stat };
    const written: Base = { stat: res.stat, ...diskBaseOf(merged.page, hashText(content)) };
    if (plan === "ours") {
      // La vue reprend l'encre du disque : sa page vaut alors celle ecrite.
      this.bases.set(page, written);
      return { outcome: { kind: "merged", n, disk, added: merged.added }, stat };
    }
    this.bases.set(merged.page, written);
    return { outcome: { kind: "replaced", n, page: merged.page }, stat };
  }

  /**
   * Le fichier vise ne porte plus la page (R2) : elle est cherchee par son
   * id dans l'intercalaire et ecrite la ou elle est. Introuvable (supprimee
   * sur l'autre PC) : notre version part dans une copie de conflit.
   */
  private async relocate(dir: string, divider: string, n: number, page: Page, depth: number): Promise<WriteOutcome> {
    const found = depth < 2 ? await this.findPageNumber(dir, divider, page.id) : null;
    if (found != null && found !== n) return this.guardedWrite(dir, divider, found, page, depth + 1);
    const copy = await this.writeConflictCopy(dir, divider, n, page);
    return { kind: "conflict", n, copy, page: null };
  }

  /** Numero de la page d'id `id` dans l'intercalaire (lecture du disque), ou null. */
  async findPageNumber(dir: string, divider: string, id: string): Promise<number | null> {
    for (const num of await this.listPageNumbers(dir, divider)) {
      try {
        const raw = await this.fs.readText(joinPath(dir, divider, pageFileName(num)));
        if (raw.includes(id) && (JSON.parse(raw) as Page).id === id) return num;
      } catch { /* page illisible : la suivante */ }
    }
    return null;
  }

  /**
   * Notre version d'une page qu'on ne peut pas ecrire sans ecraser autre
   * chose : `NNNN.page-<PC>.json` a cote, jamais par-dessus un fichier.
   * Elle apparait comme toute copie de conflit (bandeau, fusion, corbeille).
   */
  async writeConflictCopy(dir: string, divider: string, n: number, page: Page): Promise<string> {
    const rel = joinPath(dir, divider);
    const content = serializePage(page);
    for (let i = 0; i < 20; i++) {
      const taken = await this.fs.listFiles(rel).catch(() => [] as string[]);
      const name = conflictCopyName(n, this.fs.machine, taken);
      const path = joinPath(rel, name);
      if (this.fs.writeTextIf) {
        const res = await this.fs.writeTextIf(path, content, null);
        if (res.ok) return name;
      } else if (!(await this.fs.exists(path))) {
        await this.fs.writeText(path, content);
        return name;
      }
    }
    throw new Error("copie de conflit impossible à écrire");
  }

  /* ---------------- historique des versions ---------------- */

  private versionsDir(dir: string, pageId: string): string {
    return joinPath(dir, VERSIONS_DIR, pageId.replace(/[^A-Za-z0-9_-]+/g, "_") || "page");
  }

  /** Versions gardees d'une page, la plus recente d'abord. */
  async listVersions(dir: string, pageId: string): Promise<PageVersion[]> {
    const rel = this.versionsDir(dir, pageId);
    if (!(await this.fs.exists(rel))) return [];
    const out: PageVersion[] = [];
    for (const file of await this.fs.listFiles(rel)) {
      const at = parseVersionName(file);
      if (at != null) out.push({ file, at });
    }
    return out.sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
  }

  async readVersion(dir: string, pageId: string, file: string): Promise<Page> {
    if (parseVersionName(file) == null) throw new Error(`${file} n'est pas une version`);
    return migratePage(JSON.parse(await this.fs.readText(joinPath(this.versionsDir(dir, pageId), file))) as Page);
  }

  /** Ecrit une version (texte d'une page) maintenant ; rend son nom. */
  private async saveVersion(dir: string, pageId: string, raw: string, now: number): Promise<string> {
    const rel = this.versionsDir(dir, pageId);
    await this.fs.mkdir(rel);
    let file = versionFileName(new Date(now));
    for (let i = 2; await this.fs.exists(joinPath(rel, file)); i++) {
      file = versionFileName(new Date(now)).replace(/\.json$/, `-${i}.json`);
    }
    await this.fs.writeText(joinPath(rel, file), raw);
    this.lastSnap.set(`${dir}\u0000${pageId}`, now);
    return file;
  }

  /**
   * Avant d'ecraser `path` : sa version actuelle part dans `.versions`, si
   * la derniere date de plus de 10 minutes. Jamais bloquant : un historique
   * en echec n'empeche pas d'enregistrer la page. Purge selon
   * planVersionPurge a la premiere fois de la seance pour cette page.
   */
  private async snapshotBefore(dir: string, pageId: string, path: string, mayBeAbsent: boolean): Promise<void> {
    try {
      const key = `${dir}\u0000${pageId}`;
      const now = Date.now();
      let last = this.lastSnap.get(key);
      if (last === undefined) {
        const list = await this.listVersions(dir, pageId);
        last = list.length ? list[0].at : -Infinity;
        this.lastSnap.set(key, last);
        const drop = new Set(planVersionPurge(list.map((v) => v.at), now));
        for (const v of list) {
          if (drop.has(v.at)) await this.fs.remove(joinPath(this.versionsDir(dir, pageId), v.file)).catch(() => undefined);
        }
      }
      if (!shouldSnapshot(Number.isFinite(last) ? last : null, now)) return;
      if (mayBeAbsent && !(await this.fs.exists(path))) return;
      const raw = await this.fs.readText(path);
      // Seulement si c'est bien cette page (R2) : jamais la version d'une autre.
      if (!raw.includes(pageId)) return;
      await this.saveVersion(dir, pageId, raw, now);
    } catch { /* historique facultatif */ }
  }

  /**
   * Restaure une version : la page actuelle (`current`, deja ecrite) passe
   * d'abord en version, puis le contenu de `file` est ecrit sous le meme id.
   * Rend la page ecrite et l'issue de l'ecriture.
   */
  async restoreVersion(
    dir: string, divider: string, n: number, current: Page, file: string,
  ): Promise<{ page: Page; outcome: WriteOutcome }> {
    const old = await this.readVersion(dir, current.id, file);
    await this.saveVersion(dir, current.id, serializePage(current), Date.now());
    const page: Page = { ...old, id: current.id };
    if (current.continues !== undefined && old.continues === undefined) delete page.continues;
    this.shareBase(current, page);
    const outcome = await this.writePage(dir, divider, n, page);
    return { page, outcome };
  }

  /* ---------------- corbeille ---------------- */

  /**
   * Vide de la corbeille les suppressions de plus de 30 jours, jamais
   * celles d'apres (ni un dossier qu'on ne sait pas dater). Rend leur nombre.
   */
  async purgeTrash(now = Date.now()): Promise<number> {
    if (!(await this.fs.exists(TRASH_DIR))) return 0;
    let done = 0;
    for (const bin of trashToPurge(await this.fs.listDirs(TRASH_DIR), now)) {
      try {
        await this.fs.remove(joinPath(TRASH_DIR, bin));
        done++;
      } catch { /* fichier tenu par OneDrive : au prochain lancement */ }
    }
    return done;
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
   * `page` : contenu de depart (pagination automatique : la suite d'une
   * page qui deborde), une page vide sinon.
   */
  async createPage(dir: string, divider: string, at?: number, page?: Page): Promise<number> {
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
    await this.writePage(dir, divider, target, page ?? emptyPage(uuid(), nowIso()));
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

  /**
   * Page d'id `pageId` dans la corbeille (lien vers une page supprimee) :
   * de quoi la restaurer, ou null. Lit les pages de la corbeille, du plus
   * recent au plus ancien ; seulement a la demande (un clic sur un lien).
   */
  async findTrashedPage(pageId: string): Promise<TrashEntry | null> {
    if (!pageId || !(await this.fs.exists(TRASH_DIR))) return null;
    const bins = (await this.fs.listDirs(TRASH_DIR)).sort().reverse();
    const walk = async (bin: string, rel: string, depth: number): Promise<TrashEntry | null> => {
      const segs = rel.split("/");
      if (segs.length >= 2) {
        for (const name of await this.fs.listFiles(joinPath(bin, rel))) {
          const n = parsePageNumber(name);
          if (n === null) continue;
          try {
            const raw = await this.fs.readText(joinPath(bin, rel, name));
            if (!raw.includes(pageId) || (JSON.parse(raw) as Page).id !== pageId) continue;
          } catch { continue; }
          return { bin, dir: segs[0], divider: segs.slice(1).join("/"), page: n };
        }
      }
      if (depth <= 0) return null;
      for (const d of await this.fs.listDirs(joinPath(bin, rel))) {
        if (d === ASSETS_DIR) continue;
        const hit = await walk(bin, rel ? joinPath(rel, d) : d, depth - 1);
        if (hit) return hit;
      }
      return null;
    };
    for (const b of bins) {
      const bin = joinPath(TRASH_DIR, b);
      try {
        const hit = await walk(bin, "", MAX_DEPTH + 1);
        if (hit) return hit;
      } catch { /* dossier de corbeille illisible : le suivant */ }
    }
    return null;
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
   * Fond de page d'un intercalaire (D12). « uni » retire l'entree : un
   * cahier.json sans fond reste tel qu'avant.
   */
  async setPaper(dir: string, divider: string, kind: PaperKind): Promise<void> {
    await this.updateMeta(dir, (meta) => {
      const map: Record<string, PaperKind> =
        meta.paper && typeof meta.paper === "object" && !Array.isArray(meta.paper) ? { ...meta.paper } : {};
      if (kind === "uni") delete map[divider];
      else map[divider] = kind;
      if (Object.keys(map).length) meta.paper = map;
      else delete meta.paper;
    });
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
        const index = indexPage(await this.readPage(dir, divider, n, false));
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

  /** Fichiers de assets/ de l'intercalaire (dedoublonnage des PDF importes). Vide s'il n'existe pas. */
  async listAssets(dir: string, divider: string): Promise<string[]> {
    const rel = joinPath(dir, divider, ASSETS_DIR);
    if (!(await this.fs.exists(rel))) return [];
    return this.fs.listFiles(rel).catch(() => []);
  }

  async ensureRootLayout(): Promise<void> {
    // Au lancement : la corbeille perd ce qui a plus de 30 jours (en fond).
    if (!this.trashChecked) {
      this.trashChecked = true;
      void this.purgeTrash().catch(() => 0);
    }
    if (!(await this.fs.exists(VRAC))) {
      await this.fs.mkdir(joinPath(VRAC, "Notes"));
      await this.writeMeta(VRAC, {
        version: META_VERSION, title: "Vrac", color: "#64748b",
        dividers: ["Notes"], viewMode: {},
      });
    }
  }
}

/**
 * cahier.json apres le renommage ou le deplacement de l'intercalaire `from`
 * en `to` : ordre, ancienne position, modes et fonds de page suivent, pour
 * lui et tout ce qu'il contient. Les autres champs ne sont pas touches.
 */
export function remapMeta(meta: NotebookMeta, from: string, to: string): NotebookMeta {
  meta.dividers = meta.dividers.map((d) => renamePrefix(d, from, to));
  if (meta.lastPosition && typeof meta.lastPosition.divider === "string") {
    meta.lastPosition.divider = renamePrefix(meta.lastPosition.divider, from, to);
  }
  if (meta.viewMode) meta.viewMode = remapKeys(meta.viewMode, from, to);
  if (meta.paper && typeof meta.paper === "object" && !Array.isArray(meta.paper)) {
    meta.paper = remapKeys(meta.paper, from, to);
  }
  return meta;
}

/** cahier.json lu : objet JSON (BOM d'un editeur Windows retire), sinon erreur. */
function parseMetaText(raw: string): NotebookMeta {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("contenu inattendu");
  return parsed as NotebookMeta;
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
 * Texte d'une page sur le disque (format v2, CLAUDE.md section 2). Le JSON
 * reste lisible a la main (un champ par ligne), mais chaque trait tient sur
 * une seule ligne, ses points en tableaux plats (`pts`, `p`, `t`, voir
 * encodeStroke) : en objets {x, y, p, t}, une page de cours pesait 60 a
 * 190 octets par point, reecrits et renvoyes a OneDrive a chaque pause.
 * Un trait par ligne garde aussi les differences lisibles. Le fichier porte
 * toujours SCHEMA_VERSION : une page v1 lue puis modifiee repart en v2.
 */
export function serializePage(page: Page): string {
  const compact: string[] = [];
  const text = JSON.stringify({ ...page, version: SCHEMA_VERSION }, (_key, value: unknown) => {
    if (isMemoryStroke(value)) {
      compact.push(JSON.stringify(diskStroke(value)));
      return `\u0000stroke${compact.length - 1}\u0000`;
    }
    return value;
  }, 1);
  return text.replace(/"\\u0000stroke(\d+)\\u0000"/g, (_, i: string) => compact[Number(i)]);
}

/**
 * Trait v2 tel qu'ecrit. `points: []` reste en tete, vide : la version 1
 * de l'application (l'autre PC pas encore mis a jour) lit alors la page en
 * lecture seule sans encre au lieu de planter sur des traits sans points.
 * Les vrais points sont dans `pts` ; decodeStroke ignore `points` des que
 * `pts` est la.
 */
function diskStroke(s: Stroke): Record<string, unknown> {
  const { id, ...rest } = encodeStroke(s);
  return { id, points: [], ...rest };
}

/**
 * Point d'entree unique des migrations de schema : toute page lue (page,
 * copie de conflit, fichier remis de la corbeille) passe ici.
 *  - v1 : points en objets {x, y, p, t}, gardes tels quels ;
 *  - v2 : points en tableaux plats, decodes en objets (decodeStroke).
 * Les deux formats peuvent cohabiter dans un meme fichier (trait par trait).
 * La page est ramenee a SCHEMA_VERSION en memoire mais rien n'est ecrit ici :
 * une page v1 ouverte sans etre modifiee reste v1 sur le disque, lisible par
 * l'autre PC tant qu'il n'est pas a jour. Une page plus recente garde sa
 * version (lecture seule) ; ses traits sont decodes s'ils sont en v2, pour
 * l'afficher.
 */
export function migratePage(p: Page): Page {
  if (!Array.isArray(p.blocks)) p.blocks = [];
  p.blocks = p.blocks.filter((b) => !!b && typeof b === "object");
  for (const b of p.blocks) {
    if ((b.type === "math" || b.type === "ink") && !Array.isArray(b.strokes)) b.strokes = [];
    if (b.type === "pdf" && !Array.isArray(b.annotations)) b.annotations = [];
    const holder = b as unknown as Record<string, unknown>;
    for (const key of ["strokes", "annotations"]) {
      const list = holder[key];
      if (Array.isArray(list)) holder[key] = list.map(decodeStroke);
    }
    // Mot lu dont plus aucun trait n'existe (resultat de lecture arrive apres
    // une gomme) : il restait affiche sans pouvoir etre gomme.
    if (b.type === "ink" && Array.isArray(b.words)) {
      const ids = new Set(b.strokes.map((s) => s.id));
      const kept = b.words.filter((w) => !w.strokeIds?.length || w.strokeIds.some((id) => ids.has(id)));
      if (kept.length !== b.words.length) {
        b.words = kept.some((w) => w.strokeIds?.length) ? kept : undefined;
        b.recognized = b.words ? joinWords(b.words) || null : null;
      }
    }
  }
  if (!isFutureVersion(p)) p.version = SCHEMA_VERSION;
  return p;
}
