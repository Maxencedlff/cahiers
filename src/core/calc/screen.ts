/**
 * Ecran de l'onglet Calcul, facon TI : saisie avec curseur, enchainement
 * avec ans, rappel de l'historique. Logique pure, sans DOM.
 */

export interface EditState { input: string; caret: number }

/**
 * Decision D10 : apres un resultat, une saisie qui commence par + * / ^ ² ³ !
 * reprend ans (« +1 » donne ans+1). Le « - » reste le moins unaire.
 */
const CHAIN_START = /^[+*/^²³!]/;

export function chainsAns(state: EditState, text: string, hasResult: boolean): boolean {
  return hasResult && state.input === "" && CHAIN_START.test(text);
}

/**
 * Insere au curseur ; prefixe ans si la saisie enchaine sur le resultat.
 * `afterError` : l'expression affichee vient d'echouer ; une nouvelle frappe
 * la remplace (comme une TI), sans reprendre ans. Les fleches et del, eux,
 * gardent l'expression pour la corriger.
 */
export function insertText(state: EditState, text: string, hasResult = false, afterError = false): EditState {
  if (afterError) return { input: text, caret: text.length };
  const t = chainsAns(state, text, hasResult) ? `ans${text}` : text;
  return {
    input: state.input.slice(0, state.caret) + t + state.input.slice(state.caret),
    caret: state.caret + t.length,
  };
}

/**
 * Texte colle dans l'ecran Calcul : une egalite avec une lettre (« 2μ + 3 =
 * 13 », « F(p) = α/p + … », « Feq = … ») part dans Résoudre ; le reste se
 * calcule. Les noms de fonctions et constantes ne comptent pas comme lettres.
 */
export function pasteGoesToSolve(text: string): boolean {
  return /(?<![=<>!])=(?!=)/.test(text) && /\p{L}/u.test(text.replace(/\b(?:sin|cos|tan|exp|ln|log|sqrt|pi|e)\b/g, ""));
}

export function deleteBack(state: EditState): EditState {
  if (state.caret === 0) return state;
  return {
    input: state.input.slice(0, state.caret - 1) + state.input.slice(state.caret),
    caret: state.caret - 1,
  };
}

export function deleteForward(state: EditState): EditState {
  if (state.caret >= state.input.length) return state;
  return { input: state.input.slice(0, state.caret) + state.input.slice(state.caret + 1), caret: state.caret };
}

export function moveCaret(state: EditState, to: number): EditState {
  return { input: state.input, caret: Math.max(0, Math.min(state.input.length, to)) };
}

/**
 * Rappel de l'historique avec ↑ / ↓. `index` vaut null quand on n'est pas
 * dans l'historique ; le brouillon en cours est rendu en redescendant.
 */
export class HistoryRecall {
  private index: number | null = null;
  private draft = "";

  reset(): void { this.index = null; }

  /** dir -1 = plus ancien (↑), +1 = plus recent (↓). Null si rien ne change. */
  step(entries: string[], current: string, dir: -1 | 1): string | null {
    if (!entries.length) return null;
    if (this.index === null) {
      if (dir === 1) return null;
      this.draft = current;
      this.index = entries.length - 1;
      return entries[this.index];
    }
    const next = this.index + dir;
    if (next < 0) return null;
    if (next >= entries.length) {
      this.index = null;
      return this.draft;
    }
    this.index = next;
    return entries[next];
  }
}
