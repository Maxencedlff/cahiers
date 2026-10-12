/**
 * Suggestions de formules deja ecrites (texte grise, Fleche droite pour
 * l'accepter). Module pur : l'interface (ui/suggestions.ts, TextDoc) lui
 * donne les formules des pages et la ligne tapee jusqu'au curseur.
 *
 * Une formule de cahier est souvent a moitie en texte : « ΔS = $\frac{\Delta
 * i_{L}}{8C}T$ », « Δ$i_{L}$= ... ». L'unite retenue est donc une
 * RELATION « membre gauche = membre droit » lue sur une ligne du texte
 * (texte et formules melanges), gardee sous sa forme du fichier (markdown
 * restreint de core/text/doc.ts) pour etre recollee telle quelle.
 *
 * Correspondance : ce qui est tape ("DeltaS =", "ΔS=", "DS", "Di") est plie
 * comme la recherche (core/text/find.ts : minuscules, grec par son nom,
 * sans espaces) et doit etre le debut de la formule pliee, en clair (« delta »)
 * ou abrege (grec par son initiale : « d »).
 */
import { docLines, parseDoc, serializeDoc, texToPlain, type DocToken } from "./text/doc";
import { fold } from "./text/find";

/** Une relation lue dans une page. */
export interface Formula {
  /** Texte a recoller (markdown restreint : texte et $latex$). */
  insert: string;
  /** Membre gauche, meme forme. */
  lhs: string;
  /** Membre droit = une simple valeur (« 250 mA », « 50 kHz ») : moins utile a reproposer. */
  valueOnly: boolean;
}

/** Formules d'une page, pour l'index. */
export interface CorpusPage {
  notebook: string;
  divider: string;
  /** Date de la page (ISO), pour la recence. */
  modified: string;
  formulas: Formula[];
}

export interface SuggestContext {
  notebook: string;
  divider: string;
  /** Maintenant (ms), pour les tests. */
  now?: number;
}

export interface Suggestion {
  insert: string;
  /** Nombre de caracteres de la fin de la ligne tapee qui sont remplaces. */
  replace: number;
  score: number;
}

/** Mots outils : jamais une requete a eux seuls (« de », « on », « pour »). */
const STOP = new Set([
  "a", "et", "ou", "on", "le", "la", "les", "de", "des", "du", "au", "aux", "un", "une", "il", "ils",
  "elle", "en", "ce", "ces", "se", "sa", "son", "si", "ne", "je", "tu", "me", "ma", "mon", "que", "qui",
  "or", "car", "donc", "mais", "pour", "par", "pas", "sur", "sous", "avec", "sans", "dans", "est", "soit",
  "alors", "ainsi", "comme", "tout", "avant", "apres", "entre", "puis", "plus", "cas", "fois",
]);

/** Separateurs de clauses sur une ligne : chaque clause donne au plus une relation. */
const CLAUSE = /\s*(?:;|⇔|⇒|→|<=>|=>|\t| {2,})\s*/;

/** Grec par son nom (forme pliee) -> initiale latine : « delta » -> « d ». */
const GREEK_NAMES = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda",
  "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
];
const GREEK_RE = new RegExp(`(${GREEK_NAMES.sort((a, b) => b.length - a.length).join("|")})`, "g");

/** Texte lisible d'un morceau en markdown restreint (formules relues comme tapees). */
function plainOf(src: string): string {
  return parseDoc(src).map((t) => (t.kind === "text" ? t.text : t.kind === "math" ? texToPlain(t.latex) : "")).join("");
}

/**
 * Cle pliee : minuscules, grec par son nom, sans espaces ni accolades.
 * `short` : grec par son initiale (« ΔS » -> « ds »), comme on l'abrege.
 */
export function formulaKey(text: string): { long: string; short: string } {
  const long = fold(text).text.replace(/[\s{}\\$]/g, "").replace(/_/g, "");
  return { long, short: long.replace(GREEK_RE, (g) => g[0]) };
}

/** Membre droit qui n'est qu'une valeur numerique, avec ou sans unite. */
function valueOnly(rhsPlain: string): boolean {
  // Mesure ou application numerique (« 17 % », « 3,39 V, η = 66 % ») : on retape rarement.
  return /^[-−+]?\s*\d/.test(rhsPlain.trim());
}

/** Fin de clause en langage courant (« La puissance moyenne... ») : coupe le membre droit. */
function cutProse(rhs: string): string {
  // Hors des $...$ : un mot de 4 lettres ou plus en minuscules (ou un mot outil) arrete la formule.
  let out = "", inMath = false;
  const parts = rhs.split(/(\$[^$]*\$)/);
  for (const p of parts) {
    if (p.startsWith("$") && p.endsWith("$") && p.length > 1) { out += p; continue; }
    const m = /(^|[\s(])(?:[a-zàâçéèêëîïôûùüÿœ]{4,}|(?:donc|avec|pour|soit|et|ou|on|car|est|sur|que|le|la|les|de|du|à|a|c'est)(?![\p{L}]))/iu.exec(p);
    if (m) { out += p.slice(0, m.index + m[1].length); inMath = true; break; }
    out += p;
  }
  void inMath;
  // Restes de phrase : parenthese ouverte seule, « (max) », ponctuation.
  let t = out;
  for (let k = 0; k < 4; k++) {
    t = t.replace(/[\s,.:;]+$/, "").replace(/\s*\((?:[^()$]*)\)?$/, (g) => (/[=+\-*/^_\\]/.test(g) ? g : ""));
  }
  return t.replace(/[\s,.:;(]+$/, "");
}

/** Membre gauche : la grandeur collee avant le « = » (formule, ou nom court, ou les deux : « Δ$i_{L}$ »). */
const LHS = /(?:[A-Za-zΑ-Ωα-ω][A-Za-z0-9Α-Ωα-ω]{0,6}\s*)?(?:\$[^$]+\$)?\s*$|[A-Za-zΑ-Ωα-ω][A-Za-z0-9Α-Ωα-ω_]{0,6}\s*$/u;

/**
 * Relations d'un texte de page (markdown restreint) : « X = ... » sur une
 * ligne, clause par clause, avec au moins une vraie formule ($...$) ou une
 * grandeur nommee. Couleurs et gras retires.
 */
export function extractFormulas(content: string): Formula[] {
  const out: Formula[] = [];
  for (const line of docLines(parseDoc(content))) {
    const toks = line.tokens
      .map((t): DocToken | null => (t.kind === "text" ? { kind: "text", text: t.text } : t.kind === "math" ? { kind: "math", latex: t.latex } : null))
      .filter((t): t is DocToken => !!t);
    const src = serializeDoc(toks).replace(/^\s*(?:\d{1,3}\\?[.)]|\\?[-•])\s+/, "");
    for (const clause of src.split(CLAUSE)) {
      // Premier « = » hors formule, ou dans une formule ($S = \alpha$).
      const eq = equalsAt(clause);
      if (!eq) continue;
      let lhs: string, rhs: string;
      if (eq.inMath) {
        // Relation entiere dans une formule : $S = \alpha \cdot E$.
        lhs = `$${eq.mathLhs}$`;
        rhs = clause.slice(eq.at);
        // La suite hors formule n'en fait partie que si elle la prolonge (« $..$= $..$ », « $\frac{..}$T »).
        const after = clause.slice(eq.mathEnd);
        rhs = `$${eq.mathRhs}$` + (/^\s*(?:[=+\-−*/^·<>≈]|\$|[A-Z](?![a-z]))/.test(after) ? after : "");
      } else {
        const before = clause.slice(0, eq.at);
        const m = LHS.exec(before);
        lhs = (m?.[0] ?? "").trim();
        // Nom ecrit en texte : court (Ru, Cte, Δ$i_L$), jamais un mot (« fournie », « que $I_B$ »).
        const word = lhs.replace(/\$[^$]*\$/g, "").trim();
        if (word && (/^[a-zàâçéèêëîïôûùü]{3,}$/.test(word) || word.length > 4)) continue;
        rhs = clause.slice(eq.at + 1);
      }
      rhs = cutProse(rhs.trim());
      if (!lhs || !rhs || lhs === "$$") continue;
      const lhsPlain = plainOf(lhs).trim();
      const rhsPlain = plainOf(rhs).trim();
      if (!lhsPlain || !rhsPlain || STOP.has(lhsPlain.toLowerCase())) continue;
      // Une formule au moins : sinon c'est une phrase (« le but = comprendre »).
      if (!/\$/.test(lhs + rhs) && !/^[A-Za-zΑ-Ωα-ω]{1,3}\d?$/u.test(lhsPlain)) continue;
      const insert = eq.inMath ? `${lhs.slice(0, -1)} = ${rhs.slice(1)}`.replace(/\$\s*\$/g, "") : `${lhs} = ${rhs}`;
      out.push({ insert: tidy(insert), lhs, valueOnly: valueOnly(rhsPlain) });
    }
  }
  return out;
}

/** Espaces en trop autour des formules recollees. */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\$\s+\$/g, "").trim();
}

/** Position du premier « = » d'une clause (hors <=, >=, !=), dans le texte ou dans une formule. */
function equalsAt(clause: string): { at: number; inMath: boolean; mathLhs?: string; mathRhs?: string; mathEnd?: number } | null {
  let i = 0;
  while (i < clause.length) {
    const c = clause[i];
    if (c === "$") {
      const end = clause.indexOf("$", i + 1);
      if (end < 0) return null;
      const tex = clause.slice(i + 1, end);
      const k = topEquals(tex);
      // Relation entiere dans la formule ; le texte avant (« On démontre ») n'en fait pas partie.
      if (k >= 0) return { at: i, inMath: true, mathLhs: tex.slice(0, k).trim(), mathRhs: tex.slice(k + 1).trim(), mathEnd: end + 1 };
      i = end + 1;
      continue;
    }
    if (c === "=" && !/[<>!=]/.test(clause[i - 1] ?? "") && clause[i + 1] !== "=") return { at: i, inMath: false };
    i++;
  }
  return null;
}

/** « = » au premier niveau d'un LaTeX (pas dans un \frac{..}{..}). */
function topEquals(tex: string): number {
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "=" && depth === 0) return i;
  }
  return -1;
}

interface Entry {
  insert: string;
  long: string;
  short: string;
  lhsLong: string;
  lhsShort: string;
  count: number;
  valueOnly: boolean;
  /** Ou elle apparait : « cahier/intercalaire » -> date la plus recente. */
  where: Map<string, string>;
}

/** Index en memoire des formules : construit une fois par cahier, interroge a chaque frappe. */
export class SuggestIndex {
  private entries = new Map<string, Entry>();

  constructor(pages: CorpusPage[] = []) {
    for (const p of pages) this.add(p);
  }

  get size(): number { return this.entries.size; }

  add(p: CorpusPage): void {
    const where = `${p.notebook}/${p.divider}`;
    for (const f of p.formulas) {
      const plain = plainOf(f.insert);
      const { long, short } = formulaKey(plain);
      if (long.length < 3) continue;
      // Meme formule a espaces pres : une seule entree.
      const dedup = long;
      const lk = formulaKey(plainOf(f.lhs));
      const e = this.entries.get(dedup) ?? {
        insert: f.insert, long, short, lhsLong: lk.long, lhsShort: lk.short, count: 0, valueOnly: f.valueOnly, where: new Map(),
      };
      e.count++;
      const seen = e.where.get(where);
      if (!seen || p.modified > seen) {
        e.where.set(where, p.modified);
        // L'ecriture la plus recente gagne.
        if ([...e.where.values()].every((d) => d <= p.modified)) e.insert = f.insert;
      }
      this.entries.set(dedup, e);
    }
  }

  /**
   * Suggestion pour la ligne tapee jusqu'au curseur (`line` : texte, les
   * formules deja mises en forme sous leur source tapee). On essaie les
   * debuts de mot du plus long au plus court : « Donc DeltaS = » cherche
   * « Donc DeltaS = », puis « DeltaS = ».
   */
  suggest(line: string, ctx: SuggestContext): Suggestion | null {
    if (!this.entries.size || /\s{2,}$/.test(line)) return null;
    const tail = line.slice(-40);
    const starts: number[] = [];
    for (let i = 0; i < tail.length; i++) {
      if (i === 0 ? tail.length === line.length || /[\s(;,]/.test(line[line.length - tail.length - 1]) : /[\s(;,]/.test(tail[i - 1])) {
        if (/\S/.test(tail[i])) starts.push(i);
      }
    }
    for (const s of starts) {
      const raw = tail.slice(s);
      const q = queryOk(raw);
      if (!q) continue;
      const best = this.best(q, raw, ctx);
      if (best) return { insert: best.e.insert, replace: raw.length, score: best.score };
    }
    return null;
  }

  private best(q: { long: string; short: string }, raw: string, ctx: SuggestContext): { e: Entry; score: number } | null {
    const now = ctx.now ?? Date.now();
    const here = `${ctx.notebook}/${ctx.divider}`;
    let best: { e: Entry; score: number } | null = null;
    for (const e of this.entries.values()) {
      const hit = e.long.startsWith(q.long) || e.short.startsWith(q.short);
      if (!hit) continue;
      // La formule entiere est deja tapee : rien a proposer.
      if (e.long === q.long || e.short === q.short) continue;
      // Tape en clair, la requete doit au moins couvrir le debut du membre gauche.
      if (!(e.lhsLong.startsWith(q.long) || q.long.startsWith(e.lhsLong) || e.lhsShort.startsWith(q.short) || q.short.startsWith(e.lhsShort))) continue;
      let score = 2 * Math.log(1 + e.count);
      let latest = "";
      for (const [w, d] of e.where) {
        if (d > latest) latest = d;
        if (w === here) score += 3;
        else if (w.startsWith(`${ctx.notebook}/`)) score += 1.5;
      }
      const age = (now - (Date.parse(latest) || now)) / 86400000;
      score += 2 * 0.5 ** (Math.max(0, age) / 30);
      if (e.valueOnly) score -= 2;
      // Casse respectee (S et s ne sont pas la meme grandeur).
      const lhsPlainStart = raw.replace(/\s/g, "")[0];
      if (lhsPlainStart && e.insert.replace(/[\s$\\{}]/g, "").includes(lhsPlainStart)) score += 0.5;
      score -= Math.max(0, e.long.length - 60) * 0.02;
      if (!best || score > best.score) best = { e, score };
    }
    return best;
  }
}

/**
 * Ce qui est tape peut-il lancer une suggestion ? Au moins 2 caracteres
 * plies ; pas un mot outil ; un mot tout en minuscules seulement s'il
 * ressemble a une grandeur (court, ou avec chiffre ou « = »).
 */
function queryOk(raw: string): { long: string; short: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const k = formulaKey(t);
  if (k.long.length < 2) return null;
  const words = t.toLowerCase().split(/[\s=]+/).filter(Boolean);
  if (words.length === 1 && STOP.has(words[0])) return null;
  // Phrase en cours (plusieurs mots courants) : pas une formule.
  if (words.some((w) => w.length >= 4 && /^[a-zàâçéèêëîïôûùüÿœ]+$/.test(w) && !GREEK_NAMES.includes(w) && !/^(?:delta|alpha|sigma|omega)/.test(w))) return null;
  if (/^[a-z]+$/.test(t) && t.length > 3) return null;
  return k;
}
