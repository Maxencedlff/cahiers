/**
 * Etape suivante proposee en grise derriere un « = » (logique pure ; DOM :
 * TextDoc.suggester, branche dans pageview.ts).
 *
 * Le membre juste avant le dernier « = » est relu (formule tapee, voir
 * automath.findFormulas) et recrit par mathjs : simplifie (« 3p + 4p » ->
 * « 7p »), factorise (« p(3 + 4) »), developpe (« (x+1)^2 » -> « x^2 + 2x + 1 »),
 * valeur numerique. Rien tape apres le « = » : la forme simplifiee d'abord.
 * Debut tape (« p( », « 7 ») : la premiere forme qui commence ainsi, sa fin
 * proposee. Aucune forme : rien.
 */
import { create, all, type MathNode } from "mathjs";
import { normalizeInput, frNumber } from "./engine";
import { findFormulas } from "../text/automath";

type Math = ReturnType<typeof create>;
let mathInst: Math | null = null;
const M = (): Math => (mathInst ??= create(all, { number: "number" }));

export interface StepSuggestion { insert: string; replace: number }

/** Relations qui separent les membres d'une chaine de calcul. */
const REL = /=|⇒|⇔|→|≈|≤|≥|<|>/;

let memo: { line: string; out: StepSuggestion | null } | null = null;

/** Suite a proposer pour la ligne `line` (relue jusqu'au curseur), ou null. */
export function nextStepSuggest(line: string, prev = ""): StepSuggestion | null {
  const key = `${prev}\n${line}`;
  if (memo?.line === key) return memo.out;
  let out: StepSuggestion | null = null;
  try { out = compute(line, prev); } catch { out = null; }
  memo = { line: key, out };
  return out;
}

function compute(line: string, prev: string): StepSuggestion | null {
  const at = line.lastIndexOf("=");
  if (at < 0 || /[<>!=]/.test(line[at - 1] ?? "")) return null;
  const typed = line.slice(at + 1);
  if (/[=\n]/.test(typed)) return null;
  // Ligne qui commence par « = » : la suite du calcul de la ligne du dessus,
  // son dernier membre (texte de la page, formules relues en clair).
  const head = line.slice(0, at);
  const lhs = head.trim() ? lhsBefore(head)
    : prev.includes("=") ? prev.split(REL).pop()!.replace(/[\s;,.\u202f]+$/, "").trim() || null : null;
  if (!lhs) return null;
  const forms = equivalents(lhs);
  if (!forms.length) return null;
  const want = compact(typed);
  for (const f of forms) {
    const rest = restAfter(f, want);
    if (rest === null || !rest) continue;
    const lead = !typed ? " " : "";
    return { insert: (lead + rest).replace(/[\\$*[\]`]/g, (c) => `\\${c}`), replace: 0 };
  }
  return null;
}

/** Membre de gauche : la formule tapee qui finit juste avant le « = », son dernier membre. */
function lhsBefore(before: string): string | null {
  const head = before.trimEnd();
  if (!head) return null;
  const probe = `${head} = 0`;
  const fs = findFormulas(probe, "final");
  const f = fs[fs.length - 1];
  if (!f || f.end !== probe.length) return null;
  const src = probe.slice(f.start, head.length);
  const last = src.split(REL).pop()!.trim();
  return last || null;
}

/** Formes equivalentes du membre, dans l'ordre de preference, sans le membre lui-meme. */
export function equivalents(src: string): string[] {
  // Texte de la page : γ(t) est l'echelon (pas la fonction gamma de mathjs),
  // « . » entre deux facteurs est un produit (« e^t.γ(t) »).
  src = src.replace(/\bgamma\s*\(/g, "γ(").replace(/γ\s+\(/g, "γ(")
    .replace(/(?<![\d\s])\.(?![\d\s])|(?<=\d)\.(?=[^\d\s])|(?<=[^\d\s])\.(?=\d)/g, "*");
  return equivalentsRaw(src).map((f) => f.replace(/greekmu/g, "μ").replace(/greekOmega/g, "Ω"));
}

function equivalentsRaw(src: string): string[] {
  const m = M();
  // μ et Ω sont ici des grandeurs (normalizeInput les lit en unites).
  const node = toProducts(m.parse(normalizeInput(src.replace(/\s+/g, " ").replace(/μ/g, "greekmu").replace(/Ω/g, "greekOmega"))));
  const self = compact(print(node));
  const out: string[] = [];
  const add = (s: string | null) => {
    if (!s) return;
    const c = compact(s);
    if (c && c !== self && !out.some((o) => compact(o) === c)) out.push(s);
  };
  const slashes = (s: string) => (s.match(/\//g) ?? []).length;
  let simp: MathNode | null = null;
  try { simp = m.simplify(node); } catch { simp = null; }
  if (simp) {
    const s = print(simp);
    if (slashes(s) <= slashes(self)) add(s);
  }
  add(factored(node));
  try { add(print(m.rationalize(node))); } catch { /* pas un polynome */ }
  // Developpe : seulement s'il ouvre vraiment des parentheses.
  const ex = expanded(node), parens = (x: string) => (x.match(/\(/g) ?? []).length;
  if (ex && parens(ex) < parens(print(node))) add(ex);
  if (!hasSymbols(node)) {
    try {
      const v = node.evaluate();
      if (typeof v === "number" && Number.isFinite(v)) add(frNumber(v));
    } catch { /* rien */ }
  }
  return out;
}

/** « p(3+4) » : p n'est pas une fonction connue, c'est un produit. « f(t) » reste une fonction. */
function toProducts(node: MathNode): MathNode {
  const m = M();
  return node.transform((n: any) => {
    if (n.type === "FunctionNode" && n.fn?.type === "SymbolNode" && typeof (m as any)[n.fn.name] !== "function") {
      const args = n.args as MathNode[];
      if (args.length === 1 && (args[0] as any).type !== "SymbolNode") {
        return new m.OperatorNode("*", "multiply", [new m.SymbolNode(n.fn.name), new m.ParenthesisNode(toProducts(args[0]))]);
      }
    }
    return n;
  });
}

function hasSymbols(node: MathNode): boolean {
  let found = false;
  node.traverse((n: any, _path: string, parent: any) => {
    if (n.type === "SymbolNode" && !(parent?.type === "FunctionNode" && parent.fn === n) && n.name !== "pi" && n.name !== "e") found = true;
  });
  return found;
}

/** Distribue les produits sur les sommes (« 5(1 - cos(t)) » -> « 5 - 5cos(t) »), sans autre recriture. */
const EXPAND = [
  "n1*(n2+n3) -> n1*n2+n1*n3", "n1*(n2-n3) -> n1*n2-n1*n3",
  "(n1+n2)*n3 -> n1*n3+n2*n3", "(n1-n2)*n3 -> n1*n3-n2*n3",
];
function expanded(node: MathNode): string | null {
  const m = M();
  try {
    const out = m.simplify(node, [...EXPAND, ...(m.simplify as any).rules.filter((r: any) => typeof r === "function")]);
    return print(out);
  } catch {
    return null;
  }
}

/* ---------------- factorisation ---------------- */

interface Term { sign: 1 | -1; coef: number; atoms: Map<string, { base: string; pow: number }> }

function factored(node: MathNode): string | null {
  const terms: Term[] = [];
  if (!collect(strip(node), 1, terms) || terms.length < 2) return null;
  const ints = terms.every((t) => Number.isInteger(t.coef));
  let g = ints ? terms.reduce((a, t) => gcd(a, Math.abs(t.coef)), 0) : 1;
  const common = new Map<string, { base: string; pow: number }>();
  for (const [k, a] of terms[0].atoms) {
    let pow = a.pow;
    for (const t of terms.slice(1)) pow = Math.min(pow, t.atoms.get(k)?.pow ?? 0);
    if (pow > 0) common.set(k, { base: a.base, pow });
  }
  if (g <= 1 && !common.size) return partial(terms);
  // Somme de nombres : rien a mettre en facteur (« 2 + 12 »).
  if (!common.size && terms.every((t) => !t.atoms.size)) return null;
  if (g < 1) g = 1;
  const inner = terms.map((t, i) => {
    const c = Math.abs(t.coef) / g;
    const atoms = [...t.atoms].map(([k, a]) => ({ base: a.base, pow: a.pow - (common.get(k)?.pow ?? 0) })).filter((a) => a.pow > 0);
    const body = product(c, atoms);
    return i === 0 ? (t.sign < 0 ? `-${body}` : body) : `${t.sign < 0 ? "-" : "+"} ${body}`;
  }).join(" ");
  const out = product(g, [...common.values()]);
  return `${out === "1" ? "" : out}(${inner})`;
}

/**
 * Facteur commun a une partie des termes seulement : « γ(t) - e^t γ(t) +
 * e^(2t) » -> « γ(t)(1 - e^t) + e^(2t) ». Le facteur le plus frequent.
 */
function partial(terms: Term[]): string | null {
  const count = new Map<string, number>();
  for (const t of terms) for (const k of t.atoms.keys()) count.set(k, (count.get(k) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, n] of count) if (n >= 2 && n < terms.length && (!best || n > count.get(best)!)) best = k;
  if (!best) return null;
  const inG = terms.filter((t) => t.atoms.has(best!)), rest = terms.filter((t) => !t.atoms.has(best!));
  const pow = Math.min(...inG.map((t) => t.atoms.get(best!)!.pow));
  const atom = { ...inG[0].atoms.get(best)!, pow };
  const termStr = (t: Term, i: number, drop?: string) => {
    const atoms = [...t.atoms].map(([k, a]) => ({ base: a.base, pow: a.pow - (k === drop ? pow : 0) })).filter((a) => a.pow > 0);
    const body = product(t.coef, atoms);
    return i === 0 ? (t.sign < 0 ? `-${body}` : body) : `${t.sign < 0 ? "-" : "+"} ${body}`;
  };
  const inner = inG.map((t, i) => termStr(t, i, best!)).join(" ");
  const tail = rest.map((t) => termStr(t, 1)).join(" ");
  return `${product(1, [atom])}(${inner}) ${tail}`;
}

function product(c: number, atoms: { base: string; pow: number }[]): string {
  const a = atoms.map((x) => (x.pow === 1 ? x.base : `${x.base}^${x.pow}`));
  const cs = coefText(c);
  if (!a.length) return cs;
  const body = a.join(" ");
  if (Math.abs(c - 1) < 1e-12) return body;
  return cs.includes("/") ? `${cs} ${body}` : `${cs}${body}`;
}

/** Coefficient ecrit comme on le tape : entier, fraction (1/3) ou decimal a virgule. */
function coefText(c: number): string {
  if (Number.isInteger(c)) return String(c);
  for (let q = 2; q <= 100; q++) {
    const p = Math.round(c * q);
    if (Math.abs(c - p / q) < 1e-9) return `${p}/${q}`;
  }
  return frNumber(c);
}

function strip(n: any): any {
  return n.type === "ParenthesisNode" ? strip(n.content) : n;
}

/** Termes d'une somme, chacun coefficient x atomes. Faux si un terme ne se lit pas ainsi. */
function collect(n: any, sign: 1 | -1, out: Term[]): boolean {
  n = strip(n);
  if (n.type === "OperatorNode" && (n.op === "+" || n.op === "-") && n.args.length === 2) {
    return collect(n.args[0], sign, out) && collect(n.args[1], n.op === "-" ? (-sign as 1 | -1) : sign, out);
  }
  if (n.type === "OperatorNode" && n.op === "-" && n.args.length === 1) return collect(n.args[0], -sign as 1 | -1, out);
  const t: Term = { sign, coef: 1, atoms: new Map() };
  if (!factorsOf(n, t)) return false;
  if (t.coef < 0) { t.coef = -t.coef; t.sign = -t.sign as 1 | -1; }
  out.push(t);
  return true;
}

function factorsOf(n: any, t: Term): boolean {
  n = strip(n);
  if (n.type === "OperatorNode" && n.op === "*") return n.args.every((a: any) => factorsOf(a, t));
  // « 1/3 e^(-t) », « x/2 » : diviseur numerique dans le coefficient.
  if (n.type === "OperatorNode" && n.op === "/" && strip(n.args[1]).type === "ConstantNode" && typeof strip(n.args[1]).value === "number") {
    t.coef /= strip(n.args[1]).value;
    return factorsOf(n.args[0], t);
  }
  if (n.type === "ConstantNode" && typeof n.value === "number") { t.coef *= n.value; return true; }
  let base = n, pow = 1;
  if (n.type === "OperatorNode" && n.op === "^") {
    const e = strip(n.args[1]);
    if (e.type !== "ConstantNode" || !Number.isInteger(e.value) || e.value < 1) { base = n; pow = 1; }
    else { base = n.args[0]; pow = e.value; }
  }
  if (base.type === "OperatorNode" && (base.op === "+" || base.op === "-" || base.op === "/")) {
    if (base === n) return false;
  }
  const s = print(base);
  const key = compact(s);
  const wrapped = /^[\p{L}\d]+(?:\^(?:[\p{L}\d]+|\(.*\)))?$/u.test(s) || /^\p{L}+\(.*\)$/u.test(s) ? s : `(${s})`;
  const prev = t.atoms.get(key);
  t.atoms.set(key, { base: wrapped, pow: (prev?.pow ?? 0) + pow });
  return true;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/* ---------------- ecriture « comme on la tape » ---------------- */

/** Expression mathjs ecrite comme on la tape dans le texte (automath la relit). */
export function print(n: any): string {
  n = n.type === "ParenthesisNode" ? n : n;
  switch (n.type) {
    case "ConstantNode": return typeof n.value === "number" ? frNumber(n.value) : String(n.value);
    case "SymbolNode": return n.name;
    case "ParenthesisNode": return `(${print(n.content)})`;
    case "FunctionNode": return `${n.fn.name ?? print(n.fn)}(${n.args.map(print).join(", ")})`;
    case "OperatorNode": {
      const [a, b] = n.args;
      const sum = (x: any) => x.type === "OperatorNode" && (x.op === "+" || x.op === "-") && x.args.length === 2;
      const wrapIf = (x: any, w: boolean) => (w && x.type !== "ParenthesisNode" ? `(${print(x)})` : print(x));
      if (n.args.length === 1) return `${n.op}${wrapIf(a, sum(a))}`;
      switch (n.op) {
        case "+": return `${print(a)} + ${print(b)}`;
        case "-": return `${print(a)} - ${wrapIf(b, sum(b))}`;
        case "*": {
          const l = wrapIf(a, sum(a)), r = wrapIf(b, sum(b));
          if (/\d$/.test(l) && /^\d/.test(r)) return `${l}·${r}`;
          if (/\d$/.test(l) || r.startsWith("(")) return `${l}${r}`;
          return `${l} ${r}`;
        }
        case "/": {
          const l = wrapIf(a, sum(a));
          const r = wrapIf(b, sum(b) || (b.type === "OperatorNode" && (b.op === "*" || b.op === "/")));
          return `${l}/${r}`;
        }
        case "^": {
          const base = wrapIf(a, a.type === "OperatorNode" || a.type === "FunctionNode");
          const e = print(strip(b));
          return /^(?:\d+(?:,\d+)?|\p{L})$/u.test(e) ? `${base}^${e}` : `${base}^(${e})`;
        }
        default: return `${print(a)} ${n.op} ${print(b)}`;
      }
    }
    default: return n.toString();
  }
}

/** Sans blancs ni signe de produit : pour comparer et suivre la frappe. */
function compact(s: string): string {
  return s.replace(/[\s·*​]/g, "").replace(/−/g, "-").replace(/\./g, ",");
}

/** Fin de `form` apres le debut tape `want` (compact), ou null si `form` ne commence pas ainsi. */
function restAfter(form: string, want: string): string | null {
  if (!compact(form).startsWith(want)) return null;
  let i = 0, k = 0;
  while (i < form.length && k < want.length) {
    if (compact(form[i]) === "") { i++; continue; }
    i++; k++;
  }
  return want ? form.slice(i) : form;
}
