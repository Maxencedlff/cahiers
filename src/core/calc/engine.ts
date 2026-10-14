import { texToPlain } from "../text/doc";
import { create, all, type MathJsInstance, type MathNode } from "mathjs";

/**
 * Moteur de calcul. Aucune dependance a l'interface (section 10) :
 * on doit pouvoir ajouter un bouton sans risquer de casser la derivation.
 */

export type AngleMode = "RAD" | "DEG";
/** Unite imaginaire affichee : j en electronique (defaut), i en maths. */
export type ImagUnit = "i" | "j";

export interface EvalOk {
  ok: true;
  /** Valeur brute mathjs (nombre, complexe, matrice, unite...). */
  raw: unknown;
  /** Resultat complet, forme machine (point decimal, i) : stocke dans les blocs. */
  text: string;
  /** Resultat lisible : virgule, 6 chiffres significatifs, j, ∞. */
  display: string;
  /** Valeur complete a la francaise, quand `display` est arrondi. */
  full?: string;
  /** Forme polaire d'un complexe : « 5 ∠ 53,1301° ». */
  polar?: string;
  /** Lecture ingenieur du resultat (unites, prefixes), si elle aide. */
  eng?: string;
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

/**
 * `expr` est la saisie telle que tapee (jamais la forme normalisee).
 * `eng` : lecture ingenieur (« 7,234 kHz », « 22 µ »), si elle aide.
 */
export interface HistoryEntry {
  expr: string; text: string; latex: string; resultLatex: string; eng?: string;
  /** Lecture a la francaise (voir EvalOk.display). */
  display: string; full?: string; polar?: string;
}

const math: MathJsInstance = create(all, { number: "number" });

/**
 * Fonctions propres a la calculatrice, a installer dans chaque instance
 * mathjs qui lit la sortie de normalizeInput (courbes comprises) :
 * - par(a, b, ...) : resistances en parallele a*b/(a+b), associatif,
 *   reels, complexes (impedances) et unites ; ecrit R1 // R2 ou R1 || R2 ;
 * - __si(n, e) : nombre a prefixe d'ingenieur, seulement pour l'affichage
 *   (« 10 n » au lieu de « 1·10⁻⁸ »).
 */
export function installCalcFunctions(m: MathJsInstance): void {
  const f = m as unknown as Record<string, (...a: unknown[]) => unknown>;
  const par = (...args: unknown[]): unknown => {
    if (args.length < 2) throw new Error("Le parallèle // demande deux valeurs");
    return args.reduce((a, b) => f.divide(f.multiply(a, b), f.add(a, b)));
  };
  (par as any).toTex = (node: any, options: any) =>
    `\\left(${node.args.map((a: any) => a.toTex(options)).join("\\parallel ")}\\right)`;
  const si = (n: unknown, p: unknown) => Number(n) * 10 ** (SI_PREFIX[String(p)] ?? 0);
  (si as any).toTex = (node: any, options: any) => {
    const sym = SI_SYMBOL[SI_PREFIX[String(node.args[1].value)] ?? 0] ?? "";
    return `${node.args[0].toTex(options)}\\,\\mathrm{${sym === "µ" ? "\\mu" : sym}}`;
  };
  m.import({ par, __si: si }, { override: true });
}
installCalcFunctions(math);

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
const INJECTED = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "arg", "__add", "__sub", "ans"]);

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
    // arg suit le mode d'angle, comme les fonctions reciproques.
    arg: (...args: unknown[]) => r2d(f.arg(one("arg", args))),
    __add: sumWith("add"),
    __sub: sumWith("subtract"),
  };
}

/**
 * Fonctions trigonometriques d'un mode d'angle, a passer dans le scope d'une
 * expression compilee hors de CalcEngine (courbes, racines). RAD : rien,
 * mathjs travaille deja en radians.
 */
export function angleScope(mode: AngleMode | undefined): Record<string, unknown> {
  if (mode !== "DEG") return {};
  const { __add: _a, __sub: _s, ...trig } = trigScope(math, "DEG");
  return trig;
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

/** Resultat sous ses deux formes : machine (text) et lisible (display). */
interface Shown { text: string; display: string; full?: string; polar?: string }

/** Une phrase (« f(x) définie ») : meme texte sous les deux formes. */
function plain(t: string): Shown { return { text: t, display: t }; }

export class CalcEngine {
  angleMode: AngleMode = "RAD"; // RAD par defaut (section 7)
  /** Unite imaginaire affichee (j par defaut : TD d'electronique). */
  imagUnit: ImagUnit = "j";
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

  /**
   * Saisie de l'onglet Calcul : normalisee, prefixes d'ingenieur colles a un
   * nombre traduits (2,2k = 2200), sauf si la lettre est une variable definie.
   */
  calcInput(expr: string, mode: "eval" | "tex" = "eval"): { src: string; prefixed: boolean } {
    const reserved = (name: string) => name in this.vars;
    return siPrefixes(normalizeInput(expr, reserved), reserved, mode);
  }

  /**
   * Analyse seule : sert a reafficher en permanence ce que le moteur a lu.
   * `prefixes` : lecture de l'onglet Calcul (2,2k lu 2,2e3).
   */
  toLatex(expr: string, prefixes = false): string | null {
    const reserved = (name: string) => name in this.vars;
    const src = (prefixes ? this.calcInput(expr, "tex").src : normalizeInput(expr, reserved)).trim();
    if (!src) return null;
    try {
      const tex = math.parse(src).toTex({ parenthesis: "auto" });
      if (!tex || tex === "undefined") return null;
      // j tape reste j a l'ecran : c'est ce que l'utilisateur a ecrit.
      const j = typedJ(expr, reserved);
      return texArc(frTexDecimal(j ? texImag(tex, "j") : tex));
    } catch {
      return null;
    }
  }

  parse(expr: string): MathNode {
    return math.parse(normalizeInput(expr));
  }

  evaluate(expr: string): EvalResult {
    const { src, prefixed } = this.calcInput(expr);
    const opts: DisplayOptions = { imag: this.imagUnit, angle: this.angleMode };
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
          return this.record(expr, plain("Variables définies"), latex, "\\text{ok}", undefined);
        }
      }
      if (typeof raw === "function") {
        const name = (raw as any).syntax ?? "fonction";
        return this.record(expr, plain(`${name} définie`), latex, `\\text{${name} définie}`, undefined);
      }
      if (raw === undefined) return { ok: false, message: "Pas de résultat", latex };
      const shown = displayValue(raw, opts);
      const out: Shown = { text: format(raw), display: shown.text };
      if (shown.full) out.full = shown.full;
      if (shown.polar) out.polar = shown.polar;
      return this.record(expr, out, latex, displayTex(raw, opts), raw, engFormat(raw, prefixed));
    } catch (e) {
      return { ok: false, message: humanError(e, expr), latex };
    }
  }

  private record(expr: string, shown: Shown, latex: string, resultLatex: string, raw: unknown, eng?: string): EvalOk {
    // ans garde la valeur brute ; une definition ne la change pas.
    if (raw !== undefined) this.ans = raw;
    const entry: HistoryEntry = { expr: expr.trim(), latex, resultLatex, ...shown };
    if (eng) entry.eng = eng;
    this.history.push(entry);
    if (this.history.length > 200) this.history.shift();
    const r: EvalOk = { ok: true, raw, latex, resultLatex, ...shown };
    if (eng) r.eng = eng;
    return r;
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
export function normalizeInput(expr: string, reserved: (name: string) => boolean = () => false): string {
  // LaTeX colle (copie depuis l'editeur de formule : « $$ \frac{\alpha}{p} $$ ») :
  // relu comme on le tape (« alpha/p »).
  if (/\\[A-Za-z]|\$/.test(expr)) expr = texToPlain(expr.replace(/\$/g, " "));
  // Point de multiplication a la francaise (« (a+b).0,2 », « R.I ») : jamais
  // entre deux chiffres (« 3.5 » reste un nombre).
  expr = expr
    .replace(/\)\s*\.\s*(?=[\w(])/g, ")*")
    .replace(/([A-Za-z])\s*\.\s*(?=[A-Za-z\d(])/g, "$1*")
    .replace(/(\d)\.(?=[A-Za-z(])/g, "$1*");
  const s = imagJ(greekNames(expr), reserved)
    .replace(/π/g, "pi")
    .replace(/×|·/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/√/g, "sqrt")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/⁻¹/g, "^(-1)")
    // µ (signe micro) : toujours le prefixe ; μ grec seulement colle a un
    // nombre (« 4,7μ ») ou entre un nombre et une unite (« 10 μF ») ; sinon
    // c'est une grandeur (« 2 μ + 3 », copie du texte de la page).
    .replace(/µ/g, "u")
    .replace(/(\d)μ/g, "$1u")
    .replace(/(\d\s)μ(?=[FHAVsWgmlLC]\b)/g, "$1u")
    // Ω : l'ohm derriere une valeur (« 100 Ω », « 2,2 kΩ ») ; seul, une grandeur.
    .replace(/(\d\s?[kMmGu]?)Ω/g, "$1ohm");
  return renameLogs(parallel(decimalCommas(s)));
}

/**
 * Lettres grecques en toutes lettres (texte copie de la page : « mu »,
 * « omega », « tau ») : la lettre, une grandeur comme une autre. Sans cela
 * mathjs lit tau = 2π et phi = nombre d'or. pi reste la constante ; un nom
 * suivi d'une parenthese reste une fonction (gamma(5)).
 */
const GREEK_NAMES: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", eta: "η",
  theta: "θ", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", rho: "ρ", sigma: "σ",
  tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", zeta: "ζ",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
const GREEK_WORD = new RegExp(`(?<![A-Za-z_])(${Object.keys(GREEK_NAMES).join("|")})(?![A-Za-z_(])`, "g");

export function greekNames(s: string): string {
  return s.replace(GREEK_WORD, (w) => GREEK_NAMES[w]);
}

/* ------------------------------------------------------------------ */
/* j, unite imaginaire de l'electronique                               */
/* ------------------------------------------------------------------ */

/** j isole : pas dans un nom (adj, jx), pas une variable, pas affecte. */
const LONE_J = /(^|[^A-Za-z_À-ʯͰ-Ͽ])j(?![A-Za-z0-9_])/g;
const J_BEFORE = /(^|[^A-Za-z_À-ʯͰ-Ͽ])j(?=[Ͱ-Ͽ(])/g;

/** La saisie utilise-t-elle j comme unite imaginaire ? */
export function typedJ(expr: string, reserved: (name: string) => boolean = () => false): boolean {
  return imagJ(expr, reserved) !== expr;
}

/**
 * En electronique j = i : 2j, 4j, j*w, jω (j colle a une lettre grecque),
 * j(1+x). Un j defini par l'utilisateur (j = 3) reste sa variable.
 */
function imagJ(expr: string, reserved: (name: string) => boolean): string {
  if (!expr.includes("j") || reserved("j") || /(^|[;\n])\s*j\s*=(?!=)/.test(expr)) return expr;
  return expr.replace(J_BEFORE, "$1i*").replace(LONE_J, "$1i");
}

/** i -> j dans un LaTeX (pas dans \pi, \sin, ni dans un nom). */
export function texImag(tex: string, unit: ImagUnit): string {
  return unit === "j" ? tex.replace(/(?<![\\A-Za-z])i(?![A-Za-z])/g, "j") : tex;
}

/* ------------------------------------------------------------------ */
/* Parallele : R1 // R2, R1 || R2                                      */
/* ------------------------------------------------------------------ */

/**
 * « a // b » et « a || b » deviennent par(a, b). Le parallele lie plus fort
 * que + et - (R1 + R2 // R3 = R1 + (R2 // R3)) et moins fort que * et /
 * (2*R // R = (2R) // R). Associatif : a // b // c = par(a, b, c).
 * Traite chaque niveau de parentheses.
 */
export function parallel(s: string): string {
  if (!/\/\/|\|\|/.test(s)) return s;
  // D'abord l'interieur des groupes, recursivement.
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") {
      const close = matching(s, i);
      if (close < 0) { out += s.slice(i); break; }
      out += c + parallel(s.slice(i + 1, close)) + s[close];
      i = close;
    } else out += c;
  }
  // Puis le niveau courant : termes separes par + - , ; = (binaires).
  const terms: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && isTermBreak(out, i)) {
      terms.push(out.slice(start, i), c);
      start = i + 1;
    }
  }
  terms.push(out.slice(start));
  return terms.map((t, k) => (k % 2 ? t : parTerm(t))).join("");
}

function matching(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if ("([{".includes(s[i])) depth++;
    else if (")]}".includes(s[i]) && --depth === 0) return i;
  }
  return -1;
}

/** + ou - binaire (pas l'exposant de 1e-3), virgule, point-virgule, egal. */
function isTermBreak(s: string, i: number): boolean {
  const c = s[i];
  if (c === "," || c === ";" || c === "=" || c === "\n") return true;
  if (c !== "+" && c !== "-") return false;
  const before = s.slice(0, i).trimEnd();
  if (!before || !/[A-Za-z0-9_.)\]}!'²³Ͱ-Ͽ]$/.test(before)) return false; // unaire
  return !/(^|[^A-Za-z0-9_.])\d+(?:\.\d*)?[eE]$/.test(before); // 1e-3
}

/** Un terme « a // b // c » (au niveau courant) devient par(a, b, c). */
function parTerm(t: string): string {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < t.length - 1; i++) {
    const c = t[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && (t.startsWith("//", i) || t.startsWith("||", i))) {
      parts.push(t.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  if (!parts.length) return t;
  parts.push(t.slice(start));
  const lead = /^\s*/.exec(parts[0])![0];
  return `${lead}par(${parts.map((p) => p.trim()).join(", ")})`;
}

/* ------------------------------------------------------------------ */
/* Prefixes d'ingenieur                                                */
/* ------------------------------------------------------------------ */

/** Prefixes SI colles a un nombre : 2,2k, 10n, 4,7µ, 100m, 1M. */
const SI_PREFIX: Record<string, number> = { p: -12, n: -9, u: -6, m: -3, k: 3, M: 6, G: 9, T: 12 };
const SI_SYMBOL: Record<number, string> = { [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m", 0: "", 3: "k", 6: "M", 9: "G", 12: "T" };

/**
 * « 2.2k » -> « 2.2e3 », sur une saisie deja normalisee (µ devenu u,
 * virgule decimale devenue point). Le prefixe doit etre COLLE au nombre et
 * suivi d'autre chose qu'une lettre, un chiffre ou une parenthese ouvrante :
 * « 2,2kΩ » et « 10nF » restent des unites mathjs, « 5 m » (espace) reste le
 * metre, « 2pi » reste 2π, « 1e-3 » reste une notation scientifique (e n'est
 * pas un prefixe). m colle a un nombre = milli, M = mega, T = tera.
 * `reserved` : nom d'une variable definie, qui garde le produit (k = 5 : 2k = 10).
 */
export function siPrefixes(
  s: string, reserved: (name: string) => boolean = () => false, mode: "eval" | "tex" = "eval",
): { src: string; prefixed: boolean } {
  let prefixed = false;
  const src = s.replace(
    /(^|[^A-Za-z0-9_.])(\d+(?:\.\d*)?|\.\d+)([pnumkMGT])(?![A-Za-z0-9_.(])/g,
    (all, before: string, num: string, p: string) => {
      if (reserved(p)) return all;
      prefixed = true;
      const n = num.replace(/\.$/, "");
      // Affichage : « 10 n », jamais « 1·10⁻⁸ » (voir __si).
      return mode === "tex" ? `${before}__si(${n}, "${p}")` : `${before}${n}e${SI_PREFIX[p]}`;
    },
  );
  return { src, prefixed };
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

/** Mantisse a 4 chiffres significatifs, virgule decimale, zeros inutiles retires. */
function mantissa(x: number): string {
  return String(Number(x.toPrecision(4))).replace(".", ",");
}

/**
 * Lecture ingenieur d'un resultat (section 7, electronique) :
 * - unite : 4 chiffres significatifs, virgule, µ et Ω (« 7,234 kHz ») ;
 * - nombre, seulement si la saisie utilisait un prefixe (2,2k...) : exposant
 *   multiple de 3 et son prefixe (« 22 µ », « 7,234 k »). Sans prefixe, un
 *   calcul de maths (2^10) n'est jamais reecrit en « 1,024 k ».
 * Undefined quand cela n'apporte rien.
 */
export function engFormat(v: unknown, prefixed = false): string | undefined {
  const x = cleanValue(v);
  if (typeof x === "object" && x !== null && (x as any).isUnit) {
    try {
      const t = math.format(x as any, { precision: 4 });
      const m = /^(-?[\d.]+(?:e[+-]?\d+)?)\s*(.*)$/.exec(t);
      if (!m) return undefined;
      const units = m[2]
        .replace(/\b([pnumkMGT]?)ohm\b/g, "$1Ω")
        .replace(/\bu(?=[A-Za-zΩ])/g, "µ");
      return `${m[1].replace(".", ",")} ${units}`.trim();
    } catch {
      return undefined;
    }
  }
  if (!prefixed || typeof x !== "number" || !Number.isFinite(x) || x === 0) return undefined;
  let exp = Math.floor(Math.log10(Math.abs(x)) / 3) * 3;
  exp = Math.max(-12, Math.min(12, exp));
  let m = x / 10 ** exp;
  // 999,96 arrondi a 4 chiffres = 1000 : on passe au prefixe suivant.
  if (Math.abs(Number(m.toPrecision(4))) >= 1000 && exp < 12) { exp += 3; m = x / 10 ** exp; }
  const sym = SI_SYMBOL[exp];
  return sym ? `${mantissa(m)} ${sym}` : mantissa(m);
}

/* ------------------------------------------------------------------ */
/* Lecture a la francaise                                              */
/* ------------------------------------------------------------------ */

export interface DisplayOptions { imag: ImagUnit; angle: AngleMode }

/** Chiffres significatifs affiches : constant partout (ecran, blocs, tableaux). */
export const SIG = 6;

const SUP: Record<string, string> = {
  "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

/** Mantisse et exposant d'une ecriture scientifique a `sig` chiffres. */
function sci(x: number, sig: number): { m: string; exp: number } {
  const [m, e] = x.toExponential(sig - 1).split("e");
  return { m: String(Number(m)).replace(".", ","), exp: Number(e) };
}

/**
 * Nombre a la francaise : virgule decimale, `sig` chiffres significatifs,
 * zeros inutiles retires. Entier exact jusqu'a 10¹² ; ecriture
 * scientifique « 1,5·10⁻¹² » hors de [10⁻⁴, 10⁶[. ∞, -∞, non défini.
 */
export function frNumber(x: number, sig = SIG): string {
  if (Number.isNaN(x)) return "non défini";
  if (!Number.isFinite(x)) return x > 0 ? "∞" : "-∞";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (Number.isInteger(x) && a < 1e12) return String(x);
  if (a >= 1e-4 && a < 1e6) {
    const r = Number(x.toPrecision(sig));
    if (Math.abs(r) < 1e6) return String(r).replace(".", ",");
  }
  const { m, exp } = sci(x, sig);
  return `${m}·10${[...String(exp)].map((c) => SUP[c]).join("")}`;
}

/** Le nombre affiche (a `sig` chiffres) n'est pas la valeur exacte. */
export function isRounded(x: number, sig = SIG): boolean {
  if (!Number.isFinite(x) || Number.isInteger(x) && Math.abs(x) < 1e12) return false;
  return Number(x.toPrecision(sig)) !== x;
}

/** Meme nombre en LaTeX : {,} et \cdot 10^{n}, \infty. */
export function frNumberTex(x: number, sig = SIG): string {
  if (Number.isNaN(x)) return "\\text{non défini}";
  if (!Number.isFinite(x)) return x > 0 ? "\\infty" : "-\\infty";
  const t = frNumber(x, sig);
  const m = /^(-?[\d,]+)·10(.+)$/.exec(t);
  const tex = (n: string) => n.replace(",", "{,}");
  if (!m) return tex(t);
  const exp = [...m[2]].map((c) => Object.keys(SUP).find((k) => SUP[k] === c) ?? c).join("");
  return `${tex(m[1])} \\cdot 10^{${exp}}`;
}

/** a + bj a la francaise ; jamais « 0 + 2j », jamais « 1j ». */
function complexText(re: number, im: number, unit: ImagUnit, num: (x: number) => string): string {
  const imPart = (v: number) => (Math.abs(v) === 1 ? unit : `${num(Math.abs(v))}${unit}`);
  if (re === 0) return `${im < 0 ? "-" : ""}${imPart(im)}`;
  return `${num(re)} ${im < 0 ? "-" : "+"} ${imPart(im)}`;
}

/** Forme polaire : module ∠ argument (degres en DEG, sinon radians). */
export function polarText(re: number, im: number, angle: AngleMode): string {
  const mod = frNumber(Math.hypot(re, im));
  const arg = Math.atan2(im, re);
  return angle === "DEG" ? `${mod} ∠ ${frNumber(arg * 180 / Math.PI)}°` : `${mod} ∠ ${frNumber(arg)} rad`;
}

/**
 * Lecture d'un resultat : `text` arrondi a SIG chiffres, `full` la valeur
 * complete quand elle differe, `polar` pour un complexe.
 */
export function displayValue(v: unknown, opts: DisplayOptions): { text: string; full?: string; polar?: string } {
  const x = cleanValue(v);
  if (typeof x === "number") {
    const text = frNumber(x);
    return isRounded(x) ? { text, full: frNumber(x, 15) } : { text };
  }
  if (isComplex(x)) {
    const text = complexText(x.re, x.im, opts.imag, (n) => frNumber(n));
    const full = complexText(x.re, x.im, opts.imag, (n) => frNumber(n, 15));
    const out: { text: string; full?: string; polar?: string } = { text, polar: polarText(x.re, x.im, opts.angle) };
    if (full !== text) out.full = full;
    return out;
  }
  if (typeof x === "boolean") return { text: x ? "vrai" : "faux" };
  if (typeof x === "object" && x !== null && (x as any).isUnit) {
    const eng = engFormat(x);
    return eng ? { text: eng, full: frPlain(format(x)) } : { text: frPlain(format(x)) };
  }
  if (typeof x === "object" && x !== null && typeof (x as any).toArray === "function") {
    // Matrice : ; separe les cellules (la virgule est decimale).
    const cell = (c: unknown): string => (Array.isArray(c) ? `[${c.map(cell).join(" ; ")}]` : displayValue(c, opts).text);
    return { text: cell((x as any).toArray()) };
  }
  return { text: format(x) };
}

/** Texte mathjs (point decimal) a la francaise, hors separateurs. */
function frPlain(t: string): string {
  return t.replace(/(\d)\.(\d)/g, "$1,$2");
}

/** Resultat en LaTeX, a la francaise (arrondi, j, ∞). */
export function displayTex(v: unknown, opts: DisplayOptions): string {
  const x = cleanValue(v);
  if (typeof x === "number") return frNumberTex(x);
  if (isComplex(x)) {
    const unit = `\\,${opts.imag}`;
    const im = Math.abs(x.im) === 1 ? unit.slice(2) : `${frNumberTex(Math.abs(x.im))}${unit}`;
    if (x.re === 0) return `${x.im < 0 ? "-" : ""}${im}`;
    return `${frNumberTex(x.re)} ${x.im < 0 ? "-" : "+"} ${im}`;
  }
  if (typeof x === "object" && x !== null && (x as any).isUnit) {
    const eng = engFormat(x);
    const m = eng ? /^(\S+)\s*(.*)$/.exec(eng) : null;
    if (m) return `${m[1].replace(",", "{,}")}${m[2] ? `\\,\\text{${m[2]}}` : ""}`;
  }
  try {
    return frTexDecimal(math.parse(format(x)).toTex({ parenthesis: "auto" }));
  } catch {
    return `\\text{${format(x)}}`;
  }
}

/** Point decimal des nombres d'un LaTeX mis en virgule ({,} : sans espace). */
export function frTexDecimal(tex: string): string {
  return tex.replace(/(\d)\.(\d)/g, "$1{,}$2");
}

/** Notation francaise des reciproques : arctan, pas tan⁻¹. */
export function texArc(tex: string): string {
  return tex.replace(/\\(sin|cos|tan)\^\{-1\}/g, "\\arc$1");
}

/**
 * Morceau cite par mathjs (forme normalisee : 2.2, 2.2e3, pi) ramene a ce
 * que l'utilisateur a tape (2,2 ; 2,2k ; π), quand on le retrouve.
 */
function typedPart(part: string, typed?: string): string {
  if (!typed) return part;
  const back = (t: string) => t
    .replace(/(\d)e(-?\d+)/g, (all, d: string, e: string) => {
      const p = Object.entries(SI_PREFIX).find(([, v]) => v === Number(e))?.[0];
      return p ? `${d}${p === "u" ? "µ" : p}` : all;
    });
  const tries = [part, part.replace(/\./g, ","), back(part), back(part).replace(/\./g, ","), part.replace(/\bpi\b/g, "π")];
  return tries.find((t) => typed.includes(t)) ?? part.replace(/(\d)\.(\d)/g, "$1,$2");
}

/** Messages mathjs en clair, en francais. `typed` : la saisie, pour la citer. */
export function humanError(e: unknown, typed?: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  let m: RegExpExecArray | null;
  if ((m = /Undefined symbol (\w+)/.exec(msg))) return `Symbole inconnu : ${m[1]}`;
  if ((m = /Undefined function (\w+)/.exec(msg))) return `Fonction inconnue : ${m[1]}`;
  if (/Unexpected end of expression/.test(msg)) return "Expression incomplète";
  if (/Parenthesis \) expected/.test(msg)) return "Parenthèse fermante manquante";
  if (/Parenthesis \( expected/.test(msg)) return "Parenthèse ouvrante manquante";
  if (/Unexpected operator/.test(msg)) return "Opérateur mal placé";
  if ((m = /Unexpected part "([^"]*)"/.exec(msg))) return `Caractère inattendu : ${typedPart(m[1], typed)}`;
  if ((m = /Syntax error in part "([^"]*)"/.exec(msg))) return `Écriture non comprise : ${typedPart(m[1], typed)}`;
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
