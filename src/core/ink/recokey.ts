import type { Block, Page } from "../types";
import type { Repo } from "../storage/repo";
import type { RecoResult } from "./recognizer";
import { carryEdits, dropStrokes, joinWords } from "./words";
import { hasDirty, mergeIncremental } from "./bands";

/**
 * Ou ranger un resultat de reconnaissance, eventuellement bien plus tard.
 *
 * Logique pure (sauf la lecture/ecriture disque, passee par le Repo) : la
 * vue ne s'en sert que pour les pages qu'elle a en memoire, l'appli pour le
 * disque quand aucune vue ne tient la page.
 */

export interface BlockRef {
  notebook: string;
  divider: string;
  /** Id de la page, jamais son numero : une insertion decale les numeros. */
  pageId: string;
  blockId: string;
}

/**
 * Cle stable d'un bloc dans toute l'arborescence, utilisee par la file.
 * Avec le numero de page, un resultat revenu apres une insertion ou une
 * suppression ne retrouvait plus son bloc.
 */
export function blockKey(nb: string, div: string, pageId: string, blockId: string): string {
  return `${nb}/${div}/${pageId}#${blockId}`;
}

/**
 * Relit une cle. Les ids n'ont ni « / » ni « # », un nom peut porter un
 * « # » (« C# »). La matiere est un dossier de la racine (premier segment) ;
 * l'intercalaire est tout ce qui suit jusqu'a l'id de page, sur un ou
 * plusieurs niveaux (« E3A/S1/Chapitre 1 », D4).
 */
export function parseBlockKey(key: string): BlockRef | null {
  const hash = key.lastIndexOf("#");
  if (hash < 0) return null;
  const blockId = key.slice(hash + 1);
  const path = key.slice(0, hash);
  const p = path.lastIndexOf("/");
  const d = path.indexOf("/");
  if (p < 0 || d <= 0 || d >= p || !blockId) return null;
  return {
    notebook: path.slice(0, d),
    divider: path.slice(d + 1, p),
    pageId: path.slice(p + 1),
    blockId,
  };
}

/**
 * Range le resultat la ou le bloc l'attend : LaTeX pour math, texte pour
 * l'encre. `more` = une version plus recente du bloc est encore en file :
 * le resultat s'affiche, mais le bloc reste « en attente ».
 */
export function applyToBlock(block: Block, result: RecoResult, more = false): void {
  if (block.type !== "math" && block.type !== "ink") return;
  if (block.type === "math") {
    block.latex = result.value;
    block.candidates = result.candidates.length ? result.candidates : undefined;
  } else if (!block.rect && result.scope) {
    // Envoi par bandes : seuls les traits envoyes changent de lecture, et le
    // bloc reste en attente tant qu'une ligne n'est pas lue (ligne en cours
    // gardee par la vue, a reprendre apres une fermeture).
    mergeIncremental(block, result.words, result.scope);
    delete block.recoError;
    block.pending = more || hasDirty(block);
    return;
  } else if (!block.rect && result.words) {
    // Mot a mot. Un trait gomme (ou deplace dans une zone) pendant
    // l'aller-retour reseau ne doit pas ressusciter dans un mot : on ne
    // garde que les traits encore la.
    const alive = new Set(block.strokes.map((st) => st.id));
    const gone = new Set(result.words.flatMap((w) => w.strokeIds).filter((id) => !alive.has(id)));
    block.words = dropStrokes(carryEdits(block.words, result.words), gone);
    block.recognized = joinWords(block.words) || null;
    block.candidates = undefined;
  } else {
    block.recognized = result.value;
    block.candidates = result.candidates.length ? result.candidates : undefined;
  }
  delete block.recoError;
  block.pending = more;
}

/** Bloc abandonne par la reconnaissance : l'encre reste, le motif s'affiche. */
export function markFailed(block: Block, message: string): void {
  if (block.type !== "math" && block.type !== "ink") return;
  block.pending = false;
  block.recoError = message;
}

/** Bloc encore en attente de conversion, a remettre en file. */
export function isPending(block: Block): boolean {
  return (block.type === "math" || block.type === "ink") && !!block.pending;
}

/**
 * Cherche un bloc sur le disque : d'abord la page de cet id, sinon toute
 * page de l'intercalaire qui porte le bloc. Une page illisible est passee.
 */
export async function findBlockOnDisk(
  repo: Repo, ref: BlockRef,
): Promise<{ number: number; page: Page; block: Block } | null> {
  let nums: number[];
  try { nums = await repo.listPageNumbers(ref.notebook, ref.divider); } catch { return null; }
  let fallback: { number: number; page: Page; block: Block } | null = null;
  for (const n of nums) {
    let page: Page;
    try { page = await repo.readPage(ref.notebook, ref.divider, n); } catch { continue; }
    const block = page.blocks.find((b) => b.id === ref.blockId);
    if (!block) continue;
    if (page.id === ref.pageId) return { number: n, page, block };
    fallback ??= { number: n, page, block };
  }
  return fallback;
}

/**
 * Applique `change` au bloc sur le disque, en une seule lecture et une seule
 * ecriture. Faux si le bloc n'existe plus (page supprimee, bloc gomme).
 * L'appelant serialise : jamais deux ecritures concurrentes d'une page.
 */
export async function updateBlockOnDisk(
  repo: Repo, ref: BlockRef, change: (block: Block) => void,
): Promise<boolean> {
  const found = await findBlockOnDisk(repo, ref);
  if (!found) return false;
  change(found.block);
  await repo.writePage(ref.notebook, ref.divider, found.number, found.page);
  return true;
}
