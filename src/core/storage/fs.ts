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
  readText(rel: string): Promise<string>;
  writeText(rel: string, content: string): Promise<void>;
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
  constructor(private invoke: InvokeFn) {}

  listDirs(rel: string) { return this.invoke<string[]>("list_dirs", { rel }); }
  listFiles(rel: string) { return this.invoke<string[]>("list_files", { rel }); }
  readText(rel: string) { return this.invoke<string>("read_text", { rel }); }
  writeText(rel: string, content: string) { return this.invoke<void>("write_text", { rel, content }); }
  exists(rel: string) { return this.invoke<boolean>("path_exists", { rel }); }
  mkdir(rel: string) { return this.invoke<void>("make_dir", { rel }); }
  remove(rel: string) { return this.invoke<void>("remove_path", { rel }); }
  rename(from: string, to: string) { return this.invoke<void>("rename_path", { from, to }); }
  rootLabel() { return this.invoke<string>("root_path"); }
  reveal(rel: string) { return this.invoke<void>("reveal_path", { rel }); }

  async writeDataUrl(rel: string, dataUrl: string) {
    const { base64 } = splitDataUrl(dataUrl);
    await this.invoke<void>("write_binary", { rel, base64 });
  }

  async readDataUrl(rel: string) {
    const base64 = await this.invoke<string>("read_binary", { rel });
    return `data:${mimeOf(rel)};base64,${base64}`;
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

  private flush() {
    if (!this.persist) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.tree)); } catch { /* quota */ }
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
  async readText(rel: string) {
    const v = this.tree[rel];
    if (v == null) throw new Error(`fichier introuvable : ${rel}`);
    return v;
  }
  async writeText(rel: string, content: string) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(dir in this.tree)) this.tree[dir] = null;
    }
    this.tree[rel] = content;
    this.flush();
  }
  async exists(rel: string) { return rel === "" || rel in this.tree; }
  async mkdir(rel: string) {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(dir in this.tree)) this.tree[dir] = null;
    }
    this.flush();
  }
  async remove(rel: string) {
    for (const key of Object.keys(this.tree)) {
      if (key === rel || key.startsWith(rel + "/")) delete this.tree[key];
    }
    this.flush();
  }
  async rename(from: string, to: string) {
    for (const key of Object.keys(this.tree)) {
      if (key === from || key.startsWith(from + "/")) {
        const next = to + key.slice(from.length);
        this.tree[next] = this.tree[key];
        delete this.tree[key];
      }
    }
    this.flush();
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
