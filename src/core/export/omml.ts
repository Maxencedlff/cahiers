/**
 * Formules en vraies equations Word (OMML, Office Math Markup Language),
 * editables dans Word : LaTeX -> MathML (KaTeX, sortie « mathml ») -> OMML.
 * Logique pure, sans DOM : le MathML de KaTeX est lu par un petit lecteur
 * XML (il est toujours bien forme), puis chaque element est traduit.
 *
 * Couverts : fractions (et \binom sans barre), indices/exposants, racines,
 * integrales/sommes/produits avec bornes (m:nary, l'integrande jusqu'a la
 * relation suivante), lim/max/min (m:limLow), fonctions (sin, ln : m:func),
 * matrices et systemes (m:m), parentheses extensibles (\left \right : m:d),
 * accents et vecteurs (m:acc), barres (m:bar), accolades (m:groupChr),
 * grec, operateurs, \mathbb, \text. Un element inconnu passe par ses enfants :
 * rien n'est jamais perdu.
 */

import katex from "katex";

/* ---------------- lecteur XML minimal ---------------- */

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Texte d'un noeud texte (tag "#text"). */
  text?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Lit un fragment XML bien forme (sortie de KaTeX). Leve une erreur sinon. */
export function parseXml(src: string): XNode {
  const root: XNode = { tag: "#root", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src))) {
    if (m.index !== last) throw new Error("XML illisible");
    last = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      if (top.tag !== m[1]) throw new Error(`balise ${m[1]} mal fermee`);
      stack.pop();
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[3]))) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
      const node: XNode = { tag: m[2], attrs, children: [] };
      top.children.push(node);
      if (!m[4]) stack.push(node);
    } else if (m[5] !== undefined) {
      top.children.push({ tag: "#text", attrs: {}, children: [], text: decode(m[5]) });
    }
  }
  if (last !== src.length || stack.length !== 1) throw new Error("XML incomplet");
  return root;
}

/* ---------------- LaTeX -> MathML ---------------- */

/**
 * MathML de KaTeX pour une formule, ou null si KaTeX ne la lit pas (dans ce
 * cas l'appli elle-meme l'affiche en texte simple).
 */
export function latexToMathml(latex: string, display = false): string | null {
  try {
    return katex.renderToString(latex, { output: "mathml", throwOnError: true, displayMode: display, strict: "ignore" });
  } catch {
    return null;
  }
}

/* ---------------- MathML -> OMML ---------------- */

/** Proprietes Word d'un morceau d'equation : couleur (hex sans #). */
export interface OmmlStyle { color?: string }

export function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"))
    // Caracteres interdits en XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** Grands operateurs : m:nary (bornes dessous/dessus pour Σ, Π ; a cote pour ∫). */
const NARY = new Set(["∫", "∬", "∭", "∮", "∯", "∰", "∑", "∏", "∐", "⋃", "⋂", "⋁", "⋀", "⨁", "⨂", "⨀"]);
const NARY_SIDE = new Set(["∫", "∬", "∭", "∮", "∯", "∰"]);
/** Noms dont l'indice va dessous (m:limLow) : lim x->0. */
const LIMIT_NAMES = new Set(["lim", "liminf", "limsup", "max", "min", "sup", "inf", "arg max", "arg min", "argmax", "argmin", "det", "gcd", "Pr"]);
/** Relations : fin de l'integrande d'une integrale ou d'une somme. */
const RELATIONS = new Set(["=", "<", ">", "≤", "≥", "≈", "≠", "→", "⇒", "⇔", "⟹", "⟺", "≡", "∼", "≃", "≅", "∝", "≪", "≫", ",", ";"]);
/** Invisibles de MathML (application de fonction, produit, separateur). */
const INVISIBLE = new Set(["⁡", "⁢", "⁣", "⁤"]);

class Writer {
  constructor(private style: OmmlStyle) {}

  private rPr(sty: string | null, scr: string | null, nor = false): string {
    const m = (scr ? `<m:scr m:val="${scr}"/>` : "") + (sty ? `<m:sty m:val="${sty}"/>` : "") + (nor ? "<m:nor/>" : "");
    const w = `<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/>${this.style.color ? `<w:color w:val="${this.style.color}"/>` : ""}</w:rPr>`;
    return (m ? `<m:rPr>${m}</m:rPr>` : "") + w;
  }

  /** Un run d'equation. `sty` : p (droit), b (gras), bi, i ; null = defaut (lettres en italique). */
  run(text: string, sty: string | null = null, scr: string | null = null, nor = false): string {
    if (!text) return "";
    return `<m:r>${this.rPr(sty, scr, nor)}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;
  }

  /** Proprietes de controle (couleur des barres, parentheses, etc.). */
  ctrl(): string {
    return `<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/>${this.style.color ? `<w:color w:val="${this.style.color}"/>` : ""}</w:rPr></m:ctrlPr>`;
  }

  /** Contenu d'un argument (m:e, m:num...) : sequence d'enfants. */
  arg(nodes: XNode | XNode[] | undefined): string {
    if (!nodes) return "";
    return this.seq(Array.isArray(nodes) ? nodes : [nodes]);
  }

  /** Sequence d'elements : fences, grands operateurs et fonctions regroupent leurs voisins. */
  seq(input: XNode[]): string {
    const nodes = flatten(input);
    let out = "";
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      // Parenthese extensible (\left ... \right) : jusqu'a la fermante du meme niveau.
      if (isFence(n)) {
        const close = matchFence(nodes, i);
        const inner = nodes.slice(i + 1, close === -1 ? nodes.length : close);
        const end = close === -1 ? "" : textOf(nodes[close]);
        out += this.delim(textOf(n), end, inner);
        i = close === -1 ? nodes.length : close;
        continue;
      }
      // Grand operateur : borne(s) et integrande jusqu'a la relation suivante.
      const nary = naryOf(n);
      if (nary) {
        let j = i + 1;
        while (j < nodes.length && !isRelation(nodes[j])) j++;
        out += this.nary(nary, nodes.slice(i + 1, j));
        i = j - 1;
        continue;
      }
      // Fonction (sin x, ln x) : nom, application invisible, argument.
      // lim avec indice : l'application invisible est dans la base (msub).
      const fname = funcName(n);
      const applyNext = i + 1 < nodes.length && isApply(nodes[i + 1]);
      if (fname !== null && (applyNext || n.tag === "msub" || n.tag === "munder")) {
        const argAt = applyNext ? i + 2 : i + 1;
        const fn = this.funcHead(n);
        if (argAt < nodes.length && !isRelation(nodes[argAt]) && !isOperator(nodes[argAt]) && !isApply(nodes[argAt])) {
          out += `<m:func><m:funcPr>${this.ctrl()}</m:funcPr><m:fName>${fn}</m:fName><m:e>${this.node(nodes[argAt])}</m:e></m:func>`;
          i = argAt;
        } else {
          out += fn;
          i = argAt - 1;
        }
        continue;
      }
      out += this.node(n);
    }
    return out;
  }

  private funcHead(n: XNode): string {
    // lim avec indice : m:limLow ; sinon le nom en droit.
    if ((n.tag === "msub" || n.tag === "munder") && n.children.length >= 2) {
      return `<m:limLow><m:limLowPr>${this.ctrl()}</m:limLowPr><m:e>${this.run(textOf(n.children[0]).replace(/⁡/g, ""), "p")}</m:e><m:lim>${this.arg(n.children[1])}</m:lim></m:limLow>`;
    }
    return this.run(textOf(n).replace(/⁡/g, ""), "p");
  }

  private delim(beg: string, end: string, inner: XNode[]): string {
    const pr = `<m:dPr><m:begChr m:val="${escapeXml(beg)}"/><m:endChr m:val="${escapeXml(end)}"/>${this.ctrl()}</m:dPr>`;
    return `<m:d>${pr}<m:e>${this.seq(inner)}</m:e></m:d>`;
  }

  private nary(op: { chr: string; sub?: XNode; sup?: XNode }, body: XNode[]): string {
    const loc = NARY_SIDE.has(op.chr) ? "subSup" : "undOvr";
    const pr = `<m:naryPr><m:chr m:val="${escapeXml(op.chr)}"/><m:limLoc m:val="${loc}"/>`
      + (op.sub ? "" : "<m:subHide m:val=\"1\"/>") + (op.sup ? "" : "<m:supHide m:val=\"1\"/>") + `${this.ctrl()}</m:naryPr>`;
    return `<m:nary>${pr}<m:sub>${this.arg(op.sub)}</m:sub><m:sup>${this.arg(op.sup)}</m:sup><m:e>${this.seq(body)}</m:e></m:nary>`;
  }

  node(n: XNode): string {
    const c = n.children;
    switch (n.tag) {
      case "#text": return n.text?.trim() ? this.run(n.text) : "";
      case "mi": {
        const t = textOf(n);
        const v = n.attrs.mathvariant;
        if (v) return this.variant(t, v);
        // Plusieurs lettres (« lim », « sin » hors application) : droit.
        return this.run(t, [...t].length > 1 ? "p" : null);
      }
      case "mn": return this.run(textOf(n), n.attrs.mathvariant === "bold" ? "b" : null);
      case "mo": {
        const t = [...textOf(n)].filter((ch) => !INVISIBLE.has(ch)).join("");
        return this.run(t, "p");
      }
      case "mtext": case "ms": {
        const t = textOf(n);
        if (!t.trim()) return t ? this.run(" ", "p") : "";
        return this.run(t, "p", null, true);
      }
      case "mspace": {
        const w = parseFloat(n.attrs.width ?? "0");
        return w >= 0.5 ? this.run(" ", "p") : w > 0.1 ? this.run(" ", "p") : "";
      }
      case "mphantom": case "annotation": case "annotation-xml": case "none": case "mprescripts": return "";
      case "semantics": return this.arg(c[0]);
      case "mfrac": {
        const noBar = /^0(?:\.0*)?(?:px|em|pt)?$/.test(n.attrs.linethickness ?? "");
        return `<m:f><m:fPr>${noBar ? "<m:type m:val=\"noBar\"/>" : ""}${this.ctrl()}</m:fPr><m:num>${this.arg(c[0])}</m:num><m:den>${this.arg(c[1])}</m:den></m:f>`;
      }
      case "msqrt":
        return `<m:rad><m:radPr><m:degHide m:val="1"/>${this.ctrl()}</m:radPr><m:deg/><m:e>${this.arg(c)}</m:e></m:rad>`;
      case "mroot":
        return `<m:rad><m:radPr>${this.ctrl()}</m:radPr><m:deg>${this.arg(c[1])}</m:deg><m:e>${this.arg(c[0])}</m:e></m:rad>`;
      case "msub":
        return `<m:sSub><m:sSubPr>${this.ctrl()}</m:sSubPr><m:e>${this.arg(c[0])}</m:e><m:sub>${this.arg(c[1])}</m:sub></m:sSub>`;
      case "msup":
        return `<m:sSup><m:sSupPr>${this.ctrl()}</m:sSupPr><m:e>${this.arg(c[0])}</m:e><m:sup>${this.arg(c[1])}</m:sup></m:sSup>`;
      case "msubsup":
        return `<m:sSubSup><m:sSubSupPr>${this.ctrl()}</m:sSubSupPr><m:e>${this.arg(c[0])}</m:e><m:sub>${this.arg(c[1])}</m:sub><m:sup>${this.arg(c[2])}</m:sup></m:sSubSup>`;
      case "munder": return this.under(c[0], c[1], n.attrs.accentunder === "true");
      case "mover": return this.over(c[0], c[1], n.attrs.accent === "true");
      case "munderover":
        return `<m:limUpp><m:limUppPr>${this.ctrl()}</m:limUppPr><m:e>${this.under(c[0], c[1], false)}</m:e><m:lim>${this.arg(c[2])}</m:lim></m:limUpp>`;
      case "mtable": return this.table(n);
      case "menclose":
        return `<m:borderBox><m:borderBoxPr>${this.ctrl()}</m:borderBoxPr><m:e>${this.arg(c)}</m:e></m:borderBox>`;
      default:
        // math, mrow, mstyle, mpadded, merror, mtd, inconnus : leurs enfants.
        return this.seq(c);
    }
  }

  private variant(t: string, v: string): string {
    switch (v) {
      case "normal": return this.run(t, "p");
      case "bold": return this.run(t, "b");
      case "bold-italic": return this.run(t, "bi");
      case "italic": return this.run(t, "i");
      case "double-struck": return this.run(t, "p", "double-struck");
      case "script": case "bold-script": return this.run(t, null, "script");
      case "fraktur": case "bold-fraktur": return this.run(t, null, "fraktur");
      case "sans-serif": case "bold-sans-serif": case "sans-serif-italic": return this.run(t, v.includes("bold") ? "b" : "p", "sans-serif");
      case "monospace": return this.run(t, "p", "monospace");
      default: return this.run(t);
    }
  }

  private under(base: XNode, below: XNode, accent: boolean): string {
    const ch = textOf(below);
    if (below?.tag === "mo" && (ch === "⏟" || ch === "︸")) {
      return `<m:groupChr><m:groupChrPr><m:chr m:val="⏟"/><m:pos m:val="bot"/><m:vertJc m:val="top"/>${this.ctrl()}</m:groupChrPr><m:e>${this.arg(base)}</m:e></m:groupChr>`;
    }
    if (below?.tag === "mo" && (ch === "‾" || ch === "_" || ch === "¯")) {
      return `<m:bar><m:barPr><m:pos m:val="bot"/>${this.ctrl()}</m:barPr><m:e>${this.arg(base)}</m:e></m:bar>`;
    }
    void accent;
    // lim x->0, \underset : limite dessous.
    const head = base && (funcName(base) !== null || base.tag === "mi") ? this.run(textOf(base).replace(/⁡/g, ""), [...textOf(base)].length > 1 ? "p" : null) : this.arg(base);
    return `<m:limLow><m:limLowPr>${this.ctrl()}</m:limLowPr><m:e>${head}</m:e><m:lim>${this.arg(below)}</m:lim></m:limLow>`;
  }

  private over(base: XNode, above: XNode, accent: boolean): string {
    const ch = textOf(above);
    if (above?.tag === "mo" && (ch === "‾" || ch === "¯") ) {
      return `<m:bar><m:barPr><m:pos m:val="top"/>${this.ctrl()}</m:barPr><m:e>${this.arg(base)}</m:e></m:bar>`;
    }
    if (above?.tag === "mo" && (ch === "⏞" || ch === "︷")) {
      return `<m:groupChr><m:groupChrPr><m:chr m:val="⏞"/><m:pos m:val="top"/><m:vertJc m:val="bot"/>${this.ctrl()}</m:groupChrPr><m:e>${this.arg(base)}</m:e></m:groupChr>`;
    }
    if (accent && above?.tag === "mo" && [...ch].length === 1) {
      return `<m:acc><m:accPr><m:chr m:val="${escapeXml(accentChar(ch))}"/>${this.ctrl()}</m:accPr><m:e>${this.arg(base)}</m:e></m:acc>`;
    }
    return `<m:limUpp><m:limUppPr>${this.ctrl()}</m:limUppPr><m:e>${this.arg(base)}</m:e><m:lim>${this.arg(above)}</m:lim></m:limUpp>`;
  }

  private table(n: XNode): string {
    const rows = n.children.filter((r) => r.tag === "mtr" || r.tag === "mlabeledtr");
    const cols = Math.max(1, ...rows.map((r) => r.children.filter((d) => d.tag === "mtd").length));
    const align = (n.attrs.columnalign ?? "").split(/\s+/)[0] === "left" ? "left" : "center";
    const pr = `<m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="${align}"/></m:mcPr></m:mc></m:mcs>${this.ctrl()}</m:mPr>`;
    const body = rows.map((r) => {
      const cells = r.children.filter((d) => d.tag === "mtd").map((d) => `<m:e>${this.arg(d.children)}</m:e>`);
      while (cells.length < cols) cells.push("<m:e/>");
      return `<m:mr>${cells.join("")}</m:mr>`;
    }).join("");
    return `<m:m>${pr}${body}</m:m>`;
  }
}

/** Accents de KaTeX vers les caracteres combinants qu'attend Word. */
function accentChar(ch: string): string {
  const map: Record<string, string> = {
    "^": "̂", "ˆ": "̂", "~": "̃", "˜": "̃", "¨": "̈", "˙": "̇",
    "´": "́", "`": "̀", "ˇ": "̌", "˘": "̆", "→": "⃗", "⃗": "⃗",
    "‾": "̅", "¯": "̅", "←": "⃖", "↔": "⃡", "˚": "̊",
  };
  return map[ch] ?? ch;
}

/** mrow / mstyle sans attribut utile : leurs enfants dans la sequence du parent. */
function flatten(nodes: XNode[]): XNode[] {
  const out: XNode[] = [];
  for (const n of nodes) {
    if (n.tag === "#text" && !n.text?.trim()) continue;
    if ((n.tag === "mrow" || n.tag === "mstyle" || n.tag === "semantics" || n.tag === "math") && !n.children.some(isFenceOpen)) {
      if (n.tag === "semantics") { out.push(...flatten(n.children.slice(0, 1))); continue; }
      out.push(...flatten(n.children));
      continue;
    }
    out.push(n);
  }
  return out;
}

/** Texte complet d'un noeud. */
export function textOf(n: XNode | undefined): string {
  if (!n) return "";
  if (n.tag === "#text") return n.text ?? "";
  if (n.tag === "annotation" || n.tag === "annotation-xml") return "";
  return n.children.map(textOf).join("");
}

function isFence(n: XNode): boolean {
  return n.tag === "mo" && n.attrs.fence === "true";
}
function isFenceOpen(n: XNode): boolean {
  return isFence(n);
}

/** Fermante qui repond a l'ouvrante en `i` (fences emboitees comptees), -1 si aucune. */
function matchFence(nodes: XNode[], i: number): number {
  let depth = 0;
  for (let j = i + 1; j < nodes.length; j++) {
    if (!isFence(nodes[j])) continue;
    const t = textOf(nodes[j]);
    // \middle| : separateur, ni ouvrant ni fermant.
    if (nodes[j].attrs.separator === "true") continue;
    if (OPENERS.has(t) && !CLOSERS.has(t)) { depth++; continue; }
    if (CLOSERS.has(t) && !OPENERS.has(t)) {
      if (depth === 0) return j;
      depth--;
      continue;
    }
    // | ou ‖ : ferme si on est au niveau 0, sinon ouvre.
    if (depth === 0) return j;
    depth--;
  }
  return -1;
}
const OPENERS = new Set(["(", "[", "{", "⟨", "⌊", "⌈", "⟦", ""]);
const CLOSERS = new Set([")", "]", "}", "⟩", "⌋", "⌉", "⟧"]);

function isApply(n: XNode): boolean {
  return n.tag === "mo" && textOf(n) === "⁡";
}

function isRelation(n: XNode): boolean {
  return n.tag === "mo" && RELATIONS.has(textOf(n).trim());
}

function isOperator(n: XNode): boolean {
  return n.tag === "mo" && /^[+\-−±∓·⋅×÷*/]$/.test(textOf(n).trim());
}

/** Nom d'une fonction (« sin », « lim » avec indice), null sinon. */
function funcName(n: XNode): string | null {
  if (n.tag === "mi" && [...textOf(n)].length > 1) return textOf(n);
  if ((n.tag === "msub" || n.tag === "munder") && n.children[0]) {
    const base = n.children[0];
    const t = textOf(base).replace(/⁡/g, "");
    if ((base.tag === "mrow" || base.tag === "mi") && LIMIT_NAMES.has(t)) return t;
  }
  return null;
}

/** Grand operateur (∫, Σ...), seul ou avec ses bornes. */
function naryOf(n: XNode): { chr: string; sub?: XNode; sup?: XNode } | null {
  const big = (x: XNode | undefined) => (x && x.tag === "mo" && NARY.has(textOf(x).trim()) ? textOf(x).trim() : null);
  const own = big(n);
  if (own) return { chr: own };
  const c = n.children;
  const chr = big(c[0]);
  if (!chr) return null;
  switch (n.tag) {
    case "msub": case "munder": return { chr, sub: c[1] };
    case "msup": case "mover": return { chr, sup: c[1] };
    case "msubsup": case "munderover": return { chr, sub: c[1], sup: c[2] };
    default: return null;
  }
}

/** MathML (chaine) -> contenu OMML (sans m:oMath). Leve une erreur si le MathML est illisible. */
export function mathmlToOmml(mathml: string, style: OmmlStyle = {}): string {
  const root = parseXml(mathml);
  const math = findTag(root, "math");
  if (!math) throw new Error("pas de <math>");
  return mergeRuns(new Writer(style).seq(math.children));
}

/** Runs voisins de memes proprietes fusionnes (« b » « e » -> « be ») : l'equation se relit et s'edite mieux. */
const SAME_RUNS = /<m:r>((?:<m:rPr>(?:(?!<\/m:rPr>).)*<\/m:rPr>)?<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)<m:t xml:space="preserve">([^<]*)<\/m:t><\/m:r><m:r>\1<m:t xml:space="preserve">/g;
function mergeRuns(xml: string): string {
  for (let k = 0; k < 50; k++) {
    const next = xml.replace(SAME_RUNS, "<m:r>$1<m:t xml:space=\"preserve\">$2");
    if (next === xml) break;
    xml = next;
  }
  return xml;
}

function findTag(n: XNode, tag: string): XNode | null {
  if (n.tag === tag) return n;
  for (const c of n.children) {
    const f = findTag(c, tag);
    if (f) return f;
  }
  return null;
}

/**
 * Formule LaTeX -> `<m:oMath>` complet, ou null si elle ne se convertit pas
 * (l'appelant passe alors a l'image de repli).
 */
export function latexToOmml(latex: string, style: OmmlStyle = {}): string | null {
  const mathml = latexToMathml(latex);
  if (!mathml) return null;
  try {
    const body = mathmlToOmml(mathml, style);
    return body ? `<m:oMath>${body}</m:oMath>` : null;
  } catch {
    return null;
  }
}
