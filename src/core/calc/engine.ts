import { create, all, type MathJsInstance, type MathNode } from "mathjs";

/**
 * Moteur de calcul. Aucune dependance a l'interface (section 10) :
 * on doit pouvoir ajouter un bouton sans risquer de casser la derivation.
 */

export type AngleMode = "RAD" | "DEG";

export interface EvalOk {
  ok: true;
  /** Valeur brute mathjs (nombre, complexe, matrice, unite...). */
  raw: unknown;
  /** Resultat formate pour l'affichage. */
  text: string;
  /** Expression telle qu'elle a ete COMPRISE, en LaTeX (section 7). */
  latex: string;
}

export interface EvalErr {
  ok: false;
  message: string;
  latex: string | null;
}

export type EvalResult = EvalOk | EvalErr;

export interface HistoryEntry { expr: string; text: string; latex: string }

const math: MathJsInstance = create(all, { number: "number" });

/** Fonctions trigonometriques en degres, injectees dans le scope en mode DEG. */
function degScope(m: MathJsInstance): Record<string, unknown> {
  // Les surcharges de mathjs sont trop etroites pour un scope generique :
  // ces fonctions doivent accepter reels et complexes indifferemment.
  const f = m as unknown as Record<string, (...args: unknown[]) => unknown>;
  const d2r = (x: unknown) => f.multiply(x, Math.PI / 180);
  const r2d = (x: unknown) => f.multiply(x, 180 / Math.PI);
  return {
    sin: (x: unknown) => f.sin(d2r(x)),
    cos: (x: unknown) => f.cos(d2r(x)),
    tan: (x: unknown) => f.tan(d2r(x)),
    asin: (x: unknown) => r2d(f.asin(x)),
    acos: (x: unknown) => r2d(f.acos(x)),
    atan: (x: unknown) => r2d(f.atan(x)),
  };
}

export class CalcEngine {
  angleMode: AngleMode = "RAD"; // RAD par defaut (section 7)
  ans: unknown = 0;
  history: HistoryEntry[] = [];
  /** Variables definies par l'utilisateur, partagees entre les onglets. */
  vars: Record<string, unknown> = {};

  get math(): MathJsInstance { return math; }

  scope(): Record<string, unknown> {
    return {
      ...this.vars,
      ans: this.ans,
      ...(this.angleMode === "DEG" ? degScope(math) : {}),
    };
  }

  /** Analyse seule : sert a reafficher en permanence ce que le moteur a lu. */
  toLatex(expr: string): string | null {
    const src = normalizeInput(expr).trim();
    if (!src) return null;
    try {
      const tex = math.parse(src).toTex({ parenthesis: "auto" });
      return tex && tex !== "undefined" ? tex : null;
    } catch {
      return null;
    }
  }

  parse(expr: string): MathNode {
    return math.parse(normalizeInput(expr));
  }

  evaluate(expr: string): EvalResult {
    const src = normalizeInput(expr);
    if (!src.trim()) return { ok: false, message: "Expression vide", latex: null };
    let latex: string | null = null;
    try {
      const node = math.parse(src);
      latex = node.toTex({ parenthesis: "auto" });
      const scope = this.scope();
      const raw = node.evaluate(scope);
      // Une affectation (a = 3) enrichit les variables partagees.
      for (const [k, v] of Object.entries(scope)) {
        if (k !== "ans" && !(k in this.vars) && typeof v !== "function") this.vars[k] = v;
      }
      if (raw === undefined) return { ok: false, message: "Pas de resultat", latex };
      const text = format(raw);
      this.ans = raw;
      this.history.push({ expr: src, text, latex });
      if (this.history.length > 200) this.history.shift();
      return { ok: true, raw, text, latex };
    } catch (e) {
      return { ok: false, message: humanError(e), latex };
    }
  }

  /** Les 3 dernieres lignes, plus recente en dernier (section 7). */
  lastLines(n = 3): HistoryEntry[] {
    return this.history.slice(-n);
  }

  reset(): void {
    this.ans = 0;
    this.history = [];
    this.vars = {};
  }
}

/**
 * Tolerance de saisie : le pave TI produit des symboles que mathjs ne lit pas
 * tels quels. On ne touche PAS a la semantique, seulement a l'ecriture.
 */
export function normalizeInput(expr: string): string {
  return expr
    .replace(/π/g, "pi")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/√/g, "sqrt")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/⁻¹/g, "^(-1)")
    .replace(/,(?=\d)/g, ".");
}

export function format(v: unknown): string {
  try {
    return math.format(v, { precision: 12, lowerExp: -9, upperExp: 12 });
  } catch {
    return String(v);
  }
}

/** Messages mathjs en clair, en francais. */
export function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Undefined symbol (\w+)/.test(msg)) {
    const name = /Undefined symbol (\w+)/.exec(msg)![1];
    return `Symbole inconnu : ${name}`;
  }
  if (/Unexpected end of expression/.test(msg)) return "Expression incomplete";
  if (/Parenthesis \) expected/.test(msg)) return "Parenthese fermante manquante";
  if (/Value expected/.test(msg)) return "Valeur attendue";
  if (/Dimension mismatch/.test(msg)) return "Dimensions incompatibles";
  if (/Cannot calculate inv, determinant is zero/.test(msg)) return "Matrice non inversible (determinant nul)";
  return msg;
}
