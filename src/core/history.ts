import type { Block } from "./types";

/**
 * Annulation par page. Une pile unique indexee par NUMERO restaurait une
 * autre page apres une suppression ou une insertion, et un Ctrl+Z fait
 * ailleurs consommait un pas en silence. Ici chaque page (par son id, qui
 * ne change jamais) a ses propres piles.
 *
 * Logique pure, sans DOM : les instantanes sont des JSON de blocs.
 */
export class PageHistory {
  private stacks = new Map<string, { undo: string[]; redo: string[] }>();

  constructor(private limit = 200) {}

  private of(id: string): { undo: string[]; redo: string[] } {
    let s = this.stacks.get(id);
    if (!s) { s = { undo: [], redo: [] }; this.stacks.set(id, s); }
    return s;
  }

  /** Etat de la page juste avant une modification. Vide le "retablir". */
  push(id: string, snapshot: string): void {
    const s = this.of(id);
    s.undo.push(snapshot);
    // Annulation profonde, mais pas infinie : 200 pas suffisent largement.
    if (s.undo.length > this.limit) s.undo.shift();
    s.redo = [];
  }

  canUndo(id: string): boolean { return (this.stacks.get(id)?.undo.length ?? 0) > 0; }
  canRedo(id: string): boolean { return (this.stacks.get(id)?.redo.length ?? 0) > 0; }

  /**
   * Rend l'instantane a restaurer et range `current` dans l'autre pile.
   * Rien a annuler : null, et aucune pile n'est touchee.
   */
  undo(id: string, current: string): string | null {
    const s = this.stacks.get(id);
    const entry = s?.undo.pop();
    if (!s || entry === undefined) return null;
    s.redo.push(current);
    return entry;
  }

  redo(id: string, current: string): string | null {
    const s = this.stacks.get(id);
    const entry = s?.redo.pop();
    if (!s || entry === undefined) return null;
    s.undo.push(current);
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
