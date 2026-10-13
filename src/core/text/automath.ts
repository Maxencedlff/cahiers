/**
 * Formules automatiques dans le texte tape.
 *
 * Repere dans une ligne de texte brut les morceaux qui sont des formules
 * ("Vs = Vz - Vbe", "iD = (Vz - Vbe)/(beta.Ru) - (vbatt - Vz)/R") et les
 * traduit en LaTeX pour qu'ils s'affichent comme de vraies formules :
 * fractions, indices (Vbe -> V_{be}), lettres grecques, relations.
 *
 * Le texte courant ne doit jamais etre pris pour une formule. D'ou des regles
 * volontairement prudentes : une formule contient toujours un operateur
 * entre deux operandes, un mot francais (accents, mot outil, mot long) coupe
 * la formule, et deux operandes separes par un espace ne se multiplient que
 * derriere un nombre ou une lettre grecque ("2 R", "beta Ru"), ou entre deux
 * grandeurs dans une formule deja commencee ("U = R I"). Une variable seule
 * ("Vz") suit une liste blanche et attend de voir le mot suivant.
 *
 * Module sans DOM.
 */

export interface FoundFormula {
  start: number;
  end: number;
  latex: string;
}

/**
 * Moment de la relecture, pour les variables seules ("Vz", "I1") :
 * - "final" : la ligne est finie (Entree) ou relue en entier ;
 * - "space" : on vient de taper une espace, le mot suivant n'est pas encore
 *   la. Une variable en fin de ligne attend : "iD" puis " = (Vz" doit
 *   rester une seule formule ;
 * - "pause" : simple pause de frappe, peut-etre au milieu d'un mot ("Qu"
 *   puis "and") : aucune variable seule.
 */
export type ScanMode = "final" | "space" | "pause";

type Tok =
  | { t: "num"; s: string; a: number; b: number }
  | { t: "id"; s: string; a: number; b: number }
  | { t: "op"; s: string; a: number; b: number }
  | { t: "sp"; s: string; a: number; b: number }
  | { t: "other"; s: string; a: number; b: number };

const GREEK_NAMES: Record<string, string> = {
  alpha: "\\alpha", beta: "\\beta", gamma: "\\gamma", delta: "\\delta",
  epsilon: "\\varepsilon", eps: "\\varepsilon", eta: "\\eta", theta: "\\theta", lambda: "\\lambda",
  mu: "\\mu", pi: "\\pi", rho: "\\rho", sigma: "\\sigma", tau: "\\tau",
  phi: "\\varphi", omega: "\\omega",
  Gamma: "\\Gamma", Delta: "\\Delta", Theta: "\\Theta", Lambda: "\\Lambda",
  Sigma: "\\Sigma", Phi: "\\Phi", Omega: "\\Omega",
};

const GREEK_CHARS: Record<string, string> = {
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\varepsilon",
  "η": "\\eta", "θ": "\\theta", "λ": "\\lambda", "μ": "\\mu", "π": "\\pi",
  "ρ": "\\rho", "σ": "\\sigma", "τ": "\\tau", "φ": "\\varphi", "ω": "\\omega",
  "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta", "Λ": "\\Lambda", "Π": "\\Pi",
  "Σ": "\\Sigma", "Φ": "\\Phi", "Ω": "\\Omega",
};

/** Lettre grecque en toutes lettres + chiffres : omega0, tau1. */
const GREEK_NAME_SUB = new RegExp(`^(${Object.keys(GREEK_NAMES).join("|")})(\\d{1,2})$`);

/** Lettre grecque + indice : ω0, ωc, τ1. */
const GREEK_SUB = new RegExp(`^[${Object.keys(GREEK_CHARS).join("")}](?:[0-9]{1,2}|[a-z]{1,2})$`);

const FUNCS: Record<string, string> = {
  sin: "\\sin", cos: "\\cos", tan: "\\tan", ln: "\\ln", log: "\\log",
  exp: "\\exp", sqrt: "\\sqrt",
  arctan: "\\arctan", arcsin: "\\arcsin", arccos: "\\arccos",
  sinh: "\\sinh", cosh: "\\cosh", tanh: "\\tanh",
};

/**
 * Operateurs nommes, seulement colles a une parenthese : "Re(Z)" est la
 * partie reelle, "Re" seul reste la resistance R_e.
 */
const OPNAMES: Record<string, string> = {
  Re: "\\operatorname{Re}", Im: "\\operatorname{Im}", arg: "\\arg",
  max: "\\max", min: "\\min", det: "\\det",
};

/**
 * Grands operateurs a bornes, tapes comme en LaTeX sans barre oblique :
 * "lim_(x->0) sin(x)/x", "sum_(k=0)^n k", "int_0^1 x^2 dx". Seulement
 * colles a un "_" (une integrale sans bornes doit finir par "dx") : "int x"
 * d'un programme C reste du texte.
 */
const BIGOPS: Record<string, string> = {
  lim: "\\lim", sum: "\\sum", prod: "\\prod", int: "\\int",
};

/** Ensembles de nombres deja tapes en symbole (ℝ) ou en double lettre (RR). */
const SET_CHARS: Record<string, string> = {
  "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}",
};

/**
 * j devant des grandeurs, ou pulsation w collee a R, L, C : produit, pas
 * indice. "jLw" = j·L·ω, "jRCw" = j·R·C·ω, "RCw" = R·C·ω, "jω" = j·ω.
 * "RC" seul (sans j ni w) garde la lecture d'avant.
 */
const IMAG = /^(?:j[RLC]{1,3}[wω]?|j[wω]|[RLC]*[LC][RLC]*[wω])$/;

function imagTex(s: string): string {
  const parts = [...s].map((c) => (c === "w" || c === "ω" ? "\\omega" : c));
  // "jw" s'ecrit j\omega, comme avant ; sinon un petit espace entre facteurs.
  if (parts.length === 2 && parts[0] === "j" && parts[1] === "\\omega") return "j\\omega";
  return parts.join("\\,");
}

/** Mots du francais courant qui ne sont jamais des variables. */
const STOP = new Set([
  "a", "et", "ou", "on", "le", "la", "les", "de", "des", "du", "au", "aux",
  "un", "une", "il", "ils", "elle", "en", "ce", "ces", "cet", "se", "sa",
  "son", "ses", "si", "ne", "ni", "je", "tu", "me", "te", "ma", "mon", "ta",
  "ton", "que", "qui", "or", "car", "donc", "mais", "pour", "par", "pas",
  "sur", "sous", "avec", "sans", "dans", "vers", "voir", "puis", "plus",
  "peu", "est", "sont", "ici", "soit", "alors", "ainsi", "comme", "tout",
  "tous", "cas", "oui", "non", "quel", "lors", "via", "nous", "vous", "leur",
  "fois", "cela", "ceci", "tres", "bien", "sinon", "entre", "avant", "apres",
]);

const UNITS: Record<string, string> = {
  V: "\\mathrm{V}", mV: "\\mathrm{mV}", kV: "\\mathrm{kV}",
  A: "\\mathrm{A}", mA: "\\mathrm{mA}", "µA": "\\mu\\mathrm{A}",
  W: "\\mathrm{W}", mW: "\\mathrm{mW}", kW: "\\mathrm{kW}",
  "Ω": "\\Omega", "kΩ": "\\mathrm{k}\\Omega", "MΩ": "\\mathrm{M}\\Omega",
  ohm: "\\Omega", ohms: "\\Omega",
  Hz: "\\mathrm{Hz}", kHz: "\\mathrm{kHz}", MHz: "\\mathrm{MHz}",
  s: "\\mathrm{s}", ms: "\\mathrm{ms}", "µs": "\\mu\\mathrm{s}",
  F: "\\mathrm{F}", "µF": "\\mu\\mathrm{F}", nF: "\\mathrm{nF}", pF: "\\mathrm{pF}",
  H: "\\mathrm{H}", mH: "\\mathrm{mH}", "%": "\\%",
  Ohm: "\\Omega", dB: "\\mathrm{dB}", dec: "\\mathrm{dec}",
  m: "\\mathrm{m}", km: "\\mathrm{km}", cm: "\\mathrm{cm}", mm: "\\mathrm{mm}",
  "µm": "\\mu\\mathrm{m}", nm: "\\mathrm{nm}", rad: "\\mathrm{rad}",
  g: "\\mathrm{g}", kg: "\\mathrm{kg}", mg: "\\mathrm{mg}", N: "\\mathrm{N}",
  J: "\\mathrm{J}", kJ: "\\mathrm{kJ}", Wh: "\\mathrm{Wh}", kWh: "\\mathrm{kWh}",
  Pa: "\\mathrm{Pa}", kPa: "\\mathrm{kPa}", bar: "\\mathrm{bar}",
  bit: "\\mathrm{bit}", bits: "\\mathrm{bits}", ko: "\\mathrm{ko}", Ko: "\\mathrm{Ko}",
  Mo: "\\mathrm{Mo}", Go: "\\mathrm{Go}", To: "\\mathrm{To}",
  // Multiples tapes au clavier : kOhm pour kΩ, u pour µ (uF, uA, us).
  kOhm: "\\mathrm{k}\\Omega", MOhm: "\\mathrm{M}\\Omega", kohm: "\\mathrm{k}\\Omega",
  uF: "\\mu\\mathrm{F}", uA: "\\mu\\mathrm{A}", uH: "\\mu\\mathrm{H}", uV: "\\mu\\mathrm{V}",
  us: "\\mu\\mathrm{s}", "µH": "\\mu\\mathrm{H}", "µV": "\\mu\\mathrm{V}", nH: "\\mathrm{nH}",
  ns: "\\mathrm{ns}", GHz: "\\mathrm{GHz}", mF: "\\mathrm{mF}",
};

/** Mot qui est une unite ("Hz", "dB", "Mo") : jamais une variable seule. */
export function isUnit(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(UNITS, s);
}

const REL: Record<string, string> = {
  "=": "=", "<": "<", ">": ">", "<=": "\\leq", "≤": "\\leq", ">=": "\\geq",
  "≥": "\\geq", "!=": "\\neq", "≠": "\\neq", "~=": "\\approx", "≈": "\\approx",
  "<<": "\\ll", "≪": "\\ll", ">>": "\\gg", "≫": "\\gg", "->": "\\to",
  "→": "\\to", "=>": "\\Rightarrow", "⇒": "\\Rightarrow", "<=>": "\\Leftrightarrow",
  "⇔": "\\Leftrightarrow",
  "∈": "\\in", "∉": "\\notin", "⊂": "\\subset", "⊆": "\\subseteq",
};
const PRODUCT = new Set(["·", "*", "×", "."]);
const SUMOP = new Set(["+", "-", "−"]);

const MULTI_OPS = ["<=>", "<=", ">=", "!=", "~=", "->", "=>", "<<", ">>"];
const SINGLE_OPS = "=<>≈≤≥≠≪≫→⇒⇔∈∉⊂⊆∀∃+-−*·×/^()|²³._'";

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const rest = line.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^[\s​ ]+/))) {
      out.push({ t: "sp", s: m[0], a: i, b: i + m[0].length }); i += m[0].length; continue;
    }
    if ((m = rest.match(/^\d+(?:[.,]\d+)?/))) {
      out.push({ t: "num", s: m[0], a: i, b: i + m[0].length }); i += m[0].length; continue;
    }
    // Un mot entier, accents compris : un accent le disqualifie ensuite.
    if ((m = rest.match(/^[A-Za-zÀ-ÖØ-öø-ÿœŒµͰ-Ͽ][A-Za-z0-9À-ÖØ-öø-ÿœŒͰ-Ͽ]*/))) {
      out.push({ t: "id", s: m[0], a: i, b: i + m[0].length }); i += m[0].length; continue;
    }
    // Ensembles et infini tapes en symbole : des grandeurs.
    if (c in SET_CHARS || c === "∞") {
      out.push({ t: "id", s: c, a: i, b: i + 1 }); i++; continue;
    }
    const multi = MULTI_OPS.find((o) => rest.startsWith(o));
    if (multi) { out.push({ t: "op", s: multi, a: i, b: i + multi.length }); i += multi.length; continue; }
    if (SINGLE_OPS.includes(c) || c === "%") {
      out.push({ t: c === "%" ? "id" : "op", s: c, a: i, b: i + 1 } as Tok); i++; continue;
    }
    out.push({ t: "other", s: c, a: i, b: i + 1 }); i++;
  }
  return out;
}

function isGreek(s: string): boolean {
  return s in GREEK_NAMES || (s.length === 1 && s in GREEK_CHARS);
}

const LOWER_VAR = /^[viu](?:batt|bat|ce|be|cb|cc|ee|dd|ss|in|out|ref|max|min|ch|eff|moy|pp|th)$/;

/** Differentielle d'une integrale : dx, dt, dθ. */
const DIFF = /^d(?:[a-zA-Z]|[α-ω])$/;

/** Pulsation tapee en "w" : wt, jw, jwt (omega t). */
const OMEGA_WORD = /^(?:jw|wt|jwt)$/;

/**
 * Noms usuels a indice dont l'initiale est une minuscule ou une lettre
 * grecque : fc, f0, fe (frequences), w0, wc, ω0, ωc, τ1 (pulsations,
 * constantes de temps). Sans cela "fc" serait le produit f·c, comme "ax".
 */
const LOWER_SUB = /^(?:f[cehlps0-9]|w[c0-9])$/;


/**
 * Grandeurs dont le nom est aussi un mot outil du francais ("Te" = te) :
 * variables dans une formule ("Te = 1/Fe"), jamais seules dans une phrase.
 */
const FORMULA_ONLY = new Set(["Te"]);

/**
 * Grandeurs seules hors des initiales V I U R C L P Z (voir loneVariable) :
 * frequences, periodes d'echantillonnage, Thevenin, gains, pulsations.
 * Liste fermee : "Av" (avenue), "Ad" restent du texte hors formule.
 */
const LONE_NAMES = new Set([
  "fc", "fe", "fs", "fh", "fl", "fp", "f0", "f1", "f2", "Fe", "Fs", "F0", "Ts", "T0",
  "Eth", "Gv", "Gd", "w0", "ω0", "ωc", "τ1", "τ2",
]);

/**
 * Mot outil du francais tel qu'on l'ecrit : "il", "Il". "iL", "IL" (casse
 * melangee ou majuscules) sont des grandeurs.
 */
function stopWord(s: string): boolean {
  const l = s.toLowerCase();
  return STOP.has(l) && (s === l || s === l[0].toUpperCase() + l.slice(1));
}

/** Le mot peut-il etre une variable ? */
function validIdent(s: string): boolean {
  if (isGreek(s) || s in FUNCS || GREEK_SUB.test(s) || FORMULA_ONLY.has(s)) return true;
  if (GREEK_NAME_SUB.test(s)) return true;
  if (s in SET_CHARS || s === "∞" || IMAG.test(s)) return true;
  if (/[^A-Za-z0-9]/.test(s)) return false; // accents, lettres grecques collees
  // "IL", "iL" : des grandeurs (courant dans L), pas « il » ; "IL" en
  // majuscules seulement dans une formule (voir loneVariable).
  if (stopWord(s)) return false;
  if (s.length > 6) return false;
  if (OMEGA_WORD.test(s)) return true;
  // Mot en minuscules de 3 lettres ou plus : seulement les tensions et
  // courants a la francaise (vbatt, vce, icc, vout...), jamais "vaut".
  if (/^[a-z]{3,}$/.test(s)) return LOWER_VAR.test(s);
  // Majuscule + 4 lettres ou plus : Vbatt oui, Zener ou Pont non.
  if (/^[A-Z][a-z]{4,}$/.test(s)) return /^[VIU]/.test(s);
  // Sigle de 3 lettres ou plus (TCP, USB, AOP) : du texte.
  if (/^[A-Z]{3,}$/.test(s)) return false;
  return true;
}

function identTex(s: string): string {
  if (s in GREEK_NAMES) return GREEK_NAMES[s];
  if (s in SET_CHARS) return SET_CHARS[s];
  const gs = GREEK_NAME_SUB.exec(s);
  if (gs) return `${GREEK_NAMES[gs[1]]}_${gs[2].length === 1 ? gs[2] : `{${gs[2]}}`}`;
  if (s === "∞" || s === "inf" || s === "infty") return "\\infty";
  if (IMAG.test(s)) return imagTex(s);
  if (s.length === 1 && s in GREEK_CHARS) return GREEK_CHARS[s];
  if (OMEGA_WORD.test(s)) return s === "wt" ? "\\omega t" : s === "jw" ? "j\\omega" : "j\\omega t";
  // fc, fe : indice ; w0, ω0 : omega indice.
  if (LOWER_SUB.test(s)) return `${s[0] === "w" ? "\\omega" : s[0]}_${s.slice(1)}`;
  if (GREEK_SUB.test(s)) {
    const sub = s.slice(1);
    return `${GREEK_CHARS[s[0]]}_${sub.length === 1 ? sub : `{${sub}}`}`;
  }
  // Deux minuscules hors tensions (ax, ac) : un produit, pas un indice.
  // vs, id, ic gardent l'indice (v_s, i_d).
  if (/^[a-z]{2}$/.test(s) && !/^[viu]/.test(s)) return `${s[0]}\\,${s[1]}`;
  // j devant une grandeur : l'imaginaire (jL -> j L).
  if (/^j[A-Z]$/.test(s)) return `j\\,${s[1]}`;
  const m = s.match(/^([A-Za-z])([A-Za-z0-9]+)$/);
  if (!m) return s;
  return m[2].length === 1 ? `${m[1]}_${m[2]}` : `${m[1]}_{${m[2]}}`;
}

interface Node { tex: string; group?: string; ops: number; vars: number }

class Parser {
  private i = 0;
  /** Un operateur a deja ete lu : on est dans une formule. */
  private seenOp = false;
  /** Corps d'integrale en cours de lecture : "dx" le termine. */
  private inIntegral = 0;
  /** Bornes d'un intervalle en cours de lecture (voir interval). */
  private inInterval = 0;
  /** Bornes lues comme grandeur seulement parce qu'on est dans un intervalle. */
  private relaxed = 0;
  constructor(private toks: Tok[], start: number) { this.i = start; }

  get pos(): number { return this.i; }

  private skipSp(): void {
    while (this.toks[this.i]?.t === "sp") this.i++;
  }

  private peek(): Tok | undefined {
    let j = this.i;
    while (this.toks[j]?.t === "sp") j++;
    return this.toks[j];
  }

  /** Espace entre la position courante et le prochain jeton ? */
  private spaced(): boolean { return this.toks[this.i]?.t === "sp"; }

  /** Jeton non blanc juste avant l'indice `at`. */
  private before(at: number): Tok | undefined {
    let j = at - 1;
    while (this.toks[j]?.t === "sp") j--;
    return this.toks[j];
  }

  relation(): Node | null {
    const first = this.sum();
    if (!first) return null;
    let tex = first.tex, ops = first.ops, vars = first.vars;
    for (;;) {
      const save = this.i, seen = this.seenOp;
      const t = this.peek();
      // "x in [0, IL]" : appartient, devant un intervalle.
      const inInterval = t?.t === "id" && t.s === "in" && this.intervalAfter();
      if (!inInterval && (t?.t !== "op" || !(t.s in REL))) break;
      this.skipSp(); this.i++;
      this.seenOp = true;
      const rhs = this.sum();
      if (!rhs) { this.i = save; this.seenOp = seen; break; }
      tex += ` ${inInterval ? "\\in" : REL[t!.s]} ${rhs.tex}`; ops += 1 + rhs.ops; vars += rhs.vars;
    }
    return { tex, ops, vars };
  }

  /** Le prochain jeton (un mot) est-il suivi d'un crochet d'intervalle ? */
  private intervalAfter(): boolean {
    let j = this.i;
    while (this.toks[j]?.t === "sp") j++;
    j++;
    while (this.toks[j]?.t === "sp") j++;
    const n = this.toks[j];
    return n?.t === "other" && (n.s === "[" || n.s === "]");
  }

  private sum(): Node | null {
    const first = this.product();
    if (!first) return null;
    let tex = first.tex, ops = first.ops, vars = first.vars;
    for (;;) {
      const save = this.i, seen = this.seenOp;
      const t = this.peek();
      if (t?.t !== "op" || !SUMOP.has(t.s)) break;
      this.skipSp(); this.i++;
      this.seenOp = true;
      const rhs = this.product();
      if (!rhs) { this.i = save; this.seenOp = seen; break; }
      tex += ` ${t.s === "+" ? "+" : "-"} ${rhs.tex}`; ops += 1 + rhs.ops; vars += rhs.vars;
    }
    return { tex, ops, vars };
  }

  private product(): Node | null {
    const first = this.unary();
    if (!first) return null;
    let cur: Node = first;
    for (;;) {
      const save = this.i, seen = this.seenOp;
      const sp = this.spaced();
      const t = this.peek();
      if (t?.t === "op" && t.s === "/") {
        this.skipSp(); this.i++;
        this.seenOp = true;
        const den = this.unary();
        if (!den) { this.i = save; this.seenOp = seen; break; }
        cur = {
          tex: `\\frac{${cur.group ?? cur.tex}}{${den.group ?? den.tex}}`,
          ops: cur.ops + den.ops + 1, vars: cur.vars + den.vars,
        };
        continue;
      }
      if (t?.t === "op" && PRODUCT.has(t.s)) {
        this.skipSp();
        // Un point suivi d'un espace finit une phrase ("Q1. Zener").
        if (t.s === "." && this.toks[this.i + 1]?.t !== "id" && this.toks[this.i + 1]?.s !== "(") { this.i = save; break; }
        this.i++;
        this.seenOp = true;
        const rhs = this.unary();
        if (!rhs) { this.i = save; this.seenOp = seen; break; }
        cur = { tex: `${cur.tex} \\cdot ${rhs.tex}`, ops: cur.ops + rhs.ops + 1, vars: cur.vars + rhs.vars };
        continue;
      }
      // Produit implicite : colle ("2R", "R(Vz"), ou derriere un nombre ou
      // une lettre grecque ("2 R", "beta Ru"). Dans une formule deja
      // commencee, aussi entre deux grandeurs ("R I", "L C"), devant une
      // fonction ("Vm sin(wt)") ou une parenthese qui calcule ("Vz (1 + x)").
      // "5[-cos(u)]_0^t" : crochet d'evaluation colle.
      const startsAtom = t && ((t.t === "op" && t.s === "(") || t.t === "id" || t.t === "num"
        || (!sp && t.t === "other" && t.s === "["));
      if (!startsAtom) break;
      // "dx" d'une integrale : la fin du corps, pas un facteur.
      if (this.inIntegral > 0 && t.t === "id" && DIFF.test(t.s)) break;
      const spacedOk = !sp || this.lastWasNumOrGreek(save)
        || (this.seenOp && t.t === "id" && (t.s in FUNCS || this.strongVar(save, t.s)));
      const parenTry = sp && !spacedOk && this.seenOp && t.t === "op";
      if (!spacedOk && !parenTry) break;
      this.skipSp();
      const rhs = this.unary();
      if (!rhs || (parenTry && !(rhs.group !== undefined && rhs.ops >= 1))) { this.i = save; this.seenOp = seen; break; }
      // f(x), v(t) : pas d'espace devant une parenthese collee.
      const glue = !sp && (t.t === "op" || t.t === "other") ? "" : "\\,";
      cur = { tex: `${cur.tex}${glue}${rhs.tex}`, ops: cur.ops + rhs.ops, vars: cur.vars + rhs.vars };
      continue;
    }
    return cur;
  }

  private lastWasNumOrGreek(at: number): boolean {
    const t = this.before(at);
    return !!t && (t.t === "num" || (t.t === "id" && isGreek(t.s)));
  }

  /** Deux grandeurs voisines ("R I") : la precedente et `next` en sont. */
  private strongVar(at: number, next: string): boolean {
    const prev = this.before(at);
    const strong = (s: string) => isGreek(s) || /^j?[A-Z]$/.test(s) || loneVariable(s);
    return !!prev && prev.t === "id" && strong(prev.s) && strong(next);
  }

  private unary(): Node | null {
    const save = this.i;
    const t = this.peek();
    if (t?.t === "op" && (t.s === "-" || t.s === "−")) {
      this.skipSp(); this.i++;
      const inner = this.unary();
      if (!inner) { this.i = save; return null; }
      return { tex: `-${inner.tex}`, ops: inner.ops + 1, vars: inner.vars };
    }
    // "+inf", "x -> +∞" : un plus devant, seulement derriere une relation
    // ou une parenthese (sinon "a + b" se lit deja comme une somme).
    if (t?.t === "op" && t.s === "+") {
      const prev = this.before(this.i);
      if (!prev || (prev.t === "op" && (prev.s in REL || prev.s === "(" || prev.s === "^" || prev.s === "_"))) {
        this.skipSp(); this.i++;
        const inner = this.unary();
        if (!inner) { this.i = save; return null; }
        return { tex: `+${inner.tex}`, ops: inner.ops, vars: inner.vars };
      }
    }
    return this.power();
  }

  private power(): Node | null {
    const at = this.toks[this.i]?.t === "sp" ? this.i + 1 : this.i;
    let base = this.atom();
    if (!base) return null;
    const head = this.toks[at];
    // Une seule lettre (ou grecque) avant "'" ou "_" colles.
    const letter = this.i === at + 1 && head?.t === "id" && (/^[A-Za-z]$/.test(head.s) || isGreek(head.s));
    // Primes : f'(x), y'', F'. Jamais devant une lettre (l'Ohm, d'un, c'est).
    if (letter && this.toks[this.i]?.s === "'") {
      let j = this.i;
      while (this.toks[j]?.s === "'") j++;
      const n = this.toks[j];
      if (j - this.i <= 3 && !(n && (n.t === "id" || n.t === "num"))) {
        base = { ...base, tex: base.tex + "'".repeat(j - this.i) };
        delete base.group;
        this.i = j;
      }
    }
    // Indice tape : u_n, x_max, u_(n+1).
    if (letter && this.toks[this.i]?.s === "_") {
      const save = this.i, seen = this.seenOp;
      this.i++;
      const sub = this.script();
      if (sub === null) { this.i = save; this.seenOp = seen; }
      else base = { tex: `${base.tex}_${sub.length === 1 ? sub : `{${sub}}`}`, ops: base.ops + 1, vars: base.vars };
    }
    const t = this.toks[this.i];
    // Entrees d'AOP : "V+", "V-" colles et suivis d'un blanc, d'une
    // relation ou de la fin s'ecrivent en exposant (V^+, V^-).
    if (t?.t === "op" && (t.s === "+" || t.s === "-" || t.s === "−") && base.vars === 1) {
      const n = this.toks[this.i + 1];
      const ends = !n || n.t === "sp" || n.t === "other" || (n.t === "op" && (n.s in REL || n.s === ")"));
      if (ends) {
        this.i++;
        return { tex: `${base.tex}^{${t.s === "+" ? "+" : "-"}}`, ops: base.ops + 1, vars: base.vars };
      }
    }
    if (t?.t === "op" && (t.s === "²" || t.s === "³")) {
      this.i++;
      return { tex: `${base.tex}^${t.s === "²" ? 2 : 3}`, ops: base.ops + 1, vars: base.vars };
    }
    if (t?.t === "op" && t.s === "^") {
      const save = this.i, seen = this.seenOp;
      this.i++;
      this.seenOp = true;
      const exp = this.unary();
      if (!exp) { this.i = save; this.seenOp = seen; return base; }
      return { tex: `${base.tex}^{${exp.group ?? exp.tex}}`, ops: base.ops + exp.ops + 1, vars: base.vars + exp.vars };
    }
    return base;
  }

  /** Unite derriere un nombre, composee ("m/s", "dB/dec") ou au carre. */
  private unit(): string | null {
    const u = this.toks[this.i];
    if (u?.t !== "id" || !isUnit(u.s)) return null;
    const after = this.toks[this.i + 1];
    let tex = UNITS[u.s];
    let j = this.i + 1;
    if (after?.t === "op" && after.s === "/" && this.toks[j + 1]?.t === "id" && isUnit(this.toks[j + 1].s)) {
      tex += `/${UNITS[this.toks[j + 1].s]}`;
      j += 2;
    }
    const sq = this.toks[j];
    if (sq?.t === "op" && (sq.s === "²" || sq.s === "³")) { tex += `^${sq.s === "²" ? 2 : 3}`; j++; }
    // "3 m donc" oui ; "2 R1" non (R1 n'est pas une unite, et une lettre
    // collee derriere l'unite en fait un autre mot).
    if (this.toks[j]?.t === "id") return null;
    this.i = j;
    return tex;
  }

  /**
   * Borne ou indice colle derriere "_" ou "^" : un nombre, une lettre ou
   * un mot court, un signe et un de ceux-la, ou un groupe entre
   * parentheses (sans les parentheses). null si rien de lisible.
   */
  private script(): string | null {
    const t = this.toks[this.i];
    if (!t) return null;
    if (t.t === "num") { this.i++; return t.s.replace(",", "{,}"); }
    if (t.t === "id") {
      if (t.s in SET_CHARS || t.s === "∞" || t.s === "inf" || t.s === "infty" || isGreek(t.s)) { this.i++; return identTex(t.s); }
      if (/^[A-Za-z][A-Za-z0-9]{0,3}$/.test(t.s)) { this.i++; return t.s; }
      return null;
    }
    if (t.t === "op" && (t.s === "-" || t.s === "−" || t.s === "+")) {
      this.i++;
      const inner = this.script();
      return inner === null ? null : `${t.s === "+" ? "+" : "-"}${inner}`;
    }
    if (t.t === "op" && t.s === "(") {
      const save = this.i;
      const g = this.atom();
      if (!g || g.group === undefined) { this.i = save; return null; }
      return g.group;
    }
    return null;
  }

  /** lim, sum, prod, int avec leurs bornes et leur corps (voir BIGOPS). */
  private bigOp(t: Tok): Node | null {
    const save = this.i, seen = this.seenOp;
    const fail = () => { this.i = save; this.seenOp = seen; return null; };
    this.i++;
    let tex = BIGOPS[t.s];
    let bounded = false;
    if (this.toks[this.i]?.s === "_") {
      this.i++;
      const lo = this.script();
      if (lo === null) return fail();
      tex += `_{${lo}}`;
      bounded = true;
      if (t.s !== "lim" && this.toks[this.i]?.s === "^") {
        this.i++;
        const hi = this.script();
        if (hi === null) return fail();
        tex += `^{${hi}}`;
      }
    }
    // Colle a autre chose qu'un blanc ou une parenthese : un mot ("intro").
    const next = this.toks[this.i];
    if (next && next.t !== "sp" && !(next.t === "op" && next.s === "(")) {
      if (!bounded || next.t === "id" || next.t === "num") return fail();
    }
    this.seenOp = true;
    if (t.s === "int") this.inIntegral++;
    let body: Node | null;
    try { body = this.product(); } finally { if (t.s === "int") this.inIntegral--; }
    let diff = "";
    if (t.s === "int") {
      const save2 = this.i;
      this.skipSp();
      const d = this.toks[this.i];
      if (d?.t === "id" && DIFF.test(d.s)) {
        this.i++;
        diff = `\\,\\mathrm{d}${identTex(d.s.slice(1))}`;
      } else this.i = save2;
      // Sans bornes, seule une integrale qui finit par "dx" en est une.
      if (!bounded && (!diff || !body)) return fail();
    } else if (!bounded) return fail();
    const vars = 1 + (body?.vars ?? 0);
    return { tex: `${tex}${body ? ` ${body.tex}` : ""}${diff}`, ops: 1 + (body?.ops ?? 0), vars };
  }

  /**
   * Matrice tapee entre parentheses, lignes separees par ";" : "(a b; c d)",
   * "(1, 2; 3, 4)". Toutes les lignes ont le meme nombre (2 ou plus) de
   * coefficients simples (nombre, lettre, grandeur), sinon rien.
   */
  private matrix(): Node | null {
    const rows: string[][] = [[]];
    let j = this.i + 1, vars = 0;
    for (;; j++) {
      const t = this.toks[j];
      if (!t) return null;
      if (t.t === "sp" || (t.t === "other" && t.s === ",")) continue;
      if (t.t === "other" && t.s === ";") { rows.push([]); continue; }
      if (t.t === "op" && t.s === ")") break;
      let sign = "";
      let u: Tok = t;
      if (t.t === "op" && (t.s === "-" || t.s === "−")) { sign = "-"; u = this.toks[++j]; if (!u) return null; }
      if (u.t === "num") rows[rows.length - 1].push(sign + u.s.replace(",", "{,}"));
      else if (u.t === "id" && (/^[A-Za-z]$/.test(u.s) || (validIdent(u.s) && !(u.s in FUNCS)))) {
        rows[rows.length - 1].push(sign + identTex(u.s));
        vars++;
      } else return null;
    }
    const n = rows[0].length;
    if (rows.length < 2 || n < 2 || rows.some((r) => r.length !== n)) return null;
    this.i = j + 1;
    const body = rows.map((r) => r.join(" & ")).join(" \\\\ ");
    return { tex: `\\begin{pmatrix} ${body} \\end{pmatrix}`, ops: 1, vars };
  }

  private atom(): Node | null {
    this.skipSp();
    const t = this.toks[this.i];
    if (!t) return null;
    // Quantificateurs : "∀ x", "∃ n". Pas un operateur a eux seuls : "∀ x"
    // attend la suite ("x in RR" a l'Espace suivant), "∀ x ∈ ℝ" en est une.
    if (t.t === "op" && (t.s === "∀" || t.s === "∃")) {
      const save = this.i;
      this.i++;
      const v = this.atom();
      if (!v || v.vars < 1) { this.i = save; return null; }
      return { tex: `${t.s === "∀" ? "\\forall" : "\\exists"} ${v.tex}`, ops: v.ops, vars: v.vars };
    }
    if (t.t === "num") {
      this.i++;
      let tex = t.s.replace(",", "{,}");
      // Unite derriere un nombre : "0,6 V", "50 Ω", "10 mA", "10 m/s".
      const save = this.i;
      this.skipSp();
      const u = this.unit();
      if (u) tex += `\\,${u}`;
      else this.i = save;
      return { tex, ops: 0, vars: 0 };
    }
    if (t.t === "id") {
      if (t.s in BIGOPS) {
        const op = this.bigOp(t);
        if (op) return op;
      }
      // "inf" (ou "infty") : l'infini, seulement derriere un signe ou une
      // relation ("x -> +inf") ; "borne inf" reste du texte.
      if (t.s === "inf" || t.s === "infty") {
        const prev = this.before(this.i);
        // Borne d'intervalle : "[0, inf[" aussi.
        if (!(prev?.t === "op" && prev.s !== ")" && prev.s !== ".") && !(this.inInterval > 0 && prev?.t === "other")) return null;
        this.i++;
        return { tex: "\\infty", ops: 0, vars: 0 };
      }
      if (t.s === "∞") { this.i++; return { tex: "\\infty", ops: 0, vars: 0 }; }
      // Re(Z), Im(Z), arg(z), max(a, b) : colle a la parenthese seulement.
      if (t.s in OPNAMES && this.toks[this.i + 1]?.t === "op" && this.toks[this.i + 1].s === "(") {
        const save = this.i;
        this.i++;
        const arg = this.atom();
        if (!arg || arg.group === undefined) { this.i = save; return null; }
        return { tex: `${OPNAMES[t.s]}\\left(${arg.group}\\right)`, ops: arg.ops + 1, vars: arg.vars };
      }
      if (t.s in FUNCS) {
        const save = this.i;
        this.i++;
        const arg = this.atom();
        if (!arg) { this.i = save; return null; }
        if (t.s === "sqrt") return { tex: `\\sqrt{${arg.group ?? arg.tex}}`, ops: arg.ops + 1, vars: arg.vars };
        return { tex: `${FUNCS[t.s]}${arg.group ? `\\left(${arg.group}\\right)` : ` ${arg.tex}`}`, ops: arg.ops + 1, vars: arg.vars };
      }
      if (!validIdent(t.s) && !this.letterA(t)) {
        // Borne d'intervalle : "ton", "toff" sont des grandeurs (t_on).
        if (!(this.inInterval > 0 && /^[A-Za-z][A-Za-z0-9]{0,4}$/.test(t.s))) return null;
        this.relaxed++;
      }
      this.i++;
      return { tex: identTex(t.s), ops: 0, vars: 1 };
    }
    if (t.t === "other" && (t.s === "[" || t.s === "]")) return this.interval() ?? (t.s === "[" ? this.evalBracket() : null);
    if (t.t === "op" && t.s === "<") return this.mean();
    if (t.t === "op" && t.s === "(") {
      const m = this.matrix();
      if (m) return m;
    }
    if (t.t === "op" && (t.s === "(" || t.s === "|")) {
      const save = this.i;
      this.i++;
      const inner = this.relation();
      this.skipSp();
      const close = this.toks[this.i];
      const want = t.s === "(" ? ")" : "|";
      if (!inner || close?.t !== "op" || close.s !== want) { this.i = save; return null; }
      this.i++;
      if (t.s === "|") return { tex: `\\left|${inner.tex}\\right|`, ops: inner.ops, vars: inner.vars };
      return { tex: `\\left(${inner.tex}\\right)`, group: inner.tex, ops: inner.ops, vars: inner.vars };
    }
    return null;
  }

  /**
   * Valeur moyenne : "<ic(t)>T", "<iL(t)>_T", "<iL(t)> = 0", en debut de
   * terme (atom n'est jamais appele sur le "<" d'une relation "x < y").
   * ">=" colle a la fermeture : ">" puis "=", rendu a la relation.
   */
  private mean(): Node | null {
    const save = this.i, seen = this.seenOp;
    const fail = () => { this.i = save; this.seenOp = seen; return null; };
    this.i++;
    const inner = this.sum();
    if (!inner || inner.vars < 1) return fail();
    this.skipSp();
    const close = this.toks[this.i];
    if (close?.t !== "op" || (close.s !== ">" && close.s !== ">=")) return fail();
    let tex = `\\left\\langle ${inner.tex} \\right\\rangle`;
    if (close.s === ">=") {
      // Le "=" reste a lire : la relation le prendra.
      this.toks[this.i] = { t: "op", s: "=", a: close.a + 1, b: close.b };
    } else {
      this.i++;
      const n = this.toks[this.i];
      if (n?.t === "id" && /^[A-Z]\d?$/.test(n.s)) { this.i++; tex += `_{${n.s}}`; }
      else if (n?.s === "_") {
        this.i++;
        const sub = this.script();
        if (sub === null) this.i--; else tex += `_{${sub}}`;
      }
    }
    this.seenOp = true;
    return { tex, ops: inner.ops + 1, vars: inner.vars };
  }

  /**
   * Crochet d'evaluation (primitive entre deux bornes) : "[-cos(u)]_0^t",
   * "[x^2/2]_0^(a+1)" -> \left[ ... \right]_{0}^{t}. Les deux bornes sont
   * obligatoires : "[note]" reste du texte.
   */
  private evalBracket(): Node | null {
    const save = this.i, seen = this.seenOp;
    const fail = () => { this.i = save; this.seenOp = seen; return null; };
    this.i++;
    const inner = this.relation();
    if (!inner) return fail();
    this.skipSp();
    const close = this.toks[this.i];
    if (close?.t !== "other" || close.s !== "]") return fail();
    this.i++;
    if (this.toks[this.i]?.s !== "_") return fail();
    this.i++;
    const lo = this.script();
    if (lo === null || this.toks[this.i]?.s !== "^") return fail();
    this.i++;
    const hi = this.script();
    if (hi === null) return fail();
    this.seenOp = true;
    return { tex: `\\left[${inner.tex}\\right]_{${lo}}^{${hi}}`, ops: inner.ops + 1, vars: Math.max(1, inner.vars) };
  }

  /**
   * Intervalle a la francaise : "[0, ton[", "]a ; b]", "[ILmin, ILmax]",
   * "]-inf, 0]". Bornes : des expressions, separees par "," ou ";". Un mot
   * outil ("ton") n'y est une grandeur que si l'autre borne en est une sans
   * doute possible : "[note, page]" reste du texte.
   */
  private interval(): Node | null {
    const save = this.i, seen = this.seenOp, relaxed0 = this.relaxed;
    const open = this.toks[this.i].s;
    const fail = () => { this.i = save; this.seenOp = seen; this.relaxed = relaxed0; return null; };
    this.i++;
    this.inInterval++;
    try {
      const bound = (): { node: Node; relaxed: boolean } | null => {
        const r0 = this.relaxed;
        this.skipSp();
        let plus = "";
        // "+inf" derriere le separateur.
        if (this.toks[this.i]?.t === "op" && this.toks[this.i].s === "+") { plus = "+"; this.i++; }
        const node = this.sum();
        return node ? { node: { ...node, tex: plus + node.tex }, relaxed: this.relaxed > r0 } : null;
      };
      const lo = bound();
      if (!lo) return fail();
      this.skipSp();
      const sep = this.toks[this.i];
      if (sep?.t !== "other" || (sep.s !== "," && sep.s !== ";")) return fail();
      this.i++;
      const hi = bound();
      if (!hi || (lo.relaxed && hi.relaxed)) return fail();
      this.skipSp();
      const close = this.toks[this.i];
      if (close?.t !== "other" || (close.s !== "[" && close.s !== "]")) return fail();
      this.i++;
      this.seenOp = true;
      const s = sep.s === ";" ? ";\\," : ",\\,";
      return {
        tex: `\\left${open} ${lo.node.tex}${s}${hi.node.tex} \\right${close.s}`,
        ops: lo.node.ops + hi.node.ops + 1, vars: lo.node.vars + hi.node.vars,
      };
    } finally {
      this.inInterval--;
    }
  }

  /**
   * "a" (et "A", "à" tape sans accent) est un mot outil ("il y a"), sauf en maths : colle a un nombre
   * ("2a"), derriere un operateur ou une parenthese ("= a", "(a"), ou
   * devant une relation ("a != b").
   */
  private letterA(t: Tok): boolean {
    if (t.s !== "a" && t.s !== "A") return false;
    const prevRaw = this.toks[this.i - 1];
    if (prevRaw?.t === "num") return true;
    const prev = this.before(this.i);
    if (prev?.t === "op" && prev.s !== ")" && prev.s !== ".") return true;
    let j = this.i + 1;
    while (this.toks[j]?.t === "sp") j++;
    const next = this.toks[j];
    return next?.t === "op" && next.s in REL;
  }
}

/**
 * Indices reconnus derriere l'initiale d'une grandeur (Vz, Ru, Vbe, Req,
 * Vcc, Vbatt). Liste fermee : "Voici", "Loi", "Ohm", "Vu" restent du texte.
 */
const LONE_SUB = /^(?:[sezdubcgfmnoptkrx]|be|ce|cb|bc|eb|ds|gs|sd|th|eq|cc|ee|dd|ss|ab|out|ref|max|min|moy|eff|pp|ch|batt|bat|ac|dc|rms|sat)$/;
/** Mots qui ont la forme d'une grandeur mais qui n'en sont pas. */
const LONE_STOP = new Set(["Vu", "Lu", "Pr", "If", "It", "In", "Up", "Un", "Lac"]);

/**
 * Variable seule dans une phrase ("Vz", "Ru", "Vbatt", "I1", "iD") : elle a
 * une forme de variable sans ambiguite. Liste blanche : initiale V, I, U,
 * R, C, L, P ou Z suivie d'un indice connu ; les mots courts du francais
 * ("La", "On", "Il", "Voici", "Loi"), les unites ("Hz", "dB"), les
 * numeros de question ("Q1") et de seance ("S01") restent du texte, comme
 * les grandeurs d'une seule lettre ("R", "a").
 */
function loneVariable(s: string): boolean {
  if (LONE_NAMES.has(s)) return true;
  if (FORMULA_ONLY.has(s)) return false;
  // Seul dans une phrase, "IL" en majuscules reste du texte (« IL FAUT »).
  if (!validIdent(s) || stopWord(s) || (STOP.has(s.toLowerCase()) && /^[A-Z]+$/.test(s)) || isGreek(s) || s in FUNCS) return false;
  if (isUnit(s) || LONE_STOP.has(s)) return false;
  // Majuscule + indice : Vz, Ru, Vbe, Vbatt, Vin, Zin (pas Pin, Voici, Loi).
  const m = /^([VIURCLPZ])([a-z]{1,4})$/.exec(s);
  if (m) return LONE_SUB.test(m[2]) || (m[2] === "in" && /^[VIZ]$/.test(m[1]));
  // Lettre + chiffres : I1, R2, C10, R0 ; pas Q1 (question), S01 (seance), P1.
  if (/^[VIURCLZ]\d{1,2}$/.test(s)) return !/^[A-Za-z]0\d/.test(s);
  // Minuscule + majuscule : iD, uD, vS (pas kV, mA, uF : des unites).
  if (/^[iuv][A-Z]{1,2}$/.test(s)) return !/^u[AFHVWS]$/.test(s);
  // Tensions et courants a la francaise en minuscules : vbatt, vce, icc.
  return LOWER_VAR.test(s);
}

/**
 * Calcul sans variable ("3/2", "2^10", "5 * 3 = 15") : garde seulement
 * s'il a une fraction, une puissance, un produit ou une relation, et si ce
 * n'est pas une date ("30/09", "29/09/2026") ni un simple "1 - 2".
 */
function numericOk(src: string, tex: string): boolean {
  const s = src.replace(/\s+/g, "");
  if (/^\d+\/\d+\/\d+$/.test(s) || /^\d{2}\/\d{2}$/.test(s) || /^0\d\//.test(s)) return false;
  // Intervalle de nombres ("]0 ; 1[", "[0, +inf[") : des maths aussi.
  return /\\frac|\^|\\cdot|=|<|>|\\leq|\\geq|\\approx|\\neq|\\ll|\\gg|\\to|Rightarrow|\\left[[\]]/.test(tex);
}

/** Paires a barre oblique qui ne sont pas des fractions (E/S, I/O). */
const SLASH_WORDS = new Set(["E/S", "I/O", "A/N", "N/A", "R/W", "S/N", "O/N", "TCP/IP", "UDP/IP"]);

/** "m/s", "dB/dec", "E/S" : une unite ou un sigle, pas une fraction. */
function slashWord(src: string): boolean {
  const s = src.replace(/\s+/g, "");
  if (SLASH_WORDS.has(s)) return true;
  const m = /^([A-Za-zµΩ]+)\/([A-Za-zµΩ]+)$/.exec(s);
  return !!m && isUnit(m[1]) && isUnit(m[2]);
}

/**
 * Le jeton `j` (premier non blanc apres une variable) prolonge-t-il une
 * formule ? Un operateur oui ; une virgule, un mot, une parenthese
 * fermante ou un point de fin de phrase non.
 */
function continues(toks: Tok[], j: number): boolean {
  const n = toks[j];
  if (!n || n.t !== "op") return false;
  if (n.s === ")" || n.s === "|" || n.s === "'") return false;
  if (n.s === ".") {
    const after = toks[j + 1];
    return !!after && after.t !== "sp";
  }
  return true;
}

/**
 * Formules d'une ligne de texte brut, de gauche a droite, sans
 * chevauchement. Une formule a au moins un operateur et une variable ; une
 * variable seule ("Vz") n'est prise que quand la suite montre qu'elle ne
 * commence pas une formule (voir ScanMode).
 */
export function findFormulas(line: string, mode: ScanMode = "final"): FoundFormula[] {
  const toks = tokenize(line);
  const out: FoundFormula[] = [];
  let k = 0;
  while (k < toks.length) {
    const t = toks[k];
    if (t.t === "sp" || (t.t === "other" && t.s !== "[" && t.s !== "]")) { k++; continue; }
    // Trait d'union colle a un mot ("lithium-ion") : pas un moins.
    const prev = toks[k - 1];
    if (t.t === "op" && (t.s === "-" || t.s === "−") && prev && (prev.t === "id" || prev.t === "num")) { k++; continue; }
    const p = new Parser(toks, k);
    const node = p.relation();
    let last = p.pos - 1;
    while (last > k && toks[last].t === "sp") last--;
    if (last < k) last = k;
    const src = line.slice(t.a, toks[last].b);
    let lone = !!node && node.ops === 0 && t.t === "id" && last === k && loneVariable(t.s);
    if (lone) {
      let j = last + 1;
      while (toks[j]?.t === "sp") j++;
      if (mode === "pause") lone = false;
      else if (!toks[j]) lone = mode === "final";
      else lone = !continues(toks, j);
    }
    if (node && (lone || (node.ops >= 1 && (node.vars >= 1 || numericOk(src, node.tex)) && !slashWord(src)))) {
      // Fin = dernier jeton non blanc consomme.
      const end = toks[last].b;
      // Un point final de phrase reste du texte.
      out.push({ start: t.a, end, latex: node.tex.replace(/\s+/g, " ").trim() });
      k = last + 1;
      continue;
    }
    // Mot suivant : on ne recommence pas au milieu d'un mot.
    k++;
  }
  return out;
}

/**
 * Morceau de la ligne en cours, relue jusqu'au curseur : du texte, une
 * formule convertie automatiquement (sa source tapee), ou le texte tape
 * dans le noeud du curseur (toujours le dernier).
 */
export interface LinePart { kind: "text" | "eq" | "cur"; str: string }

/**
 * Formules a (re)mettre en forme sur une ligne relue : celles qui touchent
 * ce qu'on vient de taper, ou qui prolongent une formule deja en forme
 * ("Vs = Vz" puis " - Vbe"). Une formule en forme n'est jamais coupee en
 * deux. `undone` : indice de la formule collee a la frappe ("x = Q" puis
 * "uand") qui redevient du texte, -1 sinon. `atCaret` : la derniere formule
 * finit au curseur ("Vs = Vz - Vbe" puis Espace), et non quelques mots plus
 * tot ("I1" converti a l'Espace apres "traverse") : seule la premiere est
 * annulee par Retour arriere. null : rien a faire.
 */
export function planLine(
  parts: LinePart[], mode: ScanMode,
): { formulas: FoundFormula[]; undone: number; atCaret: boolean } | null {
  const pos: { a: number; b: number }[] = [];
  let at = 0;
  for (const p of parts) { pos.push({ a: at, b: at + p.str.length }); at += p.str.length; }
  const full = parts.map((p) => p.str).join("");
  const curStart = pos[pos.length - 1]?.a ?? 0;
  const found = findFormulas(full, mode);
  const eqIdx = parts.map((p, i) => (p.kind === "eq" ? i : -1)).filter((i) => i >= 0);
  const covers = (f: FoundFormula, i: number) => f.start <= pos[i].a && f.end >= pos[i].b;
  const pick = (kept: number[]) => found.filter((f) => {
    if (kept.some((i) => f.start < pos[i].b && f.end > pos[i].a && !covers(f, i))) return false;
    if (kept.some((i) => pos[i].a === f.start && pos[i].b === f.end)) return false;
    return f.end > curStart || kept.some((i) => covers(f, i));
  });
  let formulas = pick(eqIdx);
  let undone = -1;
  const g = parts.length - 2;
  if (g >= 0 && parts[g].kind === "eq" && /^[\p{L}\p{N}]/u.test(parts[g + 1].str)
      && !formulas.some((f) => covers(f, g))) {
    undone = g;
    formulas = pick(eqIdx.filter((i) => i !== g));
  }
  if (!formulas.length && undone < 0) return null;
  const lastEnd = formulas.length ? formulas[formulas.length - 1].end : -1;
  return { formulas, undone, atCaret: lastEnd >= full.trimEnd().length };
}

/**
 * "/" tape derriere `before` : peut-il ouvrir une fraction ? Non derriere
 * une unite ("10 m/", "20 dB/", "en m/") ni un sigle seul ("les E/",
 * "TCP/"), qui s'ecrivent avec une barre oblique.
 */
export function slashOpensFraction(numerator: string, before: string): boolean {
  const num = numerator.trim();
  if (/\d\s*([A-Za-zµΩ]+)$/.test(before) && isUnit(/([A-Za-zµΩ]+)$/.exec(before)![1])) return false;
  // Une lettre majuscule seule (V, F) est plutot une grandeur qu'une unite.
  if (isUnit(num) && !/^[A-Z]$/.test(num)) return false;
  if (/^[A-Z]+$/.test(num) && !/^[VIURCLPZ]$/.test(num)) return false;
  return true;
}

/** Unites a majuscule tapees dans l'editeur : en romain, pas en indice (Hz, pas H_z). */
const ROMAN_UNITS = new Set(["Hz", "Ohm", "Pa", "Wh", "Ko", "Mo", "Go"]);

/**
 * Variables tapees dans l'editeur de formules ("Ru", "Vbe", "Vbatt", "R1") :
 * meme convention que le texte, la suite passe en indice (R_{u}, V_{be},
 * R_{1}). Les unites passent en romain (Hz). Les commandes LaTeX et le
 * contenu de \mathrm{}, \text{} ne sont pas touches.
 */
export function subscriptVars(latex: string): string {
  latex = meanValues(latex);
  const protectedRe = /\\(?:mathrm|text|operatorname|mathbb)\{[^}]*\}|\\[A-Za-z]+/g;
  let out = "", last = 0, m: RegExpExecArray | null;
  const fix = (part: string) => part
    // j et pulsation : jLw = j L omega, jRCw, RCw, jw (voir IMAG).
    .replace(
      /(?<![A-Za-z_^{])(j[RLC]{1,3}w?|jw|[RLC]*[LC][RLC]*w)(?![A-Za-z0-9_])/g,
      (_all, word: string) => imagTex(word),
    )
    // Courants et tensions a indice : ic, iL, vs, iLmoy (i_c, i_L) ; IL,
    // VCC, ILmoy (I_L, V_CC). Jamais RC ou LC (des produits).
    .replace(
      /(^|[^A-Za-z_^])(?<![_^]\{)([iuv])([A-Z][A-Za-z0-9]{0,4}|[cesdgbr]|be|ce|cc|ch|in|out|ref|max|min|moy|eff|batt|bat)(?![A-Za-z_])/g,
      (_all, pre: string, head: string, rest: string) => `${pre}${head}_{${rest}}`,
    )
    .replace(
      /(^|[^A-Za-z_^])(?<![_^]\{)([IUV])([A-Z][A-Za-z0-9]{0,4})(?![A-Za-z_])/g,
      (_all, pre: string, head: string, rest: string) => `${pre}${head}_{${rest}}`,
    )
    // Pas devant "_" : "Cu_{c}" est C fois u_c, et C_{u}_{c} serait un
    // double indice (formule en rouge).
    .replace(
      /(^|[^A-Za-z_^])(?<![_^]\{)([A-Z])([a-z]{1,5})(?![A-Za-z_])/g,
      (all, pre: string, head: string, rest: string) => {
        const word = head + rest;
        if (ROMAN_UNITS.has(word)) return `${pre}${UNITS[word]}`;
        return STOP.has(word.toLowerCase()) ? all : `${pre}${head}_{${rest}}`;
      },
    )
    .replace(
      /(^|[^A-Za-z_^])(?<![_^]\{)([A-Z])(\d{1,2})(?![\d_])/g,
      (_all, pre: string, head: string, digits: string) => `${pre}${head}_{${digits}}`,
    );
  while ((m = protectedRe.exec(latex))) {
    out += fix(latex.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fix(latex.slice(last));
}

/**
 * Valeur moyenne tapee dans une formule : "<ic(t)>T" -> ⟨ic(t)⟩_T. Le "<"
 * ouvre un terme (debut, apres =, +, -, une case) ; MathLive lit ">=" comme
 * \ge : derriere un "<" ouvert, c'est la fermeture puis "=". Une lettre
 * majuscule collee derriere (T) ou un indice tape devient l'indice.
 */
function meanValues(latex: string): string {
  return latex.replace(
    /(^|[=+\-&{(,]|\\\\|\\[,;:]|\\quad|\\begin\{[a-z]+\*?\})(\s*)<(?![=<])\s*((?:[^<>&\\]|\\[A-Za-z]+\s*|\\[,;])+?)\s*(>|\\geq?(?![A-Za-z]))(?:_\{([^{}]*)\}|_([A-Za-z0-9])|([A-Z0-9])(?![A-Za-z]))?/g,
    (all, pre: string, sp: string, inner: string, close: string, subB?: string, subC?: string, subL?: string) => {
      if (!inner.trim() || /[<>]/.test(inner)) return all;
      // ">=0" : le 0 suit le "=", ce n'est pas un indice.
      if (close !== ">") return `${pre}${sp}\\left\\langle ${inner.trim()}\\right\\rangle=${subB !== undefined ? `_{${subB}}` : subC !== undefined ? `_${subC}` : subL ?? ""}`;
      const sub = subB ?? subC ?? subL;
      return `${pre}${sp}\\left\\langle ${inner.trim()}\\right\\rangle${sub ? `_{${sub}}` : ""}`;
    },
  );
}

/**
 * Source tapee equivalente a un petit morceau de LaTeX de MathLive
 * ("(\beta.R_{u})" -> "(beta.Ru)"), pour qu'une formule saisie dans une
 * fraction automatique reste prolongeable comme le reste du texte. null si
 * le morceau a une structure (fraction, exposant) qu'on ne sait pas relire.
 */
export function latexToSource(tex: string): string | null {
  const names: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(GREEK_NAMES)) names[cmd.slice(1)] = name;
  names.varepsilon = "eps";
  const s = tex
    .replace(/\\placeholder\{\}/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/\\[,;: ]|~/g, " ")
    .replace(/([A-Za-z])_\{([A-Za-z0-9]+)\}/g, "$1$2")
    .replace(/([A-Za-z])_([A-Za-z0-9])/g, "$1$2")
    .replace(/\\([A-Za-z]+)\s?/g, (all, name: string) => {
      if (name in names) return `${names[name]} `;
      if (`\\${name}` === FUNCS[name]) return name;
      return all;
    });
  if (/[\\{}_^]/.test(s)) return null;
  // "\beta.R_{u}" donne "beta .Ru" : pas d'espace avant un point ou une
  // parenthese fermante, la source rendue par Ctrl+Z reste celle tapee.
  return s.replace(/\s+/g, " ").replace(/ (?=[.,)\]])/g, "").trim();
}

/** Lettre grecque tapee en toutes lettres, hors formule ("pi" -> π). */
// Pas "Pi" (Raspberry Pi) ni "lambda" (mot cle Python) : ils restent tels quels.
const GREEK_WORDS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", eps: "ε", epsilon: "ε",
  eta: "η", theta: "θ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", phi: "φ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ",
  Lambda: "Λ", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
};

/**
 * Mot grec qui termine `text` (juste avant le curseur) : renvoie le texte
 * avec la lettre, ou null. "pi" seul oui, "pixel" ou "api" non.
 */
export function greekWordAtEnd(text: string): string | null {
  const m = text.match(/(^|[^A-Za-z0-9À-ÿ])([A-Za-z]+)$/);
  if (!m || !(m[2] in GREEK_WORDS)) return null;
  return text.slice(0, text.length - m[2].length) + GREEK_WORDS[m[2]];
}

/** Symbole tape en deux touches, remplace des la seconde ("->" -> →). */
const SYMBOL_PAIRS: Record<string, string> = {
  "->": "→", "=>": "⇒", ">=": "≥", "<=": "≤", "!=": "≠", "~=": "≈",
  ">>": "≫", "<<": "≪", "≤>": "⇔",
};
/** Operateurs de code : colles a un nom (p->next, a>=b, cout<<x), ils restent tels quels. */
const CODE_PAIRS = new Set(["->", "=>", ">=", "<=", "!=", ">>", "<<"]);

/** `text` se termine-t-il par un symbole a deux touches ? */
export function symbolAtEnd(text: string): string | null {
  if (text.endsWith("<=>")) return text.slice(0, -3) + "⇔";
  const two = text.slice(-2);
  if (!(two in SYMBOL_PAIRS)) return null;
  if (CODE_PAIRS.has(two) && /[A-Za-z0-9_\])]$/.test(text.slice(0, -2))) return null;
  return text.slice(0, -2) + SYMBOL_PAIRS[two];
}

/** Ensembles tapes en double majuscule. */
const SET_WORDS: Record<string, string> = { RR: "ℝ", NN: "ℕ", ZZ: "ℤ", QQ: "ℚ", CC: "ℂ" };

/**
 * Mots de maths tapes dans le texte, remplaces par leur symbole quand le
 * mot vient d'etre fini (Espace, Entree). Seulement en contexte formule :
 * "forall" et "infty" toujours (ce ne sont pas des mots) ; "exists" si la
 * ligne a deja un symbole de maths (ou une formule, `mathBefore`), ou
 * derriere une virgule ; RR, NN... derriere ∈, ⊂, →, ":" ;
 * "in" et "sub" entre une lettre et un ensemble ("x in RR", "A sub B") ;
 * "inf" derriere un signe ou une relation ("x -> +inf"). « le CC de
 * maths », « logged in », « borne inf » restent du texte. null : rien.
 */
export function mathWordsAtEnd(text: string, mathBefore = false): string | null {
  const m = /(^|[^\p{L}\p{N}_])([\p{L}\p{N}]+)([,;.)]*)$/u.exec(text);
  if (!m) return null;
  const word = m[2], tail = m[3];
  const head = text.slice(0, m.index + m[1].length);
  const line = head.slice(head.lastIndexOf("\n") + 1);
  const done = (sym: string, h = head) => h + sym + tail;
  if (word === "forall") return done("∀");
  if (word === "infty") return done("∞");
  if (word === "inf") return /(?:[+\-−→=<>≤≥]|->)\s*$/.test(head) ? done("∞") : null;
  if (word === "exists") return mathBefore || /,\s*$/.test(head) || /[∀∃∈∉⊂⊆ℝℕℤℚℂ⇒⇔]/.test(line) ? done("∃") : null;
  const set = SET_WORDS[word];
  const target = set ?? (/^[A-Z]$|^[ℝℕℤℚℂ]$/u.test(word) ? word : null);
  if (target) {
    // "x in RR", "A sub B" : la relation et l'ensemble ensemble.
    const rel = /(^|[\s(,;:∀∃])([A-Za-zα-ωΑ-Ω]\d{0,2})\s+(in|sub)\s+$/.exec(head);
    if (rel) {
      const at = head.search(/(?:in|sub)\s+$/);
      const sym = rel[3] === "in" ? "∈" : "⊂";
      const h = head.slice(0, at) + sym + head.slice(at + rel[3].length);
      return done(target, h);
    }
    if (set && /(?:[∈∉⊂⊆×→:]|\(|->)\s*$/.test(head)) return done(set);
  }
  return null;
}

/** Relations (LaTeX) autour desquelles un espace tape ne sert a rien. */
const REL_CMDS = "in|notin|subset|subseteq|supset|to|Rightarrow|Leftarrow|iff|Leftrightarrow|le|ge|leq|geq|ne|neq|approx|equiv|forall|exists";

/**
 * Sortie de MathLive relue pour KaTeX : commandes propres a MathLive
 * (\differentialD, \exponentialE, \imaginaryI, \mleft), cases vides
 * retirees (une integrale aux bornes vides devient une integrale sans
 * bornes), "in" tape entre deux espaces = appartient, espaces inutiles
 * autour des relations. Le contenu de \text{} et \mathrm{} n'est pas touche.
 */
export function cleanMathLive(latex: string): string {
  const keep: string[] = [];
  let s = latex.replace(/\\(?:text|mathrm|operatorname\*?)\{[^{}]*\}/g, (g) => `\u0000${keep.push(g) - 1}\u0000`);
  s = s
    .replace(/\\differentialD\s*/g, "\\mathrm{d}")
    .replace(/\\exponentialE\s*/g, "\\mathrm{e}")
    .replace(/\\imaginaryI\s*/g, "\\mathrm{i}")
    .replace(/\\imaginaryJ\s*/g, "\\mathrm{j}")
    .replace(/\\mleft/g, "\\left").replace(/\\mright/g, "\\right")
    .replace(/\^\{\\doubleprime\}/g, "''").replace(/\^\{\\prime\}/g, "'")
    .replace(/\\doubleprime/g, "''").replace(/\\prime(?![A-Za-z])/g, "'")
    .replace(/\\placeholder(?:\[[^\]]*\])?\{\}/g, "");
  // Parentheses tapees autour de tout le contenu d'une racine, d'une borne
  // ou d'un terme de fraction : \sqrt{(x)}, \sum_{(k=0)}, \frac{1}{(2x)}.
  s = unwrapGroups(s);
  // Indices et exposants vides (bornes non remplies), jusqu'a ce qu'il n'en reste plus.
  for (let k = 0; k < 5; k++) {
    const next = s.replace(/[_^]\{\s*\}/g, "");
    if (next === s) break;
    s = next;
  }
  // Espace LaTeX ("\\,", "\\ "), jamais le second "\\" d'un saut de
  // ligne de systeme ("\\\\ <x" perdait un antislash : systeme casse).
  const SP = "(?:(?<!\\\\)\\\\[;:, ]|\\\\quad|\\s)";
  // "x in R" : les lettres i, n entre deux espaces (pas V_{in}, ni "min").
  s = s.replace(new RegExp(`(^|${SP})in(?=${SP}|$)`, "g"), "$1\\in");
  // Espaces tapes autour d'une relation : KaTeX espace deja.
  s = s
    .replace(new RegExp(`${SP}+(?=\\\\(?:${REL_CMDS})(?![A-Za-z])|[=<>])`, "g"), "")
    .replace(new RegExp(`(\\\\(?:${REL_CMDS})(?![A-Za-z])|[=<>])${SP}+(?=([A-Za-z])?)`, "g"),
      (_a, rel: string, letter?: string) => (letter && rel.startsWith("\\") ? `${rel} ` : rel));
  return s.replace(/\u0000(\d+)\u0000/g, (_a, i: string) => keep[Number(i)]).trim();
}

/** Contenu entre parentheses qui l'englobent en entier : "(a+b)" -> "a+b", "(a)(b)" -> null. */
function outerParens(x: string): string | null {
  const t = x.trim();
  let open = "", close = "";
  if (t.startsWith("\\left(") && t.endsWith("\\right)")) { open = "\\left("; close = "\\right)"; }
  else if (t.startsWith("(") && t.endsWith(")")) { open = "("; close = ")"; }
  else return null;
  const inner = t.slice(open.length, t.length - close.length);
  let depth = 0;
  for (const c of inner) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return null;
  }
  return depth === 0 ? inner : null;
}

/** Groupes {..} de \sqrt, \frac, _ et ^ dont le contenu est tout entier entre parentheses. */
function unwrapGroups(s: string): string {
  // Groupe {..} qui commence a `start` (juste apres "{") : fin exclue, ou -1.
  const groupEnd = (start: number) => {
    let depth = 1, j = start;
    for (; j < s.length && depth > 0; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
    }
    return depth === 0 ? j : -1;
  };
  const unwrap = (body: string) => unwrapGroups(outerParens(body) ?? body);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const m = /^(?:\\sqrt|\\frac|_|\^)\{/.exec(s.slice(i));
    if (!m) { out += s[i]; continue; }
    const start = i + m[0].length;
    const end = groupEnd(start);
    if (end < 0) { out += s[i]; continue; }
    out += m[0] + unwrap(s.slice(start, end - 1)) + "}";
    i = end - 1;
    // Denominateur d'une fraction : le groupe qui suit.
    if (m[0] === "\\frac{" && s[end] === "{") {
      const end2 = groupEnd(end + 1);
      if (end2 > 0) {
        out += "{" + unwrap(s.slice(end + 1, end2 - 1)) + "}";
        i = end2 - 1;
      }
    }
  }
  return out;
}
