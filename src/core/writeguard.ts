/**
 * Ecriture conditionnelle d'une page (R1). Logique pure : empreintes, et
 * que faire quand le fichier a change sur le disque depuis sa lecture
 * (OneDrive a pose la version de l'autre PC, l'explorateur, un editeur).
 * Le disque est dans storage/repo.ts.
 *
 * Regle : ne jamais ecraser. Soit les deux versions se fusionnent sans
 * rien perdre (seule l'encre a change d'un cote), soit la notre part dans
 * une copie de conflit `NNNN.page-<PC>.json` et la page affiche celle du
 * disque.
 */
import type { Block, Page, TextBlock } from "./types";
import { mergeInk } from "./sync";
import { merge3 } from "./textmerge";

/** Empreinte d'un texte (cyrb53, 53 bits) et sa longueur. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${n.toString(16)}:${s.length}`;
}


function sortedJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return val;
  });
}

/**
 * Empreinte de tout ce qui n'est pas de l'encre : texte tape, photos,
 * blocs vivants, reperes, liens, le document d'une page de PDF (sans ses
 * anciennes annotations) et les champs de la page. L'encre, les zones
 * math/texte et leur lecture n'y sont pas : mergeInk sait les reunir
 * (traits et zones absents repris par id). Deux versions de meme empreinte
 * ne different que par l'encre : elles se fusionnent sans rien perdre.
 */
export function contentKey(page: Page): string {
  const blocks = (Array.isArray(page.blocks) ? page.blocks : [])
    .filter((b: Block) => !!b && b.type !== "ink" && b.type !== "math")
    .map((b: Block) => {
      if (b.type !== "pdf") return b;
      const { annotations: _a, ...rest } = b;
      return rest;
    });
  const { blocks: _b, modified: _m, created: _c, version: _v, height: _h, ...rest } = page as Page & Record<string, unknown>;
  return hashText(sortedJson({ rest, blocks }));
}

/** Ce qu'on sait de la version d'une page telle qu'elle a ete lue ou ecrite. */
export interface DiskBase {
  /** Empreinte du fichier (texte exact). */
  hash: string;
  /** contentKey de la page a ce moment. */
  key: string;
  /** Texte tape de la page a ce moment (absent : pas de texte), pour mergeText. */
  text?: string;
  /** restKey de la page a ce moment. */
  rest?: string;
}

/** Texte tape de la page (le bloc texte sans cadre, comme PageView.bodyText). */
export function bodyOf(page: Page): TextBlock | undefined {
  return (Array.isArray(page.blocks) ? page.blocks : [])
    .find((b): b is TextBlock => !!b && b.type === "text" && !b.rect);
}

/** contentKey sans le texte tape : tout le reste (photos, blocs, reperes...). */
export function restKey(page: Page): string {
  const body = bodyOf(page);
  if (!body) return contentKey(page);
  return contentKey({ ...page, blocks: page.blocks.map((b) => (b === body ? { ...body, content: "" } : b)) });
}

/** Ce qu'on retient d'une version lue ou ecrite (`hash` : du fichier exact). */
export function diskBaseOf(page: Page, hash: string): DiskBase {
  const body = bodyOf(page);
  return { hash, key: contentKey(page), rest: restKey(page), ...(body ? { text: body.content } : {}) };
}

/**
 * Que faire d'un fichier change sur le disque :
 *  - `ours` : le disque n'a change que l'encre (ou a le meme contenu que
 *    nous) : on garde notre page et on y ajoute son encre ;
 *  - `disk` : nous n'avons change que l'encre : on garde la page du disque
 *    et on y ajoute notre encre ;
 *  - `conflict` : les deux ont change autre chose (texte, photo...) : notre
 *    version part dans une copie de conflit, la page reprend celle du disque.
 * Sans base connue (page jamais lue ici), seule l'egalite permet la fusion.
 */
export type ExternalPlan = "ours" | "disk" | "conflict";

export function planExternal(base: DiskBase | null, ours: Page, disk: Page): ExternalPlan {
  const ok = contentKey(ours), dk = contentKey(disk);
  if (ok === dk) return "ours";
  if (!base) return "conflict";
  if (dk === base.key) return "ours";
  if (ok === base.key) return "disk";
  return "conflict";
}

/**
 * Page a ecrire selon le plan. `ours` : nos blocs + l'encre du disque ;
 * `disk` : la page du disque + notre encre. Jamais appele pour un conflit.
 * Rend aussi le nombre de traits repris.
 */
export function mergedPage(plan: Exclude<ExternalPlan, "conflict">, ours: Page, disk: Page): { page: Page; added: number } {
  const [keep, other] = plan === "ours" ? [ours, disk] : [disk, ours];
  const r = mergeInk(keep, other);
  const page: Page = { ...keep, blocks: r.blocks };
  if (r.height != null) page.height = r.height;
  return { page, added: r.added };
}

/**
 * Les deux cotes ont change autre chose que l'encre (planExternal rend
 * `conflict`) : si c'est surtout le texte tape, on le fusionne a trois
 * (merge3, base = version lue). Le reste (photos, blocs...) doit n'avoir
 * change que d'un cote au plus ; l'encre est reunie comme pour `ours`.
 * Null : vraie collision, copie de conflit comme avant.
 */
export function mergeText(base: DiskBase | null, ours: Page, disk: Page): { page: Page; added: number } | null {
  if (!base || base.text === undefined || base.rest === undefined) return null;
  const ob = bodyOf(ours), db = bodyOf(disk);
  if (!ob || !db || ob.id !== db.id) return null;
  const ro = restKey(ours), rd = restKey(disk);
  let keepOurs: boolean;
  if (ro === rd || rd === base.rest) keepOurs = true;
  else if (ro === base.rest) keepOurs = false;
  else return null;
  // Le disque ne fait qu'ajouter : rien de ce qu'on a ne disparait sans copie.
  const text = merge3(base.text, ob.content, db.content, { theirsAddOnly: true });
  if (text === null) return null;
  const [keep, other] = keepOurs ? [ours, disk] : [disk, ours];
  const r = mergeInk(keep, other);
  const blocks = r.blocks.map((b) => (b.type === "text" && b.id === ob.id && !b.rect ? { ...b, content: text } : b));
  const page: Page = { ...keep, blocks };
  if (r.height != null) page.height = r.height;
  return { page, added: r.added };
}

/** Nom de machine utilisable dans un nom de fichier. */
export function machineTag(machine: string | undefined): string {
  return (machine ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[-_]+|[-_]+$/g, "") || "CE-PC";
}

/**
 * Nom de la copie de conflit ecrite par l'appli pour la page `n` :
 * `0003.page-<PC>.json`, puis `-2`, `-3`... si le nom est pris. Meme forme
 * que les copies de OneDrive (parseConflictName les reconnait).
 */
export function conflictCopyName(n: number, machine: string | undefined, taken: readonly string[]): string {
  const base = `${String(n).padStart(4, "0")}.page-${machineTag(machine)}`;
  const used = new Set(taken.map((t) => t.toLowerCase()));
  let name = `${base}.json`;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}.json`;
  return name;
}
