/**
 * Ecriture de l'arbre lu par texparse.ts en saisie de calculatrice :
 * parentheses minimales mais suffisantes, signe du produit choisi selon ce
 * qui se touche (voir les conventions dans texinput.ts).
 */
import type { Item, Node } from "./texparse";

/**
 * Nature de l'ecriture produite, pour decider des parentheses :
 * atom (nombre, nom, appel, parenthese), pow, product, quotient, sum, rel.
 */
type Kind = "atom" | "text" | "pow" | "product" | "quotient" | "sum" | "rel";
interface Out { s: string; kind: Kind; node?: Node }

const BINARY_SPACED = new Set(["+", "-", "=", "<", ">", "<=", ">=", "!="]);

export function printSeq(seq: Item[]): Out {
  // Termes = suites de facteurs colles, separes par des operateurs explicites.
  const terms: { op: string | null; factors: Node[] }[] = [{ op: null, factors: [] }];
  for (const it of seq) {
    if (it.k === "op") terms.push({ op: it.v, factors: [] });
    else terms[terms.length - 1].factors.push(it);
  }
  let s = "", kind: Kind = "atom", count = 0, last: Out | null = null;
  for (let t = 0; t < terms.length; t++) {
    const { op, factors } = terms[t];
    const term = printTerm(factors);
    if (op !== null) {
      // Moins unaire (en tete, apres un autre operateur) : colle.
      const unary = (op === "-" || op === "+") && (s.trim() === "" || /[+\-×/=<>,;(]\s*$/.test(s));
      s += unary ? op : BINARY_SPACED.has(op) ? ` ${op} ` : op === "," || op === ";" ? `${op} ` : op;
      if (!unary) {
        if (op === "+" || op === "-") kind = kind === "rel" ? "rel" : "sum";
        else if (/^[=<>!]/.test(op)) kind = "rel";
        else if (kind === "atom" || kind === "pow" || kind === "text") kind = op === "/" ? "quotient" : "product";
      }
    }
    if (!term) continue;
    // Apres « / » ou « × » : un produit ou une somme entre parentheses (a/(b·c)).
    // Une somme parmi d'autres termes ({a+b}/c) : entre parentheses aussi.
    const needs = op === "/" ? !["atom", "pow", "text"].includes(term.kind)
      : (term.kind === "sum" || term.kind === "rel") && terms.length > 1;
    s += needs ? `(${term.s})` : term.s;
    if (count === 0 && op === null) kind = term.kind;
    else if (op === null && count > 0) kind = "product";
    count++;
    last = term;
  }
  const single = count === 1 && terms.length === 1 ? last : null;
  return { s: s.trim(), kind: single ? single.kind : kind, node: single?.node };
}

/** Facteurs colles : produit implicite, signe choisi selon ce qui se touche. */
function printTerm(factors: Node[]): Out | null {
  if (!factors.length) return null;
  const outs = factors.map(printNode);
  if (outs.length === 1) return outs[0];
  let s = "";
  outs.forEach((o, k) => {
    const piece = o.kind === "sum" || o.kind === "rel" ? `(${o.s})` : o.s;
    if (k > 0) s += joiner(outs[k - 1], o, outs[k - 2]);
    s += piece;
  });
  return { s, kind: "product" };
}

/** Signe entre deux facteurs colles. */
function joiner(l: Out, r: Out, ll?: Out): string {
  const ln = l.node, rn = r.node;
  // Prefixe colle au nombre comme au pave (« 2,2kΩ », « 100n ») ; unite separee (« 76 mA »).
  if (r.kind === "text") return ln?.k === "num" && /^[pnuµμmkMGT]$/.test(r.s) ? "" : " ";
  if (l.kind === "text") return rn?.k === "name" && rn.v === "Ω" ? "" : "·";
  const lNum = ln?.k === "num", rNum = rn?.k === "num" || (rn?.k === "pow" && rn.base.k === "num");
  if (lNum && rNum) return "×";
  if (l.kind === "quotient" || r.kind === "quotient") return "·";
  if (lNum && rn?.k === "name") {
    if (rn.v === "Ω") return " ";
    // « 10 μF » (micro) : l'espace, comme on l'ecrit ; « 2μ » serait lu micro aussi.
    if (rn.v === "μ") return " ";
    // « 2e » serait lu comme un nombre en notation scientifique.
    if (/^[eE]/.test(rn.v)) return "·";
    return "";
  }
  if (lNum && (rn?.k === "paren" || rn?.k === "call" || rn?.k === "sqrt" || rn?.k === "abs" || (rn?.k === "pow" && rn.base.k === "name" && !/^[eE]/.test(rn.base.v)))) return "";
  // Unite collee au micro : « 10 μF ».
  if (ln?.k === "name" && ln.v === "μ" && ll?.node?.k === "num" && rn?.k === "name" && /^[FHAVsWgmlLC]$/.test(rn.v)) return "";
  // « jω » : j colle a une lettre grecque, comme on l'ecrit (le moteur lit j·ω).
  if (ln?.k === "name" && ln.v === "j" && rn?.k === "name" && /^\p{Script=Greek}$/u.test(rn.v)) return "";
  // Nom colle a une parenthese : appel ou produit, le moteur tranche (« p(p+1) », « u(t) »).
  if (ln?.k === "name" && rn?.k === "paren" && rn.open === "(") return "";
  return "·";
}

function printNode(n: Node): Out {
  switch (n.k) {
    case "num": return { s: n.v, kind: "atom", node: n };
    case "name": return { s: n.v, kind: "atom", node: n };
    case "text": return { s: n.v, kind: "text", node: n };
    case "group": {
      const o = printSeq(n.seq);
      return { ...o, node: o.node ?? n };
    }
    case "paren": return { s: `${n.open}${printSeq(n.seq).s}${n.close}`, kind: "atom", node: n };
    case "abs": return { s: `abs(${printSeq(n.seq).s})`, kind: "atom", node: n };
    case "sqrt": {
      const arg = printSeq(n.arg).s;
      return n.index ? { s: `nthRoot(${arg}, ${printSeq(n.index).s})`, kind: "atom", node: n } : { s: `√(${arg})`, kind: "atom", node: n };
    }
    case "call": {
      const arg = printSeq(n.arg).s;
      const call = n.base && n.fn === "log" ? `log(${arg}, ${printSeq(n.base).s})` : `${n.fn}(${arg})`;
      return n.exp ? { s: `${call}^${exponent(n.exp)}`, kind: "pow", node: n } : { s: call, kind: "atom", node: n };
    }
    case "frac": {
      const num = printSeq(n.num), den = printSeq(n.den);
      // Numerateur : entre parentheses autour d'une somme (ou d'une fraction, pour la lisibilite).
      const ns = num.kind === "sum" || num.kind === "rel" || num.kind === "quotient" ? `(${num.s})` : num.s || "1";
      // Denominateur : autour de tout ce qui n'est pas un seul facteur.
      const ds = den.kind === "atom" || den.kind === "pow" ? den.s : `(${den.s})`;
      return { s: `${ns}/${ds}`, kind: "quotient", node: n };
    }
    case "pow": {
      if (n.exp.length === 1 && n.exp[0].k === "op" && n.exp[0].v === "!") {
        const b = printNode(n.base);
        return { s: `${b.kind === "atom" ? b.s : `(${b.s})`}!`, kind: "atom", node: n };
      }
      const b = printNode(n.base);
      const bs = b.kind === "atom" && !b.s.startsWith("-") ? b.s : `(${b.s})`;
      return { s: `${bs}^${exponent(n.exp)}`, kind: "pow", node: n };
    }
  }
}

/** Exposant : nu s'il tient en un nombre positif ou une lettre (« x^2 », « e^t »), sinon entre parentheses. */
function exponent(exp: Item[]): string {
  const o = printSeq(exp);
  if (o.kind === "atom" && (o.node?.k === "num" || o.node?.k === "name" || o.node?.k === "paren" || o.node?.k === "call" || o.node?.k === "sqrt")) return o.s;
  return `(${o.s})`;
}
