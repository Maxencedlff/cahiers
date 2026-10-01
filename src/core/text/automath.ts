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

const FUNCS: Record<string, string> = {
  sin: "\\sin", cos: "\\cos", tan: "\\tan", ln: "\\ln", log: "\\log",
  exp: "\\exp", sqrt: "\\sqrt",
};

/**
 * Operateurs nommes, seulement colles a une parenthese : "Re(Z)" est la
 * partie reelle, "Re" seul reste la resistance R_e.
 */
const OPNAMES: Record<string, string> = {
  Re: "\\operatorname{Re}", Im: "\\operatorname{Im}", arg: "\\arg",
  max: "\\max", min: "\\min",
};

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
};
const PRODUCT = new Set(["·", "*", "×", "."]);
const SUMOP = new Set(["+", "-", "−"]);

const MULTI_OPS = ["<=>", "<=", ">=", "!=", "~=", "->", "=>", "<<", ">>"];
const SINGLE_OPS = "=<>≈≤≥≠≪≫→⇒⇔+-−*·×/^()|²³.";

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

/** Pulsation tapee en "w" : wt, jw, jwt (omega t). */
const OMEGA_WORD = /^(?:jw|wt|jwt)$/;

/** Le mot peut-il etre une variable ? */
function validIdent(s: string): boolean {
  if (isGreek(s) || s in FUNCS) return true;
  if (/[^A-Za-z0-9]/.test(s)) return false; // accents, lettres grecques collees
  if (STOP.has(s.toLowerCase())) return false;
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
  if (s.length === 1 && s in GREEK_CHARS) return GREEK_CHARS[s];
  if (OMEGA_WORD.test(s)) return s === "wt" ? "\\omega t" : s === "jw" ? "j\\omega" : "j\\omega t";
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
      if (t?.t !== "op" || !(t.s in REL)) break;
      this.skipSp(); this.i++;
      this.seenOp = true;
      const rhs = this.sum();
      if (!rhs) { this.i = save; this.seenOp = seen; break; }
      tex += ` ${REL[t.s]} ${rhs.tex}`; ops += 1 + rhs.ops; vars += rhs.vars;
    }
    return { tex, ops, vars };
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
      const startsAtom = t && ((t.t === "op" && t.s === "(") || t.t === "id" || t.t === "num");
      if (!startsAtom) break;
      const spacedOk = !sp || this.lastWasNumOrGreek(save)
        || (this.seenOp && t.t === "id" && (t.s in FUNCS || this.strongVar(save, t.s)));
      const parenTry = sp && !spacedOk && this.seenOp && t.t === "op";
      if (!spacedOk && !parenTry) break;
      this.skipSp();
      const rhs = this.unary();
      if (!rhs || (parenTry && !(rhs.group !== undefined && rhs.ops >= 1))) { this.i = save; this.seenOp = seen; break; }
      // f(x), v(t) : pas d'espace devant une parenthese collee.
      const glue = !sp && t.t === "op" ? "" : "\\,";
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
    return this.power();
  }

  private power(): Node | null {
    const base = this.atom();
    if (!base) return null;
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

  private atom(): Node | null {
    this.skipSp();
    const t = this.toks[this.i];
    if (!t) return null;
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
      if (!validIdent(t.s) && !this.letterA(t)) return null;
      this.i++;
      return { tex: identTex(t.s), ops: 0, vars: 1 };
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
   * "a" est un mot outil ("il y a"), sauf en maths : colle a un nombre
   * ("2a"), derriere un operateur ou une parenthese ("= a", "(a"), ou
   * devant une relation ("a != b").
   */
  private letterA(t: Tok): boolean {
    if (t.s !== "a") return false;
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
const LONE_SUB = /^(?:[sezdubcgfmnoptkrx]|be|ce|cb|bc|eb|ds|gs|sd|th|eq|cc|ee|dd|ss|out|ref|max|min|moy|eff|pp|ch|batt|bat|ac|dc|rms|sat)$/;
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
  if (!validIdent(s) || STOP.has(s.toLowerCase()) || isGreek(s) || s in FUNCS) return false;
  if (isUnit(s) || LONE_STOP.has(s)) return false;
  // Majuscule + indice : Vz, Ru, Vbe, Vbatt, Vin (pas Pin, Voici, Loi).
  const m = /^([VIURCLPZ])([a-z]{1,4})$/.exec(s);
  if (m) return LONE_SUB.test(m[2]) || (m[2] === "in" && /^[VI]$/.test(m[1]));
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
  return /\\frac|\^|\\cdot|=|<|>|\\leq|\\geq|\\approx|\\neq|\\ll|\\gg|\\to|Rightarrow/.test(tex);
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
  if (n.s === ")" || n.s === "|") return false;
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
    if (t.t === "sp" || t.t === "other") { k++; continue; }
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
 * "uand") qui redevient du texte, -1 sinon. null : rien a faire.
 */
export function planLine(parts: LinePart[], mode: ScanMode): { formulas: FoundFormula[]; undone: number } | null {
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
  return { formulas, undone };
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
  const protectedRe = /\\(?:mathrm|text|operatorname|mathbb)\{[^}]*\}|\\[A-Za-z]+/g;
  let out = "", last = 0, m: RegExpExecArray | null;
  const fix = (part: string) => part
    .replace(
      /(^|[^A-Za-z_^])(?<![_^]\{)([A-Z])([a-z]{1,5})(?![A-Za-z])/g,
      (all, pre: string, head: string, rest: string) => {
        const word = head + rest;
        if (ROMAN_UNITS.has(word)) return `${pre}${UNITS[word]}`;
        return STOP.has(word.toLowerCase()) ? all : `${pre}${head}_{${rest}}`;
      },
    )
    .replace(
      /(^|[^A-Za-z_^])(?<![_^]\{)([A-Z])(\d{1,2})(?![\d])/g,
      (_all, pre: string, head: string, digits: string) => `${pre}${head}_{${digits}}`,
    );
  while ((m = protectedRe.exec(latex))) {
    out += fix(latex.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fix(latex.slice(last));
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
  return s.replace(/\s+/g, " ").trim();
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
