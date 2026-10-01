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
  /** Resultat en LaTeX (unites, matrices, complexes). */
  resultLatex: string;
}

export interface EvalErr {
  ok: false;
  message: string;
  latex: string | null;
}

export type EvalResult = EvalOk | EvalErr;

/** `expr` est la saisie telle que tapee (jamais la forme normalisee). */
export interface HistoryEntry { expr: string; text: string; latex: string; resultLatex: string }

const math: MathJsInstance = create(all, { number: "number" });

/* ------------------------------------------------------------------ */
/* Residus flottants                                                   */
/* ------------------------------------------------------------------ */

/**
 * Seuil relatif : en dessous de 8 epsilons de l'operande, le resultat n'est
 * que du bruit d'arrondi. Jamais de seuil absolu : 3e-15 F (3 fF) est une
 * vraie valeur en electronique et ne doit pas devenir 0.
 */
const NOISE = 8 * Number.EPSILON;

function isComplex(v: unknown): v is { re: number; im: number } {
  return typeof v === "object" && v !== null && (v as any).isComplex === true;
}

/** sin(pi) vaut 0, pas 1.22e-16 : le bruit est relatif a l'argument. */
function snapTrig(value: unknown, angle: unknown): unknown {
  const arg = typeof angle === "object" && angle !== null && (angle as any).isUnit
    ? (angle as any).toNumber("rad") : angle;
  const scale = typeof arg === "number" ? Math.max(1, Math.abs(arg))
    : isComplex(arg) ? Math.max(1, Math.hypot(arg.re, arg.im)) : null;
  if (scale === null) return value;
  if (typeof value === "number") return Math.abs(value) < NOISE * scale ? 0 : value;
  if (isComplex(value)) {
    const re = Math.abs(value.re) < NOISE * scale ? 0 : value.re;
    const im = Math.abs(value.im) < NOISE * scale ? 0 : value.im;
    return im === 0 ? re : math.complex(re, im);
  }
  return value;
}

/** 0.1 + 0.2 - 0.3 vaut 0 : annulation detectee par rapport aux operandes. */
function snapSum(r: number, a: number, b: number): number {
  return Math.abs(r) < NOISE * 8 * Math.max(Math.abs(a), Math.abs(b)) ? 0 : r;
}

function sumWith(op: "add" | "subtract") {
  const f = math as unknown as Record<string, (a: unknown, b: unknown) => unknown>;
  return (a: unknown, b: unknown): unknown => {
    const r = f[op](a, b);
    if (typeof r === "number" && typeof a === "number" && typeof b === "number") return snapSum(r, a, b);
    if (isComplex(r) && (typeof a === "number" || isComplex(a)) && (typeof b === "number" || isComplex(b))) {
      const ca = math.complex(a as number), cb = math.complex(b as number);
      const re = snapSum(r.re, ca.re, cb.re), im = snapSum(r.im, ca.im, cb.im);
      return im === 0 ? re : math.complex(re, im);
    }
    return r;
  };
}

/** Noms injectes dans le scope : jamais recopies dans les variables. */
const INJECTED = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "__add", "__sub", "ans"]);

/** Trigonometrie RAD ou DEG, nettoyee des residus, tan indefinie signalee. */
function trigScope(m: MathJsInstance, mode: AngleMode): Record<string, unknown> {
  // Les surcharges de mathjs sont trop etroites pour un scope generique :
  // ces fonctions doivent accepter reels et complexes indifferemment.
  const f = m as unknown as Record<string, (...args: unknown[]) => unknown>;
  const deg = mode === "DEG";
  // Un angle avec unite (90 deg, 1 rad) est deja explicite : pas de conversion.
  const isUnit = (x: unknown) => typeof x === "object" && x !== null && (x as any).isUnit === true;
  const d2r = (x: unknown) => (deg && !isUnit(x) ? f.multiply(x, Math.PI / 180) : x);
  const r2d = (x: unknown) => (deg ? f.multiply(x, 180 / Math.PI) : x);
  // Un seul argument : sin(3,5) doit echouer, pas calculer sin(3) en silence.
  const one = (name: string, args: unknown[]) => {
    if (args.length !== 1) throw new Error(`${args.length > 1 ? "Trop d'arguments" : "Argument manquant"} pour ${name}`);
    return args[0];
  };
  const wrap = (name: string) => (...args: unknown[]) => {
    const rad = d2r(one(name, args));
    return snapTrig(f[name](rad), rad);
  };
  return {
    sin: wrap("sin"),
    cos: wrap("cos"),
    tan: (...args: unknown[]) => {
      const rad = d2r(one("tan", args));
      if (typeof rad === "number" && snapTrig(Math.cos(rad), rad) === 0) {
        throw new Error("tan non définie : cos vaut 0 pour cet angle");
      }
      return snapTrig(f.tan(rad), rad);
    },
    asin: (...args: unknown[]) => r2d(f.asin(one("asin", args))),
    acos: (...args: unknown[]) => r2d(f.acos(one("acos", args))),
    atan: (...args: unknown[]) => r2d(f.atan(one("atan", args))),
    __add: sumWith("add"),
    __sub: sumWith("subtract"),
  };
}

/** Remplace les + et - binaires par les versions qui detectent l'annulation. */
function guardSums(node: MathNode): MathNode {
  const mapped = node.map((child: MathNode) => guardSums(child));
  const n = mapped as any;
  if (n.type === "OperatorNode" && n.args.length === 2 && (n.fn === "add" || n.fn === "subtract")) {
    return new math.FunctionNode(new math.SymbolNode(n.fn === "add" ? "__add" : "__sub"), n.args);
  }
  return mapped;
}

export class CalcEngine {
  angleMode: AngleMode = "RAD"; // RAD par defaut (section 7)
  ans: unknown = 0;
  history: HistoryEntry[] = [];
  /** Variables et fonctions definies par l'utilisateur, partagees entre les onglets. */
  vars: Record<string, unknown> = {};

  get math(): MathJsInstance { return math; }

  scope(): Record<string, unknown> {
    return {
      ...this.vars,
      ans: this.ans,
      ...trigScope(math, this.angleMode),
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
      let raw = guardSums(node).evaluate(scope);
      // Une affectation (a = 3, f(x) = x^2) enrichit les variables partagees,
      // y compris quand elle redefinit une variable existante.
      for (const [k, v] of Object.entries(scope)) {
        if (!INJECTED.has(k)) this.vars[k] = v;
      }
      // « a = 1; b = 2 » : on garde la derniere valeur affichee.
      if (raw && typeof raw === "object" && Array.isArray((raw as any).entries) && (raw as any).isResultSet) {
        const entries = (raw as any).entries as unknown[];
        raw = entries.length ? entries[entries.length - 1] : undefined;
        if (raw === undefined) {
          return this.record(expr, "Variables définies", latex, "\\text{ok}", undefined);
        }
      }
      if (typeof raw === "function") {
        const name = (raw as any).syntax ?? "fonction";
        return this.record(expr, `${name} définie`, latex, `\\text{${name} définie}`, undefined);
      }
      if (raw === undefined) return { ok: false, message: "Pas de résultat", latex };
      return this.record(expr, format(raw), latex, resultTex(raw), raw);
    } catch (e) {
      return { ok: false, message: humanError(e), latex };
    }
  }

  private record(expr: string, text: string, latex: string, resultLatex: string, raw: unknown): EvalOk {
    // ans garde la valeur brute ; une definition ne la change pas.
    if (raw !== undefined) this.ans = raw;
    this.history.push({ expr: expr.trim(), text, latex, resultLatex });
    if (this.history.length > 200) this.history.shift();
    return { ok: true, raw, text, latex, resultLatex };
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

/* ------------------------------------------------------------------ */
/* Normalisation de la saisie                                          */
/* ------------------------------------------------------------------ */

/**
 * Tolerance de saisie : le pave TI et le clavier francais produisent des
 * symboles que mathjs ne lit pas tels quels. On ne touche PAS a la semantique,
 * seulement a l'ecriture.
 *
 * - virgule decimale : « 3,5 » vaut 3.5, mais dans un appel de fonction ou
 *   une matrice la virgule reste un separateur (max(1,2), nthRoot(8,3)) ;
 * - ln(x) est le logarithme neperien, log(x) a un argument le decimal (TI),
 *   log(x, b) garde sa base ;
 * - µ et Ω pour les unites (10 µF, 2,2 kΩ).
 */
export function normalizeInput(expr: string): string {
  const s = expr
    .replace(/π/g, "pi")
    .replace(/×|·/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/√/g, "sqrt")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/⁻¹/g, "^(-1)")
    .replace(/[µμ]/g, "u")
    .replace(/Ω/g, "ohm");
  return renameLogs(decimalCommas(s));
}

/** Debut d'un appel de fonction : la parenthese suit un identifiant. */
function isCallParen(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /[A-Za-z0-9_]/.test(s[j])) j--;
  return j + 1 < i && /[A-Za-z_]/.test(s[j + 1]);
}

function decimalCommas(s: string): string {
  const stack: ("call" | "group" | "list")[] = [];
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") stack.push(isCallParen(s, i) ? "call" : "group");
    else if (c === "[" || c === "{") stack.push("list");
    else if (c === ")" || c === "]" || c === "}") stack.pop();
    else if (c === "," && /\d/.test(s[i - 1] ?? "") && /\d/.test(s[i + 1] ?? "")) {
      const top = stack[stack.length - 1];
      if (top === undefined || top === "group") { out += "."; continue; }
    }
    out += c;
  }
  return out;
}

/** log(x) -> log10(x) (un argument), puis ln -> log. Dans cet ordre. */
function renameLogs(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const m = /^log\(/.exec(s.slice(i));
    const before = s[i - 1] ?? "";
    if (m && !/[A-Za-z0-9_]/.test(before)) {
      // Compte les virgules de premier niveau jusqu'a la parenthese fermante.
      let depth = 0, commas = 0, j = i + 3;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) break; }
        else if (c === "," && depth === 1) commas++;
      }
      out += commas === 0 ? "log10(" : "log(";
      i += 4;
      continue;
    }
    out += s[i];
    i++;
  }
  return out.replace(/(^|[^A-Za-z0-9_])ln(?=\s*\()/g, "$1log");
}

/* ------------------------------------------------------------------ */
/* Affichage                                                           */
/* ------------------------------------------------------------------ */

/**
 * Un complexe dont une partie est negligeable devant l'autre l'affiche a 0 :
 * e^(i*pi) vaut -1, pas -1 + 1.2e-16i. Un reel n'est jamais arrondi a 0 ici.
 */
export function cleanValue(v: unknown): unknown {
  if (isComplex(v)) {
    const mod = Math.hypot(v.re, v.im);
    const re = Math.abs(v.re) < NOISE * 8 * mod ? 0 : v.re;
    const im = Math.abs(v.im) < NOISE * 8 * mod ? 0 : v.im;
    return im === 0 ? re : math.complex(re, im);
  }
  return v;
}

export function format(v: unknown): string {
  try {
    return math.format(cleanValue(v), { precision: 12, lowerExp: -9, upperExp: 12 });
  } catch {
    return String(v);
  }
}

/** Resultat en LaTeX (matrices, unites, complexes), via son texte affiche. */
function resultTex(v: unknown): string {
  try {
    return math.parse(format(v)).toTex({ parenthesis: "auto" });
  } catch {
    return `\\text{${format(v)}}`;
  }
}

/** Messages mathjs en clair, en francais. */
export function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  let m: RegExpExecArray | null;
  if ((m = /Undefined symbol (\w+)/.exec(msg))) return `Symbole inconnu : ${m[1]}`;
  if ((m = /Undefined function (\w+)/.exec(msg))) return `Fonction inconnue : ${m[1]}`;
  if (/Unexpected end of expression/.test(msg)) return "Expression incomplète";
  if (/Parenthesis \) expected/.test(msg)) return "Parenthèse fermante manquante";
  if (/Parenthesis \( expected/.test(msg)) return "Parenthèse ouvrante manquante";
  if (/Unexpected operator/.test(msg)) return "Opérateur mal placé";
  if ((m = /Unexpected part "([^"]*)"/.exec(msg))) return `Caractère inattendu : ${m[1]}`;
  if ((m = /Syntax error in part "([^"]*)"/.exec(msg))) return `Écriture non comprise : ${m[1]}`;
  if (/Value expected/.test(msg)) return "Valeur attendue";
  if (/Dimension mismatch|dimensions mismatch/i.test(msg)) return "Dimensions incompatibles";
  if (/determinant is zero/.test(msg)) return "Matrice non inversible (déterminant nul)";
  if (/Matrix must be square|must be square/i.test(msg)) return "La matrice doit être carrée";
  if ((m = /Cannot process function "(\w+)" in derivative/.exec(msg))) {
    return `Dérivée de « ${m[1]} » non prise en charge`;
  }
  if (/Units do not match|Unit .* expected|Unexpected type of argument.*Unit/i.test(msg)) {
    return "Unités incompatibles";
  }
  if ((m = /Too many arguments in function (\w+)/.exec(msg))) return `Trop d'arguments pour ${m[1]}`;
  if ((m = /Too few arguments in function (\w+)/.exec(msg))) return `Arguments manquants pour ${m[1]}`;
  if (/Unexpected type of argument/.test(msg)) return "Type d'argument inattendu";
  if (/Unknown unit/.test(msg)) return "Unité inconnue";
  if (/Cannot convert/i.test(msg)) return "Conversion impossible";
  return msg;
}
