/**
 * Lecture du LaTeX en arbre pour la calculatrice (voir texinput.ts) :
 * jetons, puis analyse en fractions, racines, puissances, appels de
 * fonction, parentheses et suites de facteurs. Ce qui ne se calcule pas
 * est nomme dans `Parser.dropped`.
 */
import { printSeq } from "./texprint";

export type Tok =
  | { t: "cmd"; v: string } // \frac, \alpha
  | { t: "num"; v: string } // 2,5  10  0.1
  | { t: "ch"; v: string }; // tout autre caractere (lettre, operateur, accolade)

/** Point de multiplication a la francaise devant une puissance de 10 : « 10.10^3 ». */
const FR_DOT_POW10 = /^\.10\^/;

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const m = /^\\([A-Za-z]+)/.exec(src.slice(i));
      if (m) { out.push({ t: "cmd", v: m[1] }); i += m[0].length; continue; }
      const sym = src[i + 1] ?? "";
      // \, \; \: \! \  : espaces ; \\ : saut de ligne (systeme) ; \% \{ \} : le caractere.
      if (/[,;:! ]/.test(sym) || sym === "") { i += 2; continue; }
      out.push(sym === "\\" ? { t: "cmd", v: "newline" } : { t: "ch", v: sym === "{" ? "(" : sym === "}" ? ")" : sym });
      i += 2;
      continue;
    }
    // Exposant, indice sans accolade : un seul chiffre, comme LaTeX (« 10^5.0{,}1 » = 10⁵ × 0,1).
    if (/\d/.test(c) && /[\^_]$/.test(src.slice(0, i).trimEnd())) { out.push({ t: "num", v: c }); i++; continue; }
    if (/\d/.test(c)) {
      let j = i;
      while (j < src.length && /\d/.test(src[j])) j++;
      // Partie decimale : « 2{,}5 », « 2,5 », « 3.5 » (pas « 10.10^3 », un produit).
      const rest = src.slice(j);
      const dec = /^(?:\{,\}|,|\.)(?=\d)/.exec(rest);
      if (dec && !(dec[0] === "." && FR_DOT_POW10.test(rest))) {
        j += dec[0].length;
        while (j < src.length && /\d/.test(src[j])) j++;
      }
      out.push({ t: "num", v: src.slice(i, j).replace("{,}", ",") });
      i = j;
      continue;
    }
    if (/\s/.test(c) || c === "~") { i++; continue; }
    out.push({ t: "ch", v: c });
    i++;
  }
  return out;
}

export type Node =
  | { k: "num"; v: string }
  | { k: "name"; v: string } // lettre, grecque, nom a indice
  | { k: "text"; v: string } // \text{mA}, \mathrm{V} : unite ou mot
  | { k: "group"; seq: Item[] } // {...} : groupe invisible
  | { k: "paren"; open: string; close: string; seq: Item[] }
  | { k: "abs"; seq: Item[] }
  | { k: "frac"; num: Item[]; den: Item[] }
  | { k: "sqrt"; arg: Item[]; index?: Item[] }
  | { k: "pow"; base: Node; exp: Item[] }
  | { k: "call"; fn: string; arg: Item[]; exp?: Item[]; base?: Item[] };
export type Item = Node | { k: "op"; v: string };

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  ell: "l", hbar: "ħ",
};

/** Fonctions LaTeX -> nom lu par le moteur (mathjs, ln et log a la TI). */
const FUNCTIONS: Record<string, string> = {
  sin: "sin", cos: "cos", tan: "tan", cot: "cot", sec: "sec", csc: "csc",
  arcsin: "asin", arccos: "acos", arctan: "atan",
  sinh: "sinh", cosh: "cosh", tanh: "tanh", sh: "sinh", ch: "cosh", th: "tanh",
  ln: "ln", log: "log", exp: "exp", arg: "arg", Re: "re", Im: "im", max: "max", min: "min", det: "det",
};
/** sin^{-1} : la reciproque. */
const INVERSE: Record<string, string> = { sin: "asin", cos: "acos", tan: "atan", sinh: "asinh", cosh: "acosh", tanh: "atanh" };

const RELATIONS: Record<string, string> = { leq: "<=", le: "<=", geq: ">=", ge: ">=", neq: "!=", ne: "!=" };
/** Relations qui ne se calculent pas : la formule est coupee la (on garde le premier membre). */
const CUTS: Record<string, string> = {
  approx: "≈", simeq: "≃", sim: "∼", equiv: "≡", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  iff: "⇔", implies: "⇒", to: "→", rightarrow: "→", mapsto: "↦", longrightarrow: "→", ll: "≪", gg: "≫",
};
/** Ce qui ne se calcule pas dans l'onglet Calcul : retire, nomme dans le message. */
const DROPPED: Record<string, string> = {
  int: "intégrale", iint: "intégrale", oint: "intégrale", sum: "somme Σ", prod: "produit Π", lim: "limite",
  pm: "±", mp: "∓", partial: "∂", nabla: "∇", infty: "∞", forall: "∀", exists: "∃", in: "∈",
  langle: "valeur moyenne ⟨ ⟩", rangle: "valeur moyenne ⟨ ⟩", underbrace: "accolade", overbrace: "accolade",
  begin: "système", end: "système", newline: "système", cases: "système",
};
/** Habillages sans effet sur le calcul : leur argument compte seul. */
const TRANSPARENT = new Set([
  "mathbf", "mathit", "boldsymbol", "bm", "vec", "overrightarrow", "overline", "bar", "hat", "widehat",
  "tilde", "dot", "ddot", "underline", "mathnormal", "boxed", "color",
]);
const TEXT_CMDS = new Set(["text", "textrm", "mathrm", "operatorname", "mbox", "textit", "mathsf", "mathtt", "textbf"]);
const IGNORED = new Set(["left", "right", "limits", "nolimits", "displaystyle", "textstyle", "quad", "qquad", "middle", "big", "Big", "bigl", "bigr", "Bigl", "Bigr"]);

export class Parser {
  private i = 0;
  readonly dropped: string[] = [];
  /** Une integrale a ete retiree : son « dx » final n'a plus de sens. */
  integral = false;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.i]; }
  private isCh(v: string, tok = this.peek()): boolean { return tok?.t === "ch" && tok.v === v; }
  private isCmd(v: string, tok = this.peek()): boolean { return tok?.t === "cmd" && tok.v === v; }

  /** Suite d'elements jusqu'a `stop` (exclu) ou la fin. */
  sequence(stop: () => boolean): Item[] {
    const out: Item[] = [];
    while (this.i < this.toks.length && !stop()) {
      const before = this.i;
      const item = this.item();
      if (item) out.push(item);
      if (this.i === before) this.i++; // jamais de boucle sans fin sur un jeton inattendu
    }
    return out;
  }

  /** Argument d'une commande : un groupe {…} ou un seul jeton (« \frac12 »). */
  private argument(): Item[] {
    const tok = this.peek();
    if (!tok) return [];
    if (this.isCh("{")) {
      this.i++;
      const seq = this.sequence(() => this.isCh("}"));
      this.i++;
      return seq;
    }
    if (tok.t === "num") {
      // « \frac12 » : un chiffre a la fois, comme LaTeX.
      this.i++;
      if (tok.v.length > 1) { this.toks.splice(this.i, 0, { t: "num", v: tok.v.slice(1) }); return [{ k: "num", v: tok.v[0] }]; }
      return [{ k: "num", v: tok.v }];
    }
    const a = this.atom();
    return a ? [a] : [];
  }

  /** Texte brut d'un groupe (\text{mA}) : commandes lues en clair (\Omega -> Ω). */
  private rawText(): string {
    if (!this.isCh("{")) { const t = this.peek(); this.i++; return t ? (t.t === "cmd" ? GREEK[t.v] ?? "" : t.v) : ""; }
    this.i++;
    let s = "", depth = 0;
    for (let t = this.peek(); t && !(depth === 0 && this.isCh("}", t)); t = this.peek()) {
      if (this.isCh("{", t)) depth++;
      else if (this.isCh("}", t)) depth--;
      else s += t.t === "cmd" ? GREEK[t.v] ?? "" : t.v;
      this.i++;
    }
    this.i++;
    return s.trim();
  }

  /** Element de la suite : operateur, ou facteur suivi de ses ^ _ ' ! */
  private item(): Item | null {
    const tok = this.peek()!;
    if (tok.t === "ch" && /^[+\-−=<>*/×·÷,;:&]$/.test(tok.v)) {
      this.i++;
      const v = tok.v === "−" ? "-" : tok.v === "*" || tok.v === "×" || tok.v === "·" ? "×" : tok.v === "÷" ? "/" : tok.v;
      // « <= » « >= » tapes en deux caracteres.
      if ((v === "<" || v === ">") && this.isCh("=")) { this.i++; return { k: "op", v: `${v}=` }; }
      if (v === "&") return null;
      // Point de multiplication a la francaise « R.C », « 10.10^3 ».
      return { k: "op", v };
    }
    if (tok.t === "ch" && tok.v === ".") { this.i++; return { k: "op", v: "×" }; }
    if (tok.t === "cmd") {
      // Saut de ligne d'un systeme : les equations separees par « ; ».
      if (tok.v === "newline") { this.i++; this.dropped.push(DROPPED.cases); return { k: "op", v: ";" }; }
      if (tok.v === "cdot" || tok.v === "times") { this.i++; return { k: "op", v: "×" }; }
      if (tok.v === "div") { this.i++; return { k: "op", v: "/" }; }
      if (RELATIONS[tok.v]) { this.i++; return { k: "op", v: RELATIONS[tok.v] }; }
      if (CUTS[tok.v]) { this.i++; return { k: "op", v: CUTS[tok.v] }; }
    }
    const a = this.atom();
    return a ? this.postfix(a) : null;
  }

  private postfix(a: Node): Node {
    for (;;) {
      if (this.isCh("_")) {
        this.i++;
        const sub = this.argument();
        if (a.k === "name") a = { k: "name", v: a.v + subscript(sub) };
        // Indice d'autre chose (accolade sous un terme...) : sans effet sur le calcul.
        continue;
      }
      if (this.isCh("'") && a.k === "name") { this.i++; a = { k: "name", v: `${a.v}'` }; continue; }
      if (this.isCh("^")) {
        this.i++;
        const exp = this.argument();
        // « x^{\prime} » : une derivee notee, pas une puissance.
        if (exp.length === 1 && exp[0].k === "name" && exp[0].v === "'") { if (a.k === "name") a = { k: "name", v: `${a.v}'` }; continue; }
        a = { k: "pow", base: a, exp };
        continue;
      }
      if (this.isCh("!")) { this.i++; a = { k: "pow", base: a, exp: [{ k: "op", v: "!" }] }; continue; }
      return a;
    }
  }

  private atom(): Node | null {
    const tok = this.peek();
    if (!tok) return null;
    if (tok.t === "num") { this.i++; return { k: "num", v: tok.v }; }
    if (tok.t === "ch") {
      if (tok.v === "{") {
        this.i++;
        const seq = this.sequence(() => this.isCh("}"));
        this.i++;
        return { k: "group", seq };
      }
      if (tok.v === "(" || tok.v === "[") return this.paren(tok.v, tok.v === "(" ? ")" : "]");
      if (tok.v === "|") {
        this.i++;
        const seq = this.sequence(() => this.isCh("|"));
        this.i++;
        return { k: "abs", seq };
      }
      if (/^[\p{L}%']$/u.test(tok.v)) { this.i++; return { k: "name", v: tok.v }; }
      this.i++; // accolade fermante orpheline, ponctuation inconnue : ignoree
      return null;
    }
    return this.command(tok.v);
  }

  private paren(open: string, close: string): Node {
    this.i++;
    const seq = this.sequence(() => this.isCh(close) || this.isCmd("right"));
    if (this.isCmd("right")) this.i++;
    if (this.isCh(close) || this.isCh(")") || this.isCh("]") || this.isCh(".")) this.i++;
    return { k: "paren", open, close, seq };
  }

  private command(name: string): Node | null {
    this.i++;
    if (name === "left") {
      const d = this.peek();
      this.i++;
      const open = d?.t === "ch" ? d.v : d?.t === "cmd" ? d.v : ".";
      if (open === "|" || open === "lvert" || open === "vert") {
        const seq = this.sequence(() => this.isCmd("right"));
        this.i += 2;
        return { k: "abs", seq };
      }
      if (open === "langle") this.dropped.push(DROPPED.langle);
      const seq = this.sequence(() => this.isCmd("right"));
      this.i += 2; // \right et son delimiteur
      // \left( \left[ \left\{ : des parentheses ; \left. \left\langle : un groupe.
      return open === "(" || open === "[" ? { k: "paren", open: "(", close: ")", seq } : { k: "group", seq };
    }
    if (IGNORED.has(name)) return null;
    if (GREEK[name]) return { k: "name", v: GREEK[name] };
    if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
      const num = this.argument();
      const den = this.argument();
      return { k: "frac", num, den };
    }
    if (name === "sqrt") {
      let index: Item[] | undefined;
      if (this.isCh("[")) {
        this.i++;
        index = this.sequence(() => this.isCh("]"));
        this.i++;
      }
      return { k: "sqrt", arg: this.argument(), ...(index ? { index } : {}) };
    }
    if (TEXT_CMDS.has(name)) {
      const t = this.rawText();
      if (!t) return null;
      // \operatorname{sh} : une fonction ; \mathrm{e}, \mathrm{d} : une lettre ; \text{mA} : une unite.
      if (FUNCTIONS[t]) return this.call(FUNCTIONS[t], t);
      if ((name === "mathrm" && /^[deij]$/.test(t)) || name === "operatorname") return { k: "name", v: t };
      return { k: "text", v: t };
    }
    if (TRANSPARENT.has(name)) {
      if (name === "color") { this.rawText(); return null; }
      const arg = this.argument();
      return arg.length === 1 && arg[0].k !== "op" ? arg[0] : { k: "group", seq: arg };
    }
    if (FUNCTIONS[name]) return this.call(FUNCTIONS[name], name);
    if (name === "underbrace" || name === "overbrace") {
      const arg = this.argument();
      // L'etiquette sous l'accolade (« _{i_{L\,min}} ») ne fait pas partie du calcul.
      if (this.isCh("_") || this.isCh("^")) { this.i++; this.argument(); }
      return { k: "group", seq: arg };
    }
    if (name === "begin" || name === "end") {
      this.rawText(); // nom de l'environnement
      this.dropped.push(DROPPED.cases);
      return null;
    }
    if (name === "int" || name === "iint" || name === "oint" || name === "sum" || name === "prod" || name === "lim") {
      // Bornes retirees avec l'operateur ; ce qui suit reste (l'integrande).
      if (name !== "sum" && name !== "prod" && name !== "lim") this.integral = true;
      while (this.isCh("_") || this.isCh("^")) { this.i++; this.argument(); }
    }
    if (name === "infty") { this.dropped.push(DROPPED.infty); return { k: "name", v: "Infinity" }; }
    this.dropped.push(DROPPED[name] ?? name);
    return null;
  }

  /** \sin x, \sin^2(x), \log_{2} 8, \sin\frac{\pi}{2} : l'argument entre parentheses. */
  private call(fn: string, latexName: string): Node {
    let exp: Item[] | undefined, base: Item[] | undefined;
    for (;;) {
      if (this.isCh("^")) { this.i++; exp = this.argument(); continue; }
      if (this.isCh("_")) { this.i++; base = this.argument(); continue; }
      break;
    }
    let f = fn;
    if (exp && printSeq(exp).s === "-1" && INVERSE[latexName]) { f = INVERSE[latexName]; exp = undefined; }
    let arg: Item[];
    if (this.isCh("(") || this.isCmd("left")) {
      const p = this.atom()!;
      arg = p.k === "paren" || p.k === "group" ? p.seq : [p];
    } else {
      // Sans parentheses : les facteurs colles qui suivent (« \sin \omega t »),
      // jusqu'au prochain operateur ou a la fonction suivante.
      arg = [];
      while (this.peek()) {
        const t = this.peek()!;
        if (t.t === "ch" && /^[+\-−=<>*/×·÷,;&)\]}|]$/.test(t.v)) break;
        if (t.t === "cmd" && (FUNCTIONS[t.v] || t.v === "cdot" || t.v === "times" || t.v === "right" || RELATIONS[t.v] || CUTS[t.v])) break;
        const before = this.i;
        const it = this.item();
        if (it) arg.push(it);
        if (this.i === before) break;
      }
    }
    return { k: "call", fn: f, arg, ...(exp ? { exp } : {}), ...(base ? { base } : {}) };
  }
}

/** Indice aplati comme dans le reste de l'appli : R_{1} -> R1, V_{be} -> Vbe, u_{n+1} -> u_(n+1). */
function subscript(sub: Item[]): string {
  const s = printSeq(sub).s.replace(/[·×\s]/g, "");
  return /^[\p{L}\d']+$/u.test(s) ? s : `_(${s})`;
}

/** Integrande sans son « dx » final (« x^2 dx » -> « x^2 »). */
export function withoutDifferential(seq: Item[]): Item[] {
  const n = seq.length;
  const a = seq[n - 2], b = seq[n - 1];
  return a?.k === "name" && a.v === "d" && b?.k === "name" ? seq.slice(0, n - 2) : seq;
}

/** Coupe aux relations qui ne se calculent pas (≈, ⇔, →) : le premier membre non vide reste. */
export function cutAtRelations(seq: Item[], dropped: string[]): Item[] {
  const cut = new Set(Object.values(CUTS));
  const parts: Item[][] = [[]];
  for (const it of seq) {
    if (it.k === "op" && cut.has(it.v)) { dropped.push(it.v); parts.push([]); } else parts[parts.length - 1].push(it);
  }
  return parts.find((p) => p.length) ?? [];
}
