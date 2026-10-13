/**
 * Garde-fous de la pagination (pageview.ts : pullNext, undoFlow). Logique
 * pure, testable sans DOM : l'ordre des ecritures d'une remontee de page,
 * et la condition pour annuler un debordement sans perdre de texte.
 *
 * Perte du 13/10 : une page de suite remontee puis un Ctrl+Z rendait la
 * page d'avant sans la suite, et la suite n'etait plus qu'en corbeille.
 */

/** Etapes d'une remontee (pullNext), fournies par la vue. */
export interface PullSteps {
  /** Ecrit la page d'avant, avec la suite deja dedans. Rejette si l'ecriture echoue. */
  writeFrom(): Promise<void>;
  /** Met la page de suite a la corbeille (et renumerote). */
  trashNext(): Promise<void>;
  /** Rend a la page d'avant son contenu d'avant la remontee (en memoire). */
  revert(): void;
}

export type PullResult =
  /** Suite remontee, page de suite a la corbeille. */
  | { result: "pulled" }
  /** Ecriture de la page d'avant en echec : rien n'a bouge (R3). */
  | { result: "reverted"; error: unknown }
  /** Page d'avant ecrite mais la suite toujours la : en double, rien de perdu. */
  | { result: "kept-both"; error: unknown };

/**
 * Remontee dans le seul ordre sur (R3) : la page d'avant, complete, est
 * ecrite AVANT que la suite parte a la corbeille. Si cette ecriture
 * echoue, la remontee est defaite et la suite reste ou elle est.
 */
export async function commitPull(steps: PullSteps): Promise<PullResult> {
  try {
    await steps.writeFrom();
  } catch (error) {
    steps.revert();
    return { result: "reverted", error };
  }
  try {
    await steps.trashNext();
  } catch (error) {
    return { result: "kept-both", error };
  }
  return { result: "pulled" };
}

/** Texte sans blancs (ni espaces insecables, ni ​) : ce qu'on compare. */
function squash(s: string): string {
  return s.replace(/[\s​]/g, "");
}

/**
 * Annuler un debordement remet le texte d'avant la frappe dans la page
 * d'avant (`fromText`) et met la page creee a la corbeille. Seulement si
 * le texte de cette page (`toText`) revient bien dans `fromText`, au bout
 * tape pres (au plus `typed` caracteres d'affilee, pas encore dans le texte
 * d'avant) ; sinon on n'annule rien (jamais de perte).
 */
export function textComesBack(toText: string, fromText: string, typed = 10): boolean {
  const to = squash(toText);
  if (!to) return true;
  const back = squash(fromText);
  if (back.includes(to)) return true;
  for (let len = 1; len <= typed; len++) {
    for (let i = 0; i + len <= to.length; i++) {
      if (back.includes(to.slice(0, i) + to.slice(i + len))) return true;
    }
  }
  return false;
}
