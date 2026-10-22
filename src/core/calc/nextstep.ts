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
import { normalizeInput, frNumber, frTexDecimal } from "./engine";
import { findFormulas, forceFormula } from "../text/automath";
import { polynomialCoefficients, polynomialRoots, solveEquation } from "./solve";

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
  // `prev` : les lignes du dessus (la plus proche en dernier).
  const above = prev.split("\n").filter((x) => x.trim());
  const last = above[above.length - 1] ?? "";
  const lhs = head.trim() ? lhsBefore(head)
    : last.includes("=") ? last.split(REL).pop()!.replace(/[\s;,.\u202f]+$/, "").trim() || null : null;
  if (!lhs) return null;
  // « donc α = » : une inconnue seule, sa valeur tiree d'un calcul plus haut.
  const lone = normalizeInput(lhs.trim());
  if (/^[A-Za-zα-ωΑ-Ω][A-Za-z0-9]{0,2}$/.test(lone) && above.length) {
    const v = valueOf(lone, above);
    if (v) {
      const rest = restAfter(v, compact(typed));
      if (rest) return { insert: ((!typed ? " " : "") + rest).replace(/[\\$*[\]`]/g, (c) => `\\${c}`), replace: 0 };
    }
  }
  // Dernier membre avec des inconnues (\u00ab \u03b1/(p - p1) + \u03b2/(p - p2) \u00bb) : leurs
  // valeurs, tirees d'un membre precedent, remplacees.
  const members = (head.trim() ? head : last).split(REL).map((x) => x.replace(/[\s;,.\u202f]+$/, "").trim()).filter(Boolean);
  members[members.length - 1] = lhs;
  let chain: string | null = null;
  try { chain = chainValues(members); } catch { chain = null; }
  const forms = chain ? [chain] : equivalents(lhs);
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

/* ---------------- inconnues d'un membre : identification ---------------- */

type Cx = { re: number; im: number };
const cx = (v: any): Cx => (typeof v === "number" ? { re: v, im: 0 } : { re: Number(v?.re), im: Number(v?.im) });
const cmul = (a: Cx, b: Cx): Cx => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cdiv = (a: Cx, b: Cx): Cx => { const d = b.re * b.re + b.im * b.im; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; };
const cpoly = (c: number[], z: Cx): Cx => c.reduceRight<Cx>((acc, k) => { const p = cmul(acc, z); return { re: p.re + k, im: p.im }; }, { re: 0, im: 0 });

/** Reel ecrit exactement si possible : entier, fraction, fraction de racine (« 5sqrt(7)/56 »). */
function exactReal(x: number): string {
  const frac = (y: number): { p: number; q: number } | null => {
    for (let q = 1; q <= 1000; q++) { const p = Math.round(y * q); if (Math.abs(y - p / q) < 1e-9 * Math.max(1, Math.abs(y))) return { p, q }; }
    return null;
  };
  const f = frac(x);
  if (f) return f.q === 1 ? String(f.p) : `${f.p}/${f.q}`;
  for (const m of [2, 3, 5, 6, 7, 10, 11, 13, 14, 15, 17, 19, 21, 22, 23]) {
    const g = frac(x / Math.sqrt(m));
    if (g) return `${g.p === 1 ? "" : g.p === -1 ? "-" : g.p}sqrt(${m})${g.q === 1 ? "" : `/${g.q}`}`;
  }
  return frNumber(x);
}

function complexText(z: Cx): string {
  const re = Math.abs(z.re) < 1e-12 ? 0 : z.re, im = Math.abs(z.im) < 1e-12 ? 0 : z.im;
  if (!im) return exactReal(re);
  const imAbs = exactReal(Math.abs(im));
  const imT = imAbs === "1" ? "i" : `${imAbs} i`;
  if (!re) return im < 0 ? `-${imT}` : imT;
  return `(${exactReal(re)} ${im < 0 ? "-" : "+"} ${imT})`;
}

/** x = p/q × √r (r = 1 : rationnel), ou null. */
function exactParts(x: number): { p: number; q: number; r: number } | null {
  for (const r of [1, 2, 3, 5, 6, 7, 10, 11, 13, 14, 15, 17, 19, 21, 22, 23]) {
    const y = x / Math.sqrt(r);
    for (let q = 1; q <= 1000; q++) {
      const p = Math.round(y * q);
      if (Math.abs(y - p / q) < 1e-9 * Math.max(1, Math.abs(y))) return { p, q, r };
    }
  }
  return null;
}

/**
 * Coefficient (complexe) sur un denominateur, en une seule fraction :
 * « (-7 + 5sqrt(7) i)/(56(p + 1/2 - i sqrt(7)/2)) », « 1/(2p) ».
 */
function coefOver(k: Cx, d: string): string {
  const c = coefParts(k);
  if (!c) return `${complexText(k)}/${d}`;
  return `${c.num}/${c.q === 1 ? d : `(${c.q}${d})`}`;
}

/** Valeur seule : « (-7 + 5i sqrt(7))/56 », « -1/4 », « i/2 ». */
function valueText(k: Cx): string {
  const c = coefParts(k);
  if (!c) return complexText(k);
  return c.q === 1 ? c.num : `${c.num}/${c.q}`;
}

/** Numerateur exact (entiers, racines, i) et denominateur commun d'un complexe. */
function coefParts(k: Cx): { num: string; q: number } | null {
  const re = Math.abs(k.re) < 1e-12 ? 0 : k.re, im = Math.abs(k.im) < 1e-12 ? 0 : k.im;
  const a = re ? exactParts(re) : { p: 0, q: 1, r: 1 }, b = im ? exactParts(im) : { p: 0, q: 1, r: 1 };
  if (!a || !b) return null;
  const q = (a.q * b.q) / gcd(a.q, b.q);
  const A = a.p * (q / a.q), B = b.p * (q / b.q);
  const rt = (n: number, r: number) => (r === 1 ? String(n) : `${n === 1 ? "" : n === -1 ? "-" : n}sqrt(${r})`);
  // Partie imaginaire « 5i sqrt(7) », « 2i », « i » : le i avant la racine (la conversion le relit).
  const imT = (n: number, r: number) => `${n === 1 ? "" : n === -1 ? "-" : n}i${r === 1 ? "" : ` sqrt(${r})`}`;
  let num: string;
  if (A && B) num = `(${rt(A, a.r)} ${B < 0 ? "-" : "+"} ${imT(Math.abs(B), b.r)})`;
  else if (B) num = imT(B, b.r);
  else num = rt(A, a.r);
  return { num, q };
}

/** Termes d'une somme, avec leur signe. */
function termsOf(n: any, sign = 1, out: { sign: number; node: any }[] = []): { sign: number; node: any }[] {
  n = strip(n);
  if (n.type === "OperatorNode" && (n.op === "+" || n.op === "-") && n.args.length === 2) {
    termsOf(n.args[0], sign, out);
    return termsOf(n.args[1], n.op === "-" ? -sign : sign, out);
  }
  if (n.type === "OperatorNode" && n.op === "-" && n.args.length === 1) return termsOf(n.args[0], -sign, out);
  out.push({ sign, node: n });
  return out;
}

/**
 * Chaine « F(p) = … = α/(p - p1) + β/(p - p2) » : les inconnues du dernier
 * membre tirees d'un membre precedent en une seule lettre, puis remplacees.
 * Reel : identification (solve.ts). Poles complexes (ou si l'identification
 * echoue) : chaque terme k/(a x + b) prend k = a × residu de F en -b/a.
 */
function chainValues(members: string[]): string | null {
  return chainSolve(members)?.text ?? null;
}

/** Comme chainValues, avec la valeur de chaque inconnue (« α » -> « 1/2 »). */
function chainSolve(members: string[]): { text: string; values: Map<string, string> } | null {
  if (members.length < 2) return null;
  const m = M();
  const parseM = (s: string) => toProducts(m.parse(normalizeInput(s.replace(/\s+/g, " "))));
  const last = members[members.length - 1];
  const lastNode = parseM(last);
  const syms = symbolsOf(lastNode);
  if (syms.length < 2) return null;
  let x = "", F: MathNode | null = null, Ftext = "";
  for (let j = members.length - 2; j >= 0 && !F; j--) {
    try {
      const n = parseM(members[j]);
      const s = symbolsOf(n);
      if (s.length === 1 && syms.includes(s[0])) { x = s[0]; F = n; Ftext = members[j]; }
    } catch { /* membre illisible (texte) */ }
  }
  if (!F) return null;
  const K = syms.filter((k) => k !== x);
  const terms = termsOf(lastNode);
  const denText = (d: any) => { const t = print(strip(d)); return /^[\p{L}\d]+$/u.test(t) ? t : `(${t})`; };
  // 1. Identification reelle.
  const r = solveEquation(`${Ftext} = ${last}`);
  if (r.ok && r.values && r.values.length === K.length) {
    const val = new Map(r.values.map((v) => [v.name, v.text]));
    let out = "";
    const values = val;
    for (const t of terms) {
      const n = t.node;
      if (!(n.type === "OperatorNode" && n.op === "/")) return null;
      const numSub = n.args[0].transform((q: any) => (q.type === "SymbolNode" && val.has(q.name) ? m.parse(`(${val.get(q.name)})`) : q));
      let nc: number[];
      try { nc = polynomialCoefficients(numSub.toString(), x, 4).map((c) => t.sign * c); } catch { return null; }
      if (nc.every((c) => Math.abs(c) < 1e-12)) continue;
      let q = 1;
      for (const c of nc) { const mm = /\/(\d+)$/.exec(coefText(Math.abs(c))); if (mm) q = (q * Number(mm[1])) / gcd(q, Number(mm[1])); }
      let ints = nc.map((c) => Math.round(c * q));
      const neg = ints[ints.length - 1] < 0;
      if (neg) ints = ints.map((c) => -c);
      const numT = polyText(ints, x);
      const numW = /[+-]/.test(numT.replace(/^-/, "")) ? `(${numT})` : numT;
      const d = denText(n.args[1]);
      out += `${out ? (neg ? " - " : " + ") : neg ? "-" : ""}${numW}/${q === 1 ? d : `(${q}${d})`}`;
    }
    return out ? { text: out, values } : null;
  }
  // 2. Residus (poles simples, complexes compris).
  let num: number[], den: number[];
  try { ({ num, den } = rationalParts(F, x)); } catch { return null; }
  const dDen = den.slice(1).map((c, i) => c * (i + 1));
  let out = "";
  const values = new Map<string, string>();
  for (const t of terms) {
    const n = t.node;
    if (!(n.type === "OperatorNode" && n.op === "/" && strip(n.args[0]).type === "SymbolNode" && K.includes(strip(n.args[0]).name))) return null;
    const dc = n.args[1].compile();
    const d0 = cx(dc.evaluate({ [x]: 0 })), d1 = cx(dc.evaluate({ [x]: 1 })), d2 = cx(dc.evaluate({ [x]: 2 }));
    const a = { re: d1.re - d0.re, im: d1.im - d0.im };
    // Denominateur du premier degre en x.
    if (Math.abs(d2.re - (2 * a.re + d0.re)) > 1e-9 || Math.abs(d2.im - (2 * a.im + d0.im)) > 1e-9) return null;
    const root = cdiv({ re: -d0.re, im: -d0.im }, a);
    const dp = cpoly(dDen, root);
    if (Math.hypot(dp.re, dp.im) < 1e-12 || Math.hypot(cpoly(den, root).re, cpoly(den, root).im) > 1e-7) return null;
    const k = cmul(a, cdiv(cpoly(num, root), dp));
    // k = coefficient de 1/den ; le terme ecrit « signe × inconnue / den » : inconnue = signe × k.
    values.set(strip(n.args[0]).name, valueText(t.sign < 0 ? { re: -k.re, im: -k.im } : k));
    out += `${out ? " + " : ""}${coefOver(k, denText(n.args[1]))}`;
  }
  return out ? { text: out, values } : null;
}

/**
 * « donc α = » : la valeur de α, tiree de la chaine la plus proche au-dessus
 * dont le dernier membre la contient (elements simples, coefficients).
 */
function valueOf(name: string, lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const members = lines[i].split(REL).map((x) => x.replace(/[\s;,.\u202f]+$/, "").trim()).filter(Boolean);
    if (members.length < 2) continue;
    let syms: string[];
    try { syms = symbolsOf(M().parse(normalizeInput(members[members.length - 1].replace(/\s+/g, " ")))); } catch { continue; }
    if (!syms.includes(name)) continue;
    try {
      const sol = chainSolve(members);
      const v = sol?.values.get(name);
      if (v) return v;
    } catch { /* chaine illisible */ }
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

/**
 * Formes equivalentes du membre, dans l'ordre de preference, sans le membre
 * lui-meme. Ce qu'on ecrit vraiment a la ligne suivante d'un calcul :
 *  - un nombre : sa valeur exacte (fraction) ou approchee ;
 *  - un polynome en une lettre : factorise par ses racines, ou developpe
 *    s'il etait en produit ;
 *  - une fraction en une lettre : denominateur factorise, puis la
 *    decomposition en elements simples ;
 *  - une derivee d/dx(...) : son resultat ;
 *  - avec des fonctions (y(t), Y(p), γ(t)) ou plusieurs lettres : seulement
 *    une vraie simplification (facteur commun, termes regroupes).
 * Rien de sur : rien.
 */
export function equivalents(src: string): string[] {
  const { text, fns } = protect(src);
  const back = (f: string) => f.replace(/zzf([a-z]+)/g, (_a, k: string) => fns[letterIndex(k)] ?? _a)
    .replace(/greekmu/g, "μ").replace(/greekOmega/g, "Ω");
  return equivalentsRaw(text).map(back);
}

/** Mots qui sont des fonctions connues : « cos(t) » n'est pas c·o·s(t). */
const FUNC_WORDS = new Set(["sin", "cos", "tan", "exp", "ln", "log", "sqrt", "sh", "ch", "th", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "abs", "frac", "lim", "max", "min"]);

const letterName = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : letterName(Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26)));
const letterIndex = (k: string): number => [...k].reduce((a, c) => a * 26 + (c.charCodeAt(0) - 96), 0) - 1;

/**
 * Texte de la page prepare pour mathjs : γ(t) echelon, « . » produit,
 * « cos 0 » = cos(0), et chaque fonction inconnue appliquee (y(t), y''(t),
 * Y(p), s(0), F(p-a), g(βt)) remplacee par un symbole opaque `zzf…` : elle
 * reste un bloc, jamais un produit. « p(p-1) » (la lettre dans
 * l'argument) reste un produit.
 */
function protect(src: string): { text: string; fns: string[] } {
  const s = src.replace(/\\?[dt]frac/g, "frac").replace(/\bgamma\s*\(/g, "γ(").replace(/γ\s+\(/g, "γ(")
    .replace(/(?<![\d\s])\.(?![\d\s])|(?<=\d)\.(?=[^\d\s])|(?<=[^\d\s])\.(?=\d)/g, "*")
    .replace(/\b(sin|cos|tan|exp|ln|log|sqrt)\s+(-?\d+(?:[.,]\d+)?|[A-Za-zα-ω])(?![\w(])/g, "$1($2)");
  const fns: string[] = [];
  let out = "";
  const isLetter = (c: string | undefined) => !!c && /[A-Za-zα-ωΑ-Ω]/.test(c);
  for (let i = 0; i < s.length;) {
    if (!isLetter(s[i])) { out += s[i++]; continue; }
    let j = i;
    while (isLetter(s[j])) j++;
    const word = s.slice(i, j);
    let k = j;
    while (s[k] === "'" || s[k] === "′" || s[k] === "″" || s[k] === "‴") k++;
    if (s[k] === "(" && !FUNC_WORDS.has(word)) {
      let depth = 0, close = -1;
      for (let q = k; q < s.length; q++) {
        if (s[q] === "(") depth++;
        else if (s[q] === ")" && --depth === 0) { close = q; break; }
      }
      const name = word[word.length - 1];
      const arg = close > 0 ? s.slice(k + 1, close).replace(/\s+/g, "") : "";
      if (close > 0 && funcArg(arg, name)) {
        // La meme fonction ecrite deux fois est le meme bloc (facteur commun).
        const text = `${name}${s.slice(j, k)}(${arg})`;
        let idx = fns.indexOf(text);
        if (idx < 0) { idx = fns.length; fns.push(text); }
        out += `${word.slice(0, -1)} zzf${letterName(idx)} `;
        i = close + 1;
        continue;
      }
    }
    out += s.slice(i, k);
    i = k;
  }
  return { text: out, fns };
}

/** Argument d'une fonction appliquee : t, 0, p-a, βt, 2t ; pas « p-1 » derriere p (produit). */
function funcArg(arg: string, name: string): boolean {
  if (!arg || new RegExp(`(^|[^A-Za-zα-ω])${name}(?![A-Za-zα-ω])`).test(arg)) return false;
  return /^-?\d+(?:[.,]\d+)?$/.test(arg) || /^[A-Za-zα-ω]$/.test(arg)
    || /^[A-Za-zα-ω][+-][A-Za-z0-9α-ω]+$/.test(arg) || /^\d*[A-Za-zα-ω]{1,2}$/.test(arg);
}

function equivalentsRaw(src: string): string[] {
  const m = M();
  // μ et Ω sont ici des grandeurs (normalizeInput les lit en unites).
  const norm = normalizeInput(src.replace(/\s+/g, " ").replace(/μ/g, "greekmu").replace(/Ω/g, "greekOmega"));
  const out: string[] = [];
  const deriv = derivativeOf(norm);
  if (deriv) return [deriv];
  const node = toProducts(m.parse(norm));
  const self = compact(print(node));
  // Meme ecriture aux parentheses pres (« S(p)/(E(p)) ») : pas une etape.
  const bare = (x: string) => x.replace(/[()]/g, "");
  const add = (s: string | null) => {
    if (!s) return;
    const c = compact(s);
    if (c && bare(c) !== bare(self) && !out.some((o) => compact(o) === c)) out.push(s);
  };
  const syms = symbolsOf(node);
  // Mot illisible (« mathcalLe », reste de LaTeX) : on ne devine pas.
  if (syms.some((x) => !x.startsWith("zzf") && !x.startsWith("greek") && x.length > 4)) return out;
  const vars = syms.filter((x) => !x.startsWith("zzf"));
  const opaque = syms.length > vars.length;
  if (!syms.length) {
    add(numericValue(node, /\d[.,]\d/.test(src)));
    return out;
  }
  if (vars.length === 1 && !opaque) {
    for (const f of oneVariable(node, vars[0])) add(f);
    return out;
  }
  // Fraction en une lettre principale avec des parametres (K, a, R) :
  // reduite et simplifiee par les facteurs communs (« K/(p(p+3)) / (1 +
  // K/(p(p+3))) » -> « K/(p^2 + 3p + K) »).
  if (!opaque && vars.length > 1) for (const f of rationalWithParams(node, vars)) add(f);
  // Plusieurs lettres, ou des fonctions : seulement une vraie simplification.
  add(factored(node, true));
  if (!opaque) add(collectBy(node, vars));
  let simp: MathNode | null = null;
  try { simp = m.simplify(node); } catch { simp = null; }
  if (simp) {
    const s = print(simp);
    const count = (x: string, c: RegExp) => (x.match(c) ?? []).length;
    // Des termes regroupes, sans fraction ni parenthese de plus (« 3a + 2a » -> « 5a »).
    if (termCount(simp) < termCount(node) && count(s, /\//g) <= count(self, /\//g) && count(s, /\(/g) <= count(print(node), /\(/g)) add(s);
  }
  return out;
}

/**
 * Plusieurs lettres, une principale (celle de plus haut degre, p) :
 * regroupee par puissances, coefficients litteraux entre parentheses
 * (« a p^3 + b p^2 + c p - a p^2 - b p - c » -> « a p^3 + (b - a)p^2 + (c - b)p - c »).
 */
function collectBy(node: MathNode, vars: string[]): string | null {
  const m = M();
  let best: { v: string; deg: number } | null = null;
  for (const v of vars) {
    let deg = 0;
    node.traverse((n: any) => {
      if (n.type === "OperatorNode" && n.op === "^" && strip(n.args[0]).name === v && strip(n.args[1]).type === "ConstantNode") deg = Math.max(deg, strip(n.args[1]).value);
    });
    if (deg >= 2 && (!best || deg > best.deg)) best = { v, deg };
  }
  if (!best || best.deg > 8) return null;
  const v = best.v;
  const coeffs: MathNode[] = [];
  let d: MathNode = node;
  let fact = 1;
  try {
    for (let k = 0; k <= best.deg; k++) {
      if (k > 0) { d = m.derivative(d, v); fact *= k; }
      const at0 = d.transform((n: any) => (n.type === "SymbolNode" && n.name === v ? new m.ConstantNode(0) : n));
      const ck = new m.OperatorNode("/", "divide", [at0, new m.ConstantNode(fact)]);
      // rationalize regroupe mieux les coefficients litteraux (« (2b - 2a)/2 » -> « b - a »).
      let c: MathNode;
      try { c = m.rationalize(ck); } catch { c = m.simplify(ck); }
      coeffs.push(c);
    }
  } catch {
    return null;
  }
  // Le reste doit etre vraiment un polynome en v de ce degre.
  const nonZero = coeffs.filter((c) => c.toString() !== "0").length;
  if (nonZero >= termCount(node)) return null;
  let out = "";
  for (let k = coeffs.length - 1; k >= 0; k--) {
    const c = coeffs[k];
    const s = print(c);
    if (s === "0") continue;
    const mono = k === 0 ? "" : k === 1 ? v : `${v}^${k}`;
    const neg = s.startsWith("-") && termCount(c) === 1;
    const body = neg ? s.slice(1) : s;
    const coef = termCount(c) > 1 ? `(${body})` : body === "1" && mono ? "" : body;
    const glue = coef && mono && !coef.endsWith(")") && !/\d$/.test(coef) ? " " : "";
    out += `${out ? (neg ? " - " : " + ") : neg ? "-" : ""}${coef}${glue}${mono}`;
  }
  return out || null;
}

/** Nombre de termes de la somme du haut. */
function termCount(n: any): number {
  n = strip(n);
  if (n.type === "OperatorNode" && (n.op === "+" || n.op === "-") && n.args.length === 2) return termCount(n.args[0]) + termCount(n.args[1]);
  return 1;
}

/** Lettres libres (pas pi, e, ni les noms de fonctions). */
function symbolsOf(node: MathNode): string[] {
  const found = new Set<string>();
  node.traverse((n: any, _p: string, parent: any) => {
    if (n.type !== "SymbolNode" || (parent?.type === "FunctionNode" && parent.fn === n)) return;
    if (n.name === "pi" || n.name === "e" || n.name === "i") return;
    found.add(n.name);
  });
  return [...found];
}

/** Valeur d'un calcul sans lettre : fraction exacte si elle existe, sinon decimal. */
function numericValue(node: MathNode, decimal = false): string | null {
  let v: unknown;
  try { v = node.evaluate(); } catch { return null; }
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (Number.isInteger(v)) return String(v);
  // Calcul ecrit en decimaux (« 3 × 0,5 ») : resultat en decimal (« 1,5 »).
  if (decimal) return frNumber(v);
  for (let q = 2; q <= 1000; q++) {
    const p = Math.round(v * q);
    if (Math.abs(v - p / q) < 1e-10 * Math.max(1, Math.abs(v))) return `${p}/${q}`;
  }
  return frNumber(v);
}

/** « d/dp(1/(p+3)) », « -d/dx(x^2) » : la derivee, simplifiee. */
function derivativeOf(src: string): string | null {
  const m = /^\s*(-?)\s*d\s*\/\s*d([A-Za-z])\s*\((.*)\)\s*$/.exec(src);
  if (!m) return null;
  try {
    const M0 = M();
    const d = M0.simplify(M0.derivative(M0.parse(m[3]), m[2]));
    return print(m[1] ? M0.simplify(new M0.OperatorNode("-", "unaryMinus", [d])) : d);
  } catch {
    return null;
  }
}

/* ---------------- une seule lettre : polynomes et fractions ---------------- */

/** Polynome (coefficients du constant au dominant) ecrit comme on le tape. */
function polyText(c: number[], v: string): string {
  let out = "";
  for (let k = c.length - 1; k >= 0; k--) {
    const a = c[k];
    if (Math.abs(a) < 1e-12) continue;
    const mono = k === 0 ? "" : k === 1 ? v : `${v}^${k}`;
    const abs = Math.abs(a);
    const num = mono && Math.abs(abs - 1) < 1e-12 ? "" : coefText(abs);
    out += `${a < 0 ? (out ? " - " : "-") : out ? " + " : ""}${num}${num.includes("/") && mono ? " " : ""}${mono}`;
  }
  return out || "0";
}

interface Factored { lc: number; factors: { text: string; mult: number; root?: number }[] }

/**
 * Factorisation sur Q : racines rationnelles (facteurs du premier degre) et
 * trinomes sans racine reelle a coefficients rationnels. null si une racine
 * est irrationnelle (la forme factorisee ne s'ecrirait pas proprement).
 */
function factorPoly(c: number[], v: string): Factored | null {
  if (c.length < 2) return null;
  const roots = polynomialRoots(c);
  if (!roots) return null;
  let lc = c[c.length - 1];
  const factors: Factored["factors"] = [];
  const rational = (x: number): { p: number; q: number } | null => {
    for (let q = 1; q <= 12; q++) { const p = Math.round(x * q); if (Math.abs(x - p / q) < 1e-9) return { p, q }; }
    return null;
  };
  for (const r of roots) {
    const mult = r.multiplicity ?? 1;
    if (typeof r.value === "number") {
      const f = rational(r.value);
      if (!f) return null;
      if (f.p === 0) factors.push({ text: v, mult, root: 0 });
      else if (f.q === 1) factors.push({ text: `(${v} ${f.p < 0 ? "+" : "-"} ${Math.abs(f.p)})`, mult, root: r.value });
      else { factors.push({ text: `(${f.q}${v} ${f.p < 0 ? "+" : "-"} ${Math.abs(f.p)})`, mult, root: r.value }); lc /= f.q ** mult; }
    } else if (r.value.im > 0) {
      const { re, im } = r.value;
      const q = [re * re + im * im, -2 * re, 1];
      if (!q.every((x) => rational(x))) return null;
      factors.push({ text: `(${polyText(q.map((x) => Math.round(x * 1e9) / 1e9), v)})`, mult });
    }
  }
  const key = (f: { root?: number }) => (f.root === undefined ? [2, 0, 0] : f.root === 0 ? [0, 0, 0] : [1, Math.abs(f.root), -f.root]);
  factors.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return { lc, factors };
}

function factoredText(f: Factored): string {
  const body = f.factors.map((x) => `${x.text}${x.mult > 1 ? `^${x.mult}` : ""}`).join("");
  const lc = Math.abs(f.lc - 1) < 1e-12 ? "" : Math.abs(f.lc + 1) < 1e-12 ? "-" : coefText(f.lc);
  return `${lc}${lc.includes("/") ? " " : ""}${body}`;
}

/** Nombre de facteurs d'un produit tel qu'il est ecrit (« p(p-1)(p^2-p-2) » : 3). */
function factorCount(n: any): number {
  n = strip(n);
  if (n.type === "OperatorNode" && n.op === "*") return n.args.reduce((a: number, x: any) => a + factorCount(x), 0);
  if (n.type === "ConstantNode") return 0;
  return 1;
}

/** Polynome ou fraction en une seule lettre `v`. */
function oneVariable(node: MathNode, v: string): string[] {
  const out: string[] = [];
  let num: number[], den: number[];
  try {
    ({ num, den } = rationalParts(node, v));
  } catch {
    return out;
  }
  // Facteurs communs du premier degre : simplifies (racine commune).
  let cancelled = false;
  for (let guard = 0; guard < 12 && den.length > 1; guard++) {
    const roots = polynomialRoots(den);
    const common = roots?.find((r) => typeof r.value === "number" && Math.abs(evalPoly(num, r.value as number)) < 1e-9);
    if (!common || num.length < 2) break;
    num = divideRoot(num, common.value as number);
    den = divideRoot(den, common.value as number);
    cancelled = true;
  }
  const top = strip(node);
  if (den.length === 1) {
    // Polynome.
    const c = num.map((x) => x / den[0]);
    const expandedText = polyText(c, v);
    const f = factorPoly(c, v);
    const isSum = top.type === "OperatorNode" && (top.op === "+" || top.op === "-") && top.args.length === 2;
    const factoredT = f && (f.factors.length > 1 || f.factors.some((x) => x.mult > 1) || Math.abs(f.lc - 1) > 1e-12) ? factoredText(f) : null;
    if (isSum) {
      // Termes a regrouper d'abord (« 3p + 4p » -> « 7p »), sinon la forme factorisee.
      if (termCount(top) > c.filter((x) => Math.abs(x) > 1e-12).length) out.push(expandedText);
      if (factoredT && f!.factors.length > 1) out.push(factoredT);
    } else {
      out.push(expandedText);
      if (factoredT) out.push(factoredT);
    }
    return out;
  }
  // Fraction : num/den.
  const fd = factorPoly(den, v);
  const numText = (c: number[]) => {
    const t = polyText(c, v);
    return /[+-]/.test(t.replace(/^-/, "")) ? `(${t})` : t;
  };
  const single = top.type === "OperatorNode" && top.op === "/";
  if (fd) {
    // den = fd.lc x (facteurs) : la constante passe au numerateur.
    const nc = num.map((x) => x / fd.lc);
    const fdText = factoredText({ ...fd, lc: 1 });
    // Un seul facteur (« (p + 3)^2 », « p ») : pas de parentheses en plus.
    const oneFactor = fd.factors.length === 1;
    const combined = `${numText(nc)}/${oneFactor ? fdText : `(${fdText})`}`;
    const typedFactors = single ? factorCount(top.args[1]) : 0;
    const full = fd.factors.length;
    // Denominateur pas encore factorise, ou plusieurs fractions : une seule fraction, denominateur factorise.
    // ... ou simplifiee (« p × 2/(p(p+1)(p+2)) » -> « 2/((p + 1)(p + 2)) »).
    if (!single || full > typedFactors || cancelled) out.push(combined);
    if (num.length < den.length) {
      const pf = partialFractions(nc, fd, v);
      if (pf) out.push(pf);
    }
  }
  return out;
}

/**
 * Numerateur et denominateur (coefficients) d'une expression rationnelle en
 * `v`. mathjs.rationalize d'abord ; il echoue sur certaines sommes de
 * fractions (« 1/p - 2/(p+1) + 1/(p+2) ») : on les ajoute alors une a une.
 */
function rationalParts(node: MathNode, v: string): { num: number[]; den: number[] } {
  const m = M();
  try {
    const r: any = m.rationalize(node, {}, true);
    const num = polynomialCoefficients(r.numerator.toString(), v, 12);
    // Un polynome n'a pas de denominateur.
    const den = r.denominator ? polynomialCoefficients(r.denominator.toString(), v, 12) : [1];
    return { num, den };
  } catch (e) {
    const n = strip(node);
    if (!(n.type === "OperatorNode" && (n.op === "+" || n.op === "-") && n.args.length === 2)) throw e;
    const a = rationalParts(n.args[0], v), b = rationalParts(n.args[1], v);
    const s = n.op === "-" ? -1 : 1;
    return {
      num: polyAdd(polyMul(a.num, b.den), polyMul(b.num, a.den).map((x) => s * x)),
      den: polyMul(a.den, b.den),
    };
  }
}

function polyMul(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => { out[i + j] += x * y; }));
  return out;
}

function polyAdd(a: number[], b: number[]): number[] {
  const out = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
  while (out.length > 1 && Math.abs(out[out.length - 1]) < 1e-12) out.pop();
  return out;
}

function evalPoly(c: number[], x: number): number {
  return c.reduceRight((a, k) => a * x + k, 0);
}

/** Division par (x - r) (Horner) ; c du constant au dominant. */
function divideRoot(c: number[], r: number): number[] {
  const hi = [...c].reverse();
  const q: number[] = [];
  let acc = 0;
  for (let i = 0; i < hi.length - 1; i++) { acc = acc * r + hi[i]; q.push(acc); }
  return q.reverse().map((x) => (Math.abs(x - Math.round(x)) < 1e-9 ? Math.round(x) : x));
}

/**
 * Decomposition en elements simples de num / (facteurs) : resolue par
 * identification (solve.ts), ecrite comme on la tape :
 * « 1/p - 2/(p + 1) + 1/(p + 2) », « -(p + 3)/(4(p^2 + p + 2)) ».
 */
function partialFractions(num: number[], f: Factored, v: string): string | null {
  const names: string[] = [];
  const terms: { fac: string; pow: number; quad: boolean; names: string[] }[] = [];
  const fresh = () => { const n = `K${letterName(names.length)}`; names.push(n); return n; };
  for (const x of f.factors) {
    const quad = x.root === undefined;
    for (let j = 1; j <= x.mult; j++) terms.push({ fac: x.text, pow: j, quad, names: quad ? [fresh(), fresh()] : [fresh()] });
  }
  if (names.length > 8) return null;
  const den = (t: { fac: string; pow: number }) => `${t.fac}${t.pow > 1 ? `^${t.pow}` : ""}`;
  const ansatz = terms.map((t) => (t.quad ? `(${t.names[0]} ${v} + ${t.names[1]})/${den(t)}` : `${t.names[0]}/${den(t)}`)).join(" + ");
  const F = `(${polyText(num, v)})/(${f.factors.map((x) => `${x.text}${x.mult > 1 ? `^${x.mult}` : ""}`).join(" * ")})`;
  const r = solveEquation(`${F} = ${ansatz}`);
  if (!r.ok || !r.values) return null;
  const val = new Map(r.values.map((x) => [x.name, Number(M().evaluate(x.text))]));
  let out = "";
  for (const t of terms) {
    const cs = t.names.map((n) => val.get(n) ?? NaN);
    if (cs.some((c) => !Number.isFinite(c))) return null;
    if (cs.every((c) => Math.abs(c) < 1e-12)) continue;
    // Coefficients rationnels mis au meme denominateur q : numerateur entier.
    let q = 1;
    for (const c of cs) { const t0 = coefText(Math.abs(c)); const mm = /\/(\d+)$/.exec(t0); if (mm) q = (q * Number(mm[1])) / gcd(q, Number(mm[1])); }
    let ints = cs.map((c) => Math.round(c * q));
    const lead = t.quad ? (ints[0] !== 0 ? ints[0] : ints[1]) : ints[0];
    const neg = lead < 0;
    if (neg) ints = ints.map((c) => -c);
    const numT = t.quad ? polyText([ints[1], ints[0]], v) : String(ints[0]);
    const numW = /[+-]/.test(numT.replace(/^-/, "")) ? `(${numT})` : numT;
    // « 1/p », « 2/(p + 1) », « 1/(p + 3)^2 », « 1/(2p) », « 1/(4(p + 2)) ».
    const d = den(t);
    const dFinal = q === 1 ? d : `(${q}${d})`;
    out += `${out ? (neg ? " - " : " + ") : neg ? "-" : ""}${numW}/${dFinal}`;
  }
  return out || null;
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


/* ---------------- factorisation ---------------- */

interface Term { sign: 1 | -1; coef: number; atoms: Map<string, { base: string; pow: number }> }

/**
 * Facteur commun. `strict` (plusieurs lettres, fonctions) : seulement un
 * facteur litteral commun (pas un simple pgcd des coefficients), et la mise
 * en facteur partielle seulement d'une fonction (γ(t), Y(p)).
 */
function factored(node: MathNode, strict = false): string | null {
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
  if (g <= 1 && !common.size) return partial(terms, strict);
  if (strict && !common.size) return null;
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
function partial(terms: Term[], onlyFunctions = false): string | null {
  const count = new Map<string, number>();
  for (const t of terms) for (const k of t.atoms.keys()) count.set(k, (count.get(k) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, n] of count) {
    if (onlyFunctions && !k.startsWith("zzf")) continue;
    if (n >= 2 && n < terms.length && (!best || n > count.get(best)!)) best = k;
  }
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
          // « A(-x) », jamais « A -x ».
          const neg = (x: any) => x.type === "OperatorNode" && x.op === "-" && x.args.length === 1;
          const l = wrapIf(a, sum(a)), r = wrapIf(b, sum(b) || neg(b));
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

/* ---------------- detail d'une simplification (calculatrice, Litteral) ---------------- */

/** Nombre en LaTeX a la francaise : entier, decimal court (0{,}8), sinon fraction. */
function numTex(x: number): string {
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  for (let d = 1; d <= 4; d++) {
    const s = x * 10 ** d;
    if (Math.abs(s - Math.round(s)) < 1e-9) return x.toFixed(d).replace(".", "{,}");
  }
  for (let q = 2; q <= 100; q++) {
    const p = Math.round(x * q);
    if (Math.abs(x - p / q) < 1e-9) return `${p < 0 ? "-" : ""}\\frac{${Math.abs(p)}}{${q}}`;
  }
  return frNumber(x).replace(",", "{,}");
}

/** Polynome en LaTeX, du terme dominant au constant. */
function polyTex(c: number[], v: string): string {
  let out = "";
  for (let k = c.length - 1; k >= 0; k--) {
    const a = c[k];
    if (Math.abs(a) < 1e-12) continue;
    const mono = k === 0 ? "" : k === 1 ? v : `${v}^{${k}}`;
    const abs = Math.abs(a);
    const coef = mono && Math.abs(abs - 1) < 1e-12 ? "" : numTex(abs);
    out += `${a < 0 ? (out ? " - " : "-") : out ? " + " : ""}${coef}${mono}`;
  }
  return out || "0";
}

const terms = (c: number[]) => c.filter((x) => Math.abs(x) > 1e-12).length;
const trimPoly = (c: number[]) => { const o = [...c]; while (o.length > 1 && Math.abs(o[o.length - 1]) < 1e-12) o.pop(); return o; };

/** Produit de facteurs en LaTeX : constante d'abord, facteurs a plusieurs termes entre parentheses. */
function prodTex(fs: number[][], v: string): string {
  let k = 1;
  const parts: string[] = [];
  for (const f of fs) {
    if (f.length === 1) { k *= f[0]; continue; }
    const t = polyTex(f, v);
    parts.push(terms(f) > 1 && (fs.length > 1 || Math.abs(k - 1) > 1e-12) ? `\\left(${t}\\right)` : t);
  }
  if (!parts.length) return numTex(k);
  const lead = Math.abs(k - 1) < 1e-12 ? "" : Math.abs(k + 1) < 1e-12 ? "-" : numTex(k);
  return `${lead}${parts.join("")}`;
}

function fracTex(num: number[][], den: number[][], v: string): string {
  const dk = den.filter((f) => f.length === 1).reduce((a, f) => a * f[0], 1);
  if (den.every((f) => f.length === 1) && Math.abs(dk - 1) < 1e-12) return prodTex(num, v);
  return `\\frac{${prodTex(num, v)}}{${prodTex(den, v)}}`;
}

/** Fraction rendue avec un denominateur unitaire (« (5p+9)/(5p+5) » -> « (p+1,8)/(p+1) »). */
function monic(r: { num: number[]; den: number[] }): { num: number[]; den: number[] } {
  const lc = r.den[r.den.length - 1];
  if (!lc || Math.abs(lc - 1) < 1e-12) return { num: trimPoly(r.num), den: trimPoly(r.den) };
  return { num: trimPoly(r.num.map((x) => x / lc)), den: trimPoly(r.den.map((x) => x / lc)) };
}

/**
 * Polynome en facteurs du premier degre a racines rationnelles
 * (« p^2 + p » -> [p, p + 1]), constante en tete ; tel quel sinon.
 */
function factorList(c: number[]): number[][] {
  if (c.length < 3) return [c];
  const roots = polynomialRoots(c);
  if (!roots) return [c];
  const out: number[][] = [];
  for (const r of roots) {
    if (typeof r.value !== "number") return [c];
    const x = r.value;
    let q = 1;
    while (q <= 12 && Math.abs(x * q - Math.round(x * q)) > 1e-9) q++;
    if (q > 12) return [c];
    for (let k = 0; k < (r.multiplicity ?? 1); k++) out.push(q === 1 ? [-Math.round(x), 1] : [-Math.round(x * q), q]);
  }
  // Ordre de la copie : p, puis (p + 1), (p + 2)... (racine la plus petite en valeur absolue d'abord).
  out.sort((f, g) => Math.abs(f[0] / f[1]) - Math.abs(g[0] / g[1]) || f[0] / f[1] - g[0] / g[1]);
  const prod = out.reduce((a, f) => polyMul(a, f), [1]);
  const k = c[c.length - 1] / prod[prod.length - 1];
  return Math.abs(k - 1) < 1e-12 ? out : [[k], ...out];
}

/** a = k b (memes polynomes a un facteur pres) : k, sinon null. */
function ratioOf(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const k = a[a.length - 1] / b[b.length - 1];
  return a.every((x, i) => Math.abs(x - k * b[i]) < 1e-9 * Math.max(1, Math.abs(x))) ? k : null;
}

/** Quotient exact a / b, ou null s'il reste quelque chose. */
function polyDivExact(a: number[], b: number[]): number[] | null {
  const r = [...a];
  const q = new Array(Math.max(1, a.length - b.length + 1)).fill(0);
  for (let i = a.length - b.length; i >= 0; i--) {
    const c = r[i + b.length - 1] / b[b.length - 1];
    q[i] = c;
    for (let j = 0; j < b.length; j++) r[i + j] -= c * b[j];
  }
  return r.every((x) => Math.abs(x) < 1e-9) ? trimPoly(q) : null;
}

/**
 * Detail d'une simplification en une lettre, redige comme sur une copie :
 * meme denominateur, multiplier par l'inverse, simplifier par le facteur
 * commun, coefficients entiers. Lignes au format du texte de la page
 * (phrases et $formules$). null : pas de fraction a detailler.
 */
export function simplifySteps(src: string): string[] | null {
  const m = M();
  let node: MathNode;
  try { node = toProducts(m.parse(normalizeInput(src.replace(/\s+/g, " ")))); } catch { return null; }
  const syms = symbolsOf(node);
  if (syms.length > 1) return paramSteps(node);
  if (syms.length !== 1) return null;
  const v = syms[0];
  const top = strip(node);
  const hasDiv = (n: MathNode) => n.filter((x: any) => x.type === "OperatorNode" && x.op === "/").length > 0;
  if (!hasDiv(top)) return null;
  const T = (n: MathNode) => frTexDecimal(n.toTex({ parenthesis: "auto", implicit: "hide" } as any));
  const lines: string[] = [`On part de $${T(node)}$.`];
  try {
    // Une partie mise en une seule fraction ; une somme avec des fractions est detaillee.
    const reduce = (n: MathNode, where: string): { num: number[]; den: number[] } => {
      const r = monic(rationalParts(n, v));
      const s = strip(n);
      if (r.den.length > 1 && s.type === "OperatorNode" && (s.op === "+" || s.op === "-") && hasDiv(s)) {
        const parts = termsOf(s).map((t) => ({ sign: t.sign, ...monic(rationalParts(t.node, v)) }));
        const ks = parts.map((t) => polyDivExact(r.den, t.den));
        const mid = ks.every((k) => k) ? parts.map((t, i) => {
          const n2 = trimPoly(polyMul(t.num, ks[i]!));
          return `${i ? (t.sign < 0 ? " - " : " + ") : t.sign < 0 ? "-" : ""}\\frac{${prodTex(factorList(n2), v)}}{${prodTex(factorList(r.den), v)}}`;
        }).join("") : null;
        lines.push(`${where ? `${where}on` : "On"} met tout au même dénominateur : $${T(n)} = ${mid ? `${mid} = ` : ""}${fracTex([r.num], factorList(r.den), v)}$.`);
      }
      return r;
    };
    let numF: number[][], denF: number[][];
    if (top.type === "OperatorNode" && top.op === "/") {
      const a = reduce(top.args[0], "En haut, ");
      const b = reduce(top.args[1], "En bas, ");
      numF = [a.num, b.den].filter((f) => !(f.length === 1 && Math.abs(f[0] - 1) < 1e-12));
      denF = [a.den, b.num].filter((f) => !(f.length === 1 && Math.abs(f[0] - 1) < 1e-12));
      if (a.den.length > 1 || b.den.length > 1) {
        lines.push(`Diviser par une fraction, c'est multiplier par son inverse : $${fracTex([a.num], [a.den], v)} \\times ${fracTex([b.den], [b.num], v)} = ${fracTex(numF, denF, v)}$.`);
      }
    } else {
      const r = reduce(top, "");
      numF = [r.num];
      denF = [r.den];
      if (!(top.type === "OperatorNode" && (top.op === "+" || top.op === "-"))) {
        lines.push(`On écrit tout en une seule fraction : $${fracTex(numF, denF, v)}$.`);
      }
    }
    // Facteurs identiques en haut et en bas.
    const gone: number[][] = [];
    for (let i = 0; i < numF.length; i++) {
      const j = denF.findIndex((d) => ratioOf(numF[i], d) !== null);
      if (j < 0) continue;
      const k = ratioOf(numF[i], denF[j])!;
      gone.push(denF[j]);
      numF[i] = [k];
      denF.splice(j, 1);
    }
    // Racines communes une fois tout developpe (« (p^2 - 1)/(p + 1) »).
    let N = trimPoly(numF.reduce((a, f) => polyMul(a, f), [1]));
    let D = trimPoly(denF.reduce((a, f) => polyMul(a, f), [1]));
    for (let guard = 0; guard < 8 && D.length > 1 && N.length > 1; guard++) {
      const roots = polynomialRoots(D);
      const r = roots?.find((x) => typeof x.value === "number" && Math.abs(evalPoly(N, x.value as number)) < 1e-9);
      if (!r) break;
      const x = r.value as number;
      N = divideRoot(N, x);
      D = divideRoot(D, x);
      gone.push([-x, 1]);
    }
    if (gone.length) {
      const by = gone.map((f) => (terms(f) > 1 ? `\\left(${polyTex(f, v)}\\right)` : polyTex(f, v))).join("");
      lines.push(`On simplifie par $${by}$ : $${fracTex([N], factorList(D), v)}$.`);
    }
    // Denominateur unitaire puis coefficients entiers.
    if (D.length > 1) {
      const lc = D[D.length - 1];
      N = N.map((x) => x / lc);
      D = D.map((x) => x / lc);
    }
    const all = [...N, ...D];
    if (all.some((x) => Math.abs(x - Math.round(x)) > 1e-9)) {
      for (let q = 2; q <= 100; q++) {
        if (all.every((x) => Math.abs(x * q - Math.round(x * q)) < 1e-9)) {
          N = N.map((x) => Math.round(x * q));
          D = D.map((x) => Math.round(x * q));
          lines.push(`On multiplie en haut et en bas par $${q}$ pour n'avoir que des coefficients entiers : $${fracTex([N], [D], v)}$.`);
          break;
        }
      }
    }
    lines.push(`Donc $${T(node)} = ${fracTex([N], factorList(D), v)}$.`);
  } catch {
    return null;
  }
  return lines.length > 2 ? lines : null;
}

/* ---------------- fraction en p avec des parametres (K, a...) ---------------- */

/** Coefficient : polynome en parametres, monome (« K^2*a ») -> nombre. */
type PCoef = Map<string, number>;

function pcoefAdd(a: PCoef, b: PCoef, k = 1): PCoef {
  const o = new Map(a);
  for (const [m, x] of b) {
    const y = (o.get(m) ?? 0) + k * x;
    if (Math.abs(y) < 1e-12) o.delete(m); else o.set(m, y);
  }
  return o;
}

/** Somme developpee (sortie de rationalize) en polynome de `v` a coefficients en parametres. */
function paramPoly(node: any, v: string): PCoef[] | null {
  const out: PCoef[] = [];
  for (const t of termsOf(node)) {
    let c = t.sign, pv = 0;
    const others = new Map<string, number>();
    const factors: any[] = [];
    const flat = (n: any) => {
      n = strip(n);
      if (n.type === "OperatorNode" && n.op === "*" && n.args.length === 2) { flat(n.args[0]); flat(n.args[1]); } else factors.push(n);
    };
    flat(t.node);
    for (const f of factors) {
      if (f.type === "ConstantNode" && typeof f.value === "number") { c *= f.value; continue; }
      let base = f, e = 1;
      if (f.type === "OperatorNode" && f.op === "^" && strip(f.args[1]).type === "ConstantNode") { base = strip(f.args[0]); e = strip(f.args[1]).value; }
      if (base.type !== "SymbolNode" || !Number.isInteger(e) || e < 0) return null;
      if (base.name === v) pv += e; else others.set(base.name, (others.get(base.name) ?? 0) + e);
    }
    const key = [...others].sort(([x], [y]) => (x < y ? -1 : 1)).map(([n, e]) => (e === 1 ? n : `${n}^${e}`)).join("*");
    while (out.length <= pv) out.push(new Map());
    out[pv] = pcoefAdd(out[pv], new Map([[key, c]]));
  }
  while (out.length > 1 && !out[out.length - 1].size) out.pop();
  return out;
}

/** Valeur numerique d'un coefficient pour des parametres donnes. */
function pcoefAt(c: PCoef, vals: Record<string, number>): number {
  let s = 0;
  for (const [m, x] of c) {
    let t = x;
    if (m) for (const part of m.split("*")) { const [n, e] = part.split("^"); t *= vals[n] ** (e ? Number(e) : 1); }
    s += t;
  }
  return s;
}

/** Division exacte par (v - r), r nombre (Horner sur les coefficients en parametres). */
function pdivRoot(c: PCoef[], r: number): PCoef[] {
  const q: PCoef[] = new Array(c.length - 1).fill(null).map(() => new Map());
  let acc: PCoef = new Map();
  for (let i = c.length - 1; i >= 1; i--) {
    acc = pcoefAdd(c[i], acc, 1);
    q[i - 1] = acc;
    acc = new Map([...acc].map(([m, x]) => [m, x * r]));
  }
  return q;
}

/** Coefficient ecrit comme on le tape : « K », « 3 », « (K + 2) », « 2K a ». */
function pcoefText(c: PCoef, alone: boolean): string {
  const mono = (m: string, x: number) => {
    const vars = m ? m.split("*").map((p) => p.replace("^", "^")).join(" ") : "";
    const abs = Math.abs(x);
    const num = vars && Math.abs(abs - 1) < 1e-12 ? "" : coefText(abs);
    return { neg: x < 0, text: `${num}${vars}` };
  };
  const parts = [...c].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a < b ? -1 : 1)).map(([m, x]) => mono(m, x));
  const s = parts.map((p, i) => `${p.neg ? (i ? " - " : "-") : i ? " + " : ""}${p.text}`).join("");
  return parts.length > 1 && !alone ? `(${s})` : s;
}

function paramPolyText(c: PCoef[], v: string): string {
  let out = "";
  for (let k = c.length - 1; k >= 0; k--) {
    const co = c[k];
    if (!co.size) continue;
    const mono = k === 0 ? "" : k === 1 ? v : `${v}^${k}`;
    const single = co.size === 1;
    const [m0, x0] = [...co][0];
    let term: string;
    if (!mono) term = pcoefText(co, true);
    else if (single && m0 === "" && Math.abs(Math.abs(x0) - 1) < 1e-12) term = `${x0 < 0 ? "-" : ""}${mono}`;
    else if (single) term = `${pcoefText(co, true)}${m0 === "" ? "" : " "}${mono}`;
    else term = `${pcoefText(co, false)}${mono}`;
    const neg = term.startsWith("-");
    out += out ? (neg ? ` - ${term.slice(1)}` : ` + ${term}`) : term;
  }
  return out || "0";
}

/**
 * Fraction en une lettre principale (p, s, x, t, z ou la premiere) avec
 * d'autres lettres en parametres : numerateur et denominateur developpes,
 * puis simplifies par les racines communes qui ne dependent pas des
 * parametres (essayees pour deux jeux de valeurs). null si rien de sur.
 */
function rationalWithParams(node: MathNode, vars: string[]): string[] {
  if (!node.filter((x: any) => x.type === "OperatorNode" && x.op === "/").length) return [];
  const v = ["p", "s", "x", "t", "z", "w"].find((x) => vars.includes(x)) ?? vars[0];
  const out: string[] = [];
  // Denominateur qui revient (« K/(p+a) / (1 + K/(p+a)) ») : traite comme un
  // bloc, comme sur la copie : K/(X + K), puis X remis.
  const counts = new Map<string, { n: number; node: any }>();
  node.traverse((n: any) => {
    if (n.type !== "OperatorNode" || n.op !== "/") return;
    const d = strip(n.args[1]);
    if (d.type === "SymbolNode" || d.type === "ConstantNode") return;
    const k = compact(print(d));
    const c = counts.get(k);
    counts.set(k, { n: (c?.n ?? 0) + 1, node: d });
  });
  const rep = [...counts].filter(([, c]) => c.n >= 2).sort(([a], [b]) => b.length - a.length)[0];
  if (rep) {
    const [key, { node: d }] = rep;
    const sub = node.transform((n: any) => (n.type !== "ConstantNode" && compact(print(strip(n))) === key ? new (M().SymbolNode)("zzu") : n));
    const otherVars = symbolsOf(sub).filter((x) => x !== "zzu");
    const t = rationalCore(sub, "zzu", otherVars);
    if (t) {
      const xt = print(d);
      // Somme au premier niveau (« p + a ») : entre parentheses seulement si elle est multipliee.
      const sum = /[+-]/.test(xt.replace(/\([^()]*\)/g, "").replace(/^-/, ""));
      out.push(t.replace(/zzu/g, (_a, off: number, str: string) => {
        const mult = /[A-Za-z0-9)τ]\s*$/.test(str.slice(0, off)) || /^\s*[A-Za-z(^]/.test(str.slice(off + 3));
        return sum && mult ? `(${xt})` : xt;
      }).replace(/([A-Za-z0-9τ]) \(/g, "$1("));
    }
  }
  // Developpe en p, s'il reste court.
  const e = rationalCore(node, v, vars.filter((x) => x !== v));
  if (e && (e.match(/[+-]/g) ?? []).length <= 4) out.push(e);
  return out;
}

function rationalCore(node: MathNode, v: string, params: string[]): string | null {
  const m = M();
  let r: any;
  try { r = m.rationalize(node, {}, true); } catch { return null; }
  if (!r.denominator) return null;
  let N = paramPoly(r.numerator, v), D = paramPoly(r.denominator, v);
  if (!N || !D || D.length < 2) return null;
  const sets = [0, 1].map((k) => Object.fromEntries(params.map((n, i) => [n, k ? 2.913 + 0.471 * i : 1.737 + 0.913 * i])));
  const at = (c: PCoef[], set: Record<string, number>) => c.map((x) => pcoefAt(x, set));
  for (let guard = 0; guard < 12 && D.length > 1 && N.length > 1; guard++) {
    const roots = polynomialRoots(at(D, sets[0]));
    const common = roots?.find((x) => {
      if (typeof x.value !== "number") return false;
      const z = x.value;
      return sets.every((set) => Math.abs(evalPoly(at(N!, set), z)) < 1e-7 && Math.abs(evalPoly(at(D!, set), z)) < 1e-7);
    });
    if (!common) break;
    let z = common.value as number;
    if (Math.abs(z - Math.round(z)) < 1e-7) z = Math.round(z);
    N = pdivRoot(N, z);
    D = pdivRoot(D, z);
  }
  // Coefficient dominant du denominateur numerique : ramene a 1 si c'est un nombre.
  const lead = D[D.length - 1];
  if (lead.size === 1 && lead.has("")) {
    const k = lead.get("")!;
    if (Math.abs(k - 1) > 1e-12) {
      const sc = (c: PCoef[]) => c.map((x) => new Map([...x].map(([mm, y]) => [mm, y / k])) as PCoef);
      N = sc(N); D = sc(D);
    }
  }
  const nt = paramPolyText(N, v), dt = paramPolyText(D, v);
  const wrap = (t: string) => (/[+\-]/.test(t.replace(/^-/, "")) || / /.test(t) ? `(${t})` : t);
  return `${wrap(nt)}/${wrap(dt)}`;
}

/* ---------------- detail avec des parametres (K, a...) ---------------- */

/** Terme en fraction : facteurs du haut et du bas (« K/(p(p+3)) » -> [K] / [p, p + 3]). */
function fracFactors(n: any): { num: any[]; den: any[] } {
  n = strip(n);
  if (n.type === "OperatorNode" && n.op === "/") {
    const a = fracFactors(n.args[0]), b = fracFactors(n.args[1]);
    return { num: [...a.num, ...b.den], den: [...a.den, ...b.num] };
  }
  if (n.type === "OperatorNode" && n.op === "*" && n.args.length === 2) {
    const a = fracFactors(n.args[0]), b = fracFactors(n.args[1]);
    return { num: [...a.num, ...b.num], den: [...a.den, ...b.den] };
  }
  return { num: [n], den: [] };
}

/**
 * Detail redige pour une fraction de fractions a plusieurs lettres (boucle
 * fermee « K/(p(p+3)) / (1 + K/(p(p+3))) ») : meme denominateur en haut et
 * en bas, multiplier par l'inverse, simplifier par les facteurs identiques,
 * puis la forme developpee. Travaille sur l'ecriture (facteurs compares a
 * l'identique), pas sur des polynomes. null si l'expression n'a pas cette forme.
 */
function paramSteps(node: MathNode): string[] | null {
  const m = M();
  const top = strip(node);
  if (!(top.type === "OperatorNode" && top.op === "/")) return null;
  const key = (f: any) => compact(print(strip(f)));
  const isOne = (f: any) => { const x = strip(f); return x.type === "ConstantNode" && x.value === 1; };
  const txt = (f: any) => {
    const t = print(strip(f));
    const x = strip(f);
    return x.type === "OperatorNode" && (x.op === "+" || x.op === "-") ? `(${t})` : t;
  };
  // Produit ecrit comme on le tape : « K p(p + 3) », « K(p + a) ».
  const prod = (fs: any[]) => {
    const k = fs.filter((f) => !isOne(f)).map(txt);
    return k.length ? k.reduce((acc, t) => (acc ? `${acc}${t.startsWith("(") ? "" : " "}${t}` : t), "") : "1";
  };
  // LaTeX par la grammaire de la page (lettres en italique, produits sans point).
  const tex = (src: string) => forceFormula(src) ?? frTexDecimal(m.parse(normalizeInput(src)).toTex({ parenthesis: "auto", implicit: "hide" } as any));
  const fracSrc = (num: any[], den: any[]) => {
    const d = den.filter((f) => !isOne(f));
    return d.length ? `(${prod(num)})/(${prod(d)})` : prod(num);
  };
  const T = (n: MathNode) => tex(print(n));
  const lines: string[] = [`On part de $${T(node)}$.`];
  // Une moitie en une seule fraction ; une somme de fractions est detaillee.
  const reduce = (x: any, where: string): { num: any[]; den: any[] } | null => {
    const s = strip(x);
    if (!(s.type === "OperatorNode" && (s.op === "+" || s.op === "-"))) return fracFactors(s);
    const terms = termsOf(s).map((t) => ({ sign: t.sign, ...fracFactors(t.node) }));
    if (!terms.some((t) => t.den.length)) return { num: [s], den: [] };
    // Denominateur commun : les facteurs distincts des denominateurs.
    const common: any[] = [];
    for (const t of terms) for (const f of t.den) if (!common.some((c) => key(c) === key(f))) common.push(f);
    const parts = terms.map((t) => {
      const missing = common.filter((c) => !t.den.some((f) => key(f) === key(c)));
      return { sign: t.sign, num: [...t.num, ...missing] };
    });
    const sumSrc = parts.map((p, i) => `${i ? (p.sign < 0 ? " - " : " + ") : p.sign < 0 ? "-" : ""}${prod(p.num)}`).join("");
    const mid = parts.map((p, i) => `${i ? (p.sign < 0 ? " - " : " + ") : p.sign < 0 ? "-" : ""}\\frac{${tex(prod(p.num))}}{${tex(prod(common))}}`).join("");
    lines.push(`${where}on met tout au même dénominateur : $${T(strip(x))} = ${mid} = \\frac{${tex(sumSrc)}}{${tex(prod(common))}}$.`);
    return { num: [m.parse(normalizeInput(sumSrc))], den: common };
  };
  try {
    const a = reduce(top.args[0], "En haut, ");
    const b = reduce(top.args[1], "En bas, ");
    if (!a || !b) return null;
    let num = [...a.num, ...b.den], den = [...a.den, ...b.num];
    if (a.den.length || b.den.length) {
      lines.push(`Diviser par une fraction, c'est multiplier par son inverse : $${tex(fracSrc(a.num, a.den))} \\times ${tex(fracSrc(b.den, b.num))} = ${tex(fracSrc(num, den))}$.`);
    }
    const gone: any[] = [];
    for (let i = 0; i < num.length; i++) {
      const j = den.findIndex((d) => key(d) === key(num[i]) && !isOne(d));
      if (j < 0 || isOne(num[i])) continue;
      gone.push(num[i]);
      num = num.filter((_f, k) => k !== i);
      den = den.filter((_f, k) => k !== j);
      i--;
    }
    if (!gone.length && lines.length < 3) return null;
    const res = fracSrc(num, den);
    if (gone.length) lines.push(`On simplifie par $${tex(prod(gone))}$ : $${tex(res)}$.`);
    // Forme developpee, si elle est plus simple a lire.
    const syms = symbolsOf(node);
    const resTex = tex(res);
    const parens = (t: string) => (t.match(/\\left\(/g) ?? []).length;
    const dev = rationalWithParams(node, syms).map(tex).find((f) => parens(f) < parens(resTex));
    lines.push(`Donc $${T(node)} = ${resTex}${dev ? ` = ${dev}` : ""}$.`);
  } catch {
    return null;
  }
  return lines;
}

