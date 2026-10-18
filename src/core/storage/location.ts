/**
 * Emplacement des cahiers (decision du 16/10/2026) : logique pure.
 *
 * Par defaut les cahiers sont dans l'espace prive de l'appli (« app ») ; un
 * dossier synchronise (OneDrive, iCloud Drive) reste possible (« folder »).
 * Memes fichiers JSON dans les deux cas : on passe de l'un a l'autre par une
 * COPIE verifiee (commandes Rust, src-tauri/src/location.rs), jamais en
 * deplacant, jamais en ecrasant. L'ancien emplacement n'est jamais supprime.
 *
 * Ici : le choix de ce qu'on fait d'un dossier vise (copier, l'ouvrir tel
 * quel, sous-dossier « Cahiers »), la verification d'une copie, et
 * l'enchainement d'une bascule (`switchFlow`), sans DOM : l'interface passe
 * ses questions par `SwitchAsk`.
 */

export type StorageMode = "app" | "folder";

export interface StorageInfo {
  mode: StorageMode;
  /** Racine actuelle. */
  path: string;
  /** Espace prive de l'appli. */
  internal: string;
  /** Dossier retenu (root.txt) mais introuvable a ce lancement. */
  missing: string | null;
  /**
   * Sandbox Mac App Store : `missing` n'est pas forcement absent, c'est
   * l'acces qui manque ; il faut le choisir de nouveau (« picked »).
   */
  lostAccess?: boolean;
}

export interface Inventory {
  files: number;
  /** Pages hors dossiers caches (corbeille, versions). */
  pages: number;
  bytes: number;
}

/** Place d'un dossier par rapport a la racine actuelle. */
export type Relation = "same" | "inside" | "contains" | "none";

export interface DirReport extends Inventory {
  path: string;
  exists: boolean;
  /** Noms du premier niveau. */
  entries: string[];
  /** Matieres : dossiers du premier niveau qui ont un cahier.json, hors Vrac. */
  notebooks: number;
  /** Parcours arrete avant la fin (dossier enorme). */
  truncated: boolean;
  relation: Relation;
}

export interface CopyReport {
  path: string;
  source: Inventory;
  dest: Inventory;
  copied: number;
  same: number;
  aside: string | null;
}

/** internal = espace prive ; picked = dossier choisi ; missing = dossier de root.txt introuvable. */
export type Target = "internal" | "picked" | "missing";

/** Ce que l'appli installee sait faire de l'emplacement (absent en mode navigateur). */
export interface LocationApi {
  info(): Promise<StorageInfo>;
  /** Boite « Choisir un dossier » ; null si fermee. */
  pickFolder(): Promise<string | null>;
  inspect(target: Target | "current", sub?: string): Promise<DirReport>;
  copy(target: Target, sub?: string, aside?: boolean): Promise<CopyReport>;
  switchTo(target: Target, sub?: string): Promise<StorageInfo>;
  /** Explorateur Windows / Finder sur la racine. */
  open(): Promise<void>;
}

/** Sous-dossier cree dans un dossier choisi qui contient deja autre chose. */
export const SUBFOLDER = "Cahiers";

/** Fichiers poses par le systeme : un dossier qui n'a qu'eux est vide. */
export function isSystemEntry(name: string): boolean {
  const n = name.toLowerCase();
  return n === "desktop.ini" || n === "thumbs.db" || n === ".ds_store" || n === ".localized"
    || n === "icon\r" || n.startsWith("._") || n === ".spotlight-v100" || n === ".trashes";
}

/** Le dossier n'a rien d'autre que des fichiers systeme. */
export function isEmptyDir(r: Pick<DirReport, "exists" | "entries">): boolean {
  return !r.exists || r.entries.every(isSystemEntry);
}

/** Le dossier contient deja des cahiers (une matiere, Vrac ou des pages). */
export function hasCahiers(r: DirReport): boolean {
  return r.notebooks > 0 || r.pages > 0 || r.entries.includes("Vrac");
}

export type DestPlan =
  /** Rien a faire : c'est la racine actuelle. */
  | { kind: "current" }
  /** L'un est dans l'autre : refuse (on copierait un dossier dans lui-meme). */
  | { kind: "nested" }
  /** Vide : on y copie les cahiers. */
  | { kind: "copy" }
  /** Espace prive sans aucune page (Vrac vide) : mis de cote, puis copie. */
  | { kind: "aside" }
  /**
   * Retour dans l'espace prive qui a deja des pages (ancienne copie) : au
   * choix, la mettre de cote puis copier les notes actuelles, ou la rouvrir.
   */
  | { kind: "reopen"; notebooks: number; pages: number }
  /** Contient deja des cahiers : proposer de l'ouvrir tel quel. */
  | { kind: "open"; notebooks: number; pages: number }
  /** Autre chose dedans : copier dans un sous-dossier « Cahiers ». */
  | { kind: "subfolder" }
  /** Sous-dossier « Cahiers » deja occupe par autre chose : choisir ailleurs. */
  | { kind: "refuse" };

/**
 * Que faire d'un emplacement vise. `nested` : on regarde deja le
 * sous-dossier « Cahiers » (pas de second niveau).
 */
export function planDestination(r: DirReport, target: Target, nested = false): DestPlan {
  if (r.relation === "same") return { kind: "current" };
  if (r.relation !== "none") return { kind: "nested" };
  if (isEmptyDir(r)) return { kind: "copy" };
  // « Ramener dans l'appli » doit ramener les notes actuelles : une ancienne
  // copie dans l'espace prive ne passe pas avant (C-13).
  if (target === "internal") {
    return r.pages > 0 ? { kind: "reopen", notebooks: r.notebooks, pages: r.pages } : { kind: "aside" };
  }
  if (hasCahiers(r) && r.pages > 0) return { kind: "open", notebooks: r.notebooks, pages: r.pages };
  if (hasCahiers(r) && !r.truncated) return { kind: "open", notebooks: r.notebooks, pages: r.pages };
  return nested ? { kind: "refuse" } : { kind: "subfolder" };
}

/** La copie est-elle complete ? Meme nombre de fichiers, de pages, d'octets. */
export function verifyCopy(source: Inventory, dest: Inventory): { ok: true } | { ok: false; message: string } {
  if (source.files !== dest.files || source.pages !== dest.pages || source.bytes !== dest.bytes) {
    return {
      ok: false,
      message: `copie incomplète : ${dest.files}/${source.files} fichiers, ${dest.pages}/${source.pages} pages, `
        + `${formatBytes(dest.bytes)} sur ${formatBytes(source.bytes)}. Rien n'a basculé, l'emplacement actuel est intact.`,
    };
  }
  return { ok: true };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
  return `${(n / 1024 ** 3).toFixed(2).replace(".", ",")} Go`;
}

export function pagesLabel(n: number): string {
  return `${n} page${n > 1 ? "s" : ""}`;
}

export function modeLabel(mode: StorageMode): string {
  return mode === "app" ? "Dans l'appli" : "Dossier synchronisé";
}

/**
 * Premier lancement : rien d'autre que Vrac, sans page, et aucun dossier a
 * cote. L'accueil propose alors de creer sa premiere matiere.
 */
export function isFirstRun(
  notebooks: { dir: string; pageCount: number }[], others: unknown[], vrac = "Vrac",
): boolean {
  return others.length === 0 && notebooks.every((n) => n.dir === vrac && n.pageCount === 0);
}

/** Questions posees pendant une bascule. Chaque `false` annule sans rien changer. */
export interface SwitchAsk {
  /** Copier `source` vers `path` ? */
  confirmCopy(source: Inventory, path: string): Promise<boolean>;
  /** Le dossier contient deja des cahiers : l'ouvrir tel quel ? */
  confirmOpen(report: DirReport): Promise<boolean>;
  /** Le dossier contient autre chose : copier dans `path/Cahiers` ? */
  confirmSubfolder(report: DirReport): Promise<boolean>;
  /**
   * Retour dans l'espace prive qui a deja une copie (`report`) : « copy » =
   * la mettre de cote (renommee, jamais effacee) puis copier `current` ;
   * « open » = rouvrir cette ancienne copie ; null = annuler.
   */
  chooseInternal(report: DirReport, current: Inventory): Promise<"copy" | "open" | null>;
  /**
   * Juste avant de copier ou de basculer, une fois tout confirme : tout
   * ecrire et liberer la presence (App.quiesce). false = une page reste
   * refusee, rien ne bascule. Jamais appele si l'utilisateur annule avant.
   */
  ready?(): Promise<boolean>;
  /** Pendant la copie (peut durer). */
  progress?(message: string): void;
}

/** `ready` refuse : une page attend encore d'etre ecrite. */
export const NOT_READY = "Une page n'est pas encore enregistrée : rien n'a changé. Réessaie dans un instant.";

export type SwitchOutcome =
  | { kind: "cancelled" }
  | { kind: "unchanged"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "switched"; info: StorageInfo; copied: CopyReport | null };

/**
 * Bascule vers `target` : choisir le dossier (picked), le regarder, copier
 * si besoin, verifier, puis seulement changer de racine. Toute erreur ou
 * verification ratee laisse la racine actuelle en place.
 */
export async function switchFlow(api: LocationApi, target: Target, ask: SwitchAsk): Promise<SwitchOutcome> {
  try {
    if (target === "picked" && !(await api.pickFolder())) return { kind: "cancelled" };
    const report = await api.inspect(target);
    const plan = planDestination(report, target);
    switch (plan.kind) {
      case "current": return { kind: "unchanged", message: "C'est déjà l'emplacement des cahiers." };
      case "nested": return { kind: "unchanged", message: "Ce dossier est dans l'emplacement actuel (ou le contient) : choisis un dossier à part." };
      case "open":
        if (!(await ask.confirmOpen(report))) return { kind: "cancelled" };
        return await openAsIs(api, ask, target);
      case "copy":
      case "aside":
        return await copyThenSwitch(api, ask, target, report.path, undefined, plan.kind === "aside");
      case "reopen": {
        const current = await api.inspect("current");
        const choice = await ask.chooseInternal(report, current);
        if (choice === "open") return await openAsIs(api, ask, target);
        if (choice !== "copy") return { kind: "cancelled" };
        return await copyThenSwitch(api, ask, target, report.path, undefined, true, current);
      }
      case "subfolder": {
        const sub = await api.inspect(target, SUBFOLDER);
        const next = planDestination(sub, target, true);
        if (next.kind === "open") {
          if (!(await ask.confirmOpen(sub))) return { kind: "cancelled" };
          return await openAsIs(api, ask, target, SUBFOLDER);
        }
        if (next.kind !== "copy") {
          return { kind: "unchanged", message: `« ${sub.path} » existe déjà et contient autre chose : choisis un autre dossier.` };
        }
        if (!(await ask.confirmSubfolder(report))) return { kind: "cancelled" };
        return await copyThenSwitch(api, ask, target, sub.path, SUBFOLDER, false);
      }
      case "refuse":
        return { kind: "unchanged", message: "Ce dossier ne convient pas : choisis-en un autre." };
    }
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Ouvre un dossier qui a deja des cahiers, tel quel, sans copie. */
async function openAsIs(api: LocationApi, ask: SwitchAsk, target: Target, sub?: string): Promise<SwitchOutcome> {
  if (ask.ready && !(await ask.ready())) return { kind: "unchanged", message: NOT_READY };
  return { kind: "switched", info: await api.switchTo(target, sub), copied: null };
}

/** `confirmed` : inventaire deja montre et copie deja acceptee (chooseInternal). */
async function copyThenSwitch(
  api: LocationApi, ask: SwitchAsk, target: Target, path: string, sub: string | undefined, aside: boolean,
  confirmed?: Inventory,
): Promise<SwitchOutcome> {
  const current = confirmed ?? await api.inspect("current");
  if (!confirmed && !(await ask.confirmCopy(current, path))) return { kind: "cancelled" };
  if (ask.ready && !(await ask.ready())) return { kind: "unchanged", message: NOT_READY };
  ask.progress?.(`Copie de ${pagesLabel(current.pages)} (${formatBytes(current.bytes)})…`);
  const report = await api.copy(target, sub, aside);
  const check = verifyCopy(report.source, report.dest);
  if (!check.ok) return { kind: "failed", message: check.message };
  return { kind: "switched", info: await api.switchTo(target, sub), copied: report };
}
