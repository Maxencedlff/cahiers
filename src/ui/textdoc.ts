import { MathfieldElement } from "mathlive";
import "mathlive/fonts.css";
import katex from "katex";
import { el } from "./dom";
import { colorOf } from "../core/palette";
import type { ColorKey } from "../core/types";
import {
  docClipboardText, normalizeTokens, parseDoc, serializeDoc, texToPlain, trailingOperand, type DocToken,
} from "../core/text/doc";
import { foldChar, occurrences } from "../core/text/find";
import {
  findFormulas, greekWordAtEnd, latexToSource, planLine, slashOpensFraction, subscriptVars, symbolAtEnd,
  type FoundFormula, type LinePart, type ScanMode,
} from "../core/text/automath";
import { recordLatex } from "../core/symbols";

// Polices chargees par fonts.css (embarquees par Vite), aucun son : l'app
// fonctionne hors ligne et en amphi.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;

/** Document dont une formule est en cours d'edition. */
let editingDoc: TextDoc | null = null;
/** Dernier document ou le curseur etait. */
let lastDoc: TextDoc | null = null;

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
  lookup: (id: string) => { url: Promise<string>; width: number; ocr: string | null } | null;
  /** Largeur choisie a la poignee, en unites de page. */
  resized: (id: string, width: number) => void;
}

/**
 * Couleur du texte tape ensuite : une des 5 couleurs de la palette, ou null
 * pour le texte normal (noir). Reglee par la barre d'outils.
 */
let typingColor: ColorKey | null = null;

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
}

/** Type de glisser-deposer interne : une photo deplacee dans le texte. */
const DRAG_TYPE = "application/x-cahiers-image";
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
 * Raccourcis d'une fraction ouverte par "/" : lettres grecques et fonctions
 * seulement. Les raccourcis complets de MathLive changent "or" en ∨ jusque
 * dans "rapport".
 */
const AUTO_SHORTCUTS: Record<string, string> = {
  alpha: "\\alpha", beta: "\\beta", gamma: "\\gamma", delta: "\\delta", eps: "\\varepsilon",
  epsilon: "\\varepsilon", eta: "\\eta", theta: "\\theta", lambda: "\\lambda", mu: "\\mu",
  pi: "\\pi", rho: "\\rho", sigma: "\\sigma", tau: "\\tau", phi: "\\varphi", omega: "\\omega",
  Gamma: "\\Gamma", Delta: "\\Delta", Theta: "\\Theta", Lambda: "\\Lambda", Sigma: "\\Sigma",
  Phi: "\\Phi", Omega: "\\Omega",
  sin: "\\sin", cos: "\\cos", tan: "\\tan", ln: "\\ln", log: "\\log", exp: "\\exp",
  sqrt: "\\sqrt{#?}",
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

/** Fraction ouverte par "/" : ce qui a servi de numerateur. */
interface AutoFrac { mf: MathfieldElement; numSrc: string; head: string }

export class TextDoc {
  readonly root: HTMLElement;
  private savedRange: Range | null = null;
  private field: MathfieldElement | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Remplacement ou collage en cours : l'evenement input n'est pas une frappe. */
  private quiet = false;
  /** Formule rouverte : son LaTeX et sa source, pour la rendre intacte si rien ne change. */
  private fieldOrigin: { latex: string; src?: string; value: string } | null = null;
  /** Fraction ouverte automatiquement par "/", s'il y en a une. */
  private autoFrac: AutoFrac | null = null;
  /**
   * Formules que la derniere frappe vient de mettre en forme : Ctrl+Z ou
   * Retour arriere juste apres rend le texte tape, comme dans Word.
   * `expectSpace` : l'espace qui a declenche la conversion n'est pas encore
   * arrivee (la conversion se fait avant elle). `atCaret` : la derniere
   * formule finit au curseur ; sinon ("I1" mis en forme a l'Espace apres
   * "traverse"), Retour arriere efface normalement et seul Ctrl+Z l'annule.
   */
  private lastAuto: { eqs: HTMLElement[]; greek?: GreekDone | null; expectSpace: boolean; atCaret: boolean } | null = null;
  /** La derniere relecture a fini sa derniere formule au curseur (voir planLine). */
  private madeAtCaret = false;
  /** Lettre grecque posee par la derniere relecture ("pi" -> π). */
  private greekDone: GreekDone | null = null;

  /** Ecouteur pose sur `document` : retire par dispose(), sinon chaque page vue reste en memoire. */
  private onSelectionChange = (): void => {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (this.root.contains(r.startContainer)) { this.savedRange = r.cloneRange(); lastDoc = this; }
  };

  /**
   * Page quittee : plus aucun ecouteur global ni minuterie. Sans cela, chaque
   * changement de page laissait en memoire la page, son canvas et ses traits.
   */
  dispose(): void {
    document.removeEventListener("selectionchange", this.onSelectionChange);
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
      // Symbole a deux touches remplace tout de suite ("->" -> →), puis
      // la formule se met en forme apres une courte pause de frappe.
      if (autoMath && !this.field && ie.inputType === "insertText") {
        this.replaceBeforeCaret(symbolAtEnd);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          const sel = document.getSelection();
          if (this.field || !sel?.rangeCount || !this.root.contains(sel.getRangeAt(0).startContainer)) return;
          const made = this.convertLine("pause");
          if (made.length) this.lastAuto = { eqs: made, expectSpace: false, atCaret: this.madeAtCaret };
        }, 900);
      }
      this.emit();
    });
    // Frappe dans la couleur choisie : si le curseur n'est pas deja dans un
    // texte de cette couleur, le caractere part dans un nouveau segment.
    this.root.addEventListener("beforeinput", (e) => {
      if (this.field || e.inputType !== "insertText" || !e.data) return;
      const sel = document.getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!this.root.contains(range.startContainer)) return;
      if (colorAt(range.startContainer, this.root) === typingColor) return;
      e.preventDefault();
      insertColored(range, e.data);
      this.emit();
    });
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    // Un clic ailleurs : la derniere mise en forme n'est plus annulable.
    this.root.addEventListener("pointerdown", () => { this.lastAuto = null; });
    this.root.addEventListener("focusin", () => { lastDoc = this; });
    this.root.addEventListener("click", (e) => {
      const eq = (e.target as HTMLElement).closest?.(".eq");
      if (eq instanceof HTMLElement && this.root.contains(eq)) this.editEq(eq, "end");
    });
    document.addEventListener("selectionchange", this.onSelectionChange);
    // Photo glissee a la souris : elle se pose la ou on la lache, dans le
    // texte, qui se remet en page autour d'elle.
    this.root.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    this.root.addEventListener("drop", (e) => {
      const id = e.dataTransfer?.getData(DRAG_TYPE);
      if (!id) return;
      e.preventDefault();
      const fig = this.root.querySelector<HTMLElement>(`.doc-img[data-id="${CSS.escape(id)}"]`);
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!fig || !range || !this.root.contains(range.startContainer) || fig.contains(range.startContainer)) return;
      range.insertNode(fig);
      if (fig.nextSibling?.nodeType !== Node.TEXT_NODE) fig.after(anchor());
      this.emit();
    });
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
      const dt = e.clipboardData;
      const internal = dt?.getData(CLIP_TYPE) || docFromHtml(dt?.getData("text/html") ?? "");
      if (internal) { this.insertTokens(parseDoc(internal)); return; }
      this.insertPlain((dt?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n"));
    });
  }

  /* ---------------- contenu ---------------- */

  get content(): string { return serializeDoc(this.read()); }

  setContent(content: string): void {
    if (this.root.isConnected && content === this.content) return;
    this.field = null;
    this.fieldOrigin = null;
    this.autoFrac = null;
    this.lastAuto = null;
    this.root.replaceChildren();
    const tokens = parseDoc(content);
    this.root.append(this.buildNodes(tokens));
    // Sans <br> final, une derniere ligne vide ne s'affiche pas.
    if (tokens[tokens.length - 1]?.kind === "br") this.root.append(el("br"));
  }

  /** Noeuds du texte pour des jetons (page entiere ou morceau colle). */
  private buildNodes(tokens: DocToken[]): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const t of tokens) {
      if (t.kind === "br") { frag.append(el("br")); continue; }
      if (t.kind === "math") {
        const eq = makeEq(t.latex);
        frag.append(t.color ? colorSpan(t.color, eq) : eq, anchor());
        continue;
      }
      if (t.kind === "image") { frag.append(this.makeImage(t.id), anchor()); continue; }
      let node: Node = document.createTextNode(t.text);
      if (t.italic) node = el("i", {}, node);
      if (t.bold) node = el("b", {}, node);
      if (t.color) node = colorSpan(t.color, node);
      frag.append(node);
    }
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
    const walk = (node: Node, bold: boolean, italic: boolean, color?: ColorKey) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = (child.textContent ?? "").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
          out.push({ kind: "text", text, bold, italic, color });
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
        if (child.classList.contains("eq")) {
          out.push({ kind: "math", latex: child.dataset.latex ?? "", color });
          continue;
        }
        if (child.classList.contains("tc")) {
          const c = child.dataset.c;
          walk(child, bold, italic, c && c !== "none" ? c as ColorKey : undefined);
          continue;
        }
        const tag = child.tagName;
        if (tag === "BR") { out.push({ kind: "br" }); continue; }
        // Chrome cree parfois des <div> par ligne : chacun commence une ligne.
        const block = tag === "DIV" || tag === "P";
        if (block && out.length && out[out.length - 1].kind !== "br") out.push({ kind: "br" });
        const b = bold || tag === "B" || tag === "STRONG" || Number(child.style.fontWeight) >= 600;
        const i = italic || tag === "I" || tag === "EM" || child.style.fontStyle === "italic";
        walk(child, b, i, color);
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
    const plain = docClipboardText(tokens);
    e.clipboardData.setData("text/plain", plain);
    e.clipboardData.setData(CLIP_TYPE, doc);
    // Copie de secours dans le HTML, si le type interne se perd en route.
    const holder = el("span", { dataset: { cahiers: doc } }, plain);
    e.clipboardData.setData("text/html", holder.outerHTML);
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
    const usable = tokens.filter((t) => t.kind !== "image" || !!this.images?.lookup(t.id));
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
    this.emit();
  }

  /** Tape `text` au curseur, dans la couleur choisie, annulable par Ctrl+Z. */
  private insertTextAtCaret(text: string): void {
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return;
    if (colorAt(range.startContainer, this.root) === typingColor && document.execCommand("insertText", false, text)) return;
    insertColored(range, text);
  }

  private emit(): void {
    this.onChange(this.content);
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

  /* ---------------- photos ---------------- */

  /**
   * Photo posee dans le texte, comme une image "alignee sur le texte" de
   * Word : elle occupe sa ligne, le texte passe au-dessus et en dessous. On
   * la deplace en la glissant a la souris, on la retaille par son coin.
   */
  private makeImage(id: string): HTMLElement {
    const info = this.images?.lookup(id) ?? null;
    const img = el("img", { alt: "photo", draggable: "false" });
    const grip = el("span", { class: "doc-img-grip", title: "Glisser pour retailler" });
    const fig = el("span", {
      class: "doc-img", contenteditable: "false", draggable: "true",
      dataset: { id }, title: info?.ocr ? `Texte lu : ${info.ocr}` : "Glisser pour déplacer",
    }, img, grip);
    fig.style.setProperty("--w", String(info?.width ?? 640));
    if (info) {
      void info.url.then((u) => { img.src = u; }).catch(() => fig.classList.add("missing"));
    } else {
      fig.classList.add("missing");
    }
    fig.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(DRAG_TYPE, id);
      e.dataTransfer.effectAllowed = "move";
      fig.classList.add("dragging");
    });
    fig.addEventListener("dragend", () => fig.classList.remove("dragging"));

    // Retaille a la souris par le coin bas droit.
    grip.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      fig.draggable = false;
      grip.setPointerCapture(e.pointerId);
      const k = Number(getComputedStyle(this.root).getPropertyValue("--k")) || 1;
      const startX = e.clientX;
      const startW = Number(fig.style.getPropertyValue("--w")) || 640;
      const move = (m: PointerEvent) => {
        const w = Math.round(Math.max(120, Math.min(772, startW + (m.clientX - startX) / k)));
        fig.style.setProperty("--w", String(w));
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        fig.draggable = true;
        this.images?.resized(id, Number(fig.style.getPropertyValue("--w")));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    return fig;
  }

  /** Pose une nouvelle photo au curseur, ou a la fin du texte. */
  insertImage(id: string): void {
    if (this.field) this.commit(null);
    const fig = this.makeImage(id);
    const r = this.savedRange;
    if (r && this.root.contains(r.startContainer)) {
      r.collapse(true);
      r.insertNode(fig);
    } else {
      this.root.append(fig);
    }
    if (fig.nextSibling?.nodeType !== Node.TEXT_NODE) fig.after(anchor());
    this.emit();
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
        if (f === " " && (folded === "" || folded.endsWith(" "))) continue;
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
      registry.set(FOUND_HIGHLIGHT, new HighlightCtor(range));
      setTimeout(() => registry.delete(FOUND_HIGHLIGHT), 2600);
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
  private editEq(eq: HTMLElement, at: "start" | "end", template = "", numSrc?: string): void {
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
    // Raccourcis en minuscules seulement : "PI" reste P fois I. Dans une
    // fraction ouverte par "/", grecs et fonctions seulement.
    mf.inlineShortcuts = numSrc !== undefined
      ? AUTO_SHORTCUTS
      : { ...mf.inlineShortcuts, eps: "\\varepsilon", pi: "\\pi" };
    this.field = mf;
    this.fieldOrigin = template ? null : { latex: eq.dataset.latex ?? "", src: eq.dataset.src, value: mf.getValue("latex").trim() };
    this.autoFrac = null;
    editingDoc = this;
    lastDoc = this;

    mf.addEventListener("input", (e) => { e.stopPropagation(); this.emit(); });
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
      if (numSrc !== undefined) {
        const parts = fracParts(mf.getValue("latex"));
        if (parts) this.autoFrac = { mf, numSrc, head: parts.head };
      }
      this.emit();
    } else {
      mf.position = at === "start" ? 0 : mf.lastOffset;
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
    const auto = this.autoFrac?.mf === mf ? this.autoFrac : null;
    this.fieldOrigin = null;
    this.autoFrac = null;
    this.root.contentEditable = "true";

    let eq: HTMLElement | null = null;
    if (origin?.latex && value === origin.value) {
      // Rouverte sans changement : elle garde sa source tapee et reste
      // prolongeable par la frappe qui suit.
      eq = makeEq(origin.latex, origin.src);
    } else if (value) {
      // Fraction ouverte par "/" et denominateur simple : relue comme le
      // texte ("Id = Vz/R1"), elle reste prolongeable elle aussi.
      const typed = auto ? autoSource(auto, value) : null;
      eq = typed ? makeEq(typed.latex, typed.src) : makeEq(subscriptVars(value));
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
    const auto = this.autoFrac?.mf === mf ? this.autoFrac : null;
    if (auto) {
      const parts = fracParts(value);
      const den = parts ? parts.den.replace(/\\placeholder\{\}/g, "").trim() : null;
      // Retour arriere juste apres l'ouverture : "num/" redevient du texte
      // ("10 m/s", "les E/S" quand la barre n'etait pas une fraction).
      if (key === "Backspace" && den === "" && parts?.head === auto.head) {
        this.undoAutoFrac(mf, auto);
        return true;
      }
      const balanced = den !== null && count(den, "(") === count(den, ")");
      if (key === " ") {
        // Espace avant le denominateur ("Vz / R") : sans effet.
        if (den === "") return true;
        // Denominateur fini : la fraction se ferme, la phrase continue en texte.
        if (den && balanced) {
          const eq = this.commit(true);
          const made = autoMath ? this.convertLine("space") : [];
          this.insertTextAtCaret(" ");
          this.lastAuto = made.length ? { eqs: made, expectSpace: false, atCaret: this.madeAtCaret }
            : eq ? { eqs: [eq], expectSpace: false, atCaret: true } : null;
          return true;
        }
      }
      // Parenthese fermante sans ouvrante dans le denominateur : elle ferme
      // celle d'avant la fraction ("Vz (1 + R2/R1)").
      if (key === ")" && den && balanced) {
        this.commit(true);
        this.insertTextAtCaret(")");
        return true;
      }
      if (key === "Enter" && !shift) {
        this.commit(true);
        if (autoMath) this.convertLine("final");
        document.execCommand("insertLineBreak");
        return true;
      }
    }
    // Entree : la formule se fige et on passe a la ligne, comme dans le texte.
    if (key === "Enter" && !shift) {
      this.commit(true);
      document.execCommand("insertLineBreak");
      return true;
    }
    // Tab : case suivante tant qu'il en reste, sinon sortie de la formule.
    const done = !value.includes("\\placeholder");
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

  /** Annule la fraction automatique : le numerateur et la barre redeviennent du texte. */
  private undoAutoFrac(mf: MathfieldElement, auto: AutoFrac): void {
    this.field = null;
    this.fieldOrigin = null;
    this.autoFrac = null;
    if (editingDoc === this) editingDoc = null;
    this.root.contentEditable = "true";
    const raw = rawSpan(`${auto.numSrc}/`);
    mf.replaceWith(raw);
    this.emit();
    this.caretBeside(raw, true);
  }

  /**
   * Pose une formule au curseur. `template` est du LaTeX MathLive ; #@ prend
   * le mot juste avant le curseur (le numerateur d'une fraction), #? est une
   * case a remplir.
   */
  insertMath(template = ""): void {
    if (this.field) { insertInField(this.field, template); return; }
    this.root.focus({ preventScroll: true });
    const sel = document.getSelection();
    let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !this.root.contains(range.startContainer)) {
      this.focus();
      range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (!range) return;
    }

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
          const text = node.textContent ?? "";
          const end = range.startOffset;
          const start = text.slice(0, end).lastIndexOf(taken);
          range.setStart(node, start);
          range.setEnd(node, end);
          range.deleteContents();
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
    let prev: Node | null = nl >= 0 ? null : node.previousSibling;
    while (prev) {
      if (prev.nodeType === Node.TEXT_NODE) {
        // Un "\n" tape par Entree finit la ligne precedente : on s'arrete.
        const t = prev.textContent ?? "";
        const n = t.lastIndexOf("\n");
        back.push({ node: prev, kind: "text", str: t.slice(n + 1).replace(/\u200b/g, ""), a: 0, b: 0, head: t.slice(0, n + 1) });
        if (n >= 0) break;
      } else if (prev instanceof HTMLElement && prev.classList.contains("eq") && prev.dataset.src) {
        back.push({ node: prev, kind: "eq", str: prev.dataset.src, a: 0, b: 0, head: "" });
      } else {
        break;
      }
      prev = prev.previousSibling;
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
    // Mot grec fini ("pi", "eps") : la lettre, meme hors formule.
    this.greekDone = mode === "pause" ? null : this.greekBeforeCaret();
    if (this.greekDone) this.emit();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return [];
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !this.root.contains(node)) return [];
    if (node.parentElement?.closest(".eq, .raw")) return [];
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
    parent.insertBefore(marker, first.node);

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
    parent.insertBefore(frag, marker);
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
    if (node.parentElement?.closest(".eq, .raw")) return false;
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
    const prevLatex = touched.filter((s) => s.kind === "eq").map((s) => (s.node as HTMLElement).dataset.latex ?? "").join(" ");
    const lead = first.kind === "eq" ? "" : first.head + first.str.slice(0, found.start - first.a);
    const marker = document.createTextNode("");
    parent.insertBefore(marker, first.node);
    for (const s of touched) s.node.parentNode?.removeChild(s.node);
    const eq = makeEq("");
    if (lead) parent.insertBefore(document.createTextNode(lead), marker);
    parent.insertBefore(eq, marker);
    parent.insertBefore(document.createTextNode("\u200b" + after), marker);
    marker.remove();
    recordLatex(found.latex.replace(MARK, ""), prevLatex);
    this.editEq(eq, "end", found.latex.replace(MARK, "#?"), num);
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
    let done = false;
    const g = last.greek;
    if (last.eqs.length && (!backspace || last.atCaret) && last.eqs.every((q) => this.root.contains(q))) {
      last.eqs.forEach((q, i) => {
        let src = q.dataset.src ?? "";
        // La lettre grecque finissait la formule : on rend aussi le mot tape.
        if (g && i === last.eqs.length - 1 && !this.root.contains(g.node) && src.endsWith(g.char)) {
          src = src.slice(0, -1) + g.word;
        }
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

  private onKey(e: KeyboardEvent): void {
    if (this.field) return;
    // Mise en forme qu'on vient de faire : Ctrl+Z ou Retour arriere l'annule.
    if (this.lastAuto) {
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      const bs = e.key === "Backspace" && plain;
      const undo = bs || ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z");
      if (undo && this.undoAuto(bs)) { e.preventDefault(); return; }
      if (!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) this.lastAuto = null;
    }
    // Retour a la ligne simple : pas de <div> par ligne, le texte reste plat
    // et se relit sans surprise.
    if (e.key === "Enter") {
      e.preventDefault();
      if (autoMath) this.convertLine("final");
      document.execCommand("insertLineBreak");
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
    // Retour arriere ou Suppr colle a une formule : on entre dedans pour la
    // corriger au clavier, au lieu de l'effacer d'un bloc.
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey) {
      const sel = document.getSelection();
      if (sel?.rangeCount && sel.isCollapsed) {
        const forward = e.key === "Delete";
        const eq = neighbour(sel.getRangeAt(0), forward);
        if (eq instanceof HTMLElement && eq.classList.contains("eq")) {
          e.preventDefault();
          this.editEq(eq, forward ? "start" : "end");
          if (!forward && waiting) waiting.keys.push(new KeyboardEvent("keydown", { key: "Backspace" }));
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
    // Fleches : entrer dans la formule voisine au lieu de la sauter.
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !e.shiftKey) {
      const sel = document.getSelection();
      if (!sel?.rangeCount || !sel.isCollapsed) return;
      const next = neighbour(sel.getRangeAt(0), e.key === "ArrowRight");
      if (next instanceof HTMLElement && next.classList.contains("eq")) {
        e.preventDefault();
        this.editEq(next, e.key === "ArrowRight" ? "start" : "end");
      }
    }
  }
}

/** Formule figee dans le texte : un seul bloc pour le curseur et la gomme. */
function makeEq(latex: string, src?: string): HTMLElement {
  const eq = el("span", { class: "eq", contenteditable: "false", dataset: src ? { latex, src } : { latex } });
  try {
    // \displaystyle : une fraction dans la phrase reste lisible, comme dans
    // le champ d'edition, au lieu de tomber en corps 7.
    // Une case laissee vide reste visible, en gris, pour qu'on la voie a remplir.
    const shown = (latex || "\\placeholder{}").replace(/\\placeholder\{\}/g, "{\\color{#9aa3b2}\\square}");
    eq.innerHTML = katex.renderToString(`\\displaystyle ${shown}`, { throwOnError: false });
  } catch {
    eq.textContent = latex;
  }
  return eq;
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
  span.style.color = color ? colorOf(color) : "var(--text-ink, #16181d)";
  return span;
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
    t.kind === "br" ? "\n" : t.kind === "math" ? texToPlain(t.latex) : t.kind === "text" ? t.text : "").join("");
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
  range.insertNode(colorSpan(typingColor, node));
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

/** Morceau interne retrouve dans le HTML du presse-papiers (copie de secours). */
function docFromHtml(html: string): string {
  if (!html.includes("data-cahiers")) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("[data-cahiers]")?.getAttribute("data-cahiers") ?? "";
}

function count(s: string, c: string): number {
  return s.split(c).length - 1;
}

/**
 * Derniere fraction d'une formule MathLive, quand elle la termine :
 * `head` = tout jusqu'au numerateur compris, `den` = le denominateur.
 */
function fracParts(latex: string): { head: string; den: string } | null {
  // MathLive abrege les fractions de chiffres (\frac34) : on remet les accolades.
  const full = latex.trimEnd()
    .replace(/\\frac(\d)(\d)/g, "\\frac{$1}{$2}")
    .replace(/\\frac(\d)(?=\{)/g, "\\frac{$1}")
    .replace(/(\\frac\{[^{}]*\})([0-9A-Za-z])$/, "$1{$2}");
  const last = lastGroup(full);
  if (!last) return null;
  const num = lastGroup(last.before);
  if (!num || !/\\frac\s*$/.test(num.before)) return null;
  return { head: last.before, den: last.body };
}

/** Dernier groupe {...} qui termine `s`, et ce qui le precede. */
function lastGroup(s: string): { before: string; body: string } | null {
  const t = s.trimEnd();
  if (!t.endsWith("}")) return null;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if ((c === "{" || c === "}") && t[i - 1] === "\\") { i--; continue; }
    if (c === "}") depth++;
    else if (c === "{" && --depth === 0) return { before: t.slice(0, i), body: t.slice(i + 1, -1) };
  }
  return null;
}

/**
 * Formule saisie dans une fraction ouverte par "/" : si le numerateur n'a
 * pas bouge et que le denominateur est simple ("R1", "(beta.Ru)"), elle est
 * relue comme du texte tape (meme rendu que le reste, source gardee).
 */
function autoSource(auto: AutoFrac, value: string): { latex: string; src: string } | null {
  const parts = fracParts(value);
  if (!parts || parts.head !== auto.head) return null;
  const den = latexToSource(parts.den);
  if (!den) return null;
  const src = `${auto.numSrc}/${den}`;
  const f = findFormulas(src);
  if (f.length !== 1 || f[0].start !== 0 || f[0].end !== src.trimEnd().length) return null;
  return { latex: f[0].latex, src };
}

function insertInField(mf: MathfieldElement, template: string): void {
  // Dans une formule, #@ prend ce qui precede (MathLive le gere).
  mf.insert(template, { selectionMode: "placeholder", focus: true });
  mf.dispatchEvent(new Event("input"));
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
