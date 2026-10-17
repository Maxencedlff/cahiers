/**
 * Bulle d'aide aux raccourcis (feuille de route, point 2) : en tapant le
 * debut d'un mot-raccourci (« ome », « tau », « lim »), une petite bulle
 * propose le resultat (ω, τ, lim) ; Tab ou → l'accepte, toute autre frappe
 * l'ignore. Logique pure ; le DOM est dans ui/textdoc.ts (`updateGhost`).
 *
 * Seulement quand c'est tres probablement voulu :
 * - le mot commence au debut de la ligne ou apres un blanc / une ponctuation,
 *   jamais colle a une lettre, un chiffre, « _ » ou « \ » ;
 * - au moins 3 lettres (« pi », « mu » : trop courts pour une bulle) ;
 * - debut d'un mot francais courant (« lim » de limite, « int » de
 *   integrale, « sig » de signal) : bulle seulement apres une pause de
 *   frappe (`delay`), sauf juste derriere un operateur (« F = int ») ;
 * - mot plus long que le raccourci (« sumo », « limite ») : rien.
 *
 * Les raccourcis sont ceux que la frappe gere deja : lettres grecques
 * (`GREEK_WORDS` d'automath, converties a l'Espace), ∀ et ∞ (mathWordsAtEnd),
 * grands operateurs a bornes (BIGOPS : « lim_( », « sum_( », « int_ »),
 * racine (« sqrt( »), et la matrice vide `mat2x2` (une formule a cases).
 */
import { GREEK_WORDS } from "./automath";

export interface ShortcutHint {
  /** Lettres tapees a remplacer (juste avant le curseur). */
  typed: string;
  /** Texte pose a la place (tape tel quel : la frappe continue en texte). */
  insert: string;
  /** Formule MathLive a ouvrir a la place (matrice vide) ; `insert` vaut alors "". */
  math?: string;
  /** Apercu montre dans la bulle (LaTeX). */
  show: string;
  /** Nom du raccourci, pour l'infobulle (« omega »). */
  word: string;
  /** Debut d'un mot francais courant : montrer seulement apres une pause. */
  delay: boolean;
}

interface Entry { word: string; insert: string; show: string }

const ENTRIES: Entry[] = [
  ...Object.entries(GREEK_WORDS)
    .filter(([w]) => w.length >= 3)
    .map(([w, ch]) => ({ word: w, insert: ch, show: ch })),
  { word: "forall", insert: "∀", show: "\\forall" },
  { word: "infty", insert: "∞", show: "\\infty" },
  { word: "exists", insert: "∃", show: "\\exists" },
  { word: "lim", insert: "lim_(", show: "\\lim_{x \\to a}" },
  { word: "sum", insert: "sum_(", show: "\\sum_{k}^{n}" },
  { word: "prod", insert: "prod_(", show: "\\prod_{k}^{n}" },
  { word: "int", insert: "int_", show: "\\int_{a}^{b}" },
  { word: "sqrt", insert: "sqrt(", show: "\\sqrt{x}" },
];

/**
 * Mots francais (et quelques mots anglais) courants dans un cours, qui
 * commencent comme un raccourci. Compares sans accents ni casse. Seul le
 * debut compte : « signal » couvre « sig », « sign »...
 */
const COMMON_WORDS = [
  // alpha, beta, gamma, delta
  "alphabet", "alpes", "alpin", "beton", "bete", "betail", "gamme", "gamin", "delai", "dela",
  "delegue", "delimiter", "delicat",
  // epsilon, eta, exists
  "etat", "etape", "etait", "etage", "etalon", "etant", "etablir", "etagere", "exister", "existe",
  "existence", "exigence", "exiger", "exil",
  // theta, tau, lambda, kappa, chi, phi, psi, rho, zeta
  "the", "theorie", "theoreme", "thermique", "these", "theme", "then", "there", "they",
  "taux", "taupe", "taureau", "lampe", "lame", "lamelle", "chiffre", "chimie", "chien", "chinois",
  "philosophie", "phishing", "psychologie", "rhone",
  // sigma, sum, sqrt
  "signal", "signe", "signifie", "signature", "significatif", "sumo",
  // omega : « ome » volontairement libre (demande explicite ; « omettre », « omelette » sont rares en cours)
  // forall, infty, int
  "forme", "force", "fort", "formule", "format", "forum", "forage", "for",
  "infini", "information", "informatique", "inferieur", "influence", "infra", "inf",
  "integrale", "integrer", "integration", "interieur", "intensite", "interet", "intervalle",
  "introduction", "intermediaire", "interne", "interface", "interrupteur", "intro", "into",
  // lim, prod
  "limite", "limiter", "limitation", "limon", "limace", "produit", "production", "produire",
  "programme", "projet", "probleme", "propriete",
];

/** Minuscules sans accents. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const FOLDED = COMMON_WORDS.map(fold);

/** `p` (deja plie) commence-t-il un mot courant plus long ? */
function startsCommonWord(p: string): boolean {
  return FOLDED.some((w) => w.length > p.length && w.startsWith(p));
}

/** Juste derriere un operateur (« F = int », « 2·ome ») : contexte formule. */
const OP_BEFORE = /[=<>≤≥≈≠→⇒⇔+\-−*/^·×∈]\s*$/;

/** Taille maximale d'une matrice vide. */
const MAT_MAX = 6;

/** LaTeX MathLive d'une matrice vide `rows`×`cols` (cases #? a remplir, Tab de l'une a l'autre). */
export function emptyMatrix(rows: number, cols: number): string {
  const row = Array.from({ length: cols }, () => "#?").join("&");
  return `\\begin{pmatrix}${Array.from({ length: rows }, () => row).join("\\\\")}\\end{pmatrix}`;
}

/** Apercu (KaTeX) d'une matrice vide : des cases grises. */
function matrixPreview(rows: number, cols: number): string {
  const row = Array.from({ length: cols }, () => "\\square").join("&");
  return `\\begin{pmatrix}${Array.from({ length: rows }, () => row).join("\\\\")}\\end{pmatrix}`;
}

/**
 * Matrice vide tapee « mat2x2 », « mat3x3 », « mat2x3 » (aussi « mat2 » et
 * « mat2x » : carree en attendant le second chiffre). null sinon.
 */
export function matrixShortcut(word: string): { rows: number; cols: number; complete: boolean } | null {
  const m = /^mat([1-9])(?:[x×]([1-9])?)?$/.exec(word);
  if (!m) return null;
  const rows = +m[1], cols = m[2] ? +m[2] : rows;
  if (rows > MAT_MAX || cols > MAT_MAX || rows * cols < 2) return null;
  return { rows, cols, complete: !!m[2] };
}

/**
 * Bulle pour le texte `before` (la ligne jusqu'au curseur). `after` : ce qui
 * suit le curseur sur la ligne (un mot coupe en son milieu : rien).
 */
export function shortcutHint(before: string, after = ""): ShortcutHint | null {
  if (/^[\p{L}\p{N}_]/u.test(after)) return null;
  const m = /(^|[^\p{L}\p{N}_\\'’])([A-Za-z][A-Za-z0-9×]*)$/u.exec(before);
  if (!m) return null;
  const typed = m[2];
  const head = before.slice(0, before.length - typed.length);

  const mat = matrixShortcut(typed);
  if (mat) {
    const { rows, cols } = mat;
    return {
      typed, insert: "", math: emptyMatrix(rows, cols), show: matrixPreview(rows, cols),
      word: `mat${rows}x${cols}`, delay: false,
    };
  }
  if (typed.length < 3 || !/^[A-Za-z]+$/.test(typed)) return null;
  // Tout en majuscules (« THE », « INT ») : un sigle, pas un raccourci.
  if (typed.length > 1 && typed === typed.toUpperCase()) return null;

  // Casse respectee : « Del » = Delta, « del » = delta.
  const found = ENTRIES.filter((e) => e.word.startsWith(typed));
  if (!found.length) return null;
  // Le mot exact d'abord, puis le plus court (« eps » avant « epsilon »).
  found.sort((a, b) => Number(b.word === typed) - Number(a.word === typed) || a.word.length - b.word.length);
  const e = found[0];
  // Deux raccourcis differents encore possibles (« Del… » : seul Delta ; « eps » : ε dans les deux cas).
  if (found.some((f) => f.insert !== e.insert && f.word !== typed) && e.word !== typed) return null;

  const mathCtx = OP_BEFORE.test(head);
  const delay = !mathCtx && startsCommonWord(fold(typed));
  return { typed, insert: e.insert, show: e.show, word: e.word, delay };
}

/** Pause de frappe avant une bulle sur le debut d'un mot courant (ms). */
export const HINT_PAUSE_MS = 700;
