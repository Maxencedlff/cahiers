import { MathfieldElement } from "mathlive";
import "mathlive/fonts.css";
import katex from "katex";
import { askText, el, toast } from "./dom";
import { inkCssColor } from "../core/theme";
import type { ColorKey } from "../core/types";
import {
  docClipboardLines, docClipboardText, frenchSpaceAtEnd, pastedMath, docLines, listNumbers, markerStyle, FONT_SIZES, MAX_LIST_LEVEL, NORMAL_SIZE, normalizeTokens, parseDoc, serializeDoc,
  texToPlain, trailingOperand, type DocToken, type LineFormat, type LineStyle,
} from "../core/text/doc";
import { foldChar, occurrences, OPS as FOLD_OPS, skipBlank } from "../core/text/find";
import {
  LIVE_CARET, balanceParens, cleanMathLive, findFormulas, forceFormula, glueDen, greekWordAtEnd, liveCaretFormula, liveComplete, liveFormula, liveSplit, mathTail, mathWordsAtEnd, planLine,
  slashOpensFraction, subscriptVars, symbolAtEnd, type FoundFormula, type LinePart, type ScanMode,
} from "../core/text/automath";
import { PALETTE } from "../core/palette";
import { recordLatex } from "../core/symbols";
import { appAltKey } from "../core/templates";
import { linesToReach, TEXT_LEFT, TEXT_RIGHT } from "../core/textlayout";
import { PAGE_W } from "../core/ink/sheet";
import { BLOCK_MAX_H } from "../core/paginate";
import { cleanHint, linkUrl, parseLinkMarkdown, pagePathOf, type LinkCandidate } from "../core/links";
import { pickLink } from "./linkpicker";

// Polices chargees par fonts.css (embarquees par Vite), aucun son : l'app
// fonctionne hors ligne et en amphi.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;

/** Document dont une formule est en cours d'edition. */
let editingDoc: TextDoc | null = null;
/** Dernier document ou le curseur etait. */
let lastDoc: TextDoc | null = null;

/** Calcul de la derniere page tapee, pour la calculatrice (Ctrl+J). */
export function lastCalcSource(): string | null {
  return lastDoc?.calcSource() ?? null;
}

/**
 * MathLive ne prend le focus que 60 ms apres focus() (voir son onFocus).
 * Les touches tapees dans l'intervalle, Alt+= puis "1/x" enchaines, iraient
 * a la page : on les retient ici et on les rejoue dans la formule.
 */
let waiting: { mf: MathfieldElement; keys: KeyboardEvent[] } | null = null;
window.addEventListener("keydown", (e) => {
  if (!waiting || !waiting.mf.isConnected || sinkFocused(waiting.mf)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1 && !["Escape", "Enter", "Tab", "Backspace"].includes(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  waiting.keys.push(e);
}, { capture: true });

/**
 * Texte de la page, toujours pret a recevoir le clavier : pas de zone a
 * inserer, on tape, comme dans Word.
 *
 * Les formules sont des blocs figes dans la ligne (rendu KaTeX). Une seule
 * devient editable a la fois : elle est alors remplacee par un champ
 * MathLive ("/" fait une fraction, "^" un exposant, "sqrt" une racine) et le
 * texte autour est gele le temps de l'edition. Un champ MathLive imbrique
 * dans un texte editable perd ses frappes sous Chromium : c'est pour cela
 * qu'on ne les laisse jamais coexister.
 *
 * La couche est au-dessus du canvas : le stylet et le doigt lui sont repris
 * au pointerdown et renvoyes a l'encre (voir PageView), la souris place le
 * curseur et selectionne.
 */
/** Ce que la page sait d'une photo posee dans le texte. */
export interface DocImages {
  /** Fichier de la photo et sa largeur, null si le bloc n'existe plus. */
  lookup: (id: string) => {
    url: Promise<string>; width: number; ocr: string | null;
    /** Original garde (D9) : « Redresser a nouveau » possible. */
    original?: boolean;
    /** Calee a gauche, la suite passe a cote (ImageBlock.side). */
    side?: boolean;
    /** Hauteur etiree (ImageBlock.height), absente = proportions d'origine. */
    height?: number;
    /** Place sur la ligne (ImageBlock.align / x). */
    align?: PhotoAlign;
    x?: number;
  } | null;
  /** Photo centree, a droite, ou decalee de `x` (rien : a gauche). */
  placed?: (id: string, place: PhotoPlace) => void;
  /**
   * Ctrl+C / Ctrl+X sur une photo : la page la garde pour un Ctrl+V
   * ailleurs. Rend le texte a mettre dans le presse-papiers (marqueur).
   */
  clip?: (id: string) => string | null;
  /** Ctrl+V d'une photo copiee : bloc cree dans cette page, son id (null : rien). */
  pasteClip?: (marker: string) => Promise<string | null>;
  /**
   * Taille choisie aux poignees, en unites de page. `height` : nombre =
   * photo etiree, null = proportions d'origine rendues, absent = inchangee.
   */
  resized: (id: string, width: number, height?: number | null) => void;
  /** Photo calee a gauche (true) ou rendue a sa ligne (false). */
  sided?: (id: string, side: boolean) => void;
  /**
   * Deplacement explicite d'une photo (monter, descendre, glisser, decaler,
   * aligner, caler a gauche) : `run` le fait ; la page mesure les photos
   * avant et apres pour que l'encre posee dessus suive (followPhotos).
   */
  moving?: (run: () => void) => void;
  /**
   * Image collee (capture Win+Maj+S) ou deposee depuis l'Explorateur :
   * enregistree telle quelle, sans recadrage. Rend l'id du bloc cree, ou
   * null (page en lecture seule, fichier illisible). L'OCR suit en fond.
   */
  addFile?: (file: File) => Promise<string | null>;
  /** « Redresser a nouveau » : rouvre le dialogue sur l'original. */
  recrop?: (id: string) => void;
  /**
   * Bloc vivant (calcul, courbe) pose dans le texte avec le meme jeton
   * qu'une photo : son rendu, sa largeur (courbe : retaillable), son nom.
   * null si l'id n'est pas un bloc vivant de la page.
   */
  live?: (id: string) => { node: HTMLElement; width?: number; label: string; ready?: Promise<void> } | null;
  /** Appui sur un bloc vivant : la calculatrice le rouvre (« Mettre à jour »). */
  openLive?: (id: string) => void;
}

/**
 * Liens entre pages (core/links.ts) : ce que la page sait faire d'un lien
 * pose dans le texte. Absent : les liens s'affichent sans rien faire.
 */
export interface DocLinks {
  /** Suit le lien (App : id de page, puis corbeille, puis chemin). */
  follow: (link: DocLinkRef) => void;
  /** Choix du selecteur `[[` (toutes les pages, lues a la demande). */
  candidates: () => Promise<LinkCandidate[]>;
  /** Id de la page de ce texte : on ne la propose pas. */
  pageId?: () => string | undefined;
  /** Etat des cibles, pour griser un lien vers une page supprimee. */
  check?: (links: DocLinkRef[]) => Promise<("ok" | "trash" | "missing")[]>;
}

/** Un lien du texte tel que l'affiche la page. */
export interface DocLinkRef { href: string; hint?: string; label: string }

/**
 * Photo plus haute qu'une page : reduite a la hauteur de page (largeur
 * maximale deduite de ses proportions). Elle tient toujours sur une feuille
 * A4, la pagination ne la coupe jamais (core/paginate.ts).
 */
function fitPageHeight(fig: HTMLElement, img: HTMLImageElement): void {
  const { naturalWidth: w, naturalHeight: h } = img;
  // Photo etiree : sa hauteur est deja bornee aux poignees.
  if (!w || !h || fig.classList.contains("stretched")) { fig.style.maxWidth = ""; return; }
  fig.style.maxWidth = `calc(${((BLOCK_MAX_H * w) / h).toFixed(1)}px * var(--k, 1))`;
}

/** Pose l'alignement ou le decalage d'une photo (style.css : al-*, --x). */
function applyPlace(fig: HTMLElement, place: PhotoPlace): void {
  fig.classList.toggle("al-center", place.align === "center");
  fig.classList.toggle("al-right", place.align === "right");
  if (!place.align && place.x) fig.style.setProperty("--x", String(place.x));
  else fig.style.removeProperty("--x");
}

/** Place actuelle d'une photo, lue sur l'element. */
function placeOf(fig: HTMLElement): PhotoPlace {
  if (fig.classList.contains("al-center")) return { align: "center" };
  if (fig.classList.contains("al-right")) return { align: "right" };
  const x = Number(fig.style.getPropertyValue("--x")) || 0;
  return x ? { x } : {};
}

/** Largeur du texte (feuille moins les marges), en unites de page. */
const TEXT_W = PAGE_W - TEXT_LEFT - TEXT_RIGHT;
/** Ecart entre une photo calee a gauche et ce qui passe a cote. */
const SIDE_GAP = 16;
/** Alignement d'une photo seule sur sa ligne (absent = a gauche). */
export type PhotoAlign = "center" | "right";
/** Place d'une photo sur sa ligne : alignee, ou decalee de `x` unites. */
export interface PhotoPlace { align?: PhotoAlign; x?: number }
/** Texte du presse-papiers d'une photo copiee dans Cahiers. */
const PHOTO_CLIP = /^\[photo Cahiers [0-9a-f-]{8,}\]$/;
/** Pas des fleches sur une photo selectionnee (Maj : pas fin), unites de page. */
const NUDGE = 17;
const NUDGE_FINE = 4;

/** Poignees d'une photo, dans l'ordre de Word (coins et milieux des cotes). */
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];
/** Plus petite photo aux poignees, en unites de page. */
const MIN_W = 60;
const MIN_H = 40;

/** Fichier image d'un presse-papiers ou d'un depot, s'il y en a un. */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f && isImageFile(f)) out.push(f);
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (isImageFile(f)) out.push(f);
  return out;
}

/** Image d'apres son type, ou son extension quand Windows ne donne pas de type (HEIC). */
function isImageFile(f: File): boolean {
  return f.type.startsWith("image/") || /\.(png|jpe?g|gif|bmp|webp|heic|heif|avif)$/i.test(f.name);
}

/**
 * Couleur du texte tape ensuite : une des 5 couleurs de la palette, ou null
 * pour le texte normal (noir). Reglee par la barre d'outils.
 */
let typingColor: ColorKey | null = null;

/**
 * Taille du texte tape ensuite, en points facon Word (doc.ts FONT_SIZES ;
 * NORMAL_SIZE = texte normal). Suit le curseur : un clic ailleurs prend la
 * taille de cet endroit.
 */
let typingSize: number = NORMAL_SIZE;

/** Taille choisie (barre du haut, Ctrl+Maj+> <) : la selection la prend, sinon la frappe qui suit. */
export function setTypingSize(size: number): void {
  typingSize = size;
  const sel = document.getSelection();
  if (lastDoc && sel?.rangeCount && sel.isCollapsed) {
    const r = sel.getRangeAt(0);
    lastDoc.keepSize = { node: r.startContainer, offset: r.startOffset };
  }
  lastDoc?.sizeSelection(size);
}

/** Taille a l'endroit du curseur (ou de la frappe a venir), pour l'afficher. */
export function currentTypingSize(): number { return typingSize; }

/** Formules reperees et mises en forme a chaque retour a la ligne. */
let autoMath = true;
export function setAutoMath(on: boolean): void { autoMath = on; }

/**
 * Correcteur orthographique du navigateur : coupe par defaut, il souligne
 * en rouge Vz, Vbe, malloc... et la page n'a plus l'air d'un document propre.
 */
let spellcheckOn = false;
export function setSpellcheck(on: boolean): void {
  spellcheckOn = on;
  document.querySelectorAll<HTMLElement>(".text-doc").forEach((d) => { d.spellcheck = on; });
}

export function setTypingColor(color: ColorKey | null): void {
  typingColor = color;
  // Texte selectionne : il prend la couleur, comme dans Word.
  lastDoc?.colorSelection(color);
  lastDoc?.paintColorTag();
}

/** Presse-papiers interne : le morceau copie, formules et couleurs comprises. */
const CLIP_TYPE = "application/x-cahiers-doc";

/**
 * Symboles du ruban poses directement dans le texte, sans formule a
 * remplir : la frappe continue en texte ("l'angle α vaut 30"), et le
 * caractere se relit dans les formules tapees ensuite.
 */
const SYMBOL_CHARS: Record<string, string> = {
  "\\alpha": "α", "\\beta": "β", "\\lambda": "λ", "\\pi": "π", "\\theta": "θ",
  "\\omega": "ω", "\\Delta": "Δ", "\\infty": "∞", "\\to": "→", "\\Rightarrow": "⇒",
  "\\Leftrightarrow": "⇔", "\\leq": "≤", "\\geq": "≥", "\\neq": "≠", "\\approx": "≈",
  "\\in": "∈", "\\forall": "∀", "\\exists": "∃", "\\mathbb{R}": "ℝ", "\\times": "×",
  "\\pm": "±", "\\partial": "∂", "\\Omega": "Ω", "\\eta": "η", "\\varepsilon": "ε",
};


/**
 * Raccourcis ajoutes a ceux de MathLive dans Alt+=. "in" : jamais colle a
 * une lettre ("Vin" reste V_{in}, "min" un mot) ; entre deux espaces, il
 * devient ∈ a la fermeture (cleanMathLive), MathLive ne voyant pas l'espace.
 * "inf" : l'infini, comme "infty".
 */
const FIELD_SHORTCUTS = {
  eps: "\\varepsilon", pi: "\\pi", inf: "\\infty",
  // Une seule case sous lim (MathLive en met deux, "_ -> _") : "lim_(x->0)" s'y tape.
  lim: "\\lim_{#?}",
  in: { after: "nothing+closefence", value: "\\in" },
};

/**
 * Morceau de la ligne relue pour les formules : un texte, une formule
 * convertie automatiquement (sa source tapee), ou le texte courant jusqu'au
 * curseur. `a`, `b` : position dans la ligne reconstituee ; `head` : texte
 * garde avant le debut de ligne (lignes precedentes du meme noeud).
 */
interface LineSeg extends LinePart { node: Node; a: number; b: number; head: string }
interface Line { segs: LineSeg[]; full: string; curStart: number }

/** Mot grec remplace par sa lettre : `at` = position juste apres la lettre. */
interface GreekDone { node: Text; at: number; word: string; char: string }


export class TextDoc {
  readonly root: HTMLElement;
  private savedRange: Range | null = null;
  private field: MathfieldElement | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Remplacement ou collage en cours : l'evenement input n'est pas une frappe. */
  private quiet = false;
  /** Formule rouverte : son LaTeX et sa source, pour la rendre intacte si rien ne change. */
  private fieldOrigin: { latex: string; src?: string; value: string } | null = null;
  /** Fractions de la formule ouvertes par "/" tape (pas par un modele). */
  private slashFracs = new WeakSet<object>();
  /** "/" vient d'etre tape : la fraction creee est relevee au prochain input. */
  private pendingSlash = false;
  /**
   * Formules que la derniere frappe vient de mettre en forme : Ctrl+Z ou
   * Retour arriere juste apres rend le texte tape, comme dans Word.
   * `expectSpace` : l'espace qui a declenche la conversion n'est pas encore
   * arrivee (la conversion se fait avant elle). `atCaret` : la derniere
   * formule finit au curseur ; sinon ("I1" mis en forme a l'Espace apres
   * "traverse"), Retour arriere efface normalement et seul Ctrl+Z l'annule.
   */
  private lastAuto: { eqs: HTMLElement[]; greek?: GreekDone | null; expectSpace: boolean; atCaret: boolean; pause?: boolean } | null = null;
  /**
   * Formule en cours de frappe derriere un "/" : le texte tape (`src`, depuis
   * le debut de la formule) se dessine en formule a chaque touche, lu par le
   * meme analyseur que le reste du texte (liveFormula). Le curseur reste
   * juste apres. `base` : le texte a l'ouverture ("num/"), Retour arriere
   * la rend en texte. Jamais l'editeur MathLive.
   */
  private live: { eq: HTMLElement; src: string; base: string } | null = null;
  /** Etiquette de la couleur de frappe, en marge de la ligne du curseur. */
  private colorTag: HTMLElement | null = null;
  /** La derniere relecture a fini sa derniere formule au curseur (voir planLine). */
  private madeAtCaret = false;
  /** Lettre grecque posee par la derniere relecture ("pi" -> π). */
  private greekDone: GreekDone | null = null;
  /**
   * Derniere mise en forme de ligne ("# " devenu titre, titre rendu au
   * texte par Retour arriere, sortie de liste) : le Ctrl+Z qui suit la
   * defait, comme dans Word. Oubliee a la touche suivante.
   */
  private lastLine: { undo: () => boolean } | null = null;
  /** Taille choisie sans selection, a cet endroit : la frappe suivante la garde. */
  keepSize: { node: Node; offset: number } | null = null;

  /** Ecouteur pose sur `document` : retire par dispose(), sinon chaque page vue reste en memoire. */
  private onSelectionChange = (): void => {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (this.root.contains(r.startContainer)) {
      this.savedRange = r.cloneRange();
      lastDoc = this;
      // Taille de frappe = celle de l'endroit ou l'on se place (comme Word) ;
      // un choix sans selection vaut jusqu'au prochain deplacement.
      const k = this.keepSize;
      const same = !!k && k.node === r.startContainer && k.offset === r.startOffset;
      if (sel.isCollapsed && !same) typingSize = sizeAt(r.startContainer, this.root);
      if (!same) this.keepSize = null;
      document.dispatchEvent(new CustomEvent("cahiers-typing-size"));
    }
    this.paintColorTag();
    this.markSelectedEqs(sel.isCollapsed ? null : r);
    // Curseur deplace : la suggestion grisee ne vaut plus.
    const g = this.ghostAt;
    if (g && !(sel.isCollapsed && r.startContainer === g.node && r.startOffset === g.offset)) this.hideGhost();
  };

  /**
   * Suggestion grisee (core/suggest.ts) : une formule deja ecrite, proposee
   * apres le curseur. Fleche droite la pose, toute autre frappe l'oublie.
   * Posee par PageView ; absente = pas de suggestion.
   */
  /** `prev` : la derniere ligne non vide au-dessus, formules relues en clair (suite d'un calcul « = … »). */
  suggester: ((line: string, prev: string) => { insert: string; replace: number } | null) | null = null;
  /** Calque de la suggestion : frere du texte (jamais dans le contenu, la pagination ou l'annulation). */
  private ghost: HTMLElement | null = null;
  /** Curseur et suggestion montres. */
  private ghostAt: { node: Text; offset: number; insert: string; replace: number } | null = null;
  private ghostRaf = 0;

  /** Suggestion recalculee a la prochaine image (apres la frappe et ses remplacements). */
  private scheduleGhost(): void {
    if (!this.suggester) return;
    cancelAnimationFrame(this.ghostRaf);
    this.ghostRaf = requestAnimationFrame(() => this.updateGhost());
  }

  private updateGhost(): void {
    this.hideGhost();
    if (!this.suggester || this.field || this.root.contentEditable === "false") return;
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !this.root.contains(node)) return;
    // Seulement en fin de ligne : rien d'autre que du blanc apres le curseur.
    const after = document.createRange();
    after.setStart(node, r.startOffset);
    after.setEnd(this.root, this.root.childNodes.length);
    const rest = after.toString();
    const eol = rest.indexOf("\n");
    if ((eol < 0 ? rest : rest.slice(0, eol)).replace(/[\s\u200b]/g, "")) return;
    if (eol < 0 && after.cloneContents().querySelector(".eq, .doc-img")) return;
    const line = this.lineAt(node as Text, r.startOffset);
    const s = this.suggester(line.full, line.full.includes("=") ? this.prevLinePlain(r) : "");
    if (!s) return;
    const rect = caretRect(r, this.root);
    const host = this.root.parentElement;
    if (!rect || !host) return;
    const g = this.ghost ?? el("div", { class: "text-ghost", "aria-hidden": "true" });
    this.ghost = g;
    g.replaceChildren(el("span", { class: "text-ghost-key" }, "→"), ...ghostNodes(s.insert));
    const cs = getComputedStyle(this.root);
    g.style.font = cs.font;
    g.style.lineHeight = cs.lineHeight;
    if (!g.isConnected) host.append(g);
    const hr = host.getBoundingClientRect();
    const left = rect.right - hr.left + 6;
    g.style.left = `${Math.round(left)}px`;
    g.style.top = `${Math.round(rect.top - hr.top)}px`;
    g.style.minHeight = `${Math.round(rect.height)}px`;
    // Trop long pour la fin de ligne : sous la ligne, au bord du texte.
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    if (left + g.offsetWidth > host.clientWidth - padR / 2) {
      g.style.left = `${Math.round(padL)}px`;
      g.style.top = `${Math.round(rect.bottom - hr.top)}px`;
      g.classList.add("below");
    } else g.classList.remove("below");
    this.ghostAt = { node: node as Text, offset: r.startOffset, insert: s.insert, replace: s.replace };
  }

  /**
   * Lignes non vides avant celle du curseur (20 au plus, la plus proche en
   * dernier), formules en clair (texToPlain) : suite d'un calcul « = … »,
   * valeur d'une inconnue trouvee plus haut (« donc α = »).
   */
  private prevLinePlain(r: Range): string {
    const before = document.createRange();
    before.setStart(this.root, 0);
    before.setEnd(r.startContainer, r.startOffset);
    const lines = docLines(normalizeTokens(this.readNodes(before.cloneContents())));
    const out: string[] = [];
    for (let i = lines.length - 2; i >= 0 && out.length < 20; i--) {
      const text = lines[i].tokens.map((t) => (t.kind === "text" ? t.text : t.kind === "math" ? texToPlain(t.latex) : "")).join("");
      if (text.trim()) out.unshift(text);
    }
    return out.join("\n");
  }

  /**
   * Calcul a envoyer a la calculatrice (Ctrl+J) : la formule en cours
   * d'edition entiere, sinon la ligne du curseur, de sa premiere a sa
   * derniere formule (« donc » et la ponctuation autour restent), en clair.
   */
  calcSource(): string | null {
    if (this.field) return texToPlain(this.field.getValue("latex")) || null;
    const sel = document.getSelection();
    const r = sel?.rangeCount && this.root.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : this.savedRange;
    if (!r || !this.root.contains(r.startContainer)) return null;
    const before = document.createRange();
    before.setStart(this.root, 0);
    before.setEnd(r.startContainer, r.startOffset);
    const n = docLines(normalizeTokens(this.readNodes(before.cloneContents()))).length;
    const line = docLines(normalizeTokens(this.readNodes(this.root)))[Math.max(0, n - 1)];
    if (!line) return null;
    const toks = line.tokens;
    const first = toks.findIndex((t) => t.kind === "math"), last = toks.map((t) => t.kind).lastIndexOf("math");
    const part = first >= 0 ? toks.slice(first, last + 1) : toks;
    const text = part.map((t) => (t.kind === "text" ? t.text : t.kind === "math" ? texToPlain(t.latex) : "")).join("").trim();
    return text || null;
  }

  /** Retire la suggestion grisee. */
  hideGhost(): void {
    cancelAnimationFrame(this.ghostRaf);
    this.ghostAt = null;
    this.ghost?.remove();
  }

  /**
   * Fleche droite : la suggestion remplace ce qui avait ete tape (« DeltaS
   * = ») et se pose telle qu'elle est dans le cahier (texte et formules).
   * Ctrl+Z juste apres rend la frappe d'avant.
   */
  private acceptGhost(): boolean {
    const g = this.ghostAt;
    this.hideGhost();
    if (!g || !g.node.isConnected) return false;
    const line = this.lineAt(g.node, g.offset);
    const from = line.full.length - g.replace;
    let start: [Node, number] | null = null;
    for (const seg of line.segs) {
      if (from > seg.b || (from === seg.b && seg !== line.segs[line.segs.length - 1])) continue;
      if (seg.kind === "eq") { start = [seg.node.parentNode!, Array.prototype.indexOf.call(seg.node.parentNode!.childNodes, seg.node)]; break; }
      // Indice dans le texte du noeud (les \u200b ne comptent pas dans la ligne).
      const t = seg.node.textContent ?? "";
      let i = seg.head.length, k = seg.a;
      while (i < t.length && k < from) { if (t[i] !== "\u200b") k++; i++; }
      start = [seg.node, i];
      break;
    }
    if (!start) return false;
    const before = this.content;
    const caret = this.caretOffset();
    const r = document.createRange();
    r.setStart(start[0], start[1]);
    r.setEnd(g.node, g.offset);
    r.deleteContents();
    r.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    this.insertTokens(parseDoc(g.insert));
    this.lastLine = {
      undo: () => {
        this.setContent(before);
        if (caret !== null) this.setCaretOffset(caret);
        this.emit();
        return true;
      },
    };
    return true;
  }

  /**
   * Formules prises dans la selection : surlignees comme le texte. KaTeX ne
   * montre pas la selection sur ses glyphes, on ne voyait pas qu'elles
   * partaient avec le copier.
   */
  private markSelectedEqs(r: Range | null): void {
    const inside = r && this.root.contains(r.commonAncestorContainer) ? r : null;
    if (!inside && !this.hasSelEq) return;
    let any = false;
    for (const eq of this.root.querySelectorAll<HTMLElement>(".eq")) {
      const on = !!inside && inside.intersectsNode(eq);
      eq.classList.toggle("in-sel", on);
      any ||= on;
    }
    this.hasSelEq = any;
  }

  private hasSelEq = false;

  /**
   * Page quittee : plus aucun ecouteur global ni minuterie. Sans cela, chaque
   * changement de page laissait en memoire la page, son canvas et ses traits.
   */
  dispose(): void {
    this.hideGhost();
    this.colorTag?.remove();
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerdown", this.onOutsideDown, { capture: true });
    this.dropMarker?.remove();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.savedRange = null;
    if (lastDoc === this) lastDoc = null;
    // Formule ouverte sur une page quittee : la page suivante ne doit pas
    // tenter de la figer.
    if (editingDoc === this) editingDoc = null;
  }

  constructor(
    content: string,
    private onChange: (content: string) => void,
    private images?: DocImages,
    private links?: DocLinks,
  ) {
    this.root = el("div", {
      class: "text-doc",
      contenteditable: "true",
      spellcheck: spellcheckOn ? "true" : "false",
      lang: "fr",
    });
    this.setContent(content);
    this.root.addEventListener("input", (e) => {
      if (this.quiet) return;
      const ie = e as InputEvent;
      // Fraction en cours de frappe : ce qui vient d'etre tape la prolonge.
      if (this.live) {
        if (!ie.isComposing) this.absorbLive();
        if (this.live) { this.emit(); return; }
      }
      this.tidyLines();
      // Ctrl+Z d'un remplacement ("→" redevient "->") : le navigateur
      // reselectionne "->", la frappe suivante l'effacerait. Curseur apres.
      if (ie.inputType === "historyUndo") {
        const sel = document.getSelection();
        if (sel?.rangeCount && !sel.isCollapsed && this.root.contains(sel.anchorNode)) sel.collapseToEnd();
      }
      // Seule l'espace qui a declenche la mise en forme la laisse annulable.
      if (this.lastAuto) {
        if (this.lastAuto.expectSpace && ie.inputType === "insertText" && ie.data === " ") this.lastAuto.expectSpace = false;
        else this.lastAuto = null;
      }
      // Touche morte (« ^ » en AZERTY) : la frappe arrive en composition,
      // traitee a sa fin (compositionend) comme une frappe ordinaire.
      if (ie.inputType === "insertText") { if (this.afterTyped(ie.data ?? "")) return; }
      else if (!ie.isComposing) this.hideGhost();
      this.emit();
    });
    this.root.addEventListener("compositionend", (e) => {
      if (this.quiet || this.field) return;
      const data = e.data ?? "";
      if (this.live) { this.absorbLive(); this.emit(); return; }
      if (!data) return;
      this.colorComposed(data);
      this.afterTyped(data);
      this.emit();
    });
    // "[[" : selecteur de lien (core/links.ts), avant la frappe en couleur.
    this.root.addEventListener("beforeinput", (e) => {
      if (this.field || this.live || e.inputType !== "insertText" || e.data !== "[" || !this.links) return;
      if (this.openPicker()) { e.preventDefault(); e.stopImmediatePropagation(); }
    });
    // Frappe dans la couleur choisie : si le curseur n'est pas deja dans un
    // texte de cette couleur, le caractere part dans un nouveau segment.
    this.root.addEventListener("beforeinput", (e) => {
      if (this.field || e.inputType !== "insertText" || !e.data) return;
      const sel = document.getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!this.root.contains(range.startContainer)) return;
      if (colorAt(range.startContainer, this.root) === typingColor && sizeAt(range.startContainer, this.root) === typingSize) return;
      e.preventDefault();
      insertColored(range, e.data);
      this.emit();
    });
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    // Un clic ailleurs : la derniere mise en forme n'est plus annulable.
    this.root.addEventListener("pointerdown", () => {
      if (this.live) this.endLive("pause");
      this.lastAuto = null; this.lastLine = null; this.hideGhost();
    });
    this.root.addEventListener("focusout", () => {
      this.hideGhost();
      this.colorTag?.remove();
      if (this.live) this.endLive("pause");
    });
    this.root.addEventListener("compositionstart", () => this.hideGhost());
    this.root.addEventListener("focusin", () => { lastDoc = this; });
    this.root.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest?.(".doc-link");
      if (link instanceof HTMLElement && this.root.contains(link)) {
        e.preventDefault();
        this.followLink(link);
        return;
      }
      const eq = (e.target as HTMLElement).closest?.(".eq");
      if (eq instanceof HTMLElement && this.root.contains(eq)) this.editEq(eq, { x: e.clientX, y: e.clientY });
    });
    // Lien au stylet ou au doigt : un appui le suit, sans laisser d'encre
    // (le stylet ne part pas a la page). Le doigt qui glisse fait defiler.
    this.root.addEventListener("pointerdown", (e) => this.onLinkDown(e));
    // Clic droit (ou appui long) sur un lien : renommer son libelle.
    this.root.addEventListener("contextmenu", (e) => {
      const link = (e.target as HTMLElement).closest?.(".doc-link");
      if (!(link instanceof HTMLElement) || !this.root.contains(link)) return;
      e.preventDefault();
      void this.renameLink(link);
    });
    document.addEventListener("selectionchange", this.onSelectionChange);
    // Fichier image depose depuis l'Explorateur (dragDropEnabled: false
    // dans tauri.conf.json, sinon Tauri garde le depot pour lui) : pose la
    // ou on le lache. Les photos deja dans le texte se deplacent par
    // pointer events (voir makeImage), plus par glisser-deposer HTML5.
    this.root.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files") || !this.images?.addFile) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    this.root.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.types.includes("Files") || !this.images?.addFile) return;
      e.preventDefault();
      e.stopPropagation();
      const files = imageFiles(e.dataTransfer);
      if (!files.length) { toast("Seules les images se déposent dans la page (PNG, JPEG, WebP).", "warn"); return; }
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      void this.addFiles(files, range && this.root.contains(range.startContainer) ? range : null);
    });
    // Photo selectionnee : un appui ailleurs la deselectionne.
    document.addEventListener("pointerdown", this.onOutsideDown, { capture: true });
    // Copier, couper : le morceau part avec ses formules (qui ne sont pas
    // du texte selectionnable) dans un format interne, et en $LaTeX$ pour
    // les autres logiciels. Sans cela un Ctrl+X, Ctrl+V les perdait.
    this.root.addEventListener("copy", (e) => this.onCopy(e, false));
    this.root.addEventListener("cut", (e) => this.onCopy(e, true));
    // Coller : un morceau copie ici revient tel quel ; d'ailleurs, du texte
    // brut, pour qu'un copier-coller depuis le web n'amene pas ses polices et
    // ses couleurs dans le cahier.
    this.root.addEventListener("paste", (e) => {
      if (this.field) return;
      e.preventDefault();
      if (this.live) this.endLive("pause");
      const dt = e.clipboardData;
      // Photo copiee ou coupee dans Cahiers (Ctrl+C / Ctrl+X sur la photo).
      const clipText = (dt?.getData("text/plain") ?? "").trim();
      if (PHOTO_CLIP.test(clipText) && this.images?.pasteClip) {
        const sel = document.getSelection();
        const r = sel?.rangeCount && this.root.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0).cloneRange() : null;
        if (r) liftToRoot(r, this.root, 1);
        void this.images.pasteClip(clipText).then((id) => {
          if (!id || !this.root.isConnected) return;
          const fig = this.insertImage(id, r && this.root.contains(r.startContainer) ? r : null);
          this.caretAfter(fig);
          fig.scrollIntoView({ block: "nearest" });
        });
        return;
      }
      // Capture d'ecran (Win+Maj+S) : une image seule, posee au curseur.
      // Un copier depuis Word amene aussi une image du passage : le texte
      // passe alors avant.
      const files = imageFiles(dt);
      if (files.length && this.images?.addFile && !dt?.getData(CLIP_TYPE) && !dt?.getData("text/plain").trim()) {
        const sel = document.getSelection();
        const r = sel?.rangeCount ? sel.getRangeAt(0) : null;
        if (r && this.root.contains(r.startContainer)) r.deleteContents();
        void this.addFiles(files, r && this.root.contains(r.startContainer) ? r.cloneRange() : null);
        return;
      }
      const internal = dt?.getData(CLIP_TYPE) || docFromHtml(dt?.getData("text/html") ?? "");
      if (internal) { this.insertTokens(parseDoc(internal)); return; }
      // Lien copie depuis la recherche (« Copier le lien ») : une puce.
      const plainText = dt?.getData("text/plain") ?? "";
      if (parseLinkMarkdown(plainText)) { this.insertTokens(parseDoc(plainText.trim())); return; }
      const plain = (dt?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      // Formules LaTeX ($…$, $$…$$, \(…\), \[…\]) : posees en formules.
      const withMath = pastedMath(plain);
      if (withMath) { this.insertTokens(withMath); return; }
      this.insertPlain(plain);
    });
  }

  /**
   * Apres une frappe de texte (insertText, ou fin de composition d'une
   * touche morte) : espace fine, `code`, symbole a deux touches, mise en
   * forme a la pause, suggestion. Vrai si la frappe est deja enregistree.
   */
  private afterTyped(data: string): boolean {
    if (this.field) return false;
    // Espace fine insecable devant : ; ? ! (hors code et formule).
    if (data && ":;?!".includes(data)) this.replaceBeforeCaret(frenchSpaceAtEnd);
    // `commande` : le texte entre les deux ` passe en chasse fixe.
    if (data === "`" && this.autoCode()) { this.emit(); return true; }
    // Symbole a deux touches remplace tout de suite ("->" -> →), puis
    // la formule se met en forme apres une courte pause de frappe.
    if (autoMath) {
      this.replaceBeforeCaret(symbolAtEnd);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        const sel = document.getSelection();
        if (this.field || this.live || !sel?.rangeCount || !this.root.contains(sel.getRangeAt(0).startContainer)) return;
        const made = this.convertLine("pause");
        if (made.length) this.lastAuto = { eqs: made, expectSpace: false, atCaret: this.madeAtCaret, pause: true };
        this.scheduleGhost();
      }, 900);
    }
    this.scheduleGhost();
    return false;
  }

  /**
   * Texte compose (touche morte) qui n'a pas pris la couleur de frappe :
   * mis dans un segment de cette couleur, comme une frappe ordinaire.
   */
  private colorComposed(data: string): void {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (!(node instanceof Text) || !this.root.contains(node) || (colorAt(node, this.root) === typingColor && sizeAt(node, this.root) === typingSize)) return;
    if (node.parentElement?.closest("code, .eq")) return;
    const off = r.startOffset;
    if (off < data.length || node.data.slice(off - data.length, off) !== data) return;
    const range = document.createRange();
    range.setStart(node, off - data.length);
    range.setEnd(node, off);
    insertColored(range, data);
  }

  /**
   * Etiquette de la couleur de frappe en marge de la ligne du curseur,
   * tant qu'elle est active : on voit que la suite sera « Théorème ».
   */
  paintColorTag(): void {
    const host = this.root.parentElement;
    const sel = document.getSelection();
    const r = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const entry = typingColor ? PALETTE.find((p) => p.key === typingColor) : undefined;
    const show = !!entry && !!host && !!r && sel!.isCollapsed && this.root.contains(r.startContainer)
      && this.root.contentEditable !== "false" && document.activeElement === this.root;
    let rect = show ? caretRect(r!, this.root) : null;
    // Page vide : la premiere ligne.
    if (show && !rect) {
      const rr = this.root.getBoundingClientRect(), cs = getComputedStyle(this.root);
      rect = new DOMRect(rr.left, rr.top + (parseFloat(cs.paddingTop) || 0), 0, parseFloat(cs.lineHeight) || 20);
    }
    if (!show || !rect || !entry || !host) { this.colorTag?.remove(); return; }
    const tag = this.colorTag ?? el("div", { class: "text-color-tag", "aria-hidden": "true" });
    this.colorTag = tag;
    tag.textContent = entry.label;
    tag.style.color = inkCssColor(entry.key);
    if (!tag.isConnected) host.append(tag);
    const hr = host.getBoundingClientRect();
    const padL = parseFloat(getComputedStyle(this.root).paddingLeft) || 0;
    tag.style.right = `${Math.round(hr.width - padL + 8)}px`;
    tag.style.top = `${Math.round(rect.top - hr.top + (rect.height - tag.offsetHeight) / 2)}px`;
  }

  /* ---------------- formule tapee derriere "/" ---------------- */

  /** Dessine la formule en cours a partir de son texte. */
  private paintLive(): void {
    const lv = this.live;
    if (!lv) return;
    const tex = liveFormula(lv.src);
    // Curseur dessine dans la formule, la ou ira la frappe suivante (case
    // vide en bleu, ou trait apres le dernier terme du denominateur) : le
    // vrai curseur, dans le texte apres la formule, est cache pendant ce temps.
    const withCaret = tex !== null ? liveCaretFormula(lv.src) : null;
    const shown = withCaret
      ?.replace("\\placeholder[caret]{}", `{\\color{${CARET_TEX_COLOR}}\\square}`)
      .replace(LIVE_CARET, `{\\color{${CARET_TEX_COLOR}}\\rule[-0.22em]{0.07em}{1.05em}}`);
    let eq: HTMLElement;
    if (tex === null) {
      eq = el("span", { class: "eq eq-raw", contenteditable: "false", dataset: { latex: "", src: lv.src } }, lv.src);
    } else {
      eq = makeEq(shown && katexHtml(shown) ? shown : tex, lv.src);
      eq.dataset.latex = tex;
      for (const c of Array.from(eq.querySelectorAll<HTMLElement>("[style*='color']"))) {
        if (c.style.color.replace(/\s/g, "") === CARET_RGB) c.classList.add("live-caret");
      }
    }
    this.root.classList.toggle("live-typing", !!eq.querySelector(".live-caret"));
    eq.classList.add("live");
    lv.eq.replaceWith(eq);
    lv.eq = eq;
  }

  /** Curseur juste apres la formule en cours, dans un texte. */
  private caretAfterLive(rest = ""): void {
    const lv = this.live;
    if (!lv) return;
    const next = lv.eq.nextSibling;
    let t: Text;
    if (next instanceof Text) {
      t = next;
      // Deja une ancre en tete : on n'en ajoute pas une seconde (touche morte).
      if (t.data.startsWith("\u200b")) t.insertData(1, rest);
      else t.insertData(0, "\u200b" + rest);
    }
    else { t = document.createTextNode("\u200b" + rest); lv.eq.after(t); }
    document.getSelection()?.collapse(t, 1 + rest.length);
  }

  /**
   * Ce qui a ete tape juste apres la formule en cours passe dedans, jusqu'a
   * ce qui la ferme : Espace, relation, virgule ou point quand le terme est
   * fini, parenthese fermante sans ouvrante. Le reste reste du texte.
   */
  private absorbLive(): void {
    const lv = this.live;
    if (!lv) return;
    const sel = document.getSelection();
    if (!lv.eq.isConnected || !sel?.rangeCount || !sel.isCollapsed) { this.endLive("pause"); return; }
    const r = sel.getRangeAt(0);
    const parent = lv.eq.parentNode!;
    const after = r.startContainer === parent
      ? r.startOffset > Array.prototype.indexOf.call(parent.childNodes, lv.eq)
      : !!(lv.eq.compareDocumentPosition(r.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) && !lv.eq.contains(r.startContainer);
    // Curseur ailleurs qu'apres la formule : on a quitte la frappe.
    if (!after) { this.endLive("pause"); return; }
    const typed = document.createRange();
    typed.setStartAfter(lv.eq);
    typed.setEnd(r.startContainer, r.startOffset);
    if (typed.cloneContents().querySelector?.(".eq, .doc-img, br, .dl")) { this.endLive("pause"); return; }
    const text = typed.toString().replace(/\u200b/g, "");
    if (!text) return;
    const split = liveSplit(lv.src, text);
    lv.src = split.src;
    typed.deleteContents();
    const rest = split.rest;
    this.paintLive();
    this.caretAfterLive(rest);
    if (rest) this.endLive("pause");
  }

  /**
   * Fin de la formule en cours : elle redevient le texte tape, relu avec la
   * ligne (`mode`, null = sans relecture : l'appelant s'en charge).
   */
  private endLive(mode: ScanMode | null): void {
    const lv = this.live;
    this.live = null;
    this.root.classList.remove("live-typing");
    if (!lv?.eq.isConnected) return;
    // « 2/p+2 » tape colle : le denominateur garde le « + » (glueDen), la relecture aussi.
    lv.src = glueDen(lv.src);
    const sel = document.getSelection();
    const r = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    // Dans le texte du curseur : la relecture le prend comme la frappe en cours.
    const next = lv.eq.nextSibling;
    if (next instanceof Text) {
      // (Le curseur, apres le \u200b de tete, suit l'insertion tout seul.)
      next.insertData(0, lv.src);
      lv.eq.remove();
    } else {
      lv.eq.replaceWith(document.createTextNode(lv.src));
      if (r && sel && r.startContainer.isConnected) { sel.removeAllRanges(); sel.addRange(r); }
    }
    if (mode && autoMath) {
      const made = this.convertLine(mode);
      if (made.length) this.lastAuto = { eqs: made, expectSpace: false, atCaret: this.madeAtCaret };
    }
    this.emit();
  }

  /** La formule en cours rendue en texte tel quel (Ctrl+Z, Retour arriere a l'ouverture). */
  private dropLive(): void {
    const lv = this.live;
    this.live = null;
    this.root.classList.remove("live-typing");
    if (!lv?.eq.isConnected) return;
    const raw = rawSpan(lv.src);
    dropAnchorAfter(lv.eq);
    lv.eq.replaceWith(raw);
    this.caretBeside(raw, true);
    this.emit();
  }

  /** Touche pendant la frappe d'une formule au "/". Vrai si elle est prise ici. */
  private liveKey(e: KeyboardEvent): boolean {
    const lv = this.live!;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process"].includes(e.key)) return true;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === "Backspace" && !mod) {
      e.preventDefault();
      if (lv.src === lv.base) { this.dropLive(); return true; }
      lv.src = lv.src.slice(0, -1);
      this.paintLive();
      this.caretAfterLive();
      this.emit();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      this.dropLive();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.endLive("pause");
      return true;
    }
    // Espace : sort de la fraction si le terme est fini (la relecture de
    // l'Espace suit), sinon il s'y ecrit ("1/(1 + x)").
    if (e.key === " " && !mod) {
      if (liveComplete(lv.src)) { this.endLive(null); return false; }
      return true;
    }
    if (e.key === "Enter") { this.endLive(null); return false; }
    // Caractere tape : il arrive par input et prolonge la formule.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) return true;
    this.endLive("pause");
    return false;
  }

  /* ---------------- contenu ---------------- */

  get content(): string { return serializeDoc(this.read()); }

  setContent(content: string): void {
    this.hideGhost();
    if (this.root.isConnected && content === this.content) return;
    this.field = null;
    this.fieldOrigin = null;
    this.live = null;
    this.lastAuto = null;
    this.lastLine = null;
    this.root.replaceChildren();
    const tokens = parseDoc(content);
    this.root.append(this.buildNodes(tokens));
    this.leadAnchors();
    // Sans <br> final, une derniere ligne vide ne s'affiche pas.
    if (tokens[tokens.length - 1]?.kind === "br") this.root.append(el("br"));
    this.renumber(tokens);
    this.checkLinks();
  }

  /** Noeuds du texte pour des jetons (page entiere ou morceau colle). */
  private buildNodes(tokens: DocToken[]): DocumentFragment {
    const frag = document.createDocumentFragment();
    // Ligne mise en forme (D11) : un bloc qui contient la ligne et la
    // termine lui-meme ; le saut qui la finit n'est pas ecrit.
    let block: HTMLElement | null = null;
    let lastOut: Node | null = null;
    tokens.forEach((t, k) => {
      const into: Node = block ?? frag;
      if (t.kind === "line") {
        block = makeLine(t);
        frag.append(block);
        lastOut = block;
        return;
      }
      if (t.kind === "br") {
        if (block) { ensurePlaceholder(block); block = null; return; }
        // Saut invisible juste avant un bloc (fin d'une ligne de texte) :
        // inutile, et Suppr en fin de ligne n'aurait rien fait a l'ecran.
        if (tokens[k + 1]?.kind === "line" && lastOut && lastOut.nodeName !== "BR" && !isLine(lastOut)) return;
        lastOut = el("br");
        frag.append(lastOut);
        return;
      }
      if (t.kind === "math") {
        const eq = makeEq(t.latex);
        const colored = t.color ? colorSpan(t.color, eq) : eq;
        into.appendChild(t.size ? sizeSpan(t.size, colored) : colored);
        into.appendChild(anchor());
      } else if (t.kind === "image") {
        into.appendChild(this.makeImage(t.id));
        into.appendChild(anchor());
      } else if (t.kind === "link") {
        into.appendChild(makeLink(t));
        into.appendChild(anchor());
      } else {
        let node: Node = document.createTextNode(t.text);
        if (t.code) node = el("code", {}, node);
        if (t.italic) node = el("i", {}, node);
        if (t.bold) node = el("b", {}, node);
        if (t.color) node = colorSpan(t.color, node);
        if (t.size) node = sizeSpan(t.size, node);
        into.appendChild(node);
      }
      if (!block) lastOut = frag.lastChild;
    });
    if (block) ensurePlaceholder(block);
    return frag;
  }

  private read(): DocToken[] {
    const out = this.readNodes(this.root);
    // Le <br> de fin ajoute pour l'affichage n'est pas une ligne.
    if (out[out.length - 1]?.kind === "br") out.pop();
    return normalizeTokens(out);
  }

  /** Jetons d'un morceau de texte (la page, ou une copie de la selection). */
  private readNodes(root: Node, base: { bold: boolean; italic: boolean; color?: ColorKey } = { bold: false, italic: false }): DocToken[] {
    const out: DocToken[] = [];
    const walk = (node: Node, bold: boolean, italic: boolean, color?: ColorKey, code = false) => {
      // Dernier <br> d'un bloc de ligne : il la garde visible quand elle est vide.
      const placeholder = isLine(node) ? lastContent(node) : null;
      for (const child of Array.from(node.childNodes)) {
        if (child === placeholder && child.nodeName === "BR") continue;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = (child.textContent ?? "").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
          out.push({ kind: "text", text, bold, italic, color, ...(code ? { code } : {}), ...sizeProp(child, root) });
          continue;
        }
        if (child instanceof MathfieldElement) {
          out.push({ kind: "math", latex: child.getValue("latex"), color });
          continue;
        }
        if (!(child instanceof HTMLElement)) continue;
        if (child.classList.contains("doc-img")) {
          out.push({ kind: "image", id: child.dataset.id ?? "" });
          continue;
        }
        if (child.classList.contains("doc-link")) {
          const d = child.dataset;
          if (d.href) out.push({ kind: "link", label: d.label ?? child.textContent ?? "", href: d.href, ...(d.hint ? { hint: d.hint } : {}) });
          continue;
        }
        // Formule en cours de frappe au "/" : enregistree telle que tapee.
        if (child.classList.contains("eq") && child.classList.contains("live")) {
          out.push({ kind: "text", text: child.dataset.src ?? "", bold, italic, color });
          continue;
        }
        if (child.classList.contains("eq")) {
          out.push({ kind: "math", latex: child.dataset.latex ?? "", color, ...sizeProp(child, root) });
          continue;
        }
        if (child.classList.contains("tc")) {
          const c = child.dataset.c;
          walk(child, bold, italic, c && c !== "none" ? c as ColorKey : undefined, code);
          continue;
        }
        if (isLine(child)) {
          // Titre, puce ou numero : sa propre ligne, finie par le bloc.
          if (!endsLine(out)) out.push({ kind: "br" });
          out.push({ kind: "line", ...lineFormatOfEl(child as HTMLElement) });
          walk(child, bold, italic, color, code);
          out.push({ kind: "br" });
          continue;
        }
        const tag = child.tagName;
        if (tag === "BR") { out.push({ kind: "br" }); continue; }
        // Chrome cree parfois des <div> par ligne : chacun commence une ligne.
        const block = tag === "DIV" || tag === "P";
        if (block && out.length && out[out.length - 1].kind !== "br") out.push({ kind: "br" });
        const b = bold || tag === "B" || tag === "STRONG" || Number(child.style.fontWeight) >= 600;
        const i = italic || tag === "I" || tag === "EM" || child.style.fontStyle === "italic";
        walk(child, b, i, color, code || tag === "CODE");
      }
    };
    walk(root, base.bold, base.italic, base.color);
    return out;
  }

  /* ---------------- presse-papiers ---------------- */

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (this.field || !e.clipboardData) return;
    const sel = document.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.commonAncestorContainer)) return;
    // Selection dans un gras ou une couleur : le morceau les garde.
    const tokens = normalizeTokens(this.readNodes(range.cloneContents(), styleAt(range.commonAncestorContainer, this.root)));
    if (!tokens.length) return;
    e.preventDefault();
    const doc = serializeDoc(tokens);
    // Ailleurs (messagerie, Bloc-notes) : formules relues comme on les tape,
    // « (3+5)/2 » plutot que du LaTeX.
    const plain = docClipboardText(tokens, texToPlain);
    e.clipboardData.setData("text/plain", plain);
    e.clipboardData.setData(CLIP_TYPE, doc);
    // HTML : formules en MathML (Word les colle en vraies equations), et
    // copie de secours du morceau dans data-cahiers si le type interne se perd.
    e.clipboardData.setData("text/html", clipboardHtml(tokens, doc));
    if (cut) {
      // Par l'editeur du navigateur : Ctrl+Z rend le morceau coupe.
      if (!document.execCommand("delete")) range.deleteContents();
      this.emit();
    }
  }

  /** Colle un morceau copie dans le cahier : formules, gras et couleurs compris. */
  private insertTokens(tokens: DocToken[]): void {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return;
    // Une photo d'une autre page n'existe pas ici : on ne colle pas un trou.
    // Dans un titre ou une puce, les lignes collees restent du texte.
    const inLine = !!closestLine(range.startContainer, this.root);
    const usable = tokens.filter((t) => (t.kind !== "image" || this.canPlace(t.id)) && !(inLine && t.kind === "line"));
    if (!usable.length) return;
    this.lastAuto = null;
    range.deleteContents();
    const frag = this.buildNodes(usable);
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last?.nodeType === Node.TEXT_NODE) {
      const r = document.createRange();
      r.setStart(last, (last.textContent ?? "").length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else if (last) {
      // Apres un gras ou une couleur colles : la frappe suivante reprend en
      // texte normal, dans une ancre a elle.
      const a = anchor();
      last.parentNode?.insertBefore(a, last.nextSibling);
      sel.collapse(a, 1);
    }
    this.tidyLines();
    this.emit();
  }

  /** Colle du texte brut, une ligne apres l'autre (jamais de <div>). */
  private insertPlain(text: string): void {
    this.quiet = true;
    try {
      text.split("\n").forEach((line, i) => {
        if (i) document.execCommand("insertLineBreak");
        if (line) this.insertTextAtCaret(line);
      });
    } finally {
      this.quiet = false;
    }
    this.lastAuto = null;
    this.tidyLines();
    this.emit();
  }

  /** Tape `text` au curseur, dans la couleur choisie, annulable par Ctrl+Z. */
  private insertTextAtCaret(text: string): void {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return;
    if (colorAt(range.startContainer, this.root) === typingColor && sizeAt(range.startContainer, this.root) === typingSize
      && document.execCommand("insertText", false, text)) return;
    insertColored(range, text);
  }

  private emit(): void {
    this.leadAnchors();
    const tokens = this.read();
    this.renumber(tokens);
    this.onChange(serializeDoc(tokens));
  }

  /** Rien d'ecrit entre le curseur et la fin de sa ligne (ancres ignorees). */
  private lineEndsAtCaret(): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return true;
    const r = sel.getRangeAt(0);
    let n: Node | null = r.startContainer;
    if (n.nodeType === Node.TEXT_NODE) {
      const after = (n.textContent ?? "").slice(r.startOffset).split("\n");
      if (after[0].replace(/\u200b/g, "")) return false;
      if (after.length > 1) return true;
    } else {
      n = n.childNodes[r.startOffset] ?? null;
      if (n && n.nodeName !== "BR" && (n.textContent ?? "").replace(/\u200b/g, "")) return false;
    }
    for (let m = n?.nextSibling ?? null; m; m = m.nextSibling) {
      if (m.nodeName === "BR" || isLine(m)) return true;
      if (m.nodeType === Node.TEXT_NODE && /\n/.test(m.textContent ?? "")) return !(m.textContent ?? "").split("\n")[0].replace(/\u200b/g, "");
      if ((m.textContent ?? "").replace(/\u200b/g, "") || (m instanceof HTMLElement && m.classList.contains("eq"))) return false;
    }
    return true;
  }

  /**
   * Ancre devant toute formule qui n'a pas de texte juste avant (debut de
   * ligne, apres un saut, une photo ou une autre formule) : sans elle, Debut,
   * ↑/↓ et Fin n'ont pas de place avant la formule, le curseur entrait dans
   * le KaTeX (frappe perdue) ou passait derriere. Les plages de la
   * selection suivent l'insertion d'elles-memes.
   */
  private leadAnchors(): void {
    for (const eq of Array.from(this.root.querySelectorAll<HTMLElement>(".eq"))) {
      if (eq.parentElement?.closest(".eq")) continue;
      const prev = eq.previousSibling;
      const bare = !prev
        || prev.nodeName === "BR"
        // Saut tape (Entree = "\n" dans le texte) juste avant : debut de ligne aussi.
        || (prev instanceof Text && prev.data.endsWith("\n"))
        || (prev instanceof HTMLElement && (prev.classList.contains("eq") || prev.classList.contains("doc-img") || isLine(prev)));
      if (bare) eq.before(anchor());
    }
  }

  /* ---------------- curseur ---------------- */

  /** Met le curseur la ou il etait, ou a la fin du texte. */
  focus(): void {
    if (this.field) { this.field.focus(); return; }
    this.root.focus({ preventScroll: true });
    const sel = document.getSelection();
    if (!sel) return;
    if (this.savedRange && this.root.contains(this.savedRange.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
      return;
    }
    const r = document.createRange();
    r.selectNodeContents(this.root);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** Curseur juste avant ou juste apres un noeud du texte. */
  private caretBeside(node: Node, after: boolean): void {
    const r = document.createRange();
    const next = node.nextSibling;
    if (after && next?.nodeType === Node.TEXT_NODE) {
      r.setStart(next, (next.textContent ?? "").startsWith("\u200b") ? 1 : 0);
    } else if (after) {
      const a = anchor();
      node.parentNode?.insertBefore(a, next);
      r.setStart(a, 1);
    } else {
      r.setStartBefore(node);
    }
    r.collapse(true);
    this.root.focus({ preventScroll: true });
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    this.savedRange = r.cloneRange();
  }

  /** Colore le texte selectionne dans ce document, s'il y en a. */
  colorSelection(color: ColorKey | null): void {
    if (this.field) return;
    const sel = document.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.commonAncestorContainer)) return;
    const frag = range.extractContents();
    // Les anciennes couleurs de la selection s'effacent devant la nouvelle.
    frag.querySelectorAll(".tc").forEach((c) => c.replaceWith(...Array.from(c.childNodes)));
    const span = colorSpan(color, frag);
    range.insertNode(span);
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.addRange(r);
    this.emit();
  }

  /** Taille du texte selectionne (points facon Word), s'il y en a. */
  sizeSelection(size: number): void {
    if (this.field) return;
    const sel = document.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.commonAncestorContainer)) return;
    const frag = range.extractContents();
    frag.querySelectorAll(".tz").forEach((c) => c.replaceWith(...Array.from(c.childNodes)));
    const span = sizeSpan(size, frag);
    range.insertNode(span);
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.addRange(r);
    this.emit();
  }

  /* ---------------- liens (core/links.ts) ---------------- */

  /**
   * Deuxieme "[" tape juste apres un "[" : le premier est retire et le
   * selecteur s'ouvre au curseur. Vrai si c'est le cas.
   */
  private openPicker(): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed || !this.links) return false;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !this.root.contains(node)) return false;
    const before = (node.textContent ?? "").slice(0, r.startOffset);
    if (!before.endsWith("[")) return false;
    // Retire le premier "[" (annulable comme une frappe).
    const del = document.createRange();
    del.setStart(node, r.startOffset - 1);
    del.setEnd(node, r.startOffset);
    sel.removeAllRanges();
    sel.addRange(del);
    this.quiet = true;
    try { if (!document.execCommand("delete")) del.deleteContents(); } finally { this.quiet = false; }
    const at = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    if (!at) return true;
    const rect = caretRect(at, this.root);
    const links = this.links;
    void pickLink(rect, links.candidates, links.pageId?.()).then((res) => {
      this.root.focus({ preventScroll: true });
      const s = document.getSelection();
      if (s && this.root.contains(at.startContainer)) { s.removeAllRanges(); s.addRange(at); }
      if (res.kind === "pick") {
        const c = res.candidate;
        this.insertLink({ label: c.label, href: linkUrl(c.ref), hint: cleanHint(pagePathOf(c.spot)) });
      } else if (res.kind === "back") {
        this.insertTextAtCaret("[");
        this.emit();
      } else {
        this.insertTextAtCaret("[[" + res.typed);
        this.emit();
      }
    });
    return true;
  }

  /** Pose un lien au curseur (selecteur `[[`). */
  insertLink(link: DocLinkRef): void {
    this.insertTokens([{ kind: "link", label: link.label, href: link.href, ...(link.hint ? { hint: link.hint } : {}) }]);
    this.checkLinks();
  }

  /** Lien colle au curseur (juste avant ou juste apres), s'il y en a un. */
  private linkAtCaret(): HTMLElement | null {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.startContainer)) return null;
    for (const forward of [false, true]) {
      const n = neighbour(r, forward);
      if (n instanceof HTMLElement && n.classList.contains("doc-link")) return n;
    }
    return null;
  }

  private refOf(link: HTMLElement): DocLinkRef {
    const d = link.dataset;
    return { href: d.href ?? "", label: d.label ?? link.textContent ?? "", ...(d.hint ? { hint: d.hint } : {}) };
  }

  private followLink(link: HTMLElement): void {
    if (!this.links || !link.dataset.href) return;
    this.links.follow(this.refOf(link));
  }

  /**
   * Stylet ou doigt sur un lien : un appui sans glisser le suit. Le stylet
   * n'ecrit pas (l'evenement ne va pas a l'encre) ; le doigt garde le
   * defilement (PageView le recoit toujours).
   */
  private onLinkDown(e: PointerEvent): void {
    const link = (e.target as HTMLElement).closest?.(".doc-link");
    if (!(link instanceof HTMLElement) || !this.root.contains(link)) return;
    // Souris : le clic suit le lien (ecouteur click), quel que soit l'outil.
    if (e.pointerType === "mouse") { if (e.button === 0) e.stopImmediatePropagation(); return; }
    if (e.pointerType === "pen") { e.preventDefault(); e.stopImmediatePropagation(); }
    const x0 = e.clientX, y0 = e.clientY, t0 = performance.now(), id = e.pointerId;
    const up = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      if (Math.hypot(u.clientX - x0, u.clientY - y0) < 12 && performance.now() - t0 < 700) this.followLink(link);
    };
    const cancel = (c: PointerEvent) => {
      if (c.pointerId !== id) return;
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
  }

  /** Nouveau libelle d'un lien (la cible ne change pas). */
  private async renameLink(link: HTMLElement): Promise<void> {
    const next = await askText("Lien", "Texte affiché", link.dataset.label ?? link.textContent ?? "");
    const label = next?.replace(/\s+/g, " ").trim();
    if (!label || !link.isConnected) return;
    link.dataset.label = label;
    link.querySelector(".doc-link-label")!.textContent = label;
    this.emit();
  }

  /** Grise les liens dont la page a disparu (corbeille ou introuvable). */
  private checkSeq = 0;
  checkLinks(): void {
    const check = this.links?.check;
    if (!check) return;
    const nodes = [...this.root.querySelectorAll<HTMLElement>(".doc-link")];
    if (!nodes.length) return;
    const seq = ++this.checkSeq;
    void check(nodes.map((n) => this.refOf(n))).then((states) => {
      if (seq !== this.checkSeq) return;
      nodes.forEach((n, i) => {
        const st = states[i] ?? "ok";
        n.classList.toggle("dead", st !== "ok");
        if (st === "ok") delete n.dataset.state; else n.dataset.state = st;
        n.title = st === "trash" ? "Page supprimée : toucher pour la restaurer"
          : st === "missing" ? "Page introuvable" : linkTitle(n);
      });
    }, () => undefined);
  }

  /* ---------------- photos ---------------- */

  /**
   * Photo posee dans le texte, comme une image "alignee sur le texte" de
   * Word : elle occupe sa ligne, le texte passe au-dessus et en dessous.
   * Souris et stylet : glisser la deplace, un appui la selectionne. Doigt :
   * un appui la selectionne, glisser une photo selectionnee la deplace (sinon
   * le doigt fait defiler). Selectionnee : poignee de 44 px pour la
   * retailler et mini-barre monter / descendre / supprimer.
   */
  private makeImage(id: string): HTMLElement {
    const live = this.images?.live?.(id) ?? null;
    if (live) return this.makeLive(id, live);
    const info = this.images?.lookup(id) ?? null;
    const img = el("img", { alt: "photo", draggable: "false" });
    // Huit poignees comme dans Word : coins = proportions gardees, cotes =
    // etirer en largeur ou en hauteur seulement.
    const grips = HANDLES.map((d) => el("span", {
      class: `doc-img-grip h-${d}`,
      title: d.length === 2 ? "Glisser pour agrandir ou réduire (double-clic : proportions d'origine)"
        : "Glisser pour étirer (double-clic : proportions d'origine)",
    }));
    const fig = el("span", {
      class: "doc-img", contenteditable: "false",
      dataset: { id }, title: info?.ocr ? `Texte lu : ${info.ocr}` : "Glisser pour déplacer",
    }, img, ...grips);
    fig.style.setProperty("--w", String(info?.width ?? 640));
    if (info?.height) { fig.classList.add("stretched"); fig.style.setProperty("--h", String(info.height)); }
    if (info?.side) fig.classList.add("side");
    applyPlace(fig, { align: info?.align, x: info?.x });
    if (info) {
      // Image decodee avant de la dire prete : l'export PDF mesure les
      // hauteurs apres (en Tauri, le src n'arrive qu'apres l'IPC).
      this.imgReady.set(fig, info.url.then((u) => {
        img.src = u;
        return img.decode().catch(() => undefined).then(() => fitPageHeight(fig, img));
      }).catch(() => { fig.classList.add("missing"); }));
    } else {
      fig.classList.add("missing");
    }
    fig.addEventListener("pointerdown", (e) => this.onImageDown(e, fig));
    grips.forEach((g, i) => this.photoResize(id, fig, img, g, HANDLES[i]));
    return fig;
  }

  /**
   * Poignee d'une photo, a la souris, au stylet ou au doigt. Coin : la
   * photo grandit en gardant sa forme du moment. Cote gauche/droit : seule
   * la largeur change ; haut/bas : seule la hauteur (photo etiree, comme
   * dans Word). Double-clic : proportions d'origine rendues.
   */
  private photoResize(id: string, fig: HTMLElement, img: HTMLImageElement, grip: HTMLElement, dir: Handle): void {
    grip.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!fig.classList.contains("stretched")) return;
      fig.classList.remove("stretched");
      fig.style.removeProperty("--h");
      fitPageHeight(fig, img);
      this.images?.resized(id, Number(fig.style.getPropertyValue("--w")) || 640, null);
    });
    grip.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Stylet ou doigt : poignees seulement sur une photo selectionnee
      // (appui long), sinon le stylet ecrit sur la photo (PageView).
      if (e.pointerType !== "mouse" && !fig.classList.contains("selected")) return;
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const k = Number(getComputedStyle(this.root).getPropertyValue("--k")) || 1;
      const x0 = e.clientX, y0 = e.clientY;
      // Taille affichee (une photo peut etre bornee par la largeur du texte).
      const box = img.getBoundingClientRect();
      const startW = box.width / k || Number(fig.style.getPropertyValue("--w")) || 640;
      const startH = box.height / k || startW * 0.75;
      const wasStretched = fig.classList.contains("stretched");
      const sx = dir.includes("w") ? -1 : dir.includes("e") ? 1 : 0;
      const sy = dir.includes("n") ? -1 : dir.includes("s") ? 1 : 0;
      let w = startW, h: number | undefined = wasStretched ? startH : undefined;
      const move = (m: PointerEvent) => {
        if (m.pointerId !== e.pointerId) return;
        const dx = (m.clientX - x0) / k, dy = (m.clientY - y0) / k;
        if (sx && sy) {
          // Coin : le plus grand des deux deplacements, forme gardee.
          const byX = startW + sx * dx, byY = (startH + sy * dy) * (startW / startH);
          let nw = Math.abs(byX - startW) >= Math.abs(byY - startW) ? byX : byY;
          nw = Math.max(MIN_W, Math.min(TEXT_W, nw, BLOCK_MAX_H * (startW / startH)));
          w = nw;
          h = wasStretched ? (startH * nw) / startW : undefined;
        } else if (sx) {
          w = Math.max(MIN_W, Math.min(TEXT_W, startW + sx * dx));
          h = startH;
        } else {
          w = startW;
          h = Math.max(MIN_H, Math.min(BLOCK_MAX_H, startH + sy * dy));
        }
        w = Math.round(w);
        if (h !== undefined) h = Math.round(h);
        fig.style.setProperty("--w", String(w));
        if (h === undefined) {
          fig.classList.remove("stretched");
          fig.style.removeProperty("--h");
        } else {
          fig.classList.add("stretched");
          fig.style.maxWidth = "";
          fig.style.setProperty("--h", String(h));
        }
      };
      const up = (u: PointerEvent) => {
        if (u.pointerId !== e.pointerId) return;
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        if (w === startW && h === (wasStretched ? startH : undefined)) return;
        this.images?.resized(id, w, h ?? (wasStretched ? null : undefined));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
  }

  /**
   * Bloc vivant (calcul, courbe) dans le texte : il vit comme une photo
   * (sa ligne, deplacer, monter/descendre, ✕ avec Annuler), et un appui le
   * rouvre dans la calculatrice. Une courbe se retaille, un calcul suit sa
   * formule.
   */
  private makeLive(id: string, live: { node: HTMLElement; width?: number; label: string; ready?: Promise<void> }): HTMLElement {
    const fig = el("span", {
      class: `doc-img live${live.width === undefined ? " live-fit" : ""}`, contenteditable: "false",
      dataset: { id, live: "1" }, title: `${live.label} : toucher pour modifier, glisser pour déplacer`,
    }, live.node);
    if (live.width !== undefined) {
      fig.style.setProperty("--w", String(live.width));
      const grip = el("span", { class: "doc-img-grip h-se", title: "Glisser pour retailler" });
      fig.append(grip);
      this.gripResize(id, fig, grip);
    }
    fig.addEventListener("pointerdown", (e) => this.onImageDown(e, fig));
    // L'export PDF attend aussi le trace des courbes (imagesReady).
    if (live.ready) this.imgReady.set(fig, live.ready);
    return fig;
  }

  /** Une photo ou un bloc vivant peut-il etre (re)pose ici sans doublon ? */
  private canPlace(id: string): boolean {
    if (this.images?.lookup(id)) return true;
    if (!this.images?.live?.(id)) return false;
    return !this.root.querySelector(`.doc-img[data-id="${CSS.escape(id)}"]`);
  }

  /** Appui court du stylet sur un bloc vivant (PageView) : comme un appui sans glisser. */
  tapFigure(fig: HTMLElement): void {
    if (this.root.contains(fig)) this.tapImage(fig);
  }

  /** Appui sans glisser sur une photo (selection) ou un bloc vivant (selection + calculatrice). */
  private tapImage(fig: HTMLElement): void {
    this.selectImage(fig);
    if (fig.dataset.live) this.images?.openLive?.(fig.dataset.id ?? "");
  }

  /** Retaille par le coin bas droit, a la souris, au stylet ou au doigt. */
  private gripResize(id: string, fig: HTMLElement, grip: HTMLElement): void {
    grip.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.pointerType !== "mouse" && !fig.classList.contains("selected")) return;
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const k = Number(getComputedStyle(this.root).getPropertyValue("--k")) || 1;
      const startX = e.clientX;
      const startW = Number(fig.style.getPropertyValue("--w")) || 640;
      const move = (m: PointerEvent) => {
        if (m.pointerId !== e.pointerId) return;
        const w = Math.round(Math.max(120, Math.min(TEXT_W, startW + (m.clientX - startX) / k)));
        fig.style.setProperty("--w", String(w));
      };
      const up = (u: PointerEvent) => {
        if (u.pointerId !== e.pointerId) return;
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        this.images?.resized(id, Number(fig.style.getPropertyValue("--w")));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
  }

  /** Chargement de chaque photo (src pose et image decodee). */
  private imgReady = new WeakMap<HTMLElement, Promise<void>>();
  /** Photo selectionnee (poignee visible, mini-barre). */
  private selectedImg: HTMLElement | null = null;
  /** Trait qui montre ou la photo deplacee va se poser. */
  private dropMarker: HTMLElement | null = null;

  /** Toutes les photos du texte chargees : a attendre avant de mesurer. */
  imagesReady(): Promise<void> {
    const all = Array.from(this.root.querySelectorAll<HTMLElement>(".doc-img"))
      .map((f) => this.imgReady.get(f) ?? Promise.resolve());
    return Promise.all(all).then(() => undefined);
  }

  /** Appui hors de la photo selectionnee : elle se deselectionne. */
  private onOutsideDown = (e: PointerEvent): void => {
    const fig = this.selectedImg;
    if (fig && !fig.contains(e.target as Node)) this.selectImage(null);
  };

  /** Selectionne une photo (null : aucune). */
  selectImage(fig: HTMLElement | null): void {
    const old = this.selectedImg;
    if (old === fig) return;
    if (old) {
      old.classList.remove("selected");
      old.querySelector(".doc-img-bar")?.remove();
    }
    this.selectedImg = fig;
    if (!fig) return;
    fig.classList.add("selected");
    // Le clavier suit : Suppr et Echap agissent sur la photo.
    if (!this.root.contains(document.activeElement)) this.root.focus({ preventScroll: true });
    const button = (label: string, title: string, run: () => void) => {
      const b = el("button", { type: "button", title, "aria-label": title }, label);
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); run(); });
      return b;
    };
    const id = fig.dataset.id ?? "";
    const recrop = this.images?.recrop && this.images.lookup(id)?.original
      ? button("⟲", "Redresser à nouveau (coins, noir et blanc)", () => { this.selectImage(null); this.images?.recrop?.(id); })
      : null;
    const side = this.images?.sided && !fig.dataset.live
      ? button("◧", fig.classList.contains("side")
        ? "Remettre seule sur sa ligne (C)"
        : "Mettre à côté : la photo ou le texte qui suit passe à droite (C)", () => this.asMove(() => this.toggleSide(fig)))
      : null;
    const cur = placeOf(fig).align ?? "left";
    const align = !fig.dataset.live && !fig.classList.contains("side")
      ? button(cur === "center" ? "⇔" : cur === "right" ? "⇥" : "⇤",
        `Alignée ${cur === "center" ? "au centre" : cur === "right" ? "à droite" : "à gauche"} : appuyer pour changer (← → décalent, Ctrl+X puis Ctrl+V : autre page)`,
        () => this.asMove(() => this.cycleAlign(fig)))
      : null;
    fig.append(el("span", { class: "doc-img-bar" },
      button("↑", "Monter d'une ligne", () => this.asMove(() => this.moveImage(fig, -1))),
      button("↓", "Descendre d'une ligne", () => this.asMove(() => this.moveImage(fig, 1))),
      align,
      side,
      recrop,
      button("✕", fig.dataset.live ? "Retirer ce bloc de la page" : "Retirer la photo", () => this.removeImage(fig)),
    ));
  }

  /**
   * Appui sur une photo. Le stylet sur une photo non selectionnee ecrit
   * dessus (PageView le rend au canvas ; un appui long la selectionne).
   * Le doigt sur une photo non selectionnee : un appui la selectionne, un
   * glisser fait defiler (PageView le rend au canvas). Sinon : glisser
   * deplace la photo, au relachement elle se pose a l'endroit du texte sous
   * le pointeur ; sans mouvement, elle est selectionnee.
   */
  private onImageDown(e: PointerEvent, fig: HTMLElement): void {
    if ((e.target as Element).closest?.(".doc-img-bar, .doc-img-grip")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType === "pen" && !fig.classList.contains("selected")) return;
    if (this.field || this.root.contentEditable === "false") return;
    const x0 = e.clientX, y0 = e.clientY;
    const far = (m: PointerEvent) => Math.hypot(m.clientX - x0, m.clientY - y0) > 8;
    if (e.pointerType === "touch" && !fig.classList.contains("selected")) {
      let moved = false;
      const move = (m: PointerEvent) => { if (m.pointerId === e.pointerId && far(m)) moved = true; };
      const up = (u: PointerEvent) => {
        if (u.pointerId !== e.pointerId) return;
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        if (!moved && u.type === "pointerup") this.tapImage(fig);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
      return;
    }
    e.preventDefault();
    let moving = false;
    let target: Range | null = null;
    // Glisser de cote en restant a hauteur de la photo : elle se decale sur
    // sa ligne au lieu de changer de place dans le texte.
    const band = fig.getBoundingClientRect();
    const sideways = !fig.dataset.live && !fig.classList.contains("side");
    let shift = false;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      if (!moving) {
        if (!far(m)) return;
        moving = true;
        this.selectImage(null);
        fig.classList.add("dragging");
        // Plus de cible sous le pointeur : le texte en dessous se lit.
        fig.style.pointerEvents = "none";
      }
      shift = sideways && m.clientY >= band.top && m.clientY <= band.bottom;
      if (shift) {
        fig.style.translate = `${Math.round(m.clientX - x0)}px 0`;
        target = null;
        this.showDropMarker(null);
        return;
      }
      fig.style.translate = "";
      target = this.dropRangeAt(m.clientX, m.clientY, fig);
      this.showDropMarker(target);
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      fig.style.pointerEvents = "";
      fig.style.translate = "";
      fig.classList.remove("dragging");
      this.showDropMarker(null);
      if (!moving) { if (u.type === "pointerup") this.tapImage(fig); return; }
      if (shift) {
        if (u.type === "pointerup") {
          const k = Number(getComputedStyle(this.root).getPropertyValue("--k")) || 1;
          this.asMove(() => this.nudge(fig, (u.clientX - x0) / k));
        }
        return;
      }
      if (u.type !== "pointerup" || !target) return;
      const at = target;
      this.asMove(() => this.placeImage(fig, at));
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  }

  /**
   * Position du texte sous le pointeur, hors de la photo deplacee, ramenee
   * au debut ou a la fin de la ligne (le plus proche) : une photo occupe
   * sa ligne, la poser au milieu d'un mot le couperait en deux.
   */
  private dropRangeAt(x: number, y: number, fig: HTMLElement): Range | null {
    const r = document.caretRangeFromPoint(x, y);
    if (!r || !this.root.contains(r.startContainer) || fig.contains(r.startContainer)) return null;
    const units = lineUnits(this.root).filter((u) => u.node !== fig);
    if (!units.length) { r.setStart(this.root, this.root.childNodes.length); r.collapse(true); return r; }
    // Premier element a partir du point vise (recherche dichotomique).
    const before = (u: LineUnit) => {
      const p = document.createRange();
      if (u.kind === "ch") p.setStart(u.node, u.off); else p.setStartBefore(u.node);
      return p.compareBoundaryPoints(Range.START_TO_START, r) < 0;
    };
    let lo = 0, hi = units.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (before(units[mid])) lo = mid + 1; else hi = mid; }
    const isBreak = (u: LineUnit) => u.kind === "br" || u.kind === "img" || (u.kind === "ch" && u.ch === "\n");
    let s0 = lo - 1;
    while (s0 >= 0 && !isBreak(units[s0])) s0--;
    let e0 = lo;
    while (e0 < units.length && !isBreak(units[e0])) e0++;
    const out = document.createRange();
    if (lo - (s0 + 1) <= e0 - lo) {
      if (s0 < 0) out.setStart(this.root, 0); else setAfter(out, units[s0]);
      out.collapse(true);
      liftToRoot(out, this.root, -1);
    } else {
      if (e0 >= units.length) setAfter(out, units[units.length - 1]);
      else { const u = units[e0]; if (u.kind === "ch") out.setStart(u.node, u.off); else out.setStartBefore(u.node); }
      out.collapse(true);
      liftToRoot(out, this.root, 1);
    }
    return out;
  }

  private showDropMarker(r: Range | null): void {
    if (!r) { this.dropMarker?.remove(); this.dropMarker = null; return; }
    const rect = caretRect(r, this.root);
    if (!rect) return;
    if (!this.dropMarker) {
      this.dropMarker = el("div", { class: "doc-img-drop" });
      document.body.append(this.dropMarker);
    }
    Object.assign(this.dropMarker.style, {
      left: `${Math.round(rect.left) - 1}px`, top: `${Math.round(rect.top)}px`,
      height: `${Math.max(16, Math.round(rect.height))}px`,
    });
  }

  /** Pose la photo a un endroit du texte. */
  private placeImage(fig: HTMLElement, at: Range): void {
    // Saut qui finissait la ligne de la photo : il part avec elle (la plage
    // `at` suit la suppression, elle est vivante).
    const units = lineUnits(this.root);
    const end = photoLineEnd(units, units.findIndex((u) => u.node === fig));
    end?.();
    const after = fig.nextSibling;
    at.collapse(true);
    at.insertNode(fig);
    // L'ancre laissee derriere elle part si elle n'a plus rien a ancrer.
    if (after?.nodeType === Node.TEXT_NODE && after.textContent === "\u200b" && after !== fig.nextSibling) {
      after.remove();
    }
    if (fig.nextSibling?.nodeType !== Node.TEXT_NODE) fig.after(anchor());
    this.emit();
  }

  /**
   * Monte (-1) ou descend (+1) la photo d'une ligne : elle passe avant la
   * ligne du dessus, ou apres celle du dessous. Une ligne finit par un "\n"
   * (Entree tape un saut de ligne dans le texte), un <br> (texte relu) ou
   * une photo ; une photo voisine compte pour une ligne.
   */
  private moveImage(fig: HTMLElement, dir: -1 | 1): void {
    let units = lineUnits(this.root);
    let i = units.findIndex((u) => u.node === fig);
    if (i < 0) return;
    // Le saut qui suit la photo finit sa ligne (invisible) : il part avec
    // elle, sinon une ligne vide restait a sa place (et ↓ ne passait pas
    // la ligne d'en dessous).
    const end = photoLineEnd(units, i);
    if (dir < 0 ? i === 0 : i + (end ? 2 : 1) >= units.length) return;
    if (end) {
      end();
      units = lineUnits(this.root);
      i = units.findIndex((u) => u.node === fig);
    }
    const isBreak = (u: LineUnit) => u.kind === "br" || u.kind === "img" || (u.kind === "ch" && u.ch === "\n");
    const r = document.createRange();
    if (dir < 0) {
      let j = i - 1;
      if (j < 0) return;
      if (units[j].kind === "img") {
        r.setStartBefore(units[j].node);
      } else {
        // Le saut qui termine la ligne du dessus n'est pas une ligne.
        if (isBreak(units[j])) j--;
        while (j >= 0 && !isBreak(units[j])) j--;
        if (j < 0) r.setStart(this.root, 0);
        else setAfter(r, units[j]);
      }
    } else {
      let j = i + 1;
      if (j >= units.length) return;
      while (j < units.length && !isBreak(units[j])) j++;
      if (j >= units.length) setAfter(r, units[units.length - 1]);
      else setAfter(r, units[j]);
    }
    // Jamais dans un segment colore ou gras : la photo reste au premier niveau.
    liftToRoot(r, this.root, dir);
    r.insertNode(fig);
    this.afterMove(fig);
  }

  /**
   * Photo calee a gauche (habillage « carre » de Word) : la photo ou le
   * texte qui suit passe a sa droite. Trop large pour laisser de la place,
   * elle est ramenee a une demi-ligne, et la photo suivante a ce qui reste.
   * Un second appui la rend a sa ligne, a la taille qu'elle a alors.
   */
  private toggleSide(fig: HTMLElement): void {
    const id = fig.dataset.id ?? "";
    if (!id || fig.dataset.live) return;
    const side = !fig.classList.contains("side");
    fig.classList.toggle("side", side);
    if (side) {
      const w = Number(fig.style.getPropertyValue("--w")) || 640;
      const mine = Math.min(w, Math.floor((TEXT_W - SIDE_GAP) / 2));
      if (mine !== w) this.shrinkTo(fig, mine);
      // Photo juste derriere (son ancre sautee) : elle doit tenir a cote.
      let next = fig.nextSibling;
      while (next && next.nodeType === Node.TEXT_NODE && !(next.textContent ?? "").replace(/\u200b/g, "").trim()) next = next.nextSibling;
      if (next instanceof HTMLElement && next.classList.contains("doc-img") && !next.dataset.live && !next.classList.contains("side")) {
        // 2 unites de jeu : au pixel pres, l'arrondi la renvoyait dessous.
        const room = TEXT_W - mine - SIDE_GAP - 2;
        const nw = Number(next.style.getPropertyValue("--w")) || 640;
        if (nw > room) this.shrinkTo(next, room);
      }
    }
    this.images?.sided?.(id, side);
    // Barre refaite : l'infobulle du bouton suit l'etat.
    this.selectImage(null);
    this.selectImage(fig);
    this.emit();
  }

  /** Change la place d'une photo et la rend a la page. */
  private setPlace(fig: HTMLElement, place: PhotoPlace): void {
    applyPlace(fig, place);
    this.images?.placed?.(fig.dataset.id ?? "", place);
    if (fig === this.selectedImg) { this.selectImage(null); this.selectImage(fig); }
  }

  /** Bouton d'alignement : gauche, centre, droite, gauche... */
  private cycleAlign(fig: HTMLElement): void {
    const cur = placeOf(fig).align;
    this.setPlace(fig, cur === undefined ? { align: "center" } : cur === "center" ? { align: "right" } : {});
  }

  /** Decale une photo de `dx` unites (fleches, glisser de cote), dans la largeur du texte. */
  private nudge(fig: HTMLElement, dx: number): void {
    if (fig.classList.contains("side") || fig.dataset.live) return;
    const k = Number(getComputedStyle(this.root).getPropertyValue("--k")) || 1;
    const cs = getComputedStyle(this.root);
    const left = this.root.getBoundingClientRect().left + (parseFloat(cs.paddingLeft) || 0);
    const box = fig.getBoundingClientRect();
    const max = Math.max(0, TEXT_W - box.width / k);
    const x = Math.round(Math.max(0, Math.min(max, (box.left - left) / k + dx)));
    this.setPlace(fig, x ? { x } : {});
  }

  /** Photo ramenee a `w` de large ; etiree, sa hauteur suit (meme forme). */
  private shrinkTo(fig: HTMLElement, w: number): void {
    const old = Number(fig.style.getPropertyValue("--w")) || 640;
    fig.style.setProperty("--w", String(w));
    let h: number | undefined;
    if (fig.classList.contains("stretched")) {
      h = Math.round(((Number(fig.style.getPropertyValue("--h")) || 0) * w) / old);
      fig.style.setProperty("--h", String(h));
    }
    this.images?.resized(fig.dataset.id ?? "", w, h);
  }

  /** Deplacement explicite d'une photo : la page fait suivre l'encre posee dessus (DocImages.moving). */
  private asMove(run: () => void): void {
    const moving = this.images?.moving;
    if (moving) moving(run); else run();
  }

  private afterMove(fig: HTMLElement): void {
    // Ancres orphelines (deux ancres de suite, ancre en tete) : retirees.
    for (const c of Array.from(this.root.childNodes)) {
      if (c.nodeType !== Node.TEXT_NODE || c.textContent !== "\u200b") continue;
      const prev = c.previousSibling;
      if (!prev || (prev.nodeType === Node.TEXT_NODE && prev.textContent === "\u200b")) c.remove();
    }
    if (fig.nextSibling?.nodeType !== Node.TEXT_NODE) fig.after(anchor());
    fig.scrollIntoView({ block: "nearest" });
    this.emit();
  }

  /**
   * Ctrl+C / Ctrl+X sur une photo : gardee pour un Ctrl+V sur une autre
   * page (ou un autre cahier). Couper la retire d'ici, avec « Annuler ».
   */
  private clipImage(fig: HTMLElement, cut: boolean): void {
    const marker = this.images?.clip?.(fig.dataset.id ?? "");
    if (!marker) return;
    void navigator.clipboard?.writeText(marker).catch(() => undefined);
    if (cut) this.removeImage(fig, "Photo coupée : Ctrl+V pour la coller (autre page, autre cahier)");
    else toast("Photo copiée : Ctrl+V pour la coller (autre page, autre cahier)");
  }

  /** Retire la photo du texte, avec « Annuler » (le fichier reste dans assets/). */
  private removeImage(fig: HTMLElement, message?: string): void {
    this.selectImage(null);
    const parent = fig.parentNode;
    if (!parent) return;
    const next = fig.nextSibling;
    const anchorNode = next?.nodeType === Node.TEXT_NODE && next.textContent === "\u200b" ? next : null;
    const ref = (anchorNode ?? fig).nextSibling;
    fig.remove();
    anchorNode?.remove();
    this.emit();
    const label = fig.dataset.live ? this.images?.live?.(fig.dataset.id ?? "")?.label ?? "Bloc" : "Photo";
    const what = message ?? `${label} ${/e$/.test(label) ? "retirée" : "retiré"}`;
    toast(what, "info", 8000, {
      label: "Annuler",
      run: () => {
        if (!this.root.isConnected) return;
        if (ref && ref.parentNode === parent) parent.insertBefore(fig, ref);
        else this.root.append(fig);
        if (fig.nextSibling?.nodeType !== Node.TEXT_NODE) fig.after(anchor());
        this.emit();
      },
    });
  }

  /**
   * Images collees ou deposees : chacune enregistree puis posee a la suite
   * de la precedente, a l'endroit vise (ou au curseur).
   */
  private async addFiles(files: File[], at: Range | null): Promise<void> {
    let range = at;
    let last: HTMLElement | null = null;
    for (const f of files) {
      const id = await this.images?.addFile?.(f);
      if (!id || !this.root.isConnected) continue;
      last = this.insertImage(id, range);
      const r = document.createRange();
      r.setStartAfter(last.nextSibling ?? last);
      range = r;
    }
    // Comme dans Word : la frappe reprend sous l'image posee.
    if (last && this.root.contains(document.activeElement ?? null)) {
      const next = last.nextSibling;
      const sel = document.getSelection();
      const r = document.createRange();
      if (next?.nodeType === Node.TEXT_NODE) r.setStart(next, (next.textContent ?? "").startsWith("\u200b") ? 1 : 0);
      else r.setStartAfter(last);
      r.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }

  /**
   * Bloc d'une photo modifie (OCR arrive en fond, photo redressee a
   * nouveau) : image et infobulle a jour.
   */
  refreshImage(id: string): void {
    const info = this.images?.lookup(id);
    const fig = this.root.querySelector<HTMLElement>(`.doc-img[data-id="${CSS.escape(id)}"]`);
    if (!fig || !info) return;
    fig.title = info.ocr ? `Texte lu : ${info.ocr}` : "Glisser pour déplacer";
    const img = fig.querySelector("img");
    if (!img) return;
    this.imgReady.set(fig, info.url.then((u) => {
      if (img.src === u) return;
      img.src = u;
      fig.classList.remove("missing");
      return img.decode().catch(() => undefined);
    }).catch(() => { fig.classList.add("missing"); }));
  }

  /**
   * Pose une nouvelle photo au curseur (ou a `at`), sinon a la fin du
   * texte. Rend la photo posee.
   */
  insertImage(id: string, at?: Range | null, noCaret = false): HTMLElement {
    if (this.field) this.commit(null);
    const fig = this.makeImage(id);
    const r = at ?? (noCaret ? null : this.savedRange);
    if (r && this.root.contains(r.startContainer)) {
      r.collapse(true);
      r.insertNode(fig);
    } else {
      this.root.append(fig);
    }
    // Texte vide laisse par la coupure (insertNode en fin de texte) : une
    // vraie ancre a la place, comme a la relecture du fichier. Sinon le
    // bloc suivant remontait d'une ligne jusqu'au rechargement.
    const next = fig.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE && next.textContent === "") next.remove();
    if (fig.nextSibling?.nodeType !== Node.TEXT_NODE) fig.after(anchor());
    this.emit();
    return fig;
  }

  /**
   * Le curseur de ce texte, s'il est le dernier texte ou l'on a ecrit ou
   * clique : la calculatrice y pose ses resultats. Le curseur garde survit
   * au passage dans la calculatrice (son recepteur prend la selection).
   */
  hasCaret(): boolean {
    return lastDoc === this && !!this.savedRange && this.root.contains(this.savedRange.startContainer);
  }

  /** Curseur garde apres `node` : l'envoi suivant se pose derriere, sans voler la selection. */
  private caretAfter(node: Node): void {
    const r = document.createRange();
    const next = node.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE) r.setStart(next, (next.textContent ?? "").startsWith("\u200b") ? 1 : 0);
    else r.setStartAfter(node);
    r.collapse(true);
    this.savedRange = r;
  }

  /**
   * Bloc vivant envoye par la calculatrice : au curseur (hasCaret) ou a la
   * fin du texte. Rend l'element pose.
   */
  insertLive(id: string, atCaret: boolean): HTMLElement {
    if (this.field) this.commit(null);
    if (this.live) this.endLive(null);
    const r = atCaret && this.savedRange && this.root.contains(this.savedRange.startContainer) ? this.savedRange.cloneRange() : null;
    if (r) liftToRoot(r, this.root, 1);
    const fig = this.insertImage(id, r ?? undefined, true);
    this.caretAfter(fig);
    return fig;
  }

  /**
   * Resultat de la calculatrice en formule du texte (KaTeX, editable comme
   * les autres) : au curseur, sinon sur une nouvelle ligne a la fin.
   * La selection du document n'est pas touchee (la calculatrice armee la
   * garde dans son recepteur), seul le curseur garde avance.
   */
  insertFormula(latex: string, atCaret: boolean): HTMLElement {
    if (this.field) this.commit(null);
    if (this.live) this.endLive(null);
    this.lastAuto = null;
    const eq = makeEq(latex);
    const r = atCaret && this.savedRange && this.root.contains(this.savedRange.startContainer) ? this.savedRange.cloneRange() : null;
    if (r) {
      r.deleteContents();
      r.collapse(true);
      // Un espace avant si la formule suit un mot.
      const prev = r.startContainer.nodeType === Node.TEXT_NODE ? (r.startContainer.textContent ?? "").slice(0, r.startOffset) : "";
      r.insertNode(eq);
      if (/\S$/.test(prev.replace(/\u200b/g, ""))) eq.before(document.createTextNode(" "));
    } else {
      const last = this.root.lastChild;
      // Derriere une photo, un calcul ou une courbe : la ligne de son ancre
      // est deja une ligne neuve.
      const prev = last?.previousSibling;
      const afterBlock = last?.nodeType === Node.TEXT_NODE && !(last.textContent ?? "").replace(/\u200b/g, "")
        && prev instanceof HTMLElement && prev.classList.contains("doc-img");
      if (last && last.nodeName === "BR") last.before(eq);
      else if (afterBlock) last!.after(eq);
      else {
        if ((this.root.textContent ?? "").replace(/\u200b/g, "").trim() || this.root.querySelector(".eq, .doc-img")) this.root.append(el("br"));
        this.root.append(eq);
      }
    }
    if (eq.nextSibling?.nodeType !== Node.TEXT_NODE) eq.after(anchor());
    this.caretAfter(eq);
    this.emit();
    return eq;
  }

  /**
   * Morceau au format de la page (phrases, $formules$, sauts de ligne) pose
   * sur des lignes neuves : sous la ligne du curseur, sinon a la fin.
   */
  insertDoc(md: string, atCaret: boolean): void {
    if (this.field) this.commit(null);
    if (this.live) this.endLive(null);
    this.lastAuto = null;
    const frag = this.buildNodes(parseDoc(md));
    const tail = anchor();
    const r = atCaret && this.savedRange && this.root.contains(this.savedRange.startContainer) ? this.savedRange.cloneRange() : null;
    if (r) {
      r.collapse(true);
      r.insertNode(tail);
      r.insertNode(frag);
      r.insertNode(el("br"));
    } else {
      if ((this.root.textContent ?? "").replace(/\u200b/g, "").trim() || this.root.querySelector(".eq, .doc-img")) this.root.append(el("br"));
      this.root.append(frag, tail);
    }
    this.caretAfter(tail);
    this.emit();
  }

  /**
   * Descend un element pose en fin de texte sous `clientY` (bas de l'encre) :
   * des sauts de ligne avant lui, pour ne jamais le poser sur l'ecriture.
   */
  pushBelow(node: HTMLElement, clientY: number): void {
    let n = 0;
    while (n < 80 && node.isConnected && node.getBoundingClientRect().top < clientY) {
      node.before(el("br"));
      n++;
    }
    if (n) this.emit();
  }

  /* ---------------- curseur et encre (mise en page, textlayout.ts) ---------------- */

  /** Curseur de ce texte : la selection si elle y est, sinon le curseur garde. */
  private caretRange(end = true): Range | null {
    const sel = document.getSelection();
    const live = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const r = live && this.root.contains(live.startContainer) ? live.cloneRange()
      : this.savedRange && this.root.contains(this.savedRange.startContainer) ? this.savedRange.cloneRange()
      : null;
    r?.collapse(!end);
    return r;
  }

  /**
   * Ligne du curseur a l'ecran (son centre est celui de la ligne). `end` :
   * fin de la selection (ce qui suit bouge si le texte grandit).
   */
  caretRow(end = true): { top: number; bottom: number } | null {
    if (this.field && this.root.contains(this.field)) {
      const f = this.field.getBoundingClientRect();
      return { top: f.top, bottom: f.bottom };
    }
    const r = this.caretRange(end);
    const rect = r ? rowRect(r, this.root) : null;
    return rect ? { top: rect.top, bottom: rect.bottom } : null;
  }

  /** La ligne du curseur est-elle vide (rien a gauche ni a droite) ? */
  caretLineEmpty(): boolean {
    if (this.field) return false;
    const sel = document.getSelection();
    if (sel?.rangeCount && !sel.isCollapsed && this.root.contains(sel.anchorNode)) return false;
    const r = this.caretRange();
    if (!r) return false;
    const box: Node = closestLine(r.startContainer, this.root) ?? this.root;
    if (!isEmptyRange(lineStart(box, r))) return false;
    return isEmptyRange(restOfLine(box, r));
  }

  /**
   * Ligne vide posee sur de l'encre : des sauts de ligne avant le curseur
   * jusqu'a ce que sa ligne soit centree a `clientY` ou plus bas (sous
   * l'encre). Rend le nombre de lignes ajoutees.
   */
  padBeforeCaret(clientY: number): number {
    const r = this.caretRange();
    if (!r) return 0;
    const block = closestLine(r.startContainer, this.root);
    let n = 0;
    for (; n < 400; n++) {
      const rect = rowRect(r, this.root);
      if (!rect || (rect.top + rect.bottom) / 2 >= clientY) break;
      const br = el("br");
      if (block) block.before(br);
      else {
        r.insertNode(br);
        r.setStartAfter(br);
        r.collapse(true);
      }
    }
    if (!n) return 0;
    this.setCaret(r);
    this.emit();
    return n;
  }

  /**
   * Clic sous la fin du texte (facon OneNote) : des lignes vides jusqu'a
   * cette hauteur, le curseur sur la derniere. `line` : interligne en px.
   * Rend false si le point n'est pas sous la derniere ligne.
   */
  caretBelowEnd(clientY: number, line: number): boolean {
    if (this.field) return false;
    let last = this.root.lastChild;
    while (last && isBlank(last)) last = last.previousSibling;
    let center: number | null = null;
    const r = document.createRange();
    if (!last) {
      r.setStart(this.root, 0);
      const rect = rowRect(r, this.root);
      const box = this.root.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(this.root).paddingTop) || 0;
      center = rect ? (rect.top + rect.bottom) / 2 : box.top + pad + line / 2;
    } else if (last.nodeName === "BR") {
      r.setStartBefore(last);
      const rect = rowRect(r, this.root);
      if (rect) center = (rect.top + rect.bottom) / 2;
    } else if (last.nodeType === Node.TEXT_NODE) {
      r.setStart(last, last.textContent?.length ?? 0);
      const rect = rowRect(r, this.root);
      if (rect) center = (rect.top + rect.bottom) / 2;
    } else if (last instanceof HTMLElement) {
      center = last.getBoundingClientRect().bottom - line / 2;
    }
    if (center == null) return false;
    const n = linesToReach(center, clientY, line);
    if (n <= 0) return false;
    // Derniere ligne : un <br> la finit, un dernier <br> garde la ligne vide visible.
    const ends = last?.nodeName === "BR" ? last : null;
    // Texte vide : la premiere ligne existe deja sans <br>, comme apres du texte.
    const inline = !last || (!ends && !isLine(last) && !(last instanceof HTMLElement && last.classList.contains("doc-img")));
    const count = ends ? n : inline ? n + 1 : n;
    for (let i = 0; i < count; i++) {
      const br = el("br");
      if (ends) ends.before(br);
      else this.root.append(br);
    }
    const tail = this.root.lastChild!;
    const at = document.createRange();
    at.setStartBefore(tail);
    at.collapse(true);
    this.root.focus({ preventScroll: true });
    this.setCaret(at);
    this.emit();
    return true;
  }

  /** Curseur pose (selection et curseur garde), sans defilement. */
  private setCaret(r: Range): void {
    const sel = document.getSelection();
    if (sel && (document.activeElement === this.root || this.root.contains(sel.anchorNode))) {
      sel.removeAllRanges();
      sel.addRange(r);
    }
    this.savedRange = r.cloneRange();
    lastDoc = this;
  }

  /* ---------------- pagination (core/paginate.ts, ui/pagebreak.ts) ---------------- */

  /** Une formule est ouverte (champ MathLive) : la page ne se coupe pas pendant la saisie. */
  get editingFormula(): boolean { return !!this.field; }

  /**
   * Coupe le texte au point `at` (debut d'une rangee, pagebreak.rowStart) :
   * rend la fin, au format du disque, et la retire de la page. Si le
   * curseur est dans la fin, `marker` y est pose : il suit le texte sur la
   * page suivante (takeMarker). La page est prevenue (onChange).
   */
  splitOff(at: Range, marker: string): { tail: string; caret: boolean } {
    const r = this.toEnd(at);
    let caret = false;
    const c = this.caretRange();
    if (c && this.root.contains(c.startContainer) && r.isPointInRange(c.startContainer, c.startOffset)) {
      c.insertNode(document.createTextNode(marker));
      caret = true;
    }
    const tail = this.readTail(r);
    r.deleteContents();
    this.lastAuto = null;
    this.lastLine = null;
    if (caret) this.savedRange = null;
    this.dropTrailingBreak();
    this.emit();
    return { tail, caret };
  }

  /**
   * Apres une coupe : le saut qui finissait la derniere ligne gardee ne
   * sert plus (sinon une ligne vide fantome, invisible ici, reapparaissait
   * a la reouverture). Une vraie ligne vide finale reste affichee.
   */
  private dropTrailingBreak(): void {
    const last = (): Node | null => {
      const w = document.createTreeWalker(this.root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let n: Node | null = this.root;
      while (w.lastChild()) n = w.currentNode;
      for (n = w.currentNode; n && n !== this.root; n = w.previousNode()) {
        const atom = n.parentElement?.closest(".eq, .doc-img, math-field");
        if (atom && this.root.contains(atom)) return atom;
        if (n.nodeType === Node.TEXT_NODE) {
          if ((n.textContent ?? "").replace(/\u200b/g, "")) return n;
          continue;
        }
        if (n.nodeName === "BR" || (n instanceof HTMLElement && (isLine(n) || n.matches(".eq, .doc-img, math-field")))) return n;
      }
      return null;
    };
    const n = last();
    if (n?.nodeType === Node.TEXT_NODE && (n.textContent ?? "").endsWith("\n")) (n as Text).deleteData((n as Text).length - 1, 1);
    else if (n?.nodeName === "BR" && !isLine(n.parentNode)) n.parentNode?.removeChild(n);
    const m = last();
    if ((m?.nodeType === Node.TEXT_NODE && (m.textContent ?? "").endsWith("\n"))
        || (m?.nodeName === "BR" && !isLine(m.parentNode))) this.root.append(el("br"));
  }

  /** Le curseur est-il a `at` ou plus loin dans le texte ? */
  caretFrom(at: Range): boolean {
    const c = this.caretRange();
    return !!c && this.root.contains(c.startContainer) && this.toEnd(at).isPointInRange(c.startContainer, c.startOffset);
  }

  /** Fin du texte a partir de `at`, au format du disque, sans rien retirer. */
  tailFrom(at: Range): string {
    return this.readTail(this.toEnd(at));
  }

  private toEnd(at: Range): Range {
    const r = document.createRange();
    r.setStart(at.startContainer, at.startOffset);
    r.setEnd(this.root, this.root.childNodes.length);
    return r;
  }

  private readTail(r: Range): string {
    const tokens = this.readNodes(r.cloneContents());
    // Le <br> de fin ajoute pour l'affichage n'est pas une ligne (voir read).
    if (tokens[tokens.length - 1]?.kind === "br") tokens.pop();
    return serializeDoc(normalizeTokens(tokens));
  }

  /**
   * Retire `marker` du texte (pose par splitOff sur la page d'avant) et y met
   * le curseur. Rend false s'il n'y est pas.
   */
  takeMarker(marker: string): boolean {
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const i = t.data.indexOf(marker);
      if (i < 0) continue;
      t.deleteData(i, marker.length);
      const r = document.createRange();
      r.setStart(t, i);
      r.collapse(true);
      this.root.focus({ preventScroll: true });
      this.setCaret(r);
      scrollCaretIntoView(this.root);
      return true;
    }
    return false;
  }

  /** Curseur en nombre de caracteres depuis le debut du texte (annulation d'un debordement). */
  caretOffset(): number | null {
    const c = this.caretRange();
    if (!c) return null;
    const r = document.createRange();
    r.setStart(this.root, 0);
    r.setEnd(c.startContainer, c.startOffset);
    return r.toString().length;
  }

  /** Pose le curseur a `offset` caracteres du debut (voir caretOffset). */
  setCaretOffset(offset: number): void {
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    let left = offset;
    const r = document.createRange();
    let placed = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = (n.textContent ?? "").length;
      if (left <= len) {
        // Dans une formule ou un bloc : juste apres lui.
        const atom = n.parentElement?.closest(".eq, .doc-img");
        if (atom && this.root.contains(atom) && atom !== this.root) r.setStartAfter(atom);
        else r.setStart(n, left);
        placed = true;
        break;
      }
      left -= len;
    }
    if (!placed) { r.selectNodeContents(this.root); r.collapse(false); }
    r.collapse(true);
    this.root.focus({ preventScroll: true });
    this.setCaret(r);
    scrollCaretIntoView(this.root);
  }

  /** Bloc vivant modifie (« Mettre à jour ») : redessine sur place. */
  refreshLive(id: string): boolean {
    const fig = this.root.querySelector<HTMLElement>(`.doc-img[data-id="${CSS.escape(id)}"]`);
    const live = this.images?.live?.(id);
    if (!fig || !live) return false;
    const fresh = this.makeLive(id, live);
    if (fig.classList.contains("selected")) this.selectImage(null);
    fig.replaceWith(fresh);
    return true;
  }

  /**
   * Range dans le texte une photo qui flottait par-dessus la page (ancien
   * format) : elle se place avant la ligne qui passait sous son bord haut.
   */
  adoptImage(id: string, clientX: number, clientY: number): void {
    const all = document.createRange();
    all.selectNodeContents(this.root);
    // Sous tout le texte : a la fin, pas avant la derniere ligne.
    const below = !this.root.textContent?.trim() || clientY > all.getBoundingClientRect().bottom;
    const range = below ? null : document.caretRangeFromPoint(clientX, clientY);
    const fig = this.makeImage(id);
    if (range && this.root.contains(range.startContainer)) {
      range.insertNode(fig);
    } else {
      this.root.append(fig);
    }
    if (fig.nextSibling?.nodeType !== Node.TEXT_NODE) fig.after(anchor());
  }

  /** Amene une photo a l'ecran (resultat de recherche sur son texte lu). */
  revealImage(id: string): boolean {
    const fig = this.root.querySelector<HTMLElement>(`.doc-img[data-id="${CSS.escape(id)}"]`);
    if (!fig) return false;
    fig.scrollIntoView({ block: "center" });
    fig.classList.add("flash");
    setTimeout(() => fig.classList.remove("flash"), 1800);
    return true;
  }

  /**
   * Va au premier passage qui contient un des termes cherches (deja plies,
   * voir core/text/find) : il passe au centre de l'ecran, surligne un
   * instant, curseur a sa fin. Le texte est plie comme dans l'index de
   * recherche, formules relues en texte : "vbe" retrouve V_{be}.
   */
  revealText(terms: string[]): boolean {
    if (!terms.length || this.field) return false;
    let folded = "";
    const at: Spot[] = [];
    const push = (s: string, spot: Spot) => {
      for (const ch of s) {
        const f = foldChar(ch);
        // Blancs resserres, comme fold() : sinon une phrase a cheval sur
        // deux espaces ne serait pas retrouvee.
        if (f === " " && skipBlank(folded)) continue;
        // Pas de blanc devant un operateur, comme fold() ("R1 + R2" = "R1+R2").
        if (FOLD_OPS.has(f[0]) && folded.endsWith(" ")) { folded = folded.slice(0, -1); at.pop(); }
        for (const c of f) { folded += c; at.push(spot); }
      }
    };
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent ?? "";
          let i = 0;
          for (const ch of text) {
            push(ch, { node: child as Text, offset: i, len: ch.length });
            i += ch.length;
          }
          continue;
        }
        if (!(child instanceof HTMLElement)) continue;
        // Formule relue sans blanc autour, comme dans l'index : "d'$O_{hm}$" donne "d'Ohm".
        if (child.classList.contains("eq")) { push(texToPlain(child.dataset.latex ?? ""), { el: child }); continue; }
        if (child.tagName === "BR" || child.classList.contains("doc-img")) { push(" ", { el: child }); continue; }
        walk(child);
      }
    };
    walk(this.root);
    const first = occurrences(folded, terms)[0];
    if (!first) return false;
    const a = at[first[0]], b = at[first[1] - 1];
    const range = document.createRange();
    if ("node" in a) range.setStart(a.node, a.offset); else range.setStartBefore(a.el);
    if ("node" in b) range.setEnd(b.node, b.offset + b.len); else range.setEndAfter(b.el);

    // Curseur a la fin du passage : on peut completer aussitot.
    const caret = range.cloneRange();
    caret.collapse(false);
    this.root.focus({ preventScroll: true });
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(caret);
    this.savedRange = caret.cloneRange();

    scrollToCenter(this.root, range.getBoundingClientRect());
    // Surlignage temporaire, sans toucher au texte (CSS Custom Highlight,
    // present dans WebView2). Une formule trouvee clignote en plus.
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (registry && HighlightCtor) {
      const mark = new HighlightCtor(range);
      registry.set(FOUND_HIGHLIGHT, mark);
      // Seulement le sien : un second resultat ouvert entre-temps garde le sien.
      setTimeout(() => { if (registry.get(FOUND_HIGHLIGHT) === mark) registry.delete(FOUND_HIGHLIGHT); }, 2600);
    }
    for (const eq of this.root.querySelectorAll<HTMLElement>(".eq")) {
      if (!range.intersectsNode(eq)) continue;
      eq.classList.add("flash");
      setTimeout(() => eq.classList.remove("flash"), 2600);
    }
    return true;
  }

  /**
   * Le curseur (ou la fin de la selection) : sa ligne a l'ecran et le texte
   * qui l'entoure, formules relues. Sert au repere « pas compris », pose a
   * la hauteur de la ligne qu'on ecrit. null s'il n'y a pas de curseur ici.
   */
  caretSpot(): { top: number; bottom: number; before: string; after: string } | null {
    // Formule en cours d'edition : le texte de part et d'autre, et la
    // formule elle-meme au milieu. Jamais de copie du champ MathLive (le
    // cloner construirait un second champ, non monte).
    const mf = this.field;
    if (mf && this.root.contains(mf)) {
      const rect = mf.getBoundingClientRect();
      const head = document.createRange();
      head.setStart(this.root, 0);
      head.setEndBefore(mf);
      const tail = document.createRange();
      tail.setStartAfter(mf);
      tail.setEnd(this.root, this.root.childNodes.length);
      return {
        top: rect.top, bottom: rect.bottom,
        before: plainOf(this.readNodes(head.cloneContents())) + texToPlain(mf.getValue("latex")),
        after: plainOf(this.readNodes(tail.cloneContents())),
      };
    }
    const sel = document.getSelection();
    const live = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const caret = live && this.root.contains(live.startContainer) ? live.cloneRange()
      : this.savedRange && this.root.contains(this.savedRange.startContainer) ? this.savedRange.cloneRange()
      : null;
    if (!caret) return null;
    caret.collapse(false);
    const rect = caretRect(caret, this.root);
    if (!rect) return null;
    const head = document.createRange();
    head.setStart(this.root, 0);
    head.setEnd(caret.endContainer, caret.endOffset);
    const tail = document.createRange();
    tail.setStart(caret.endContainer, caret.endOffset);
    tail.setEnd(this.root, this.root.childNodes.length);
    return {
      top: rect.top, bottom: rect.bottom,
      before: plainOf(this.readNodes(head.cloneContents())),
      after: plainOf(this.readNodes(tail.cloneContents())),
    };
  }

  /**
   * La ligne de texte tape a une hauteur de l'ecran (repere pose apres un
   * trait d'encre) : son texte, ou null s'il n'y a pas de texte a cette
   * hauteur.
   */
  textLineAt(clientX: number, clientY: number): string | null {
    if (this.field) return null; // formule ouverte : pas de copie du champ
    const r = document.caretRangeFromPoint(clientX, clientY);
    if (!r || !this.root.contains(r.startContainer)) return null;
    const rect = caretRect(r, this.root);
    if (!rect || clientY < rect.top - 6 || clientY > rect.bottom + 6) return null;
    const head = document.createRange();
    head.setStart(this.root, 0);
    head.setEnd(r.startContainer, r.startOffset);
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(this.root, this.root.childNodes.length);
    const before = plainOf(this.readNodes(head.cloneContents()));
    const after = plainOf(this.readNodes(tail.cloneContents()));
    const line = (before.slice(before.lastIndexOf("\n") + 1) + after.split("\n")[0]).trim();
    return line || null;
  }

  /* ---------------- formules ---------------- */

  /** Formule en cours d'edition, s'il y en a une. */
  get activeField(): MathfieldElement | null { return this.field; }

  /**
   * Rend une formule figee editable. `at` : ou poser le curseur dedans.
   * `template` : LaTeX MathLive a inserer aussitot (#? = case a remplir).
   */
  private editEq(eq: HTMLElement, at: "start" | "end" | { x: number; y: number }, template = ""): void {
    if (editingDoc && editingDoc !== this) editingDoc.commit(null);
    if (this.field) this.commit(null);
    this.lastAuto = null;

    const mf = new MathfieldElement();
    mf.mathVirtualKeyboardPolicy = "manual";
    // Pas de fermeture automatique : [a,+∞[ s'ecrit tel quel en France.
    mf.smartFence = false;
    mf.value = eq.dataset.latex ?? "";
    eq.replaceWith(mf);
    // Reglages a poser une fois le champ dans la page (sinon MathLive leve
    // "Mathfield not mounted"). La barre d'espace fait un vrai espace.
    mf.mathModeSpace = "\\;";
    // "e^23" : sans cela MathLive sort de l'exposant apres le premier chiffre (e^2 3).
    mf.smartSuperscript = false;
    // Les Alt+lettre sont a l'appli (Alt+P puissance, Alt+V vecteur...).
    mf.keybindings = mf.keybindings.filter((k) => !appAltKey(k.key));
    // Raccourcis en minuscules seulement : "PI" reste P fois I.
    mf.inlineShortcuts = { ...mf.inlineShortcuts, ...FIELD_SHORTCUTS };
    this.field = mf;
    this.fieldOrigin = template ? null : { latex: eq.dataset.latex ?? "", src: eq.dataset.src, value: mf.getValue("latex").trim() };
    editingDoc = this;
    lastDoc = this;

    this.pendingSlash = false;
    mf.addEventListener("input", (e) => {
      e.stopPropagation();
      if (this.pendingSlash) {
        this.pendingSlash = false;
        const frac = slashFracAt(mf);
        if (frac) this.slashFracs.add(frac);
      }
      // "int" tape : la borne basse d'abord, comme on lit « de 0 a t ».
      lowerBoundFirst(mf);
      this.emit();
    });
    mf.addEventListener("keydown", (e) => this.onFieldKey(e, mf), { capture: true });
    // Fleche au bord de la formule : on ressort dans le texte.
    mf.addEventListener("move-out", (e) => {
      const dir = (e as CustomEvent<{ direction: string }>).detail.direction;
      if (dir === "forward" || dir === "backward") {
        e.preventDefault();
        this.commit(dir === "forward");
      }
    });
    mf.addEventListener("focusout", () => {
      // Clic ailleurs : la formule se fige. Les boutons du ruban ne prennent
      // pas le focus, ils ne declenchent donc pas cette sortie.
      setTimeout(() => {
        if (this.field === mf && document.activeElement !== mf) this.commit(null);
      }, 0);
    });

    mf.focus();
    // Donne tout de suite le clavier a la zone de saisie interne, sans
    // attendre les 60 ms de MathLive : les premieres frappes y arrivent.
    (mf.shadowRoot?.querySelector("[part=keyboard-sink]") as HTMLElement | null)?.focus();
    waiting = { mf, keys: [] };
    this.replayWhenFocused(mf);
    // Texte gele pendant l'edition, sinon les deux editeurs se battent pour
    // le clavier. Apres le focus : geler d'abord ferait perdre le focus a la
    // page et les premieres frappes avec.
    this.root.contentEditable = "false";
    if (template) {
      mf.insert(template, { selectionMode: "placeholder", focus: true });
      lowerBoundFirst(mf);
      this.emit();
    } else {
      mf.position = at === "start" ? 0 : mf.lastOffset;
      // Clic : le curseur a l'endroit vise dans la formule, pas toujours a la fin.
      if (typeof at === "object") {
        requestAnimationFrame(() => {
          if (this.field !== mf) return;
          const o = mf.getOffsetFromPoint?.(at.x, at.y);
          if (typeof o === "number" && o >= 0) mf.position = o;
        });
      }
    }
  }

  /** Rejoue les touches retenues des que MathLive a vraiment le focus. */
  private replayWhenFocused(mf: MathfieldElement, tries = 0): void {
    setTimeout(() => {
      if (waiting?.mf !== mf) return;
      if (!mf.isConnected) { waiting = null; return; }
      if (!sinkFocused(mf) && tries < 20) { this.replayWhenFocused(mf, tries + 1); return; }
      const keys = waiting.keys;
      waiting = null;
      for (const k of keys) {
        if (this.field !== mf) {
          // La formule est deja figee (Echap retenu) : la suite va au texte.
          if (k.key.length === 1) document.execCommand("insertText", false, k.key);
          continue;
        }
        if (this.fieldKey(k.key, k.shiftKey, mf)) continue;
        if (k.key.length === 1) mf.executeCommand(["typedText", k.key, { simulateKeystroke: true }]);
        else if (k.key === "Backspace") mf.executeCommand("deleteBackward");
        else if (k.key === "Tab") mf.executeCommand(k.shiftKey ? "moveToPreviousPlaceholder" : "moveToNextPlaceholder");
      }
      if (keys.length) this.emit();
    }, tries === 0 ? 70 : 30);
  }

  /**
   * Fige la formule en cours. `after` : curseur apres (true), avant (false),
   * ou laisse ou il est (null, focus parti ailleurs).
   */
  commit(after: boolean | null): HTMLElement | null {
    const mf = this.field;
    if (!mf) return null;
    this.field = null;
    if (editingDoc === this) editingDoc = null;
    const value = mf.getValue("latex").trim();
    const origin = this.fieldOrigin;
    this.fieldOrigin = null;
    this.root.contentEditable = "true";

    let eq: HTMLElement | null = null;
    // Rouverte sans changement mais mal formee (« / » laisse en barre,
    // parenthese manquante, ancienne page) : la valider la repare.
    const repair = !!origin?.latex && !origin.src && cleanMathLive(origin.latex) !== origin.latex;
    if (origin?.latex && value === origin.value && !repair) {
      // Rouverte sans changement : elle garde sa source tapee et reste
      // prolongeable par la frappe qui suit.
      eq = makeEq(origin.latex, origin.src);
    } else if (cleanMathLive(value)) {
      // Sortie MathLive relue pour KaTeX (\differentialD, cases vides),
      // puis les indices ; si KaTeX refuse le resultat, la version sans.
      const clean = cleanMathLive(value);
      eq = makeEq(firstRendered([subscriptVars(clean), clean]));
    }
    let mark: Node;
    if (eq) {
      mf.replaceWith(eq);
      mark = eq;
    } else {
      // Une formule vide ne reste pas dans le texte.
      const a = anchor();
      mf.replaceWith(a);
      mark = a;
    }
    this.emit();
    if (after !== null) this.caretBeside(mark, after);
    return eq;
  }

  private onFieldKey(e: KeyboardEvent, mf: MathfieldElement): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (this.fieldKey(e.key, e.shiftKey, mf)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Touche dans la formule en cours : vrai si elle est traitee ici. */
  private fieldKey(key: string, shift: boolean, mf: MathfieldElement): boolean {
    const value = mf.getValue("latex");
    // "sqrt(x)" puis ")" : la racine est finie, la parenthese ferme celle d'avant.
    if (key === ")" && endOfBalancedSurd(mf)) mf.executeCommand("moveAfterParent");
    // "_" ou "^" tapes a la LaTeX ("int_0^1") : deja dans la case ; "^"
    // depuis un indice passe a l'exposant du meme terme (u_n^2, borne haute).
    if (key === "_" || key === "^") {
      const a = caretAtom(mf);
      if (a?.type === "placeholder" && a.parentBranch === (key === "_" ? "subscript" : "superscript")) return true;
      if (key === "^" && a?.parentBranch === "subscript" && atBranchEnd(a)) {
        mf.executeCommand("moveToOpposite");
        return true;
      }
    }
    // Fleche droite au bout de la borne haute (remplie en dernier) : apres
    // l'integrale, pas dans la borne basse (MathLive va du haut vers le bas).
    if (key === "ArrowRight" && !shift) {
      const a = caretAtom(mf);
      if (a?.parentBranch === "superscript" && a.parent?.branch("subscript") && atBranchEnd(a)) {
        mf.executeCommand("moveAfterParent");
        return true;
      }
      // Au bout de la borne basse : la haute si elle est vide, sinon apres.
      if (a?.parent && a.parentBranch === "subscript" && a.parent.branch("superscript") && atBranchEnd(a)) {
        mf.executeCommand(blankBranch(a.parent, "superscript") ? "moveToOpposite" : "moveAfterParent");
        return true;
      }
    }
    // Exposant ou indice fini au bout d'une formule posee depuis le texte
    // (e Alt+P 23) : Espace rend la main au texte ("e^{23} suite"), fleche
    // droite sort d'un coup. Dans une formule rouverte, rien ne change.
    if (!shift && (key === " " || key === "ArrowRight") && !this.fieldOrigin
      && ((endOfScript(mf) && scriptIsLast(mf)) || (key === " " && afterLastScript(mf)))) {
      this.commit(true);
      if (key === " ") this.insertTextAtCaret(" ");
      return true;
    }
    // Espace a la fin d'un indice ou d'une borne remplis : on en sort ("int_0^1 x").
    if (key === " " && endOfScript(mf)) mf.executeCommand("moveAfterParent");
    if (key === "/") this.pendingSlash = true;
    // Une relation ou l'Espace derriere le denominateur d'une fraction
    // tapee au "/" en sort ; « + » et « - » restent en bas.
    if (DEN_EXIT.has(key) && endOfSlashDen(mf, this.slashFracs)) {
      mf.executeCommand("moveAfterParent");
      // L'Espace sert a sortir du denominateur, pas a mettre un blanc (\;) dans la formule.
      if (key === " ") return true;
    }
    if (key === ")") closeParenOutward(mf);
    // Entree : la formule se fige et on passe a la ligne, comme dans le texte.
    if (key === "Enter" && !shift) {
      // Formule rouverte au milieu d'une ligne : Entree la valide seulement,
      // sans couper la ligne (on venait la corriger).
      const reopened = !!this.fieldOrigin;
      this.commit(true);
      if (!reopened || this.lineEndsAtCaret()) this.newLine();
      return true;
    }
    // Tab : case suivante tant qu'il en reste, sinon sortie de la formule.
    const done = !value.includes("\\placeholder");
    // Bornes : la basse puis la haute, puis le corps (MathLive va de la
    // haute a la basse).
    if (key === "Tab" && !done && switchBound(mf, shift)) return true;
    if (key === "Escape" || (key === "Tab" && done)) {
      this.commit(!(key === "Tab" && shift));
      return true;
    }
    if (key === "Backspace" && !value.trim()) {
      this.commit(false);
      return true;
    }
    return false;
  }


  /**
   * Pose une formule au curseur. `template` est du LaTeX MathLive ; #@ prend
   * le mot juste avant le curseur (le numerateur d'une fraction), #? est une
   * case a remplir.
   */
  insertMath(template = ""): void {
    if (this.field) { insertInField(this.field, template); return; }
    if (this.live) this.endLive("pause");
    this.root.focus({ preventScroll: true });
    const sel = document.getSelection();
    let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !this.root.contains(range.startContainer)) {
      this.focus();
      range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (!range) return;
    }

    // Alt+= sur une selection, sur un bout redevenu texte, ou colle a ce
    // qu'on vient de taper : mis en formule par la grammaire du texte.
    if (!template && this.forceMath(range)) return;

    // Symbole seul (lettre grecque, fleche, relation) : rien a remplir. Il
    // se pose dans le texte et la frappe continue en texte, pas dans une
    // formule restee ouverte.
    if (template && !template.includes("#?") && !template.includes("#@")) {
      this.lastAuto = null;
      const char = SYMBOL_CHARS[template];
      if (char) {
        this.insertTextAtCaret(char);
      } else {
        range.deleteContents();
        const eq = makeEq(template);
        range.insertNode(eq);
        this.caretBeside(eq, true);
      }
      this.emit();
      return;
    }

    // Texte selectionne ou mot colle au curseur : il entre dans la formule.
    let taken = range.collapsed ? "" : range.toString();
    if (taken) range.deleteContents();
    else if (template.includes("#@")) {
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const before = (node.textContent ?? "").slice(0, range.startOffset).replace(/\u200b/g, "");
        taken = trailingOperand(before);
        if (taken) {
          // « alpha » tape juste avant (pas encore converti) : la lettre α.
          const greek = /^[A-Za-z]+$/.test(taken) ? greekWordAtEnd(taken) : null;
          const text = node.textContent ?? "";
          const end = range.startOffset;
          const start = text.slice(0, end).lastIndexOf(taken);
          range.setStart(node, start);
          range.setEnd(node, end);
          range.deleteContents();
          if (greek) taken = greek;
        }
      }
    }

    const eq = makeEq("");
    range.insertNode(eq);
    if (eq.nextSibling?.nodeType !== Node.TEXT_NODE) eq.after(anchor());
    const filled = template
      ? template.replace("#@", taken ? escapeTex(taken) : "#?")
      : escapeTex(taken);
    this.editEq(eq, "end", filled);
  }

  /**
   * « Ceci est une formule » (Alt+=) : la selection, le bout de texte brut
   * (`.raw`, laisse par un Ctrl+Z) touche par le curseur, ou la fin de ce
   * qu'on vient de taper (mathTail) devient une formule. Vrai si fait ;
   * sinon l'editeur s'ouvre comme avant. Ctrl+Z ou Retour arriere juste
   * apres rendent le texte (lastAuto).
   */
  private forceMath(range: Range): boolean {
    const done = (eq: HTMLElement) => {
      if (eq.nextSibling?.nodeType !== Node.TEXT_NODE) eq.after(anchor());
      this.caretBeside(eq, true);
      this.lastAuto = { eqs: [eq], expectSpace: false, atCaret: true };
      this.emit();
      return true;
    };
    if (!range.collapsed) {
      const frag = range.cloneContents();
      if (frag.querySelector("br, .doc-img, .dl, .line")) return false;
      for (const q of Array.from(frag.querySelectorAll<HTMLElement>(".eq"))) {
        q.replaceWith(q.dataset.src ?? balanceParens(texToPlain(q.dataset.latex ?? "")));
      }
      const src = (frag.textContent ?? "").replace(/\u200b/g, "");
      if (src.includes("\n")) return false;
      const latex = forceFormula(src);
      if (!latex) return false;
      range.deleteContents();
      const eq = makeEq(latex, src.trim());
      range.insertNode(eq);
      return done(eq);
    }
    // Bout de texte brut au curseur (dedans, ou juste avant lui).
    let raw: HTMLElement | null = range.startContainer.parentElement?.closest<HTMLElement>(".raw") ?? null;
    if (!raw) {
      let prev: Node | null = range.startContainer.nodeType === Node.TEXT_NODE
        ? ((range.startContainer.textContent ?? "").slice(0, range.startOffset).replace(/\u200b/g, "") ? null : range.startContainer.previousSibling)
        : range.startContainer.childNodes[range.startOffset - 1] ?? null;
      while (prev && prev.nodeType === Node.TEXT_NODE && !(prev.textContent ?? "").replace(/\u200b/g, "")) prev = prev.previousSibling;
      if (prev instanceof HTMLElement && prev.classList.contains("raw")) raw = prev;
    }
    if (raw && this.root.contains(raw)) {
      const src = (raw.textContent ?? "").replace(/\u200b/g, "");
      const latex = forceFormula(src);
      if (!latex) return false;
      const eq = makeEq(latex, src.trim());
      raw.replaceWith(eq);
      return done(eq);
    }
    // Fin de ce qu'on vient de taper, dans le noeud du curseur.
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest(".eq, code")) return false;
    const before = (node.textContent ?? "").slice(0, range.startOffset).replace(/\u200b/g, " ");
    const tail = mathTail(before);
    if (!tail) return false;
    const cut = document.createRange();
    cut.setStart(node, tail.start);
    cut.setEnd(node, range.startOffset);
    const src = before.slice(tail.start).trim();
    cut.deleteContents();
    const eq = makeEq(tail.latex, src);
    cut.insertNode(eq);
    return done(eq);
  }

  /**
   * « Ceci est du texte » (Alt+Maj+=) : la formule juste avant le curseur
   * (ou selectionnee) redevient le texte tape, que plus rien ne remet en
   * forme ; Alt+= le reconvertit. Vrai si fait.
   */
  toText(): boolean {
    if (this.field || this.live) return false;
    const sel = document.getSelection();
    if (!sel?.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.startContainer)) return false;
    let eq: HTMLElement | null = null;
    if (!r.collapsed) {
      const inside = r.cloneContents().querySelectorAll(".eq");
      if (inside.length === 1) {
        eq = Array.from(this.root.querySelectorAll<HTMLElement>(".eq")).find((q) => r.intersectsNode(q)) ?? null;
      }
    } else {
      let prev: Node | null = r.startContainer.nodeType === Node.TEXT_NODE
        ? ((r.startContainer.textContent ?? "").slice(0, r.startOffset).replace(/\u200b/g, "") ? null : r.startContainer.previousSibling)
        : r.startContainer.childNodes[r.startOffset - 1] ?? null;
      while (prev && prev.nodeType === Node.TEXT_NODE && !(prev.textContent ?? "").replace(/\u200b/g, "")) prev = prev.previousSibling;
      if (prev instanceof HTMLElement && prev.classList.contains("eq") && !prev.classList.contains("live")) eq = prev;
    }
    if (!eq) return false;
    // Formule sans source tapee (faite a l'editeur, ou relue d'un fichier) : relue en clair.
    const src = eq.dataset.src ?? balanceParens(texToPlain(eq.dataset.latex ?? ""));
    const raw = rawSpan(src);
    eq.replaceWith(raw);
    this.lastAuto = null;
    const t = raw.firstChild;
    if (t) sel.collapse(t, (t.textContent ?? "").length);
    this.emit();
    return true;
  }

  /* ---------------- clavier ---------------- */

  /**
   * Remplace la fin du texte juste avant le curseur, dans le meme noeud,
   * si `fn` propose un remplacement. Le curseur reste en fin de remplacement.
   * Le remplacement passe par la pile d'annulation du navigateur : Ctrl+Z
   * juste apres rend "->" ou "pi" tels qu'ils ont ete tapes.
   */
  private replaceBeforeCaret(fn: (before: string) => string | null): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !this.root.contains(node)) return false;
    // Dans une commande (`code`) : "->" ou "pi" restent tels quels.
    if (node.parentElement?.closest("code")) return false;
    const text = node.textContent ?? "";
    const before = text.slice(0, r.startOffset);
    const next = fn(before);
    if (next === null) return false;
    // Seule la partie qui change est retapee.
    let p = 0;
    while (p < next.length && p < before.length && next[p] === before[p]) p++;
    const range = document.createRange();
    range.setStart(node, p);
    range.setEnd(node, r.startOffset);
    sel.removeAllRanges();
    sel.addRange(range);
    this.quiet = true;
    let done = false;
    try { done = document.execCommand("insertText", false, next.slice(p)); } finally { this.quiet = false; }
    if (!done) {
      node.textContent = next + text.slice(r.startOffset);
      const caret = document.createRange();
      caret.setStart(node, next.length);
      caret.collapse(true);
      sel.removeAllRanges();
      sel.addRange(caret);
    }
    return true;
  }

  /**
   * ` qui ferme un ` tape plus tot sur la meme ligne (meme noeud de texte) :
   * le texte entre les deux devient du code (chasse fixe, jamais converti en
   * formule), les deux ` disparaissent, le curseur repart apres, hors du code.
   */
  private autoCode(): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (!(node instanceof Text) || !this.root.contains(node)) return false;
    if (node.parentElement?.closest(".eq, code")) return false;
    const text = node.data, end = r.startOffset - 1;
    if (text[end] !== "`") return false;
    const open = text.lastIndexOf("`", end - 1);
    if (open < 0 || text.slice(open, end).includes("\n")) return false;
    const inner = text.slice(open + 1, end);
    if (!inner.replace(/\u200b/g, "").trim()) return false;
    const tail = document.createTextNode("\u200b" + text.slice(end + 1));
    const code = el("code", {}, inner);
    node.data = text.slice(0, open);
    node.after(code, tail);
    sel.collapse(tail, 1);
    return true;
  }

  /** Mot grec juste avant le curseur remplace par sa lettre, et de quoi l'annuler. */
  private greekBeforeCaret(): GreekDone | null {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const before = r.startContainer.nodeType === Node.TEXT_NODE
      ? (r.startContainer.textContent ?? "").slice(0, r.startOffset) : "";
    const next = greekWordAtEnd(before);
    if (next === null || !this.replaceBeforeCaret(greekWordAtEnd)) return null;
    const after = document.getSelection()?.getRangeAt(0);
    if (!after || after.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const char = next.slice(-1);
    return { node: after.startContainer as Text, at: after.startOffset, word: before.slice(next.length - 1), char };
  }

  /**
   * Ligne en cours, du debut de ligne jusqu'au curseur, relue comme on l'a
   * tapee : les textes, et les formules converties automatiquement par leur
   * source ("Vs = Vz" converti a l'espace, puis " - Vbe"). Une formule
   * editee a la main, une photo ou un retour a la ligne arretent la relecture.
   */
  private lineAt(node: Text, offset: number): Line {
    const raw = (node.textContent ?? "").slice(0, offset);
    const nl = raw.lastIndexOf("\n");
    const cur: LineSeg = { node, kind: "cur", str: raw.slice(nl + 1).replace(/\u200b/g, ""), a: 0, b: 0, head: raw.slice(0, nl + 1) };
    const back: LineSeg[] = [];
    // La ligne commence dans ce noeud : rien a reprendre avant.
    let prev: Node | null = nl >= 0 ? null : prevInLine(node, this.root);
    while (prev) {
      if (prev.nodeType === Node.TEXT_NODE) {
        // Un "\n" tape par Entree finit la ligne precedente : on s'arrete.
        const t = prev.textContent ?? "";
        const n = t.lastIndexOf("\n");
        back.push({ node: prev, kind: "text", str: t.slice(n + 1).replace(/\u200b/g, ""), a: 0, b: 0, head: t.slice(0, n + 1) });
        if (n >= 0) break;
      } else if (prev instanceof HTMLElement && prev.classList.contains("eq") && prev.dataset.src) {
        back.push({ node: prev, kind: "eq", str: prev.dataset.src, a: 0, b: 0, head: "" });
      } else if (prev instanceof HTMLElement && prev.classList.contains("eq") && prev.dataset.latex && !prev.closest(".raw")) {
        // Formule faite a l'editeur (sans source tapee) : relue en clair, elle
        // se fond dans la formule de la ligne (« (A)/(B) » tape autour d'elle
        // devient une fraction) ; jamais redefaite en texte (`fixed`).
        const plain = balanceParens(texToPlain(prev.dataset.latex));
        if (!plain) break;
        back.push({ node: prev, kind: "eq", str: plain, a: 0, b: 0, head: "", fixed: true });
      } else if (!(prev instanceof HTMLElement && inlineWrap(prev))) {
        break;
      }
      prev = prevInLine(prev, this.root);
    }
    const segs = [...back.reverse(), cur];
    let pos = 0;
    for (const s of segs) { s.a = pos; pos += s.str.length; s.b = pos; }
    return { segs, full: segs.map((s) => s.str).join(""), curStart: cur.a };
  }

  /**
   * Formules de la ligne qu'on vient de taper, mises en forme : le texte
   * "Vs = Vz - Vbe" devient la formule V_s = V_z - V_{be}. Appele a chaque
   * espace ("space"), a chaque Entree ("final") et apres une pause de
   * frappe ("pause"). Seul le texte avant le curseur est lu.
   *
   * Une formule convertie automatiquement garde sa source tapee : si la
   * suite la prolonge ("Vs = Vz" puis " - Vbe", ou "Vs = Vz (" puis une
   * fraction puis ")"), toute la ligne est relue et ne fait qu'une formule.
   * Renvoie les formules creees.
   */
  private convertLine(mode: ScanMode = "final"): HTMLElement[] {
    // Mots de maths finis en contexte formule ("x in RR" -> x ∈ ℝ, "forall"
    // -> ∀) : le symbole, annulable par Ctrl+Z comme "->".
    if (mode !== "pause") {
      const r0 = document.getSelection()?.rangeCount ? document.getSelection()!.getRangeAt(0) : null;
      const before = r0 ? eqBeforeOnLine(r0.startContainer) : false;
      this.replaceBeforeCaret((t) => mathWordsAtEnd(t, before));
    }
    // Mot grec fini ("pi", "eps") : la lettre, meme hors formule.
    this.greekDone = mode === "pause" ? null : this.greekBeforeCaret();
    if (this.greekDone) this.emit();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return [];
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !this.root.contains(node)) return [];
    if (node.parentElement?.closest(".eq, .raw, code")) return [];
    const after = (node.textContent ?? "").slice(r.startOffset);
    // Curseur au milieu d'un mot ("Vatt" corrige en "Vbatt") : on attend.
    if (/^[\p{L}\p{N}]/u.test(after.replace(/^\u200b+/, ""))) return [];

    const line = this.lineAt(node as Text, r.startOffset);
    const plan = planLine(line.segs, mode);
    if (!plan) return [];
    const { formulas } = plan;
    const undone = plan.undone >= 0 ? line.segs[plan.undone] : null;
    this.madeAtCaret = plan.atCaret;
    return this.rebuildLine(line, formulas, undone, after, sel);
  }

  /**
   * Remplace la fin de ligne par texte + formules. Les formules deja en
   * forme qui ne bougent pas sont gardees telles quelles ; le curseur
   * revient apres ce qu'on vient de taper.
   */
  private rebuildLine(line: Line, formulas: FoundFormula[], undone: LineSeg | null, after: string, sel: Selection): HTMLElement[] {
    const { segs, full } = line;
    const cur = segs[segs.length - 1];
    const parent = cur.node.parentNode;
    if (!parent) return [];
    const start = Math.min(...formulas.map((f) => f.start), undone ? undone.a : Infinity);
    let fi = segs.findIndex((s) => s.b > start);
    if (fi < 0) fi = segs.length - 1;
    const first = segs[fi];
    const touched = segs.slice(fi);
    // Repere pose avant de deplacer quoi que ce soit.
    const marker = document.createTextNode("");
    (first.node.parentNode ?? parent).insertBefore(marker, first.node);

    const pieces: (string | Node)[] = [];
    if (first.kind !== "eq") pieces.push(first.head + first.str.slice(0, start - first.a));
    const kept = new Set<Node>();
    const gap = (from: number, to: number) => {
      for (const s of touched) {
        const a = Math.max(from, s.a), b = Math.min(to, s.b);
        if (a >= b) continue;
        if (s.kind === "eq" && s !== undone) { pieces.push(s.node); kept.add(s.node); }
        else pieces.push(full.slice(a, b));
      }
    };
    const created: HTMLElement[] = [];
    let pos = start;
    for (const f of formulas) {
      gap(pos, f.start);
      const eq = makeEq(f.latex, full.slice(f.start, f.end));
      pieces.push(eq);
      created.push(eq);
      // Formule prolongee : ses symboles d'avant sont deja comptes.
      const merged = touched.filter((s) => s.kind === "eq" && s.a >= f.start && s.b <= f.end);
      recordLatex(f.latex, merged.map((s) => (s.node as HTMLElement).dataset.latex ?? "").join(" "));
      pos = f.end;
    }
    gap(pos, full.length);

    // Le texte de fin recoit le curseur, suivi de ce qui etait apres lui.
    let tailText = "";
    while (typeof pieces[pieces.length - 1] === "string") tailText = (pieces.pop() as string) + tailText;
    const frag = document.createDocumentFragment();
    let buf = "";
    for (const p of pieces) {
      if (typeof p === "string") { buf += p; continue; }
      if (buf) { frag.append(buf); buf = ""; }
      frag.append(p);
    }
    // Toujours un texte apres la derniere formule : le curseur s'y pose.
    const tail = document.createTextNode("\u200b" + tailText + after);
    frag.append(tail);
    for (const s of touched) if (!kept.has(s.node)) s.node.parentNode?.removeChild(s.node);
    marker.parentNode!.insertBefore(frag, marker);
    marker.remove();

    const caret = document.createRange();
    caret.setStart(tail, 1 + tailText.length);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    this.emit();
    return created;
  }

  /**
   * "/" tape juste apres une expression : ouvre la formule avec la fraction
   * deja posee, numerateur rempli, curseur au denominateur. Faux si rien ne
   * peut servir de numerateur (le "/" s'ecrit alors normalement), ou si la
   * barre est celle d'une unite ou d'un sigle ("m/s", "E/S").
   */
  private slashToFraction(): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !this.root.contains(node)) return false;
    if (node.parentElement?.closest(".eq, .raw, code")) return false;
    const after = (node.textContent ?? "").slice(r.startOffset);
    if (/^[\p{L}\p{N}]/u.test(after.replace(/^\u200b+/, ""))) return false;

    const line = this.lineAt(node as Text, r.startOffset);
    const { segs, full } = line;
    // Denominateur provisoire : une variable que personne n'ecrit (un
    // sigle en majuscules ne serait pas lu comme une variable).
    const DEN = "Zqx";
    const MARK = "Z_{qx}";
    const found = findFormulas(`${full}/${DEN}`)
      .find((f) => f.end === full.length + 1 + DEN.length && f.latex.includes(MARK));
    if (!found) return false;
    // Une formule deja en forme ne se coupe pas : le numerateur la reprend en entier.
    if (segs.some((s) => s.kind === "eq" && found.start > s.a && found.start < s.b)) return false;
    const num = full.slice(found.start);
    // "28/09/2026" : une date reste du texte (un chiffre seul, "3/", fait
    // bien une fraction).
    if (/^[\d/\s]+$/.test(num) && /\d{2}/.test(num)) return false;
    if (!slashOpensFraction(num, full)) return false;

    const cur = segs[segs.length - 1];
    const parent = cur.node.parentNode;
    if (!parent) return false;
    let fi = segs.findIndex((s) => s.b > found.start);
    if (fi < 0) fi = segs.length - 1;
    const first = segs[fi];
    const touched = segs.slice(fi);
    const lead = first.kind === "eq" ? "" : first.head + first.str.slice(0, found.start - first.a);
    const marker = document.createTextNode("");
    (first.node.parentNode ?? parent).insertBefore(marker, first.node);
    for (const s of touched) s.node.parentNode?.removeChild(s.node);
    // La formule se dessine depuis le texte tape, sans editeur : le "/" et
    // la suite s'y ajoutent a chaque touche (voir absorbLive).
    const src = `${num}/`;
    const eq = el("span", { class: "eq live", contenteditable: "false" });
    if (lead) marker.parentNode!.insertBefore(document.createTextNode(lead), marker);
    marker.parentNode!.insertBefore(eq, marker);
    if (after) marker.parentNode!.insertBefore(document.createTextNode(after), marker);
    marker.remove();
    this.live = { eq, src, base: src };
    this.lastAuto = null;
    this.paintLive();
    this.caretAfterLive();
    this.emit();
    return true;
  }

  /**
   * Ctrl+Z ou Retour arriere juste apres une mise en forme automatique :
   * les formules creees redeviennent le texte tape, et ne sont plus
   * reconverties. `backspace` : seulement ce qui touche le curseur (une
   * formule finie quelques mots plus tot reste en forme).
   */
  private undoAuto(backspace: boolean): boolean {
    const last = this.lastAuto;
    this.lastAuto = null;
    if (!last) return false;
    // Mise en forme faite a la pause, au curseur : on etait en train de
    // taper. Retour arriere efface la derniere lettre, comme sans elle ; la
    // formule redevient du texte normal, remis en forme a la prochaine pause.
    const q = last.eqs[last.eqs.length - 1];
    if (backspace && last.pause && last.atCaret && q && this.root.contains(q) && !last.greek) {
      const src = q.dataset.src ?? "";
      const t = document.createTextNode(src.slice(0, -1));
      dropAnchorAfter(q);
      q.replaceWith(t);
      document.getSelection()?.collapse(t, t.length);
      this.emit();
      return true;
    }
    let done = false;
    const g = last.greek;
    if (last.eqs.length && (!backspace || last.atCaret) && last.eqs.every((q) => this.root.contains(q))) {
      last.eqs.forEach((q, i) => {
        let src = q.dataset.src ?? "";
        // La lettre grecque finissait la formule : on rend aussi le mot tape.
        if (g && i === last.eqs.length - 1 && !this.root.contains(g.node) && src.endsWith(g.char)) {
          src = src.slice(0, -1) + g.word;
        }
        dropAnchorAfter(q);
        q.replaceWith(rawSpan(src));
      });
      done = true;
    }
    // "π " redevient "pi ", le curseur reste apres l'espace.
    if (g && this.root.contains(g.node) && (g.node.textContent ?? "").slice(g.at - 1, g.at) === g.char) {
      const sel = document.getSelection();
      const caret = sel?.rangeCount && sel.getRangeAt(0).startContainer === g.node ? sel.getRangeAt(0).startOffset : null;
      const text = g.node.textContent ?? "";
      g.node.textContent = text.slice(0, g.at - 1) + g.word + text.slice(g.at);
      if (sel && caret !== null) {
        const shift = caret >= g.at ? g.word.length - 1 : 0;
        sel.collapse(g.node, caret + shift);
      }
      done = true;
    }
    if (done) this.emit();
    return done;
  }

  /* ---------------- titres et listes (D11) ---------------- */

  /**
   * Numeros des listes a l'ecran, d'apres les jetons relus : un element de
   * liste numerotee porte son numero (data-num, affiche par le CSS).
   */
  private renumber(tokens: DocToken[]): void {
    const blocks = Array.from(this.root.querySelectorAll<HTMLElement>(".dl"));
    if (!blocks.length) return;
    const lines = docLines(tokens);
    const nums = listNumbers(lines.map((l) => l.format)).filter((_, k) => lines[k].format);
    if (nums.length !== blocks.length) return;
    blocks.forEach((b, i) => {
      const n = nums[i];
      if (n === null) { if (b.dataset.num) delete b.dataset.num; }
      else if (b.dataset.num !== String(n)) b.dataset.num = String(n);
    });
  }

  /**
   * Remet d'aplomb les lignes mises en forme apres une frappe ou un collage :
   * un saut de ligne a l'interieur d'un titre ou d'une puce (texte colle sur
   * plusieurs lignes) la coupe, la suite devient du texte normal en dessous.
   * Les styles poses par le navigateur en fusionnant deux blocs (taille,
   * graisse recopiees) sont retires : la ligne prend le style de son bloc.
   */
  private tidyLines(): void {
    const sel = document.getSelection();
    const caret = sel?.rangeCount && this.root.contains(sel.anchorNode)
      ? { node: sel.getRangeAt(0).startContainer, offset: sel.getRangeAt(0).startOffset } : null;
    let moved = false;
    for (const span of Array.from(this.root.querySelectorAll<HTMLElement>("span[style]:not([class]), font"))) {
      // Les spans de KaTeX dans les formules ont leurs styles a eux.
      if (span.closest(".eq, .doc-img, math-field")) continue;
      span.replaceWith(...Array.from(span.childNodes));
      moved = true;
    }
    for (const block of Array.from(this.root.querySelectorAll<HTMLElement>(".dl"))) {
      // Bloc dans un bloc (collage) : il passe apres son parent.
      const outer = block.parentElement?.closest(".dl");
      if (outer && this.root.contains(outer)) { outer.after(block); moved = true; }
      for (let guard = 0; guard < 50; guard++) {
        const cut = innerBreak(block);
        if (!cut) break;
        const r = document.createRange();
        if (cut.kind === "br") r.setStartAfter(cut.node);
        else r.setStart(cut.node, cut.at + 1);
        r.setEnd(block, block.childNodes.length);
        const caretAfterCut = !!caret && caret.node === cut.node && cut.kind === "nl" && caret.offset > cut.at;
        const rest = r.extractContents();
        if (cut.kind === "br") (cut.node as ChildNode).remove();
        else (cut.node as Text).deleteData(cut.at, 1);
        ensurePlaceholder(block);
        const first = rest.firstChild;
        const end = el("br");
        block.after(rest, end);
        if (caretAfterCut && caret) { caret.node = first ?? end; caret.offset = 0; }
        moved = true;
      }
    }
    if (moved && caret && sel && caret.node.isConnected && this.root.contains(caret.node)) {
      const len = caret.node.nodeType === Node.TEXT_NODE ? (caret.node.textContent ?? "").length : caret.node.childNodes.length;
      sel.collapse(caret.node, Math.min(caret.offset, len));
    }
  }

  /**
   * Entree. Dans un titre : la ligne suivante est un paragraphe (au debut
   * du titre, une ligne vide passe au-dessus). Dans une liste : un nouvel
   * element (numero suivant) ; sur un element vide, on sort de la liste.
   * Ailleurs : un simple saut de ligne.
   */
  private newLine(): void {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    let r = sel.getRangeAt(0);
    const block = closestLine(r.startContainer, this.root);
    if (!block) { document.execCommand("insertLineBreak"); return; }
    this.lastAuto = null;
    this.lastLine = null;
    if (!sel.isCollapsed) { r.deleteContents(); r.collapse(true); }
    const f = lineFormatOfEl(block);
    const list = f.style === "ul" || f.style === "ol";
    const head = document.createRange();
    head.setStart(block, 0);
    head.setEnd(r.startContainer, r.startOffset);
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(block, block.childNodes.length);
    const emptyBlock = isEmptyRange(head) && isEmptyRange(tail);
    if (list && emptyBlock) {
      this.unwrapLine(block, false);
      this.lastLine = { undo: () => this.rewrap(f) };
      this.emit();
      return;
    }
    if (!list && isEmptyRange(tail) && !emptyBlock) {
      // Fin de titre : un paragraphe vide en dessous.
      tail.deleteContents();
      ensurePlaceholder(block);
      const br = el("br");
      block.after(br);
      r = document.createRange();
      r.setStartBefore(br);
      sel.removeAllRanges();
      sel.addRange(r);
    } else if (!list && isEmptyRange(head) && !emptyBlock) {
      // Debut de titre : une ligne vide au-dessus, le curseur reste au titre.
      const prev = prevContent(block);
      block.before(...(prev && isInline(prev) ? [el("br"), el("br")] : [el("br")]));
    } else {
      const rest = tail.extractContents();
      const next = makeLine({ style: f.style, ...(f.level ? { level: f.level } : {}) });
      next.append(rest);
      dropPlaceholder(next);
      ensurePlaceholder(block);
      ensurePlaceholder(next);
      block.after(next);
      placeCaret(next);
    }
    this.emit();
    scrollCaretIntoView(this.root);
  }

  /**
   * Espace apres "#", "##", "###", "-", "*", "1." ou "1)" en debut de ligne :
   * la ligne devient un titre ou un element de liste, le marqueur disparait.
   * Vrai si la ligne a ete mise en forme (l'espace n'est alors pas tape).
   */
  private autoLine(): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.startContainer)) return false;
    if (r.startContainer.parentElement?.closest(".eq, .raw, code")) return false;
    const inLine = closestLine(r.startContainer, this.root);
    if (inLine) return this.listToHeading(inLine, r);
    const start = lineStart(this.root, r);
    const typed = start.toString().replace(/\u200b/g, "");
    const format = markerStyle(typed);
    if (!format || start.cloneContents().querySelector?.(".eq, .doc-img")) return false;
    start.deleteContents();
    start.collapse(true);
    const block = this.wrapLine(start, format);
    const marker = `${typed} `;
    this.lastAuto = null;
    this.lastLine = { undo: () => this.unmark(block, marker) };
    this.emit();
    return true;
  }

  /**
   * "# " tape au debut d'une puce (souvent la puce vide laissee par Entree) :
   * la ligne devient un titre, comme dans Notion. Ctrl+Z rend la puce.
   */
  private listToHeading(block: HTMLElement, caret: Range): boolean {
    const k = block.dataset.k;
    if (k !== "ul" && k !== "ol") return false;
    const head = document.createRange();
    head.setStart(block, 0);
    head.setEnd(caret.startContainer, caret.startOffset);
    const typed = head.toString().replace(/​/g, "");
    const format = markerStyle(typed);
    if (!format || !/^h/.test(format.style) || head.cloneContents().querySelector?.(".eq, .doc-img")) return false;
    const before: LineFormat = { style: k, level: Number(block.dataset.lvl ?? 0) || undefined };
    head.deleteContents();
    setLineFormat(block, format);
    ensurePlaceholder(block);
    placeCaret(block);
    this.lastAuto = null;
    this.lastLine = {
      undo: () => {
        if (!this.root.contains(block)) return false;
        setLineFormat(block, before);
        dropPlaceholder(block);
        block.prepend(document.createTextNode(`${typed} `));
        const end = document.createRange();
        end.setStart(block.firstChild!, typed.length + 1);
        end.collapse(true);
        const s = document.getSelection();
        s?.removeAllRanges();
        s?.addRange(end);
        this.emit();
        return true;
      },
    };
    this.emit();
    return true;
  }

  /**
   * Met toute la ligne de `caret` dans un bloc de ligne (titre, puce), y
   * compris ce qui suit le curseur ; le curseur passe au debut du bloc.
   */
  private wrapLine(caret: Range, format: LineFormat): HTMLElement {
    const start = lineStart(this.root, caret);
    const end = lineEnd(this.root, caret);
    const line = document.createRange();
    line.setStart(start.startContainer, start.startOffset);
    line.setEnd(end.range.endContainer, end.range.endOffset);
    const content = line.extractContents();
    const block = makeLine(format);
    block.append(content);
    dropPlaceholder(block);
    ensurePlaceholder(block);
    line.insertNode(block);
    removeBreak(end);
    // Saut invisible juste avant le bloc : retire (sinon Suppr en fin de
    // la ligne du dessus n'aurait rien fait a l'ecran).
    const prev = prevContent(block);
    if (prev?.nodeName === "BR") {
      const before = prevContent(prev);
      if (before && isInline(before)) (prev as ChildNode).remove();
    }
    placeCaret(block);
    return block;
  }

  /** Ctrl+Z juste apres une mise en forme par l'Espace : le marqueur tape revient. */
  private unmark(block: HTMLElement, marker: string): boolean {
    if (!this.root.contains(block)) return false;
    const at = this.unwrapLine(block, false);
    const text = document.createTextNode(marker);
    at.insertNode(text);
    document.getSelection()?.collapse(text, marker.length);
    this.emit();
    return true;
  }

  /** Ctrl+Z juste apres un titre ou une puce rendu au texte : la ligne reprend sa forme. */
  private rewrap(format: LineFormat): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.startContainer) || closestLine(r.startContainer, this.root)) return false;
    this.wrapLine(r.cloneRange(), format);
    this.emit();
    return true;
  }

  /** Defait la derniere mise en forme de ligne, s'il y en a une a defaire. */
  private undoLine(): boolean {
    const last = this.lastLine;
    this.lastLine = null;
    return !!last && last.undo();
  }

  /**
   * Bloc de ligne rendu au texte normal, a sa place. `joinPrev` : la ligne
   * se colle a la fin de la ligne du dessus (Suppr). Rend un point
   * d'insertion au debut de la ligne ; le curseur y est pose.
   */
  private unwrapLine(block: HTMLElement, joinPrev: boolean): Range {
    dropPlaceholder(block);
    const kids = Array.from(block.childNodes);
    const prev = prevContent(block);
    const parts: Node[] = [];
    if (!joinPrev && prev && isInline(prev)) parts.push(el("br"));
    const startMark = document.createTextNode("");
    parts.push(startMark, ...kids);
    // Le bloc finissait sa ligne : un saut prend sa place.
    parts.push(el("br"));
    block.replaceWith(...parts);
    const at = document.createRange();
    const first = startMark.nextSibling;
    if (first?.nodeType === Node.TEXT_NODE) at.setStart(first, 0);
    else at.setStartBefore(startMark);
    startMark.remove();
    at.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(at.cloneRange());
    return at;
  }

  /**
   * Retour arriere et Suppr aux bords d'un titre ou d'une puce, faits ici
   * plutot que par le navigateur (qui recopierait la taille du titre en
   * style dans le texte colle). Vrai si la touche a ete traitee.
   */
  private joinLines(forward: boolean): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.startContainer)) return false;
    const block = closestLine(r.startContainer, this.root);
    if (!forward) {
      const start = lineStart(block ?? this.root, r);
      if (!isEmptyRange(start)) return false;
      // Debut d'un titre ou d'une puce : paragraphe normal (Ctrl+Z le rend).
      if (block) {
        const f = lineFormatOfEl(block);
        this.unwrapLine(block, false);
        this.lastLine = { undo: () => this.rewrap(f) };
        this.emit();
        return true;
      }
      // Debut de la ligne qui suit un bloc : elle rejoint la fin du bloc.
      const above = start.startContainer === this.root ? this.root.childNodes[start.startOffset - 1] : null;
      if (!above || !isLine(above)) return false;
      this.pullLineInto(above as HTMLElement);
      return true;
    }
    const end = lineEnd(block ?? this.root, r);
    if (!isEmptyRange(end.range)) return false;
    if (block) {
      // Fin d'un titre ou d'une puce : la ligne suivante le rejoint.
      if (!block.nextSibling && !nextContent(block)) return true;
      this.pullLineInto(block);
      return true;
    }
    // Fin d'une ligne normale suivie d'un bloc : le bloc redevient du texte, colle a la ligne.
    let next: Node | null = end.stop;
    if (next && !isLine(next)) {
      const after = end.stop?.nodeName === "BR" ? nextContent(end.stop) : end.nl ? nextAfterNewline(end.nl, end.at) : null;
      if (!after || !isLine(after)) return false;
      removeBreak(end);
      next = after;
    }
    if (!next || !isLine(next)) return false;
    const caret = r.cloneRange();
    this.unwrapLine(next as HTMLElement, true);
    sel.removeAllRanges();
    sel.addRange(caret);
    this.emit();
    return true;
  }

  /** La ligne qui suit `block` (texte, ou un autre bloc) passe a la fin de `block`. */
  private pullLineInto(block: HTMLElement): void {
    dropPlaceholder(block);
    const at = block.childNodes.length;
    const nextBlock = nextContent(block);
    if (nextBlock && isLine(nextBlock)) {
      const nb = nextBlock as HTMLElement;
      dropPlaceholder(nb);
      block.append(...Array.from(nb.childNodes));
      nb.remove();
    } else {
      const from = document.createRange();
      from.setStartAfter(block);
      from.collapse(true);
      const end = lineEnd(this.root, from);
      const line = document.createRange();
      line.setStartAfter(block);
      line.setEnd(end.range.endContainer, end.range.endOffset);
      const content = line.extractContents();
      block.append(content);
      removeBreak(end);
    }
    ensurePlaceholder(block);
    const sel = document.getSelection();
    const kid = block.childNodes[at - 1];
    if (kid?.nodeType === Node.TEXT_NODE) sel?.collapse(kid, (kid.textContent ?? "").length);
    else sel?.collapse(block, Math.min(at, block.childNodes.length));
    this.emit();
  }

  /**
   * Tab / Maj+Tab dans une liste : un niveau de plus ou de moins, pour
   * chaque element touche par la selection. Faux hors liste (Tab tape alors
   * une tabulation).
   */
  private indentList(dir: 1 | -1): boolean {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.startContainer)) return false;
    const blocks = Array.from(this.root.querySelectorAll<HTMLElement>(".dl-li"))
      .filter((b) => r.intersectsNode(b) || b.contains(r.startContainer));
    if (!blocks.length) return false;
    this.lastLine = null;
    for (const b of blocks) {
      const f = lineFormatOfEl(b);
      const level = Math.max(0, Math.min(MAX_LIST_LEVEL, (f.level ?? 0) + dir));
      setLineFormat(b, { ...f, level });
    }
    this.emit();
    return true;
  }

  private onKey(e: KeyboardEvent): void {
    if (this.field) return;
    // Ctrl+Maj+> / Ctrl+< : taille suivante ou precedente (comme Word).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === ">" || e.key === "<")) {
      e.preventDefault();
      const list = FONT_SIZES as readonly number[];
      const i = list.indexOf(typingSize);
      const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? list.indexOf(NORMAL_SIZE) : i) + (e.key === ">" ? 1 : -1)))];
      setTypingSize(next);
      document.dispatchEvent(new CustomEvent("cahiers-typing-size"));
      return;
    }
    // Retour arriere, fleches... : la mise en forme a la pause attendue ne
    // vaut plus (elle avalait la lettre restante : « x^2 e » apres un ⌫).
    if (this.idleTimer && (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey)
      && !["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process"].includes(e.key)) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Fraction en cours de frappe au "/" : ses touches d'abord.
    if (this.live) {
      if (!this.live.eq.isConnected) this.live = null;
      else if (this.liveKey(e)) return;
    }
    // Suggestion grisee : Fleche droite la pose, Echap l'oublie, le reste aussi.
    if (this.ghostAt && !["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) {
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (e.key === "ArrowRight" && plain) {
        if (this.acceptGhost()) { e.preventDefault(); e.stopPropagation(); return; }
      } else if (e.key === "Escape") {
        this.hideGhost();
        e.preventDefault();
        e.stopPropagation();
        return;
      } else this.hideGhost();
    }
    // Photo selectionnee : Suppr la retire, Echap la deselectionne, toute
    // autre touche rend la main au texte.
    if (this.selectedImg && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
      const fig = this.selectedImg;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.removeImage(fig); return; }
      const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (ctrl && !fig.dataset.live && (e.key.toLowerCase() === "x" || e.key.toLowerCase() === "c")) {
        e.preventDefault();
        e.stopPropagation();
        this.clipImage(fig, e.key.toLowerCase() === "x");
        return;
      }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !ctrl && !e.altKey
        && !fig.dataset.live && !fig.classList.contains("side")) {
        e.preventDefault();
        const step = e.shiftKey ? NUDGE_FINE : NUDGE;
        this.asMove(() => this.nudge(fig, e.key === "ArrowLeft" ? -step : step));
        return;
      }
      if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.altKey && !e.metaKey && !fig.dataset.live) {
        e.preventDefault();
        this.asMove(() => this.toggleSide(fig));
        return;
      }
      this.selectImage(null);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; }
    }
    // Mise en forme qu'on vient de faire : Ctrl+Z ou Retour arriere l'annule.
    if (this.lastAuto) {
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      const bs = e.key === "Backspace" && plain;
      const undo = bs || ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z");
      if (undo && this.undoAuto(bs)) { e.preventDefault(); return; }
      if (!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) this.lastAuto = null;
    }
    // Titre ou puce que l'Espace vient de poser : Ctrl+Z rend "# " tape.
    if (this.lastLine) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && this.undoLine()) {
        e.preventDefault();
        return;
      }
      if (!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) this.lastLine = null;
    }
    // Ctrl+Entree sur un lien : le suivre. F2 : renommer son libelle.
    if ((e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey) || (e.key === "F2" && !e.ctrlKey && !e.altKey)) {
      const link = this.linkAtCaret();
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "F2") void this.renameLink(link);
        else this.followLink(link);
        return;
      }
    }
    // Retour a la ligne simple : pas de <div> par ligne, le texte reste plat
    // et se relit sans surprise. Seuls les titres et les puces ont un bloc.
    if (e.key === "Enter") {
      e.preventDefault();
      // Formule selectionnee (Maj+fleche) : Entree l'ouvre pour la corriger.
      const picked = !e.shiftKey && !e.ctrlKey && !e.altKey ? this.selectedEq() : null;
      if (picked) { this.editEq(picked, "end"); return; }
      if (autoMath) this.convertLine("final");
      this.newLine();
      // La couleur de frappe vaut pour la ligne : la suivante repart en noir.
      if (typingColor) { typingColor = null; this.paintColorTag(); }
      return;
    }
    // Debut de ligne "# ", "- ", "1. " : titre ou liste (D11).
    if (e.key === " " && !e.ctrlKey && !e.altKey && !e.metaKey && this.autoLine()) {
      e.preventDefault();
      return;
    }
    // Retour arriere au debut d'un titre ou d'une puce : paragraphe normal ;
    // Suppr en fin de ligne colle la ligne suivante sans casser les blocs.
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey
        && this.joinLines(e.key === "Delete")) {
      e.preventDefault();
      return;
    }
    // Tab dans une liste : retrait (Maj+Tab : moins de retrait).
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && this.indentList(e.shiftKey ? -1 : 1)) {
      e.preventDefault();
      return;
    }
    // "/" : la fraction s'ouvre tout de suite, ce qui precede au numerateur
    // et le curseur au denominateur. On voit ou l'on ecrit.
    if (e.key === "/" && autoMath && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (this.slashToFraction()) { e.preventDefault(); return; }
    }
    // Espace : la formule qu'on vient de finir se met en forme. Une
    // variable seule en fin de ligne attend le mot suivant ("iD" puis "=").
    if (e.key === " " && autoMath && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const made = this.convertLine("space");
      if (made.length || this.greekDone) {
        this.lastAuto = { eqs: made, greek: this.greekDone, expectSpace: true, atCaret: this.madeAtCaret };
      }
      return;
    }
    // Retour arriere ou Suppr colle a une formule : elle part d'un bloc,
    // Ctrl+Z la rend (jamais l'editeur ; un clic ou Entree l'ouvre).
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const sel = document.getSelection();
      if (sel?.rangeCount && sel.isCollapsed) {
        const eq = neighbour(sel.getRangeAt(0), e.key === "Delete");
        if (eq instanceof HTMLElement && eq.classList.contains("eq")) {
          e.preventDefault();
          const r = document.createRange();
          r.selectNode(eq);
          sel.removeAllRanges();
          sel.addRange(r);
          // Par la pile d'annulation du navigateur : Ctrl+Z la remet.
          if (!document.execCommand("delete")) eq.remove();
          this.emit();
          return;
        }
      }
    }
    // Tab insere une tabulation, comme Word, au lieu de quitter la page.
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "\t");
      return;
    }
    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "g") { e.preventDefault(); document.execCommand("bold"); this.emit(); return; }
      if (k === "i") { e.preventDefault(); document.execCommand("italic"); this.emit(); return; }
    }
    // Fleches : → juste avant une formule y entre par le debut, ← juste
    // apres par la fin (on la parcourt au clavier, sans clic) ; au bout de
    // l'editeur, la meme fleche ressort de l'autre cote. Maj : la selection
    // prend la formule entiere, ancres invisibles comprises.
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const sel = document.getSelection();
      if (!sel?.rangeCount || !sel.focusNode || (!e.shiftKey && !sel.isCollapsed)) return;
      const fwd = e.key === "ArrowRight";
      const at = document.createRange();
      at.setStart(sel.focusNode, sel.focusOffset);
      at.collapse(true);
      const eq = neighbour(at, fwd);
      if (!(eq instanceof HTMLElement && eq.classList.contains("eq") && this.root.contains(eq))) return;
      e.preventDefault();
      if (!e.shiftKey && !eq.classList.contains("live") && !eq.closest(".raw") && eq.dataset.latex !== undefined) {
        this.editEq(eq, fwd ? "start" : "end");
        return;
      }
      const [n, o] = pastNode(eq, fwd);
      if (e.shiftKey) sel.extend(n, o);
      else sel.collapse(n, o);
    }
  }

  /** Formule seule dans la selection (rien d'autre que des blancs autour), sinon null. */
  private selectedEq(): HTMLElement | null {
    const sel = document.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!this.root.contains(r.commonAncestorContainer)) return null;
    const eqs = Array.from(this.root.querySelectorAll<HTMLElement>(".eq")).filter((q) => r.intersectsNode(q));
    if (eqs.length !== 1) return null;
    const frag = r.cloneContents();
    frag.querySelectorAll(".eq").forEach((q) => q.remove());
    return (frag.textContent ?? "").replace(/[\s\u200b]/g, "") ? null : eqs[0];
  }
}

/** Lien dans le texte : une puce cliquable, son libelle seul a l'ecran (et a l'export). */
function makeLink(t: { label: string; href: string; hint?: string }): HTMLElement {
  const link = el("span", {
    class: "doc-link", contenteditable: "false", role: "link", tabindex: "-1",
    dataset: { href: t.href, label: t.label, ...(t.hint ? { hint: t.hint } : {}) },
  }, el("span", { class: "doc-link-label" }, t.label || "lien"));
  link.title = linkTitle(link);
  return link;
}

function linkTitle(link: HTMLElement): string {
  const where = link.dataset.hint ? ` (${link.dataset.hint.replace(/\/0*(\d+)$/, " p. $1")})` : "";
  return `Ouvrir${where} · Ctrl+Entrée · clic droit pour renommer`;
}

/** Formule figee dans le texte : un seul bloc pour le curseur et la gomme. */
function makeEq(latex: string, src?: string): HTMLElement {
  const eq = el("span", { class: "eq", contenteditable: "false", dataset: src ? { latex, src } : { latex } });
  // Jamais de LaTeX brut en rouge : la formule telle quelle, sinon relue
  // pour KaTeX (page ancienne avec \differentialD), sinon son texte simple.
  // Le LaTeX d'origine reste dans data-latex : rouverte, on la corrige.
  const html = katexHtml(latex) ?? katexHtml(cleanMathLive(latex));
  if (html !== null) eq.innerHTML = html;
  else {
    eq.classList.add("eq-raw");
    eq.textContent = src ?? texToPlain(latex);
  }
  return eq;
}

/**
 * Rendu KaTeX d'une formule du texte, ou null si KaTeX ne sait pas la lire.
 * \displaystyle : une fraction dans la phrase reste lisible, comme dans le
 * champ d'edition, au lieu de tomber en corps 7. Une case laissee vide reste
 * visible, en gris, pour qu'on la voie a remplir.
 */
/** Apercu d'une suggestion (markdown restreint) : texte, et formules en KaTeX. */
function ghostNodes(insert: string): Node[] {
  return parseDoc(insert).flatMap((t): Node[] => {
    if (t.kind === "text") return [document.createTextNode(t.text)];
    if (t.kind !== "math") return [];
    const span = el("span", { class: "text-ghost-eq" });
    const html = katexHtml(t.latex);
    if (html) span.innerHTML = html; else span.textContent = t.latex;
    return [span];
  });
}

/** Couleur du curseur dessine dans une formule en cours (paintLive), en LaTeX et telle que le navigateur la rend. */
const CARET_TEX_COLOR = "#2f6fed";
const CARET_RGB = "rgb(47,111,237)";

function katexHtml(latex: string): string | null {
  const shown = (latex || "\\placeholder{}").replace(/\\placeholder\{\}/g, "{\\color{#9aa3b2}\\square}");
  try {
    return katex.renderToString(`\\displaystyle ${shown}`, { throwOnError: true });
  } catch {
    return null;
  }
}

/** Premier LaTeX que KaTeX sait afficher (le dernier sinon). */
function firstRendered(cands: string[]): string {
  return cands.find((c) => katexHtml(c) !== null) ?? cands[cands.length - 1];
}

/**
 * MathLive a-t-il vraiment le clavier ? hasFocus() repond oui des l'appel a
 * focus(), avant que sa zone de saisie interne l'ait recu.
 */
function sinkFocused(mf: MathfieldElement): boolean {
  return document.activeElement === mf && !!mf.shadowRoot?.activeElement;
}

/**
 * Segment de couleur. "none" remet le texte en noir a l'interieur d'un
 * segment colore : les segments s'emboitent, le plus proche l'emporte.
 */
function colorSpan(color: ColorKey | null, ...children: Node[]): HTMLElement {
  const span = el("span", { class: "tc", dataset: { c: color ?? "none" } }, ...children);
  // Variable redefinie par la feuille sombre ; repli = couleur stockee.
  span.style.color = color ? inkCssColor(color) : "var(--text-ink, #16181d)";
  return span;
}

/**
 * Segment de taille (points facon Word) : taille absolue a l'echelle de la
 * feuille, un segment « normal » dans un plus grand remet le corps 18.
 */
function sizeSpan(size: number, ...children: Node[]): HTMLElement {
  const span = el("span", { class: "tz", dataset: { z: String(size) } }, ...children);
  span.style.fontSize = `calc(${((18 * size) / NORMAL_SIZE).toFixed(3)}px * var(--k, 1))`;
  return span;
}

/** Taille du texte a cet endroit (segment le plus proche), NORMAL_SIZE sinon. */
function sizeAt(node: Node, root: Node): number {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n instanceof HTMLElement && n.classList.contains("tz")) return Number(n.dataset.z) || NORMAL_SIZE;
    n = n.parentNode;
  }
  return NORMAL_SIZE;
}

function sizeProp(node: Node, root: Node): { size?: number } {
  const z = sizeAt(node, root);
  return z === NORMAL_SIZE ? {} : { size: z };
}

/** Couleur du texte a cet endroit (segment le plus proche), null = noir. */
function colorAt(node: Node, root: HTMLElement): ColorKey | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n instanceof HTMLElement && n.classList.contains("tc")) {
      return n.dataset.c && n.dataset.c !== "none" ? n.dataset.c as ColorKey : null;
    }
    n = n.parentNode;
  }
  return null;
}

/** Point d'ancrage invisible : le curseur a toujours un texte ou se poser. */
/** Element du texte vu ligne a ligne : un caractere, un saut, une photo, une formule. */
type LineUnit =
  | { kind: "ch"; node: Text; off: number; ch: string }
  | { kind: "br" | "img" | "atom"; node: Node };

/** Le texte a plat, dans l'ordre, ancres (\u200b) ignorees. */
function lineUnits(root: HTMLElement): LineUnit[] {
  const out: LineUnit[] = [];
  const walk = (node: Node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const t = c.textContent ?? "";
        for (let k = 0; k < t.length; k++) if (t[k] !== "\u200b") out.push({ kind: "ch", node: c as Text, off: k, ch: t[k] });
      } else if (c.nodeName === "BR") {
        out.push({ kind: "br", node: c });
      } else if (c instanceof HTMLElement) {
        if (c.classList.contains("doc-img")) out.push({ kind: "img", node: c });
        else if (c.classList.contains("eq") || c.contentEditable === "false") out.push({ kind: "atom", node: c });
        else {
          walk(c);
          // Un titre ou une puce finit sa ligne.
          if (isLine(c)) out.push({ kind: "br", node: c });
        }
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Saut qui finit la ligne de la photo `i` (« \n » ou <br> juste apres
 * elle, invisible) : rend de quoi l'oter, ou null. Jamais un titre ni une
 * puce (aussi « br » dans lineUnits).
 */
function photoLineEnd(units: LineUnit[], i: number): (() => void) | null {
  const u = i >= 0 ? units[i + 1] : undefined;
  if (u?.kind === "ch" && u.ch === "\n") return () => u.node.deleteData(u.off, 1);
  if (u?.kind === "br" && u.node.nodeName === "BR") return () => (u.node as ChildNode).remove();
  return null;
}

function setAfter(r: Range, u: LineUnit): void {
  if (u.kind === "ch") r.setStart(u.node, u.off + 1);
  else r.setStartAfter(u.node);
  r.collapse(true);
}

/** Ramene un point d'insertion au premier niveau du texte (hors <b>, <i>, couleur). */
function liftToRoot(r: Range, root: HTMLElement, dir: -1 | 1): void {
  let n: Node = r.startContainer;
  if (n === root || (n.nodeType === Node.TEXT_NODE && n.parentNode === root)) return;
  while (n.parentNode && n.parentNode !== root) n = n.parentNode;
  if (dir < 0) r.setStartBefore(n);
  else r.setStartAfter(n);
  r.collapse(true);
}

/**
 * Ancre (\u200b) qui suit une formule qu'on retire ou qu'on rend en texte :
 * elle partirait sinon en touche morte (un ← ou un ⌫ sans effet visible).
 */
function dropAnchorAfter(eq: Node): void {
  const n = eq.nextSibling;
  if (n instanceof Text && n.data.startsWith("\u200b")) n.deleteData(0, 1);
}

function anchor(): Text {
  return document.createTextNode("\u200b");
}

/** Nom du surlignage d'un passage retrouve (::highlight dans style.css). */
const FOUND_HIGHLIGHT = "cahiers-found";

/** Place d'un caractere plie : dans un texte, ou une formule / un saut de ligne entier. */
type Spot = { node: Text; offset: number; len: number } | { el: HTMLElement };

/** Texte simple de jetons : formules relues, photos omises. */
function plainOf(tokens: DocToken[]): string {
  return tokens.map((t) =>
    t.kind === "br" ? "\n" : t.kind === "math" ? texToPlain(t.latex) : t.kind === "text" ? t.text
      : t.kind === "link" ? t.label : "").join("");
}

/**
 * Rectangle d'un curseur. Un curseur replie en debut de ligne vide n'a pas
 * de rectangle : on prend alors le caractere ou le noeud voisin.
 */
function caretRect(r: Range, root: HTMLElement): DOMRect | null {
  const ok = (x: DOMRect | undefined | null) => !!x && (x.height > 0 || x.top !== 0);
  const own = r.getClientRects()[0] ?? r.getBoundingClientRect();
  if (ok(own)) return own;
  const node = r.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    const len = node.textContent?.length ?? 0;
    const probe = document.createRange();
    if (r.startOffset > 0) probe.setStart(node, r.startOffset - 1), probe.setEnd(node, r.startOffset);
    else if (len) probe.setStart(node, 0), probe.setEnd(node, 1);
    else probe.selectNode(node);
    const rect = probe.getClientRects()[0] ?? probe.getBoundingClientRect();
    if (ok(rect)) return rect;
  }
  const parent = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  const kids = parent ? Array.from(parent.childNodes) : [];
  const offset = node.nodeType === Node.TEXT_NODE ? kids.indexOf(node as ChildNode) : r.startOffset;
  for (const cand of [kids[offset - 1], kids[offset]]) {
    if (cand instanceof HTMLElement && root.contains(cand)) {
      const rect = cand.getBoundingClientRect();
      if (ok(rect)) return rect;
    }
  }
  return null;
}

/**
 * Rectangle de la ligne d'un curseur. Devant un <br>, celui du <br> (sa
 * ligne est celle du curseur) : un curseur replie dans un element n'a pas
 * de rectangle, et le voisin de gauche serait la ligne d'avant.
 */
function rowRect(r: Range, root: HTMLElement): DOMRect | null {
  const c = r.startContainer;
  if (c.nodeType === Node.ELEMENT_NODE) {
    const at = c.childNodes[r.startOffset];
    if (at?.nodeName === "BR") {
      const b = (at as Element).getBoundingClientRect();
      if (b.height > 0) return b;
    }
  }
  return caretRect(r, root);
}

/** Du curseur a la fin de sa ligne dans `box` (sans rien couper, a la difference de lineEnd). */
function restOfLine(box: Node, r: Range): Range {
  const out = document.createRange();
  out.setStart(r.startContainer, r.startOffset);
  const c = r.startContainer;
  if (c.nodeType === Node.TEXT_NODE && c.parentNode === box) {
    const i = (c.textContent ?? "").indexOf("\n", r.startOffset);
    if (i >= 0) { out.setEnd(c, i); return out; }
  }
  let n: Node | null;
  if (c === box) n = box.childNodes[r.startOffset] ?? null;
  else {
    let top: Node = c;
    while (top.parentNode && top.parentNode !== box) top = top.parentNode;
    n = top.nextSibling;
  }
  for (; n; n = n.nextSibling) {
    if (n.nodeName === "BR" || isLine(n) || (n instanceof HTMLElement && n.classList.contains("doc-img"))) {
      out.setEndBefore(n);
      return out;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      const i = (n.textContent ?? "").indexOf("\n");
      if (i >= 0) { out.setEnd(n, i); return out; }
    }
  }
  out.setEnd(box, box.childNodes.length);
  return out;
}

/** Fait defiler le conteneur de la page pour mettre un rectangle au centre. */
function scrollToCenter(from: HTMLElement, rect: DOMRect): void {
  if (!rect.height && !rect.top) return;
  let box: HTMLElement | null = from.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) {
    box = box.parentElement;
  }
  if (!box) return;
  const b = box.getBoundingClientRect();
  box.scrollTop += (rect.top + rect.bottom) / 2 - (b.top + b.height / 2);
}

/**
 * Texte redevenu brut apres une annulation de mise en forme : son propre
 * noeud, que la relecture des formules ne reprend pas.
 */
function rawSpan(text: string): HTMLElement {
  return el("span", { class: "raw" }, text);
}

/** Pose `text` a la place de `range`, dans la couleur de frappe choisie. */
function insertColored(range: Range, text: string): void {
  range.deleteContents();
  const node = document.createTextNode(text);
  const colored = colorSpan(typingColor, node);
  range.insertNode(sizeAt(range.startContainer, range.startContainer.parentElement?.closest(".text-doc") ?? document.body) === typingSize ? colored : sizeSpan(typingSize, colored));
  document.getSelection()?.collapse(node, text.length);
}

/** Gras, italique et couleur a cet endroit du texte. */
function styleAt(node: Node, root: HTMLElement): { bold: boolean; italic: boolean; color?: ColorKey } {
  let bold = false, italic = false;
  let n: Node | null = node;
  while (n && n !== root) {
    if (n instanceof HTMLElement) {
      if (n.tagName === "B" || n.tagName === "STRONG") bold = true;
      if (n.tagName === "I" || n.tagName === "EM") italic = true;
    }
    n = n.parentNode;
  }
  const color = colorAt(node, root);
  return { bold, italic, ...(color ? { color } : {}) };
}

/**
 * Mise en forme sans effet sur la ligne : couleur (span.tc), gras,
 * italique. Le texte d'une ligne y est parfois coupe (touche morte « ^ »
 * dans une ligne en couleur) : la relecture des formules passe au travers.
 */
function inlineWrap(el: HTMLElement): boolean {
  return el.matches("span.tc, span.tz, b, i, strong, em, span:not([class])");
}

/** Noeud precedent sur la ligne, en entrant et sortant des mises en forme (inlineWrap). */
function prevInLine(n: Node, root: HTMLElement): Node | null {
  let cur: Node = n;
  while (!cur.previousSibling) {
    const p = cur.parentNode;
    if (!p || p === root || !(p instanceof HTMLElement) || !inlineWrap(p)) return null;
    cur = p;
  }
  let prev: Node | null = cur.previousSibling;
  while (prev instanceof HTMLElement && inlineWrap(prev) && prev.lastChild) prev = prev.lastChild;
  return prev;
}

/** Morceau interne retrouve dans le HTML du presse-papiers (copie de secours). */
/** HTML du presse-papiers : texte echappe, formules en MathML, une ligne par <div>. */
function clipboardHtml(tokens: DocToken[], doc: string): string {
  const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = docClipboardLines(tokens).map((line) => esc(line.marker) + line.parts.map((p) => {
    if ("text" in p) return esc(p.text);
    try {
      return katex.renderToString(p.latex, { output: "mathml", throwOnError: false });
    } catch {
      return esc(texToPlain(p.latex));
    }
  }).join(""));
  const holder = document.createElement("div");
  holder.dataset.cahiers = doc;
  holder.innerHTML = lines.map((l) => `<div>${l || "<br>"}</div>`).join("");
  return holder.outerHTML;
}

function docFromHtml(html: string): string {
  if (!html.includes("data-cahiers")) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("[data-cahiers]")?.getAttribute("data-cahiers") ?? "";
}

function insertInField(mf: MathfieldElement, template: string): void {
  // Alt+P (Alt+I) dans l'exposant (l'indice) deja rempli : on en sort, comme une bascule.
  const branch = template === "#@^{#?}" ? "superscript" : template === "#@_{#?}" ? "subscript" : null;
  if (branch && endOfScript(mf) && caretAtom(mf)?.parentBranch === branch) {
    mf.executeCommand("moveAfterParent");
    return;
  }
  // Dans une formule, #@ prend ce qui precede (MathLive le gere).
  mf.insert(template, { selectionMode: "placeholder", focus: true });
  lowerBoundFirst(mf);
  mf.dispatchEvent(new Event("input"));
}

/**
 * Atome de MathLive sous le curseur. API interne (le modele n'est pas
 * public) : en cas de changement de version, null, et les reglages qui
 * s'en servent (bornes, denominateur) ne font simplement rien.
 */
interface MlAtom {
  type: string;
  parent?: MlAtom;
  parentBranch?: unknown;
  branch(name: string): MlAtom[] | undefined;
}
function caretAtom(mf: MathfieldElement): MlAtom | null {
  try {
    const model = (mf as unknown as { _mathfield?: { model?: { position: number; at(p: number): MlAtom } } })._mathfield?.model;
    return model ? model.at(model.position) ?? null : null;
  } catch {
    return null;
  }
}

/** Branche absente, vide ou reduite a une case a remplir. */
function blankBranch(p: MlAtom, name: string): boolean {
  const b = p.branch(name);
  return !b || b.length === 1 || (b.length === 2 && b[1].type === "placeholder");
}

/**
 * Integrale ou somme posee avec ses deux bornes vides : MathLive selectionne
 * la case du haut. On passe a celle du bas, qu'on remplit d'abord.
 */
function lowerBoundFirst(mf: MathfieldElement): void {
  const a = caretAtom(mf);
  const p = a?.parent;
  if (!a || !p || a.type !== "placeholder" || a.parentBranch !== "superscript") return;
  if (!p.branch("subscript") || !blankBranch(p, "subscript")) return;
  try { mf.executeCommand("moveToOpposite"); } catch { /* version de MathLive differente */ }
}

/**
 * Tab dans la borne basse, la haute encore vide : on y va (Maj+Tab dans la
 * borne haute : retour a la basse). Vrai si la touche est traitee.
 */
function switchBound(mf: MathfieldElement, back: boolean): boolean {
  const a = caretAtom(mf);
  const p = a?.parent;
  if (!a || !p) return false;
  const from = back ? "superscript" : "subscript";
  const to = back ? "subscript" : "superscript";
  if (a.parentBranch !== from || !p.branch(to) || !p.branch(from)) return false;
  if (!back && !blankBranch(p, to)) return false;
  try { return mf.executeCommand("moveToOpposite"); } catch { return false; }
}

/**
 * Une formule precede-t-elle `node` sur la meme ligne ? (contexte maths
 * pour "exists" apres "∀ x ∈ ℝ," deja mis en forme).
 */
function eqBeforeOnLine(node: Node): boolean {
  let n: Node | null = node.previousSibling;
  if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").includes("\n")) return false;
  while (n) {
    if (n instanceof HTMLElement && n.classList.contains("eq")) return true;
    if ((n.textContent ?? "").includes("\n") || n.nodeName === "BR") return false;
    n = n.previousSibling;
  }
  return false;
}

/** L'atome est-il le dernier de sa branche (curseur en fin de branche) ? */
function atBranchEnd(a: MlAtom): boolean {
  const br = a.parent && typeof a.parentBranch === "string" ? a.parent.branch(a.parentBranch) : undefined;
  return !!br && br[br.length - 1] === a;
}

/** L'exposant (l'indice) sous le curseur porte sur le dernier terme de la formule. */
function scriptIsLast(mf: MathfieldElement): boolean {
  const p = caretAtom(mf)?.parent;
  const root = p?.parent;
  if (!p || !root || root.parent) return false;
  const body = root.branch("body");
  return !!body && body[body.length - 1] === p;
}

/** Curseur juste apres un terme a exposant (indice) qui finit la formule (e^{23}|, sorti par Alt+P). */
function afterLastScript(mf: MathfieldElement): boolean {
  const a = caretAtom(mf);
  const root = a?.parent;
  if (!a || !root || root.parent || a.parentBranch !== "body") return false;
  const body = root.branch("body");
  return !!body && body[body.length - 1] === a && !!(a.branch("superscript") || a.branch("subscript"));
}

/** Curseur a la fin d'un indice ou d'un exposant deja rempli. */
function endOfScript(mf: MathfieldElement): boolean {
  const a = caretAtom(mf);
  if (!a || (a.parentBranch !== "subscript" && a.parentBranch !== "superscript")) return false;
  return a.type !== "placeholder" && a.type !== "first" && atBranchEnd(a);
}

/** Curseur a la fin d'une racine dont les parentheses tapees sont equilibrees. */
function endOfBalancedSurd(mf: MathfieldElement): boolean {
  const a = caretAtom(mf);
  const p = a?.parent;
  if (!a || !p || p.type !== "surd" || a.parentBranch !== "body" || !atBranchEnd(a)) return false;
  const body = (p.branch("body") ?? []).slice(1);
  if (!body.length) return false;
  let depth = 0;
  for (const x of body) {
    if (x.type === "mopen") depth++;
    else if (x.type === "mclose") depth--;
  }
  return depth === 0;
}

/** Fraction dont le curseur est au denominateur. */
function slashFracAt(mf: MathfieldElement): MlAtom | null {
  const a = caretAtom(mf);
  return a?.parentBranch === "below" && a.parent?.type === "genfrac" ? a.parent : null;
}

/**
 * Touches qui finissent le denominateur d'une fraction tapee au "/" : une
 * relation, une virgule, l'Espace. « + » et « - » y restent (« 2/(p+2) » se
 * tape « 2/p+2 ») ; on sort par Espace ou fleche droite.
 */
const DEN_EXIT = new Set(["=", "<", ">", ",", ";", " "]);
/**
 * Curseur a la fin du denominateur d'une fraction tapee au "/", et ce
 * denominateur est un seul terme (chiffres, lettres, parenthese, racine).
 */
function endOfSlashDen(mf: MathfieldElement, slashFracs: WeakSet<object>): boolean {
  const a = caretAtom(mf);
  const p = a?.parent;
  if (!a || !p || a.parentBranch !== "below" || p.type !== "genfrac" || !slashFracs.has(p)) return false;
  const den = p.branch("below") ?? [];
  const items = den.slice(1);
  if (!items.length || den[den.length - 1] !== a) return false;
  // Plusieurs termes (« p+2 », comme dans le texte) : on sort des que les
  // parentheses tapees dans le denominateur sont toutes fermees.
  return openParens(items) === 0;
}

/** Parentheses ouvertes et pas encore fermees dans une suite d'atomes (smartFence coupe). */
function openParens(items: readonly { type?: string }[]): number {
  let depth = 0;
  for (const x of items) {
    if (x.type === "mopen") depth++;
    else if (x.type === "mclose" && depth > 0) depth--;
  }
  return depth;
}

/**
 * « ) » tape au bout du denominateur (ou numerateur) d'une fraction qui n'a
 * pas de « ( » ouverte : elle ferme une parenthese du dehors
 * (« 1/(1+1/x) ») ; le curseur remonte d'abord hors de la fraction.
 */
function closeParenOutward(mf: MathfieldElement): void {
  for (let guard = 0; guard < 6; guard++) {
    const a = caretAtom(mf);
    const p = a?.parent;
    if (!a || !p || p.type !== "genfrac" || (a.parentBranch !== "below" && a.parentBranch !== "above")) return;
    const branch = p.branch(a.parentBranch) ?? [];
    if (branch[branch.length - 1] !== a || openParens(branch.slice(1)) > 0) return;
    mf.executeCommand("moveAfterParent");
  }
}

/** Point juste de l'autre cote de `node` (vers l'avant ou l'arriere), dans un texte s'il y en a un. */
function pastNode(node: Node, forward: boolean): [Node, number] {
  const parent = node.parentNode!;
  const idx = Array.prototype.indexOf.call(parent.childNodes, node);
  const side = forward ? node.nextSibling : node.previousSibling;
  if (side instanceof Text) {
    if (!forward) return [side, side.length];
    return [side, side.data.startsWith("\u200b") ? 1 : 0];
  }
  return [parent, forward ? idx + 1 : idx];
}

/** Noeud colle au curseur, en ignorant les ancres invisibles. */
function neighbour(r: Range, forward: boolean): Node | null {
  const c = r.startContainer, o = r.startOffset;
  let n: Node | null;
  if (c.nodeType === Node.TEXT_NODE) {
    const text = (c.textContent ?? "");
    const rest = forward ? text.slice(o) : text.slice(0, o);
    if (rest.replace(/\u200b/g, "")) return null;
    n = forward ? c.nextSibling : c.previousSibling;
  } else {
    n = forward ? c.childNodes[o] ?? null : c.childNodes[o - 1] ?? null;
  }
  // Les ancres invisibles posees autour des formules ne comptent pas.
  while (n && n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").replace(/\u200b/g, "")) {
    n = forward ? n.nextSibling : n.previousSibling;
  }
  return n;
}

function escapeTex(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, (c) => `\\${c}`);
}

/**
 * Formule du ruban ou d'un raccourci Alt : dans la formule en cours si on
 * est dedans, sinon une nouvelle formule au curseur du texte.
 */
export function insertMathTemplate(template: string, fallback?: TextDoc): void {
  if (editingDoc?.activeField) { insertInField(editingDoc.activeField, template); return; }
  const doc = lastDoc && lastDoc.root.isConnected ? lastDoc : fallback;
  doc?.insertMath(template);
}

/** Le focus est-il dans un texte de page ou une formule ? */
export function isEditingDoc(target: EventTarget | null): boolean {
  if (target instanceof MathfieldElement) return true;
  return target instanceof HTMLElement && !!target.closest(".text-doc");
}

/* ---------------- lignes mises en forme (D11) ---------------- */

const LINE_STYLES = new Set<string>(["h1", "h2", "h3", "ul", "ol"]);

/**
 * Bloc d'une ligne mise en forme : <div class="dl dl-h1">, ou
 * <div class="dl dl-ul dl-li" data-lvl="1">. Il contient la ligne et la
 * termine ; les lignes de texte normal restent a plat, separees par des sauts.
 */
function makeLine(f: LineFormat): HTMLElement {
  const d = el("div", { class: "dl" });
  setLineFormat(d, f);
  return d;
}

function setLineFormat(d: HTMLElement, f: LineFormat): void {
  const list = f.style === "ul" || f.style === "ol";
  d.className = `dl dl-${f.style}${list ? " dl-li" : ""}`;
  d.dataset.k = f.style;
  const level = list ? Math.max(0, Math.min(MAX_LIST_LEVEL, f.level ?? 0)) : 0;
  if (level) {
    d.dataset.lvl = String(level);
    d.style.setProperty("--lvl", String(level));
  } else {
    delete d.dataset.lvl;
    d.style.removeProperty("--lvl");
  }
  if (f.style === "ol" && f.num !== undefined) d.dataset.n = String(f.num);
  else delete d.dataset.n;
  if (f.style !== "ol") delete d.dataset.num;
}

function lineFormatOfEl(d: HTMLElement): LineFormat {
  const style = (LINE_STYLES.has(d.dataset.k ?? "") ? d.dataset.k : "h1") as LineStyle;
  const level = Number(d.dataset.lvl) || 0;
  const num = d.dataset.n ? Number(d.dataset.n) : undefined;
  return {
    style,
    ...(level && (style === "ul" || style === "ol") ? { level } : {}),
    ...(style === "ol" && num !== undefined && Number.isFinite(num) ? { num } : {}),
  };
}

function isLine(n: Node | null | undefined): boolean {
  return n instanceof HTMLElement && n.classList.contains("dl");
}

/** Bloc de ligne qui contient ce noeud, s'il y en a un. */
function closestLine(node: Node, root: HTMLElement): HTMLElement | null {
  const e = node instanceof HTMLElement ? node : node.parentElement;
  const b = e?.closest(".dl") ?? null;
  return b instanceof HTMLElement && root.contains(b) && b !== root ? b : null;
}

/** Texte vide ou fait d'ancres invisibles. */
function isBlank(n: Node): boolean {
  return n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").replace(/\u200b/g, "");
}

function prevContent(n: Node): Node | null {
  let p = n.previousSibling;
  while (p && isBlank(p)) p = p.previousSibling;
  return p;
}

function nextContent(n: Node): Node | null {
  let p = n.nextSibling;
  while (p && isBlank(p)) p = p.nextSibling;
  return p;
}

function lastContent(n: Node): Node | null {
  let p = n.lastChild;
  while (p && isBlank(p)) p = p.previousSibling;
  return p;
}

/** Contenu d'une ligne non terminee (ni saut, ni bloc, ni texte fini par "\n"). */
function isInline(n: Node): boolean {
  if (n.nodeName === "BR" || isLine(n)) return false;
  return !(n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").replace(/\u200b+$/, "").endsWith("\n"));
}

/** Les jetons lus finissent-ils une ligne (rien, saut, texte fini par "\n") ? */
function endsLine(out: DocToken[]): boolean {
  for (let k = out.length - 1; k >= 0; k--) {
    const t = out[k];
    if (t.kind === "text" && !t.text) continue;
    if (t.kind === "text") return t.text.endsWith("\n");
    return t.kind === "br" || t.kind === "line";
  }
  return true;
}

/** Rien de visible dans ce morceau (ancres et sauts de fin mis a part). */
function isEmptyRange(r: Range): boolean {
  if (r.toString().replace(/\u200b/g, "")) return false;
  return !r.cloneContents().querySelector(".eq, .doc-img, math-field");
}

/** Une ligne vide garde sa hauteur : un <br> dedans, comme Word et Chrome. */
function ensurePlaceholder(block: HTMLElement): void {
  if (lastContent(block)?.nodeName === "BR") return;
  const all = document.createRange();
  all.selectNodeContents(block);
  if (isEmptyRange(all)) block.append(el("br"));
}

function dropPlaceholder(block: HTMLElement): void {
  const last = lastContent(block);
  if (last?.nodeName === "BR") (last as ChildNode).remove();
}

function placeCaret(block: HTMLElement): void {
  const sel = document.getSelection();
  const first = block.firstChild;
  if (first?.nodeType === Node.TEXT_NODE) sel?.collapse(first, 0);
  else sel?.collapse(block, 0);
}

/** Debut de la ligne du curseur dans `box` (la page ou un bloc) : du debut au curseur. */
function lineStart(box: Node, r: Range): Range {
  const out = document.createRange();
  out.setEnd(r.startContainer, r.startOffset);
  const c = r.startContainer;
  if (c.nodeType === Node.TEXT_NODE && c.parentNode === box) {
    const nl = (c.textContent ?? "").slice(0, r.startOffset).lastIndexOf("\n");
    if (nl >= 0) { out.setStart(c, nl + 1); return out; }
  }
  let n: Node | null;
  if (c === box) n = box.childNodes[r.startOffset - 1] ?? null;
  else {
    let top: Node = c;
    while (top.parentNode && top.parentNode !== box) top = top.parentNode;
    n = top.previousSibling;
  }
  for (; n; n = n.previousSibling) {
    if (n.nodeName === "BR" || isLine(n)) { out.setStartAfter(n); return out; }
    if (n.nodeType === Node.TEXT_NODE) {
      const nl = (n.textContent ?? "").lastIndexOf("\n");
      if (nl >= 0) { out.setStart(n, nl + 1); return out; }
    }
  }
  out.setStart(box, 0);
  return out;
}

/**
 * Fin de la ligne du curseur dans `box` : du curseur a ce qui la termine
 * (`stop` : un saut, un bloc, un texte qui commence par "\n", ou rien).
 */
interface LineEnd { range: Range; stop: Node | null; nl: Text | null; at: number }
function lineEnd(box: Node, r: Range): LineEnd {
  const range = document.createRange();
  range.setStart(r.startContainer, r.startOffset);
  const c = r.startContainer;
  const cut = (t: Text, at: number): LineEnd => {
    // Le "\n" commence son propre noeud : extraire la ligne ne le deplace pas.
    const nl = at > 0 ? t.splitText(at) : t;
    if (at > 0 && c === t && r.startOffset >= at) range.setStart(t, at);
    range.setEndBefore(nl);
    return { range, stop: nl, nl, at: 0 };
  };
  if (c.nodeType === Node.TEXT_NODE && c.parentNode === box) {
    const i = (c.textContent ?? "").indexOf("\n", r.startOffset);
    if (i >= 0) return cut(c as Text, i);
  }
  let n: Node | null;
  if (c === box) n = box.childNodes[r.startOffset] ?? null;
  else {
    let top: Node = c;
    while (top.parentNode && top.parentNode !== box) top = top.parentNode;
    n = top.nextSibling;
  }
  for (; n; n = n.nextSibling) {
    if (n.nodeName === "BR" || isLine(n)) { range.setEndBefore(n); return { range, stop: n, nl: null, at: 0 }; }
    if (n.nodeType === Node.TEXT_NODE) {
      const i = (n.textContent ?? "").indexOf("\n");
      if (i >= 0) return cut(n as Text, i);
    }
  }
  range.setEnd(box, box.childNodes.length);
  return { range, stop: null, nl: null, at: 0 };
}

/** Retire le saut qui finissait une ligne (pas un bloc : il se termine seul). */
function removeBreak(end: LineEnd): void {
  if (end.nl) {
    const t = end.nl;
    if ((t.textContent ?? "")[0] === "\n") t.deleteData(0, 1);
    if (!t.textContent) t.remove();
    return;
  }
  if (end.stop?.nodeName === "BR") (end.stop as HTMLElement).remove();
}

/** Ce qui suit un "\n" quand il finit son texte : le noeud suivant. */
function nextAfterNewline(t: Text, at: number): Node | null {
  if ((t.textContent ?? "").slice(at + 1).replace(/\u200b/g, "")) return null;
  return nextContent(t);
}

/** Premier saut de ligne a l'interieur d'un bloc (hors son <br> de fin). */
function innerBreak(block: HTMLElement): { kind: "br"; node: Node; at: 0 } | { kind: "nl"; node: Text; at: number } | null {
  const placeholder = lastContent(block);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n instanceof HTMLElement && n.matches(".eq, .doc-img, math-field")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeName === "BR" && n !== placeholder) return { kind: "br", node: n, at: 0 };
    if (n.nodeType === Node.TEXT_NODE) {
      const at = (n.textContent ?? "").indexOf("\n");
      if (at >= 0) return { kind: "nl", node: n as Text, at };
    }
  }
  return null;
}

/** Le curseur reste a l'ecran apres un saut de ligne fait a la main. */
function scrollCaretIntoView(root: HTMLElement): void {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return;
  const rect = caretRect(sel.getRangeAt(0), root);
  if (!rect) return;
  let box: HTMLElement | null = root.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) {
    box = box.parentElement;
  }
  if (!box) return;
  const b = box.getBoundingClientRect();
  if (rect.bottom > b.bottom - 24) box.scrollTop += rect.bottom - b.bottom + 96;
  else if (rect.top < b.top + 8) box.scrollTop -= b.top - rect.top + 48;
}
