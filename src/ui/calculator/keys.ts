/**
 * Pave type Texas Instruments (section 7).
 *
 * Chaque touche declare sa famille, qui determine sa couleur. Les couleurs
 * sont semantiques et non decoratives : elles servent a trouver une touche
 * sans lire son label. Les chiffres restent neutres, ce sont les plus
 * utilises et les colorer ecraserait tout le reste.
 */

export type KeyFamily = "num" | "op" | "fn" | "const" | "del" | "2nd" | "eq";

export interface Key {
  label: string;
  /** Texte insere dans la saisie. Absent pour les touches d'action. */
  insert?: string;
  action?: "equals" | "del" | "clear" | "second" | "mode" | "left" | "right";
  family: KeyFamily;
  /** Comportement quand 2nd est actif. Le label affiche change aussi. */
  second?: { label: string; insert?: string };
  span?: number;
}

export const KEYPAD: Key[] = [
  { label: "2nd", action: "second", family: "2nd" },
  { label: "RAD", action: "mode", family: "fn" },
  { label: "<", action: "left", family: "del" },
  { label: ">", action: "right", family: "del" },
  { label: "del", action: "del", family: "del", second: { label: "clear" } },

  { label: "x²", insert: "^2", family: "fn", second: { label: "√", insert: "sqrt(" } },
  { label: "xʸ", insert: "^", family: "fn", second: { label: "ʸ√x", insert: "nthRoot(" } },
  { label: "√", insert: "sqrt(", family: "fn", second: { label: "abs", insert: "abs(" } },
  { label: "log", insert: "log10(", family: "fn", second: { label: "10ˣ", insert: "10^" } },
  { label: "ln", insert: "log(", family: "fn", second: { label: "eˣ", insert: "exp(" } },

  { label: "sin", insert: "sin(", family: "fn", second: { label: "sin⁻¹", insert: "asin(" } },
  { label: "cos", insert: "cos(", family: "fn", second: { label: "cos⁻¹", insert: "acos(" } },
  { label: "tan", insert: "tan(", family: "fn", second: { label: "tan⁻¹", insert: "atan(" } },
  { label: "(", insert: "(", family: "op" },
  { label: ")", insert: ")", family: "op" },

  { label: "π", insert: "pi", family: "const" },
  { label: "e", insert: "e", family: "const" },
  { label: "i", insert: "i", family: "const" },
  { label: "ans", insert: "ans", family: "const" },
  { label: "x⁻¹", insert: "^(-1)", family: "fn", second: { label: "!", insert: "!" } },

  { label: "7", insert: "7", family: "num" },
  { label: "8", insert: "8", family: "num" },
  { label: "9", insert: "9", family: "num" },
  { label: "÷", insert: "/", family: "op" },
  { label: "(−)", insert: "-", family: "op" },

  { label: "4", insert: "4", family: "num" },
  { label: "5", insert: "5", family: "num" },
  { label: "6", insert: "6", family: "num" },
  { label: "×", insert: "*", family: "op" },
  { label: ",", insert: ",", family: "op" },

  { label: "1", insert: "1", family: "num" },
  { label: "2", insert: "2", family: "num" },
  { label: "3", insert: "3", family: "num" },
  { label: "−", insert: "-", family: "op" },
  { label: "x", insert: "x", family: "const" },

  { label: "0", insert: "0", family: "num", span: 2 },
  { label: ".", insert: ".", family: "num" },
  { label: "+", insert: "+", family: "op" },
  { label: "=", action: "equals", family: "eq" },
];

export const FAMILY_CLASS: Record<KeyFamily, string> = {
  num: "k-num",
  op: "k-op",
  fn: "k-fn",
  const: "k-const",
  del: "k-del",
  "2nd": "k-2nd",
  eq: "k-eq",
};

/* ---------------- clavier physique ---------------- */

/** Ce que fait une touche du clavier dans l'onglet Calcul. */
export type KeyCommand =
  | { kind: "insert"; text: string }
  | { kind: "action"; action: "equals" | "back" | "delete" | "left" | "right" | "home" | "end" | "up" | "down" | "escape" }
  | { kind: "swallow" };

/** Caracteres acceptes a la frappe (lettres pour les fonctions et les unites). */
const TYPABLE = /^[0-9A-Za-z+\-*/^().,!=[\];%²³π _µΩ]$/;

/** Sous-ensemble de KeyboardEvent, pour tester sans DOM. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Traduit une frappe. Null = la calculatrice laisse passer (raccourcis
 * Ctrl+L, Ctrl+Z... restent a l'application).
 *
 * AZERTY : « ^ » est une touche morte (key "Dead", code "BracketLeft") ;
 * AltGr arrive comme Ctrl+Alt et sert a taper [ ] { } sur ce clavier.
 */
export function mapKey(e: KeyLike): KeyCommand | null {
  if (e.metaKey) return null;
  const altGr = !!e.ctrlKey && !!e.altKey;
  if ((e.ctrlKey || e.altKey) && !altGr) return null;
  if (e.key === "Dead") {
    if (e.code === "BracketLeft" && !e.shiftKey) return { kind: "insert", text: "^" };
    return { kind: "swallow" }; // ¨, ` ... : rien a inserer
  }
  if (altGr) {
    // Seuls les caracteres d'AltGr (crochets, accolades) ; jamais une lettre.
    return e.key.length === 1 && /[[\]{}^|]/.test(e.key) ? { kind: "insert", text: e.key } : null;
  }
  switch (e.key) {
    case "Enter": return { kind: "action", action: "equals" };
    case "Backspace": return { kind: "action", action: "back" };
    case "Delete": return { kind: "action", action: "delete" };
    case "ArrowLeft": return { kind: "action", action: "left" };
    case "ArrowRight": return { kind: "action", action: "right" };
    case "Home": return { kind: "action", action: "home" };
    case "End": return { kind: "action", action: "end" };
    case "ArrowUp": return { kind: "action", action: "up" };
    case "ArrowDown": return { kind: "action", action: "down" };
    case "Escape": return { kind: "action", action: "escape" };
  }
  if (TYPABLE.test(e.key)) return { kind: "insert", text: e.key };
  return null;
}
