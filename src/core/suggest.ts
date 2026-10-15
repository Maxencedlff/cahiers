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

/** Relecture en clair sans reste de LaTeX ni de structure (cases, displaystyle) : proposable telle quelle. */
function cleanPlain(plain: string): boolean {
  return !/[\\$]|displaystyle|begin|endcases|mathcal|langle|rangle/.test(plain);
}

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
        // « Donc $f_{eq}$ = » : le mot outil devant la grandeur n'en fait pas partie.
        lhs = (m?.[0] ?? "").trim().replace(/^(\S+)\s+(?=\$)/, (all, w: string) => (STOP.has(w.toLowerCase()) ? "" : all));
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
  /** Membre droit plie (apres le « = » du membre gauche). */
  rhsLong: string;
  rhsShort: string;
  /** Membres, casse gardee (caseKey). */
  lhsCase: string;
  /** Initiale de la lettre grecque en tete du membre gauche (greekLead). */
  lhsGreek: string;
  rhsCase: string;
  /** Relue proprement (pas de reste de LaTeX : \\displaystyle, cases...). */
  clean: boolean;
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
      const rhsOf = (k: string, lhs: string) => (k.startsWith(`${lhs}=`) ? k.slice(lhs.length + 1) : k.slice(k.indexOf("=") + 1));
      const e = this.entries.get(dedup) ?? {
        insert: f.insert, long, short, lhsLong: lk.long, lhsShort: lk.short,
        rhsLong: rhsOf(long, lk.long), rhsShort: rhsOf(short, lk.short), lhsCase: caseKey(plainOf(f.lhs)), lhsGreek: greekLead(plainOf(f.lhs)),
        rhsCase: caseKey(plain.slice(plain.indexOf("=", plainOf(f.lhs).length - 1) + 1)),
        clean: cleanPlain(plain), count: 0, valueOnly: f.valueOnly, where: new Map(),
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
   *
   * Stricte : mieux vaut rien qu'une formule sans rapport. Seulement
   * - le membre gauche tape en entier puis « = » (« Req = », « ΔS = V »),
   *   le debut du membre droit deja tape devant etre celui de la formule ;
   * - ou un debut de grandeur qui ne peut pas etre un mot (« DeltaS », « iLm »,
   *   « ΔS », « R1 ») ;
   * dans la meme matiere, jamais une simple valeur (« vbatt = 9 V »), et
   * seulement si une formule l'emporte nettement sur les autres.
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
      // « Pu / Pf = », « iD = is - ie = » : un terme au milieu d'un calcul, pas le debut d'une relation.
      if (/[=+\-−*/·^(<>≈]\s*$/.test(line.slice(0, line.length - tail.length + s))) continue;
      const raw = tail.slice(s);
      const q = queryOf(raw);
      if (!q) continue;
      const best = this.best(q, raw, ctx);
      if (best) return { insert: best.e.insert, replace: raw.length, score: best.score };
    }
    return null;
  }

  private best(q: Query, raw: string, ctx: SuggestContext): { e: Entry; score: number } | null {
    const now = ctx.now ?? Date.now();
    const here = `${ctx.notebook}/${ctx.divider}`;
    const scored: { e: Entry; score: number }[] = [];
    for (const e of this.entries.values()) {
      if (!e.clean) continue;
      // Meme matiere seulement : une formule de Signaux n'a rien a faire en Electronique.
      if (![...e.where.keys()].some((w) => w.startsWith(`${ctx.notebook}/`))) continue;
      // Casse respectee : is n'est pas Is, iD n'est pas Id.
      if (!caseMatch(q.lhsCase, q.lhsGreek, e, q.rhs === null)) continue;
      if (q.rhs === null) {
        // Debut du membre gauche (« DeltaS », « iLm ») : il doit en etre le debut.
        if (!(e.lhsLong.startsWith(q.long) || e.lhsShort.startsWith(q.short))) continue;
      } else {
        // « X = ... » : X est exactement le membre gauche, la suite le debut du membre droit.
        if (!(e.lhsLong === q.long || e.lhsShort === q.short)) continue;
        if (!(e.rhsLong.startsWith(q.rhs.long) || e.rhsShort.startsWith(q.rhs.short))) continue;
        if (!e.rhsCase.startsWith(q.rhs.case)) continue;
        if (e.rhsLong === q.rhs.long || e.rhsShort === q.rhs.short) continue;
      }
      let score = 2 * Math.log(1 + e.count);
      let latest = "";
      for (const [w, d] of e.where) {
        if (d > latest) latest = d;
        if (w === here) score += 3;
        else if (w.startsWith(`${ctx.notebook}/`)) score += 1.5;
      }
      const age = (now - (Date.parse(latest) || now)) / 86400000;
      score += 2 * 0.5 ** (Math.max(0, age) / 30);
      // Casse respectee (S et s ne sont pas la meme grandeur).
      const lhsPlainStart = raw.replace(/\s/g, "")[0];
      if (lhsPlainStart && e.insert.replace(/[\s$\\{}]/g, "").includes(lhsPlainStart)) score += 0.5;
      score -= Math.max(0, e.long.length - 60) * 0.02;
      scored.push({ e, score });
    }
    // Jamais une simple valeur (« Ru = 50 Ω », l'application numerique d'un exercice).
    // Meme formule ecrite un peu autrement (« $\\frac{..}{8C}$T », « $\\frac{..}{8C}T$ ») : une seule.
    const groups = new Map<string, { best: { e: Entry; score: number }; count: number }>();
    for (const x of scored) {
      if (x.e.valueOnly) continue;
      const g = groups.get(x.e.rhsCase);
      if (!g) groups.set(x.e.rhsCase, { best: x, count: x.e.count });
      else { g.count += x.e.count; if (x.score > g.best.score) g.best = x; }
    }
    const ranked = [...groups.values()].sort((a, b) => b.best.score - a.best.score);
    const win = ranked[0];
    if (!win) return null;
    // Ecrite une seule fois : pas assez sur pour la proposer.
    if (win.count < MIN_SEEN) return null;
    // Deux ecritures aussi probables l'une que l'autre : on ne choisit pas a sa place.
    const rival = ranked[1];
    if (rival && win.best.score - rival.best.score < AMBIGUOUS) return null;
    // Une grandeur ecrite de plusieurs facons (Pf = Vbatt.Ie, Pf = Pc + Pu...) :
    // seulement celle qu'il ecrit le plus souvent, et nettement.
    const total = ranked.reduce((n, g) => n + g.count, 0);
    if (win.count < DOMINANT * total) return null;
    return win.best;
  }
}

/** Ecart de score en dessous duquel deux formules sont trop proches pour en proposer une. */
const AMBIGUOUS = 0.5;
/** Part des ecritures d'une grandeur que la formule proposee doit avoir, s'il y en a plusieurs. */
const DOMINANT = 0.6;
/** Nombre de fois qu'une formule doit deja avoir ete ecrite pour etre proposee. */
const MIN_SEEN = 2;

interface Query { long: string; short: string; lhsCase: string; lhsGreek: string; rhs: { long: string; short: string; case: string } | null }

/** Lettres du membre gauche, casse gardee (« iD » n'est pas « Id »). */
function caseKey(text: string): string {
  return text.replace(GREEK_RE_CASE, "").replace(/[^A-Za-z0-9]/g, "");
}

/** Initiale (minuscule) de la lettre grecque qui ouvre le membre gauche (« ΔS » -> « d »), sinon "". */
function greekLead(text: string): string {
  const m = new RegExp(`^(?:${GREEK_RE_CASE.source})`, "i").exec(text.trim());
  if (!m) return "";
  return (/^[α-ωΑ-Ω]$/.test(m[0]) ? fold(m[0]).text : m[0])[0].toLowerCase();
}

/**
 * Le membre gauche tape (`q`, casse gardee) est-il celui de l'entree (ou son
 * debut, `prefix`) ? Grec en toutes lettres, en symbole ou par son initiale
 * latine (« DS » pour « ΔS ») ; ailleurs la casse compte (« is » n'est pas « Is »).
 */
function caseMatch(q: string, qLead: string, e: Entry, prefix: boolean): boolean {
  const same = (a: string, b: string) => (prefix ? b.startsWith(a) : a === b);
  if (same(q, e.lhsCase) && (!qLead || qLead === e.lhsGreek)) return true;
  // « DS = » pour ΔS : l'initiale latine tapee tient lieu de la lettre grecque.
  return !qLead && !!e.lhsGreek && q[0]?.toLowerCase() === e.lhsGreek && same(q.slice(1), e.lhsCase);
}
const GREEK_RE_CASE = new RegExp(`${GREEK_NAMES.join("|")}|[α-ωΑ-Ω]`, "gi");

/**
 * Ce qui est tape peut-il lancer une suggestion ? « X = suite » : X une
 * grandeur (pas un mot outil ni une phrase). Sans « = » : un seul mot qui a
 * la forme d'une grandeur et jamais d'un mot francais en cours de frappe
 * (grec, Delta, majuscule apres une minuscule, chiffre, « _ »).
 */
function queryOf(raw: string): Query | null {
  const t = raw.trim();
  if (!t) return null;
  const eq = /^([^=<>!~≈≤≥]+?)\s*=(?!=)\s*([^=<>]*)$/.exec(t);
  if (eq) {
    const lhs = eq[1].trim();
    const words = lhs.toLowerCase().split(/\s+/);
    if (words.length > 2 || words.some((w) => STOP.has(w) || (w.length >= 4 && /^[a-zàâçéèêëîïôûùüÿœ]+$/.test(w) && !GREEK_NAMES.some((g) => w.startsWith(g))))) return null;
    const k = formulaKey(lhs);
    if (!k.long) return null;
    return { ...k, lhsCase: caseKey(lhs), lhsGreek: greekLead(lhs), rhs: { ...formulaKey(eq[2]), case: caseKey(eq[2]) } };
  }
  // Sans « = » : un nom de grandeur seulement (« 2/ » ou « (p » ne sont pas un debut de membre gauche).
  if (t.length < 2 || !/^[A-Za-zΔα-ωΑ-Ω][A-Za-z0-9_α-ωΑ-Ω]*$/.test(t)) return null;
  const shaped = /^(?:Δ|Delta|delta)|[α-ωΑ-Ω]|[a-z][A-Z]|\d|_/.test(t) && !/^[A-Z]{2,}/.test(t);
  if (!shaped) return null;
  const k = formulaKey(t);
  if (k.long.length < 2) return null;
  return { ...k, lhsCase: caseKey(t), lhsGreek: greekLead(t), rhs: null };
}
