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
