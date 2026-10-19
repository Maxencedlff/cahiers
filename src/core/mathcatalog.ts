/**
 * Catalogue du ruban des formules (Σ) : chaque touche, sa section, son nom
 * en francais et ce qu'elle insere. Donnees pures, sans interface : le
 * ruban (ui/mathbar.ts), la frecence (symbols.ts) et la saisie
 * (textdoc.ts, caractere pose dans le texte) lisent tous cette table.
 *
 * Ordre : les sections les plus utiles d'abord (modeles, calcul, grec),
 * et dans chaque section l'ordre d'un cours. Une section = un onglet du
 * ruban : elle doit tenir sur deux rangees dans la zone des pages la plus
 * etroite (verifie par les tests, core/chrome.ts ribbonCapacity) ; le grec
 * majuscule est la bascule Maj de l'onglet Grec (`SHIFTED`). La frecence fait ensuite
 * passer devant, dans leur section, les touches deja utilisees.
 *
 * `insert` : LaTeX insere par MathLive (#@ = mot pris avant le curseur,
 * #? = case a remplir). Sans case, c'est un symbole seul : il se pose dans
 * le texte comme `char` s'il en a un, sinon comme une petite formule.
 * `typed` : raccourci de frappe qui donne deja ce symbole (verifie par les
 * tests contre automath et la bulle d'aide).
 */
import { MATH_TEMPLATES } from "./templates";
import { normalize } from "./text/find";

export interface MathKey {
  insert: string;
  /** Nom lisible (infobulle, lecteur d'ecran, recherche). Unique. */
  name: string;
  /** Apercu KaTeX du bouton, si different de `insert`. */
  label?: string;
  /** Caractere pose dans le texte de la page (symbole seul). */
  char?: string;
  /** Raccourci de frappe existant (« omega », « -> »). */
  typed?: string;
  /** Raccourci Alt+lettre (modeles de templates.ts). */
  altKey?: string;
  /** Mots de recherche en plus du nom. */
  words?: string;
  /** Apercu large : le bouton prend deux colonnes. */
  wide?: boolean;
}

export interface MathSection {
  id: string;
  /** Nom complet (infobulle de l'onglet, recherche par section). */
  title: string;
  /** Libelle court de l'onglet du ruban. */
  tab: string;
  /** Apercu KaTeX de l'onglet quand le ruban est trop etroit pour les mots. */
  glyph: string;
  keys: MathKey[];
}

/** Symbole seul : `[insert, nom, char?, typed?, words?]`, pour garder les tables lisibles. */
type Row = [insert: string, name: string, char?: string, typed?: string, words?: string];
const rows = (list: Row[]): MathKey[] =>
  list.map(([insert, name, char, typed, words]) => ({ insert, name, char, typed, words }));

/** Touche qui ouvre une formule a remplir (cases #?). */
const tpl = (label: string, insert: string, name: string, extra: Partial<MathKey> = {}): MathKey =>
  ({ label, insert, name, ...extra });

export const CATALOG: MathSection[] = [
  {
    id: "models",
    title: "Modèles",
    tab: "Modèles", glyph: "\\frac{a}{b}",
    keys: MATH_TEMPLATES.map((t) => ({
      insert: t.insert, label: t.label, name: t.title, altKey: t.key,
      typed: t.typed, wide: t.label.includes("\\begin"),
    })),
  },
  {
    id: "calculus",
    title: "Calcul",
    tab: "Calcul", glyph: "\\int",
    keys: [
      tpl("\\frac{\\partial f}{\\partial x}", "\\frac{\\partial #?}{\\partial #?}", "Dérivée partielle"),
      tpl("\\frac{\\mathrm{d}}{\\mathrm{d}t}", "\\frac{\\mathrm{d}}{\\mathrm{d}t}", "Dérivée par rapport au temps (d/dt)", { words: "derivee temps operateur" }),
      tpl("\\dot{x}", "\\dot{#@}", "Dérivée temporelle (point)", { typed: "dot", words: "x point vitesse" }),
      tpl("\\ddot{x}", "\\ddot{#@}", "Dérivée seconde (deux points)", { typed: "ddot", words: "x point point acceleration" }),
      tpl("\\iint", "\\iint_{#?}#?", "Intégrale double", { words: "surface" }),
      tpl("\\oint", "\\oint_{#?}#?", "Intégrale curviligne fermée", { words: "circulation contour" }),
      tpl("\\prod", "\\prod_{#?}^{#?}#?", "Produit : borne basse, Tab, borne haute, Tab, terme", { typed: "prod" }),
      tpl("\\sqrt[3]{x}", "\\sqrt[3]{#?}", "Racine cubique"),
      tpl("\\left[F\\right]_a^b", "\\left[#?\\right]_{#?}^{#?}", "Crochet d'évaluation [F] de a à b", { words: "primitive integrale" }),
      ...rows([
        ["\\partial", "dérivée partielle (∂ seul)", "∂"],
        ["\\nabla", "nabla (gradient, divergence)", undefined, undefined, "rot grad div"],
        ["\\int", "intégrale (∫ seule)"],
        ["\\mathrm{d}", "d droit (différentielle)", undefined, undefined, "dx dt"],
        ["\\mathcal{L}", "transformée de Laplace", undefined, "Lap"],
        ["\\mathcal{L}^{-1}", "transformée de Laplace inverse", undefined, undefined, "TL-1"],
        ["\\mathcal{F}", "transformée de Fourier"],
      ]),
    ],
  },
  {
    id: "greek",
    title: "Grec",
    tab: "Grec", glyph: "\\alpha",
    keys: rows([
      ["\\alpha", "alpha", "α", "alpha"], ["\\beta", "bêta", "β", "beta"], ["\\gamma", "gamma", "γ", "gamma"],
      ["\\delta", "delta", "δ", "delta"], ["\\varepsilon", "epsilon", "ε", "eps"], ["\\epsilon", "epsilon (variante)", "ϵ"],
      ["\\zeta", "zêta (amortissement)", "ζ", "zeta"], ["\\eta", "êta (rendement)", "η", "eta"], ["\\theta", "thêta", "θ", "theta"],
      ["\\vartheta", "thêta (variante)", "ϑ"], ["\\iota", "iota", "ι"], ["\\kappa", "kappa", "κ", "kappa"],
      ["\\lambda", "lambda", "λ", "lambda"], ["\\mu", "mu (micro)", "μ", "mu", "micro"], ["\\nu", "nu", "ν", "nu"],
      ["\\xi", "xi", "ξ", "xi"], ["\\pi", "pi", "π", "pi"], ["\\rho", "rhô (résistivité)", "ρ", "rho"],
      ["\\sigma", "sigma (conductivité, écart type)", "σ", "sigma"], ["\\tau", "tau (constante de temps)", "τ", "tau"],
      ["\\upsilon", "upsilon", "υ", "upsilon"], ["\\varphi", "phi (déphasage)", "φ", "phi"], ["\\phi", "phi (variante)", "ϕ"],
      ["\\chi", "khi", "χ", "chi"], ["\\psi", "psi", "ψ", "psi"], ["\\omega", "oméga (pulsation)", "ω", "omega"],
    ]),
  },
  {
    id: "greek-upper",
    title: "Grec majuscule",
    tab: "Grec maj.", glyph: "\\Omega",
    keys: rows([
      ["\\Gamma", "Gamma majuscule", "Γ", "Gamma"], ["\\Delta", "Delta majuscule", "Δ", "Delta"],
      ["\\Theta", "Thêta majuscule", "Θ", "Theta"], ["\\Lambda", "Lambda majuscule", "Λ", "Lambda"],
      ["\\Xi", "Xi majuscule", "Ξ"], ["\\Pi", "Pi majuscule (produit)", "Π"],
      ["\\Sigma", "Sigma majuscule (somme)", "Σ", "Sigma"], ["\\Upsilon", "Upsilon majuscule", "Υ"],
      ["\\Phi", "Phi majuscule (flux)", "Φ", "Phi"], ["\\Psi", "Psi majuscule", "Ψ", "Psi"],
      ["\\Omega", "Oméga majuscule (ohm)", "Ω", "Omega"], ["\\mathrm{A}", "Alpha majuscule"],
    ]),
  },
  {
    id: "operators",
    title: "Opérateurs",
    tab: "Opérateurs", glyph: "\\pm",
    keys: rows([
      ["\\times", "multiplié par", "×"], ["\\cdot", "point (produit scalaire)"], ["\\div", "divisé par", "÷"],
      ["\\pm", "plus ou moins", "±"], ["\\mp", "moins ou plus", "∓"], ["\\circ", "rond (composition)", "∘"],
      ["\\otimes", "produit tensoriel", "⊗"], ["\\oplus", "plus cerclé (ou exclusif)", "⊕", undefined, "xor"],
      ["\\ast", "étoile (convolution)", "∗"], ["\\ldots", "points de suspension", "…"],
      ["\\cdots", "points de suspension centrés", "⋯"],
    ]),
  },
  {
    id: "relations",
    title: "Relations",
    tab: "Relations", glyph: "\\leq",
    keys: rows([
      ["\\neq", "différent de", "≠", "!="], ["\\approx", "environ égal", "≈", "~="],
      ["\\leq", "inférieur ou égal", "≤", "<="], ["\\geq", "supérieur ou égal", "≥", ">="],
      ["\\ll", "très inférieur à", "≪", "<<"], ["\\gg", "très supérieur à", "≫", ">>"],
      ["\\simeq", "asymptotiquement égal", "≃"], ["\\sim", "équivalent à (∼)", "∼"],
      ["\\equiv", "identique, congru à", "≡", undefined, "modulo"], ["\\propto", "proportionnel à", "∝"],
      ["\\cong", "isomorphe, congruent", "≅"], ["\\triangleq", "égal par définition", "≜"],
      ["\\coloneqq", "défini par (:=)", "≔"],
    ]),
  },
  {
    id: "arrows",
    title: "Flèches",
    tab: "Flèches", glyph: "\\to",
    keys: [
      ...rows([
        ["\\to", "flèche, tend vers", "→", "->"], ["\\Rightarrow", "implique", "⇒", "=>"],
        ["\\Leftrightarrow", "équivalent à", "⇔", "<=>"], ["\\leftarrow", "flèche gauche", "←"],
        ["\\Leftarrow", "est impliqué par", "⇐"], ["\\leftrightarrow", "flèche double", "↔"],
        ["\\implies", "implique (long)", "⟹"], ["\\impliedby", "est impliqué par (long)", "⟸"],
        ["\\iff", "si et seulement si", "⟺"], ["\\mapsto", "associe (fonction)", "↦"],
        ["\\uparrow", "flèche haut (croissant)", "↑"], ["\\downarrow", "flèche bas (décroissant)", "↓"],
        ["\\rightleftharpoons", "équilibre", "⇌"],
      ]),
      tpl("\\xrightarrow{\\text{a}}", "\\xrightarrow{#?}", "Flèche avec texte au-dessus"),
    ],
  },
  {
    id: "sets",
    title: "Logique et ensembles",
    tab: "Ensembles", glyph: "\\in",
    keys: [
      ...rows([
        ["\\forall", "pour tout", "∀", "forall"], ["\\exists", "il existe", "∃", "exists"],
        ["\\nexists", "il n'existe pas", "∄"], ["\\neg", "non (négation)", "¬"],
        ["\\wedge", "et (logique), produit vectoriel", "∧"], ["\\vee", "ou (logique)", "∨"],
        ["\\in", "appartient à", "∈"], ["\\notin", "n'appartient pas à", "∉"],
        ["\\subset", "inclus dans", "⊂"], ["\\subseteq", "inclus ou égal", "⊆"],
        ["\\not\\subset", "non inclus dans", "⊄"], ["\\supset", "contient", "⊃"],
        ["\\cup", "union", "∪"], ["\\cap", "intersection", "∩"], ["\\setminus", "privé de", "∖"],
        ["\\emptyset", "ensemble vide", "∅"], ["\\mid", "tel que (barre)", undefined, undefined, "divise"],
        ["\\mathbb{N}", "entiers naturels", "ℕ", "NN"], ["\\mathbb{Z}", "entiers relatifs", "ℤ", "ZZ"],
        ["\\mathbb{Q}", "rationnels", "ℚ", "QQ"], ["\\mathbb{R}", "ensemble des réels", "ℝ", "RR"],
        ["\\mathbb{C}", "complexes", "ℂ", "CC"], ["\\infty", "infini", "∞", "infty"],
      ]),
      tpl("\\llbracket a,b\\rrbracket", "\\llbracket #?,#?\\rrbracket", "Intervalle d'entiers", { words: "crochets doubles" }),
    ],
  },
  {
    id: "notations",
    title: "Vecteurs et matrices",
    tab: "Vecteurs", glyph: "\\vec{u}",
    keys: [
      tpl("\\overrightarrow{AB}", "\\overrightarrow{#?}", "Vecteur AB (flèche longue)"),
      tpl("\\hat{x}", "\\hat{#@}", "Chapeau (vecteur unitaire, estimation)"),
      tpl("\\tilde{x}", "\\tilde{#@}", "Tilde"),
      tpl("\\underline{Z}", "\\underline{#@}", "Souligné (grandeur complexe)", { words: "complexe impedance" }),
      tpl("\\lVert x\\rVert", "\\left\\lVert #?\\right\\rVert", "Norme"),
      tpl("\\langle x\\rangle", "\\left\\langle #?\\right\\rangle", "Valeur moyenne, produit scalaire", { words: "chevrons crochets" }),
      tpl("\\lfloor x\\rfloor", "\\left\\lfloor #?\\right\\rfloor", "Partie entière"),
      tpl("\\lceil x\\rceil", "\\left\\lceil #?\\right\\rceil", "Partie entière supérieure"),
      tpl("x_{i}^{n}", "#@_{#?}^{#?}", "Indice et exposant"),
      tpl("A^{\\mathrm{T}}", "#@^{\\mathrm{T}}", "Transposée"),
      tpl("\\begin{pmatrix}a\\\\b\\\\c\\end{pmatrix}", "\\begin{pmatrix}#?\\\\#?\\\\#?\\end{pmatrix}", "Vecteur colonne", { wide: true }),
      tpl("\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}", "\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}", "Déterminant 2×2", { wide: true }),
      tpl("\\begin{pmatrix}a&b&c\\\\d&e&f\\\\g&h&i\\end{pmatrix}", "\\begin{pmatrix}#?&#?&#?\\\\#?&#?&#?\\\\#?&#?&#?\\end{pmatrix}", "Matrice 3×3", { wide: true }),
      tpl("\\begin{cases}\\cdot\\\\\\cdot\\\\\\cdot\\end{cases}", "\\begin{cases}#?\\\\#?\\\\#?\\end{cases}", "Système de trois équations", { wide: true }),
    ],
  },
  {
    id: "physics",
    title: "Physique et électronique",
    tab: "Physique", glyph: "\\angle",
    keys: [
      ...rows([
        ["^{\\circ}", "degré", "°", undefined, "angle"], ["{}^{\\circ}\\mathrm{C}", "degré Celsius", "°C", undefined, "temperature"],
        ["\\angle", "angle, phaseur", "∠"], ["\\perp", "perpendiculaire", "⊥"],
        ["\\parallel", "parallèle (en parallèle)", "∥"], ["\\hbar", "h barre (constante de Planck réduite)", "ℏ"],
        ["\\ell", "l cursif (longueur)", "ℓ"], ["\\mathrm{j}", "j (imaginaire)", undefined, undefined, "complexe"],
        ["\\mathrm{e}", "e (exponentielle)"], ["\\Re", "partie réelle (ℜ)", "ℜ"], ["\\Im", "partie imaginaire (ℑ)", "ℑ"],
        ["\\operatorname{Re}", "partie réelle (Re)"], ["\\operatorname{Im}", "partie imaginaire (Im)"],
        ["\\arg", "argument"], ["\\mathrm{dB}", "décibel"],
      ]),
      tpl("r\\angle\\varphi", "#?\\angle #?", "Phaseur module ∠ phase"),
    ],
  },
];

/** Toutes les touches du catalogue, dans l'ordre des sections. */
export const ALL_KEYS: readonly MathKey[] = CATALOG.flatMap((s) => s.keys);

/** Touche a remplir (modele) ou symbole seul ? */
export function isTemplate(insert: string): boolean {
  return insert.includes("#?") || insert.includes("#@");
}

const BY_INSERT = new Map(ALL_KEYS.map((k) => [k.insert, k]));

export function keyFor(insert: string): MathKey | undefined {
  return BY_INSERT.get(insert);
}

/** Caractere a poser dans le texte pour ce symbole seul, s'il en a un. */
export function symbolChar(insert: string): string | undefined {
  return BY_INSERT.get(insert)?.char;
}

/**
 * Infobulle d'une touche : son nom, puis comment l'avoir sans souris
 * (Alt+lettre, ou le raccourci de frappe).
 */
export function keyTitle(k: MathKey): string {
  const how = [k.altKey ? `Alt+${k.altKey.toUpperCase()}` : "", k.typed ? `tape « ${k.typed} »` : ""].filter(Boolean);
  return how.length ? `${k.name} (${how.join(", ")})` : k.name;
}

/** Texte plie ou l'on cherche une touche : nom, raccourci, mots, caractere. */
function haystack(k: MathKey): string {
  return normalize([k.name, k.typed ?? "", k.words ?? "", k.char ?? ""].join(" "));
}
const HAY = new Map(ALL_KEYS.map((k) => [k, haystack(k)]));

/** Un mot de `text` (plie) commence-t-il par `q` ? « fl » trouve « flèche ». */
function wordStarts(text: string, q: string): boolean {
  return text.startsWith(q) || text.includes(` ${q}`) || text.includes(`(${q}`);
}

/**
 * Onglet bascule : Maj sur l'onglet Grec montre les majuscules. La section
 * basculee n'a pas d'onglet a elle.
 */
export const SHIFTED: Readonly<Record<string, string>> = { greek: "greek-upper" };
const SHIFT_BACK = new Map(Object.entries(SHIFTED).map(([a, b]) => [b, a]));

/** Onglets du ruban, dans l'ordre du catalogue (sans les sections basculees). */
export const RIBBON_TABS: readonly MathSection[] = CATALOG.filter((s) => !SHIFT_BACK.has(s.id));

/** Onglet qui montre cette section (le grec pour le grec majuscule). */
export function tabOf(sectionId: string): string {
  return SHIFT_BACK.get(sectionId) ?? sectionId;
}

/** L'autre casse de cette section (Maj), s'il y en a une. */
export function shiftOf(sectionId: string): string | undefined {
  return SHIFTED[sectionId] ?? SHIFT_BACK.get(sectionId);
}

export function sectionById(id: string): MathSection | undefined {
  return CATALOG.find((s) => s.id === id);
}

/** Place prise dans une rangee : 2 pour un apercu large (matrice), 1 sinon. */
export function keyUnits(keys: readonly Pick<MathKey, "wide">[]): number {
  return keys.reduce((n, k) => n + (k.wide ? 2 : 1), 0);
}

/**
 * Recherche du ruban, toutes sections : « omega » → ω et Ω, « fl » → les
 * fleches (et le flux Φ apres elles). Plie casse, accents et grec (« ω »
 * trouve omega). Rang : nom qui commence par la recherche, puis un mot du
 * nom, puis le reste (raccourci, mots, section) ; a rang egal, `score`
 * (usage) puis l'ordre du catalogue. Entree pose le premier : ce doit etre
 * le plus probable. Vide : aucune touche.
 */
export function searchKeys(query: string, score: (insert: string) => number = () => 0): MathKey[] {
  const q = normalize(query);
  if (!q) return [];
  const terms = q.split(" ").filter(Boolean);
  const hits = (text: string) => terms.every((t) => wordStarts(text, t));
  const found: { k: MathKey; rank: number; s: number; i: number }[] = [];
  CATALOG.forEach((sec) => {
    const inTitle = hits(normalize(sec.title));
    for (const k of sec.keys) {
      const name = normalize(k.name);
      const rank = name.startsWith(q) ? 0 : hits(name) ? 1 : hits(HAY.get(k)!) || inTitle ? 2 : -1;
      if (rank >= 0) found.push({ k, rank, s: score(k.insert), i: found.length });
    }
  });
  return found.sort((a, b) => a.rank - b.rank || b.s - a.s || a.i - b.i).map((x) => x.k);
}
