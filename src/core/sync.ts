/**
 * Synchronisation OneDrive entre deux PC (section 11). Logique pure, sans
 * disque ni interface :
 *  - les copies de conflit que OneDrive pose a cote d'une page ;
 *  - la fusion de l'encre d'une copie, trait par trait (par id) ;
 *  - la decision de presence (le cahier est-il ouvert sur l'autre PC ?).
 *
 * Le verrou d'instance reste local a la machine (section 1) : seule la
 * presence vit dans le dossier synchronise, un fichier par machine.
 */
import type { Block, InkBlock, MathBlock, Page, Stroke, TextBlock } from "./types";

/* ------------------------------------------------------------------ */
/* Copies de conflit                                                   */
/* ------------------------------------------------------------------ */

/**
 * Copie de conflit d'une page. OneDrive, quand les deux PC ont modifie la
 * meme page avant de se synchroniser, garde les deux : la sienne sous le nom
 * normal, l'autre avec le nom du PC insere avant l'extension :
 *   0003.page-LAPTOP-MAX.json, 0003.page-LAPTOP-MAX-2.json
 * Les variantes vues ailleurs (copie de l'explorateur « 0003.page - Copie.json »,
 * « 0003.page (1).json ») sont traitees pareil : jamais une page normale.
 */
export interface ConflictName {
  /** Numero de la page dont c'est une copie. */
  page: number;
  /** Ce que le nom dit de l'origine (nom du PC le plus souvent). */
  label: string;
}

const CONFLICT_RE = /^(\d{4})\.page([-_ (].*)\.json$/i;

/** Copie de conflit d'une page, ou null (page normale, autre fichier). */
export function parseConflictName(fileName: string): ConflictName | null {
  const m = CONFLICT_RE.exec(fileName);
  if (!m) return null;
  const label = m[2]
    .replace(/^[\s\-_]+/, "")
    .replace(/^\((.*)\)$/, "$1")
    .trim();
  return { page: Number(m[1]), label: label || "autre PC" };
}

/**
 * Nom de la copie une fois la page renumerotee : seul le numero change,
 * le reste du nom (le PC d'origine) est garde.
 */
export function renumberConflictName(fileName: string, page: number): string {
  return `${String(page).padStart(4, "0")}${fileName.slice(4)}`;
}

/* ------------------------------------------------------------------ */
/* Fusion de l'encre                                                   */
/* ------------------------------------------------------------------ */

export interface InkMerge {
  /** Blocs de la page apres fusion (copies : la page d'origine n'est pas touchee). */
  blocks: Block[];
  /** Traits repris de la copie. */
  added: number;
  /** Hauteur de feuille a garder (la copie avait de l'encre plus bas). */
  height?: number;
  /** Le texte tape differe : il n'est pas fusionne, a regarder dans la copie. */
  textDiffers: boolean;
}

/** Traits d'un bloc, quel que soit son type (encre, formule, annotation PDF). */
function strokesOf(b: Block): Stroke[] {
  if (b.type === "ink" || b.type === "math") return b.strokes;
  if (b.type === "pdf") return b.annotations;
  return [];
}

/** Le fond de page : le bloc d'encre sans cadre (celui de PageView.mainInk). */
function mainInkOf(blocks: Block[]): InkBlock | undefined {
  return blocks.find((b): b is InkBlock => b.type === "ink" && !b.rect);
}

function bodyOf(blocks: Block[]): string {
  return blocks.find((b): b is TextBlock => b.type === "text" && !b.rect)?.content ?? "";
}

/**
 * Le resultat d'une reconnaissance ne couvre plus tous les traits du bloc :
 * il repart en file (l'ancien resultat reste affiche en attendant).
 */
function markStale(b: InkBlock | MathBlock): void {
  if (b.type === "math") {
    if (b.latex != null) b.pending = true;
  } else if (b.recognized != null || b.words?.length) {
    b.pending = true;
  }
}

/**
 * Reprend dans `mine` les traits de `other` qu'elle n'a pas, reconnus par
 * leur id. Un trait deja present n'importe ou dans `mine` (deplace dans une
 * zone math, par exemple) n'est jamais duplique. Rien n'est retire : un
 * trait gomme sur un seul PC revient, c'est le prix de ne rien perdre.
 *
 * - bloc de meme id : ses traits manquants y sont ajoutes ;
 * - fond de page de la copie (ids differents quand les deux PC l'ont cree
 *   chacun de son cote) : ses traits rejoignent le fond de page d'ici ;
 * - zone (math ou texte) absente d'ici : ajoutee avec ses traits manquants ;
 *   sa lecture n'est gardee que si tous ses traits sont nouveaux.
 * Le texte tape, les photos et les reperes ne sont pas fusionnes.
 */
export function mergeInk(mine: Page, other: Page): InkMerge {
  const blocks: Block[] = JSON.parse(JSON.stringify(mine.blocks)) as Block[];
  const known = new Set<string>();
  for (const b of blocks) for (const s of strokesOf(b)) known.add(s.id);

  let added = 0;
  const take = (list: Stroke[]): Stroke[] => {
    const out: Stroke[] = [];
    for (const s of list) {
      if (!s || typeof s.id !== "string" || known.has(s.id)) continue;
      known.add(s.id);
      out.push(JSON.parse(JSON.stringify(s)) as Stroke);
    }
    added += out.length;
    return out;
  };

  for (const ob of Array.isArray(other.blocks) ? other.blocks : []) {
    if (ob.type !== "ink" && ob.type !== "math" && ob.type !== "pdf") continue;
    const all = strokesOf(ob);
    if (!Array.isArray(all) || !all.length) continue;
    const same = blocks.find((b) => b.id === ob.id && b.type === ob.type);

    if (same) {
      const extra = take(all);
      if (!extra.length) continue;
      if (same.type === "pdf") same.annotations.push(...extra);
      else if (same.type === "ink" || same.type === "math") {
        same.strokes.push(...extra);
        markStale(same);
      }
      continue;
    }
    if (ob.type === "pdf") continue; // le document lui-meme n'est pas ici
    if (ob.type === "ink" && !ob.rect) {
      const extra = take(all);
      if (!extra.length) continue;
      let main = mainInkOf(blocks);
      if (!main) {
        main = { id: ob.id, type: "ink", strokes: [], recognized: null, mode: "raw" };
        blocks.push(main);
      }
      main.strokes.push(...extra);
      markStale(main);
      continue;
    }
    const extra = take(all);
    if (!extra.length) continue;
    const copy = JSON.parse(JSON.stringify(ob)) as InkBlock | MathBlock;
    copy.strokes = extra;
    if (extra.length !== all.length) {
      // Une partie de ses traits est deja ici : sa lecture ne vaut plus.
      if (copy.type === "math") copy.latex = null;
      else { copy.recognized = null; delete copy.words; }
      copy.pending = true;
    }
    blocks.push(copy);
  }

  const height = added && typeof other.height === "number" && other.height > (mine.height ?? 0)
    ? other.height : mine.height;
  return {
    blocks,
    added,
    ...(height != null ? { height } : {}),
    textDiffers: bodyOf(blocks).trim() !== bodyOf(other.blocks ?? []).trim(),
  };
}

/* ------------------------------------------------------------------ */
/* Presence                                                            */
/* ------------------------------------------------------------------ */

/**
 * Un fichier de presence PAR MACHINE, a la racine du cahier :
 * « .presence-LAPTOP-MAX.json ». Un fichier commun serait ecrit par les deux
 * PC et OneDrive en ferait lui-meme une copie de conflit.
 */
const PRESENCE_PREFIX = ".presence-";
const PRESENCE_SUFFIX = ".json";

/** Rafraichi toutes les 5 min tant que le cahier est ouvert. */
export const PRESENCE_CLAIM_MS = 5 * 60 * 1000;
/**
 * Au-dela, la presence est perimee (appli tuee, PC en veille) : trois
 * rafraichissements manques. Les deux PC ont la meme heure a quelques
 * secondes pres (heure Windows synchronisee).
 */
export const PRESENCE_TTL_MS = 15 * 60 * 1000;
/** Horloge de l'autre PC en avance : tolere jusqu'a une heure. */
const MAX_SKEW_MS = 60 * 60 * 1000;

export interface PresenceRecord {
  machine: string;
  /** Dernier rafraichissement (ISO). */
  at: string;
}

export interface OtherPresence {
  machine: string;
  /** Anciennete du dernier signe de vie, en ms (0 si l'horloge est en avance). */
  age: number;
}

/** Nom du fichier de presence d'une machine, sans caractere douteux. */
export function presenceFileName(machine: string): string {
  const safe = machine.trim().replace(/[^A-Za-z0-9_-]+/g, "_") || "PC";
  return `${PRESENCE_PREFIX}${safe}${PRESENCE_SUFFIX}`;
}

export function isPresenceFile(fileName: string): boolean {
  return fileName.startsWith(PRESENCE_PREFIX) && fileName.endsWith(PRESENCE_SUFFIX)
    && parseConflictName(fileName) === null;
}

/** Contenu d'un fichier de presence, ou null s'il ne ressemble a rien. */
export function parsePresence(raw: string): PresenceRecord | null {
  try {
    const v = JSON.parse(raw) as Partial<PresenceRecord>;
    if (typeof v?.machine !== "string" || !v.machine || typeof v.at !== "string") return null;
    if (!Number.isFinite(new Date(v.at).getTime())) return null;
    return { machine: v.machine, at: v.at };
  } catch {
    return null;
  }
}

/**
 * Les autres machines qui ont le cahier ouvert : ni celle-ci, ni une presence
 * perimee. La plus recente d'abord.
 */
export function othersPresent(
  records: readonly (PresenceRecord | null)[], me: string, now: number,
): OtherPresence[] {
  const self = me.trim().toLowerCase();
  const best = new Map<string, OtherPresence>();
  for (const r of records) {
    if (!r || r.machine.trim().toLowerCase() === self) continue;
    const age = now - new Date(r.at).getTime();
    if (!(age < PRESENCE_TTL_MS && age > -MAX_SKEW_MS)) continue;
    const o = { machine: r.machine, age: Math.max(0, age) };
    const prev = best.get(r.machine);
    if (!prev || o.age < prev.age) best.set(r.machine, o);
  }
  return [...best.values()].sort((a, b) => a.age - b.age);
}

/** « à l'instant », « il y a 4 min ». */
export function presenceAgo(age: number): string {
  const min = Math.floor(age / 60_000);
  return min < 1 ? "à l'instant" : `il y a ${min} min`;
}
