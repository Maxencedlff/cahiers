import type { Block, Stroke } from "./types";
import { dropStrokes, joinWords } from "./ink/words";

/**
 * Annulation par page. Une pile unique indexee par NUMERO restaurait une
 * autre page apres une suppression ou une insertion, et un Ctrl+Z fait
 * ailleurs consommait un pas en silence. Ici chaque page (par son id, qui
 * ne change jamais) a ses propres piles.
 *
 * Logique pure, sans DOM. Deux sortes d'entrees :
 *  - un instantane (JSON des blocs) pour les operations rares : gomme,
 *    zone, correction, insertion de bloc ;
 *  - une commande legere pour le geste le plus frequent, l'ajout d'un
 *    trait. Serialiser toute la page a chaque lever de stylet coutait
 *    plusieurs ms et 1,5 Mo par trait sur une page chargee.
 */

/** Un trait ajoute a un bloc. Annuler le retire, retablir le remet. */
export interface StrokeAdded { op: "add"; blockId: string; stroke: Stroke }

export type HistoryEntry = string | StrokeAdded;

type Stacks = { undo: HistoryEntry[]; redo: HistoryEntry[] };

export class PageHistory {
  private stacks = new Map<string, Stacks>();

  constructor(private limit = 200) {}

  private of(id: string): Stacks {
    let s = this.stacks.get(id);
    if (!s) { s = { undo: [], redo: [] }; this.stacks.set(id, s); }
    return s;
  }

  /**
   * Etat de la page juste avant une modification (instantane), ou la
   * modification elle-meme (commande). Vide le "retablir".
   */
  push(id: string, entry: HistoryEntry): void {
    const s = this.of(id);
    s.undo.push(entry);
    // Annulation profonde, mais pas infinie : 200 pas suffisent largement.
    if (s.undo.length > this.limit) s.undo.shift();
    s.redo = [];
  }

  canUndo(id: string): boolean { return (this.stacks.get(id)?.undo.length ?? 0) > 0; }
  canRedo(id: string): boolean { return (this.stacks.get(id)?.redo.length ?? 0) > 0; }

  /**
   * Rend l'entree a defaire. Un instantane range l'etat `current` dans
   * l'autre pile ; une commande y passe telle quelle (elle sait se rejouer
   * dans les deux sens). `current` peut etre une fonction : l'etat n'est
   * alors serialise que si l'entree est un instantane.
   * Rien a annuler : null, et aucune pile n'est touchee.
   */
  undo(id: string, current: string | (() => string)): HistoryEntry | null {
    return this.move(id, "undo", "redo", current);
  }

  redo(id: string, current: string | (() => string)): HistoryEntry | null {
    return this.move(id, "redo", "undo", current);
  }

  private move(
    id: string, from: keyof Stacks, to: keyof Stacks, current: string | (() => string),
  ): HistoryEntry | null {
    const s = this.stacks.get(id);
    const entry = s?.[from].pop();
    if (!s || entry === undefined) return null;
    s[to].push(typeof entry === "string"
      ? (typeof current === "function" ? current() : current)
      : entry);
    return entry;
  }

  /** Page supprimee : son historique part avec elle. */
  drop(id: string): void { this.stacks.delete(id); }
}

/**
 * Blocs apres une annulation. Le texte tape a son propre Ctrl+Z (celui de
 * l'editeur) : annuler un trait ne doit pas ramener le texte d'il y a cinq
 * minutes. Les photos posees dans ce texte le suivent : l'instantane peut
 * dater d'avant la photo, et la restaurer telle quelle supprimait le bloc
 * image alors que le texte le reference toujours (photo « introuvable »).
 */
export function restoreBlocks(current: Block[], snapshot: Block[]): Block[] {
  const inText = (b: Block) => (b.type === "text" || b.type === "image") && !b.rect;
  const kept = current.filter(inText);
  const ids = new Set(kept.map((b) => b.id));
  // Une ancienne photo flottante rangee depuis dans le texte garde son id :
  // pas de doublon.
  return [...snapshot.filter((b) => !inText(b) && !ids.has(b.id)), ...kept];
}

/**
 * Joue une commande de trait sur les blocs. "undo" retire le trait (et le
 * sort des mots reconnus, comme la gomme) ; "redo" le remet dans son bloc,
 * ou dans un bloc d'encre recree sous le meme id s'il a disparu.
 */
export function applyStrokeCommand(blocks: Block[], cmd: StrokeAdded, dir: "undo" | "redo"): Block[] {
  if (dir === "undo") {
    const gone = new Set([cmd.stroke.id]);
    for (const b of blocks) {
      if (b.type === "ink") {
        const before = b.strokes.length;
        b.strokes = b.strokes.filter((s) => s.id !== cmd.stroke.id);
        if (b.words && b.strokes.length !== before) {
          b.words = dropStrokes(b.words, gone);
          b.recognized = joinWords(b.words) || null;
        }
      } else if (b.type === "math") {
        b.strokes = b.strokes.filter((s) => s.id !== cmd.stroke.id);
      }
    }
    return blocks;
  }
  const target = blocks.find((b) => b.id === cmd.blockId);
  if (target && (target.type === "ink" || target.type === "math")) {
    if (!target.strokes.some((s) => s.id === cmd.stroke.id)) target.strokes.push(cmd.stroke);
    return blocks;
  }
  // Bloc introuvable (une annulation plus ancienne l'a retire) : on le
  // recree plutot que de perdre le trait.
  return [...blocks, { id: cmd.blockId, type: "ink", strokes: [cmd.stroke], recognized: null, mode: "raw" }];
}
