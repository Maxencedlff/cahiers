import { DataUrlCache } from "../image/cache";

/**
 * Abstraction du disque. L'application LIT l'arborescence, elle ne la possede
 * pas (section 1) : aucun index cache ne fait autorite, tout part d'un listing.
 *
 * Deux implementations :
 *  - TauriFs   : commandes Rust (invoke). Utilisee dans l'app installee.
 *  - BrowserFs : localStorage. Utilisee pour `npm run dev` dans un navigateur,
 *                pour developper et verifier l'interface sans build natif.
 */
export interface FsAdapter {
  readonly kind: "tauri" | "browser";
  listDirs(rel: string): Promise<string[]>;
  listFiles(rel: string): Promise<string[]>;
  /**
   * Fichiers d'un dossier avec date et taille, en un seul appel. Sert a
   * savoir si une page a bouge depuis sa derniere lecture (OneDrive,
   * explorateur) sans la relire. Absent : tout est relu, comme avant.
   */
  listFilesStat?(rel: string): Promise<FileStat[]>;
  readText(rel: string): Promise<string>;
  writeText(rel: string, content: string): Promise<void>;
  /**
   * Ecriture conditionnelle (R1) : le fichier n'est remplace que s'il a
   * encore la date et la taille `expect` (celles de la derniere lecture),
   * ou n'existe pas si `expect` est null. Sinon rien n'est ecrit et l'etat
   * du disque est rendu. Absent : Repo ecrit comme avant, sans garde.
   */
  writeTextIf?(rel: string, content: string, expect: FileStamp | null): Promise<CondWrite>;
  /** Lecture avec la date et la taille prises AVANT la lecture. */
  readTextStat?(rel: string): Promise<{ content: string; stat: FileStat | null }>;
  /** Date et taille d'un fichier, null s'il n'existe pas. */
  stat?(rel: string): Promise<FileStat | null>;
  /** Nom de cette machine (copies de conflit `NNNN.page-<PC>.json`). */
  readonly machine?: string;
  exists(rel: string): Promise<boolean>;
  mkdir(rel: string): Promise<void>;
  remove(rel: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Racine reelle, affichee a l'utilisateur. */
  rootLabel(): Promise<string>;
  /** Montre un fichier dans l'explorateur Windows. Absent dans le navigateur. */
  reveal?(rel: string): Promise<void>;

  /**
   * Fichiers binaires (images, PDF), echanges en data URL.
   * Sur disque c'est un vrai PNG, lisible par n'importe quel logiciel :
   * l'utilisateur ne doit jamais etre prisonnier de l'outil.
   */
  writeDataUrl(rel: string, dataUrl: string): Promise<void>;
  readDataUrl(rel: string): Promise<string>;
}

export interface FileStat {
  name: string;
  /** Date de modification, en ms (avec decimales cote Windows). */
  mtime: number;
  size: number;
}

/** Ce qui identifie une version d'un fichier sur le disque. */
export interface FileStamp {
  mtime: number;
  size: number;
}

/** Resultat d'une ecriture conditionnelle. */
export interface CondWrite {
  ok: boolean;
  /** Ecrit : le fichier ecrit. Refuse : le fichier tel qu'il est (null s'il n'existe pas). */
  stat: FileStat | null;
}

export function sameStamp(a: FileStamp | null | undefined, b: FileStamp | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.size === b.size && Math.abs(a.mtime - b.mtime) < 0.001;
}

/** "data:image/png;base64,AAA" donne ["image/png", "AAA"]. */
export function splitDataUrl(dataUrl: string): { mime: string; base64: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("data URL invalide");
  return { mime: m[1], base64: m[2] };
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== "" && p != null)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\//, "");
}

/* ------------------------------------------------------------------ */
/* Tauri                                                               */
/* ------------------------------------------------------------------ */

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriFs implements FsAdapter {
  readonly kind = "tauri" as const;
  /** Images deja lues : un rendu de page ne relit plus chaque photo par IPC. */
  private images = new DataUrlCache();
  constructor(private invoke: InvokeFn, readonly machine?: string) {}

  listDirs(rel: string) { return this.invoke<string[]>("list_dirs", { rel }); }
  listFiles(rel: string) { return this.invoke<string[]>("list_files", { rel }); }
  listFilesStat(rel: string) { return this.invoke<FileStat[]>("list_files_meta", { rel }); }
  readText(rel: string) { return this.invoke<string>("read_text", { rel }); }
  writeText(rel: string, content: string) { return this.invoke<void>("write_text", { rel, content }); }
  writeTextIf(rel: string, content: string, expect: FileStamp | null) {
    return this.invoke<CondWrite>("write_text_if", {
      rel, content, expect: expect ? { mtime: expect.mtime, size: expect.size } : null,
    });
  }
  readTextStat(rel: string) {
    return this.invoke<{ content: string; stat: FileStat | null }>("read_text_meta", { rel });
  }
  stat(rel: string) { return this.invoke<FileStat | null>("stat_path", { rel }); }
  exists(rel: string) { return this.invoke<boolean>("path_exists", { rel }); }
  mkdir(rel: string) { return this.invoke<void>("make_dir", { rel }); }
  remove(rel: string) {
    this.images.forget(rel);
    return this.invoke<void>("remove_path", { rel });
  }
  rename(from: string, to: string) {
    this.images.forget(from);
    this.images.forget(to);
    return this.invoke<void>("rename_path", { from, to });
  }
  rootLabel() { return this.invoke<string>("root_path"); }
  reveal(rel: string) { return this.invoke<void>("reveal_path", { rel }); }

  async writeDataUrl(rel: string, dataUrl: string) {
    const { base64 } = splitDataUrl(dataUrl);
    this.images.delete(rel);
    await this.invoke<void>("write_binary", { rel, base64 });
    this.images.set(rel, `data:${mimeOf(rel)};base64,${base64}`);
  }

  async readDataUrl(rel: string) {
    const hit = this.images.get(rel);
    if (hit) return hit;
    const base64 = await this.invoke<string>("read_binary", { rel });
    const url = `data:${mimeOf(rel)};base64,${base64}`;
    this.images.set(rel, url);
    return url;
  }
}

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", pdf: "application/pdf",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

/* ------------------------------------------------------------------ */
/* Navigateur (developpement)                                          */
/* ------------------------------------------------------------------ */

const LS_KEY = "cahiers.fs.v1";

export class BrowserFs implements FsAdapter {
  readonly kind = "browser" as const;
  /** chemin -> contenu. Un dossier est une entree de valeur null. */
  private tree: Record<string, string | null>;
  /**
   * Version de chaque fichier ecrit depuis le lancement, en guise de date
   * de modification. Un fichier relu du stockage n'en a pas (0) : sa
   * taille seule le distingue, et Repo oublie son cache a chaque ecriture.
   */
  private revs = new Map<string, number>();
  private clock = 0;

  constructor(private persist = true) {
    let loaded: Record<string, string | null> | null = null;
    if (persist) {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) loaded = JSON.parse(raw);
      } catch { /* stockage indisponible, on repart a vide */ }
    }
    this.tree = loaded ?? {};
  }

  readonly machine: string = "NAVIGATEUR";

  /**
   * Persiste l'arbre. Un depassement de quota remonte (R9) : la file de
   * sauvegarde affiche alors « Non enregistré » au lieu de croire la page
   * ecrite. L'appelant remet l'arbre en memoire dans son etat d'avant.
   */
  private flush() {
    if (!this.persist) return;
    localStorage.setItem(LS_KEY, JSON.stringify(this.tree));
  }

  /** Applique `change`, persiste, et defait tout si la persistance echoue. */
  private commit(change: () => void): void {
    const tree = { ...this.tree };
    const revs = new Map(this.revs);
    const clock = this.clock;
    change();
    try {
      this.flush();
    } catch (e) {
      this.tree = tree;
      this.revs = revs;
      this.clock = clock;
      const quota = e instanceof Error && /quota/i.test(`${e.name} ${e.message}`);
      throw new Error(quota ? "stockage du navigateur plein (quota dépassé)" : `stockage du navigateur indisponible : ${String(e)}`);
    }
  }

  /** Version d'un fichier ; un fichier relu du stockage en recoit une a la premiere demande. */
  private revOf(rel: string): number {
    let r = this.revs.get(rel);
    if (r == null) { r = ++this.clock; this.revs.set(rel, r); }
    return r;
  }

  private childrenOf(rel: string): string[] {
    const prefix = rel === "" ? "" : rel + "/";
    const out = new Set<string>();
    for (const key of Object.keys(this.tree)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest === "" || rest.includes("/")) continue;
      out.add(rest);
    }
    return [...out].sort();
  }

  async listDirs(rel: string) {
    const prefix = rel === "" ? "" : rel + "/";
    return this.childrenOf(rel).filter((c) => this.tree[prefix + c] === null);
  }
  async listFiles(rel: string) {
    const prefix = rel === "" ? "" : rel + "/";
    return this.childrenOf(rel).filter((c) => this.tree[prefix + c] !== null);
  }
  async listFilesStat(rel: string) {
    const prefix = rel === "" ? "" : rel + "/";
    return (await this.listFiles(rel)).map((name) => ({
      name,
      mtime: this.revOf(prefix + name),
      size: (this.tree[prefix + name] ?? "").length,
    }));
  }
  async stat(rel: string): Promise<FileStat | null> {
    const v = this.tree[rel];
    if (v == null) return null;
    return { name: rel.slice(rel.lastIndexOf("/") + 1), mtime: this.revOf(rel), size: v.length };
  }
  async readTextStat(rel: string) {
    const stat = await this.stat(rel);
    return { content: await this.readText(rel), stat };
  }
  /** Meme contrat que la commande Rust write_text_if. */
  async writeTextIf(rel: string, content: string, expect: FileStamp | null): Promise<CondWrite> {
    const current = await this.stat(rel);
    if (!sameStamp(current, expect)) return { ok: false, stat: current };
    await this.writeText(rel, content);
    return { ok: true, stat: await this.stat(rel) };
  }
  async readText(rel: string) {
    const v = this.tree[rel];
    if (v == null) throw new Error(`fichier introuvable : ${rel}`);
    return v;
  }
  async writeText(rel: string, content: string) {
    if (this.tree[rel] === null) throw new Error(`${rel} est un dossier`);
    this.commit(() => {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!(dir in this.tree)) this.tree[dir] = null;
      }
      this.tree[rel] = content;
      this.revs.set(rel, ++this.clock);
    });
  }
  async exists(rel: string) { return rel === "" || rel in this.tree; }
  async mkdir(rel: string) {
    this.commit(() => {
      const parts = rel.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!(dir in this.tree)) this.tree[dir] = null;
      }
    });
  }
  async remove(rel: string) {
    this.commit(() => {
      for (const key of Object.keys(this.tree)) {
        if (key === rel || key.startsWith(rel + "/")) { delete this.tree[key]; this.revs.delete(key); }
      }
    });
  }
  /**
   * Comme la commande Rust : jamais par-dessus une destination existante
   * (R2). Un fichier deplace garde sa version (le disque garde la date) :
   * une page renumerotee reste « la meme » pour l'ecriture conditionnelle.
   */
  async rename(from: string, to: string) {
    if (!(from in this.tree)) throw new Error(`${from} introuvable`);
    const caseOnly = from.toLowerCase() === to.toLowerCase();
    if (to in this.tree && !caseOnly) throw new Error(`${to} existe déjà : rien n'a été écrasé`);
    this.commit(() => {
      for (const key of Object.keys(this.tree)) {
        if (key === from || key.startsWith(from + "/")) {
          const next = to + key.slice(from.length);
          const rev = this.revOf(key);
          const value = this.tree[key];
          delete this.tree[key];
          this.revs.delete(key);
          this.tree[next] = value;
          this.revs.set(next, rev);
        }
      }
      // Dossiers parents de la destination (comme create_dir_all cote Rust).
      const parts = to.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!(dir in this.tree)) this.tree[dir] = null;
      }
    });
  }
  /** En mode navigateur on garde la data URL telle quelle. */
  async writeDataUrl(rel: string, dataUrl: string) { await this.writeText(rel, dataUrl); }
  async readDataUrl(rel: string) { return this.readText(rel); }
  async rootLabel() { return "(navigateur, donnees locales de developpement)"; }
}

/** Adaptateur purement en memoire, pour les tests. Rien n'est persiste. */
export class MemoryFs extends BrowserFs {
  constructor() {
    super(false);
  }
}
