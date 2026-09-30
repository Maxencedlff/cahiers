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
 * derriere un nombre ou une lettre grecque ("2 R", "beta Ru").
 *
 * Module sans DOM.
 */

export interface FoundFormula {
  start: number;
  end: number;
  latex: string;
}

type Tok =
  | { t: "num"; s: string; a: number; b: number }
  | { t: "id"; s: string; a: number; b: number }
  | { t: "op"; s: string; a: number; b: number }
  | { t: "sp"; s: string; a: number; b: number }
  | { t: "other"; s: string; a: number; b: number };

const GREEK_NAMES: Record<string, string> = {
  alpha: "\\alpha", beta: "\\beta", gamma: "\\gamma", delta: "\\delta",
  epsilon: "\\varepsilon", eta: "\\eta", theta: "\\theta", lambda: "\\lambda",
  mu: "\\mu", pi: "\\pi", rho: "\\rho", sigma: "\\sigma", tau: "\\tau",
  phi: "\\varphi", omega: "\\omega",
  Gamma: "\\Gamma", Delta: "\\Delta", Theta: "\\Theta", Lambda: "\\Lambda",
  Pi: "\\Pi", Sigma: "\\Sigma", Phi: "\\Phi", Omega: "\\Omega",
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
};

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

/** Le mot peut-il etre une variable ? */
function validIdent(s: string): boolean {
  if (isGreek(s) || s in FUNCS) return true;
  if (/[^A-Za-z0-9]/.test(s)) return false; // accents, lettres grecques collees
  if (STOP.has(s.toLowerCase())) return false;
  if (s.length > 6) return false;
  // Mot en minuscules de 3 lettres ou plus : seulement les tensions et
  // courants a la francaise (vbatt, vce, icc, vout...), jamais "vaut".
  if (/^[a-z]{3,}$/.test(s)) return LOWER_VAR.test(s);
  // Majuscule + 4 lettres ou plus : Vbatt oui, Zener ou Pont non.
  if (/^[A-Z][a-z]{4,}$/.test(s)) return /^[VIU]/.test(s);
  return true;
}

function identTex(s: string): string {
  if (s in GREEK_NAMES) return GREEK_NAMES[s];
  if (s.length === 1 && s in GREEK_CHARS) return GREEK_CHARS[s];
  const m = s.match(/^([A-Za-z])([A-Za-z0-9]+)$/);
  if (!m) return s;
  return m[2].length === 1 ? `${m[1]}_${m[2]}` : `${m[1]}_{${m[2]}}`;
}

interface Node { tex: string; group?: string; ops: number; vars: number }

class Parser {
  private i = 0;
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

  relation(): Node | null {
    const first = this.sum();
    if (!first) return null;
    let tex = first.tex, ops = first.ops, vars = first.vars;
    for (;;) {
      const save = this.i;
      const t = this.peek();
      if (t?.t !== "op" || !(t.s in REL)) break;
      this.skipSp(); this.i++;
      const rhs = this.sum();
      if (!rhs) { this.i = save; break; }
      tex += ` ${REL[t.s]} ${rhs.tex}`; ops += 1 + rhs.ops; vars += rhs.vars;
    }
    return { tex, ops, vars };
  }

  private sum(): Node | null {
    const first = this.product();
    if (!first) return null;
    let tex = first.tex, ops = first.ops, vars = first.vars;
    for (;;) {
      const save = this.i;
      const t = this.peek();
      if (t?.t !== "op" || !SUMOP.has(t.s)) break;
      this.skipSp(); this.i++;
      const rhs = this.product();
      if (!rhs) { this.i = save; break; }
      tex += ` ${t.s === "+" ? "+" : "-"} ${rhs.tex}`; ops += 1 + rhs.ops; vars += rhs.vars;
    }
    return { tex, ops, vars };
  }

  private product(): Node | null {
    const first = this.unary();
    if (!first) return null;
    let cur: Node = first;
    for (;;) {
      const save = this.i;
      const sp = this.spaced();
      const t = this.peek();
      if (t?.t === "op" && t.s === "/") {
        this.skipSp(); this.i++;
        const den = this.unary();
        if (!den) { this.i = save; break; }
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
        const rhs = this.unary();
        if (!rhs) { this.i = save; break; }
        cur = { tex: `${cur.tex} \\cdot ${rhs.tex}`, ops: cur.ops + rhs.ops + 1, vars: cur.vars + rhs.vars };
        continue;
      }
      // Produit implicite : colle ("2R", "R(Vz"), ou derriere un nombre ou
      // une lettre grecque ("2 R", "beta Ru"). Jamais entre deux mots.
      const startsAtom = t && ((t.t === "op" && t.s === "(") || t.t === "id" || t.t === "num");
      if (startsAtom && (!sp || this.lastWasNumOrGreek(save))) {
        this.skipSp();
        const rhs = this.unary();
        if (!rhs) { this.i = save; break; }
        cur = { tex: `${cur.tex}\\,${rhs.tex}`, ops: cur.ops + rhs.ops, vars: cur.vars + rhs.vars };
        continue;
      }
      break;
    }
    return cur;
  }

  private lastWasNumOrGreek(at: number): boolean {
    let j = at - 1;
    while (this.toks[j]?.t === "sp") j--;
    const t = this.toks[j];
    return !!t && (t.t === "num" || (t.t === "id" && isGreek(t.s)));
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
    if (t?.t === "op" && (t.s === "²" || t.s === "³")) {
      this.i++;
      return { tex: `${base.tex}^${t.s === "²" ? 2 : 3}`, ops: base.ops + 1, vars: base.vars };
    }
    if (t?.t === "op" && t.s === "^") {
      const save = this.i;
      this.i++;
      const exp = this.unary();
      if (!exp) { this.i = save; return base; }
      return { tex: `${base.tex}^{${exp.group ?? exp.tex}}`, ops: base.ops + exp.ops + 1, vars: base.vars + exp.vars };
    }
    return base;
  }

  private atom(): Node | null {
    this.skipSp();
    const t = this.toks[this.i];
    if (!t) return null;
    if (t.t === "num") {
      this.i++;
      let tex = t.s.replace(",", "{,}");
      // Unite derriere un nombre : "0,6 V", "50 Ω", "10 mA".
      const save = this.i;
      this.skipSp();
      const u = this.toks[this.i];
      const after = this.toks[this.i + 1];
      if (u?.t === "id" && u.s in UNITS && (!after || after.t !== "id")) {
        this.i++;
        tex += `\\,${UNITS[u.s]}`;
      } else {
        this.i = save;
      }
      return { tex, ops: 0, vars: 0 };
    }
    if (t.t === "id") {
      if (t.s in FUNCS) {
        const save = this.i;
        this.i++;
        const arg = this.atom();
        if (!arg) { this.i = save; return null; }
        if (t.s === "sqrt") return { tex: `\\sqrt{${arg.group ?? arg.tex}}`, ops: arg.ops + 1, vars: arg.vars };
        return { tex: `${FUNCS[t.s]}${arg.group ? `\\left(${arg.group}\\right)` : ` ${arg.tex}`}`, ops: arg.ops + 1, vars: arg.vars };
      }
      if (!validIdent(t.s)) return null;
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

/**
 * Formules d'une ligne de texte brut, de gauche a droite, sans
 * chevauchement. Une formule a au moins un operateur et une variable.
 */
export function findFormulas(line: string): FoundFormula[] {
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
    if (node && node.ops >= 1 && (node.vars >= 1 || numericOk(line.slice(t.a, toks[last].b), node.tex))) {
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
