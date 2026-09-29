import { MathfieldElement } from "mathlive";
import "mathlive/fonts.css";
import katex from "katex";
import { el } from "./dom";
import { normalizeTokens, parseDoc, serializeDoc, trailingOperand, type DocToken } from "../core/text/doc";

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

/** Type de glisser-deposer interne : une photo deplacee dans le texte. */
const DRAG_TYPE = "application/x-cahiers-image";

export class TextDoc {
  readonly root: HTMLElement;
  private savedRange: Range | null = null;
  private field: MathfieldElement | null = null;

  constructor(
    content: string,
    private onChange: (content: string) => void,
    private images?: DocImages,
  ) {
    this.root = el("div", {
      class: "text-doc",
      contenteditable: "true",
      spellcheck: "true",
      lang: "fr",
    });
    this.setContent(content);
    this.root.addEventListener("input", () => this.emit());
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.root.addEventListener("focusin", () => { lastDoc = this; });
    this.root.addEventListener("click", (e) => {
      const eq = (e.target as HTMLElement).closest?.(".eq");
      if (eq instanceof HTMLElement && this.root.contains(eq)) this.editEq(eq, "end");
    });
    document.addEventListener("selectionchange", () => {
      const sel = document.getSelection();
      if (!sel?.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (this.root.contains(r.startContainer)) { this.savedRange = r.cloneRange(); lastDoc = this; }
    });
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
    // Coller du texte brut : un copier-coller depuis le web ne doit pas
    // amener ses polices et ses couleurs dans le cahier.
    this.root.addEventListener("paste", (e) => {
      if (this.field) return;
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, text);
    });
  }

  /* ---------------- contenu ---------------- */

  get content(): string { return serializeDoc(this.read()); }

  setContent(content: string): void {
    if (this.root.isConnected && content === this.content) return;
    this.field = null;
    this.root.replaceChildren();
    const tokens = parseDoc(content);
    for (const t of tokens) {
      if (t.kind === "br") { this.root.append(el("br")); continue; }
      if (t.kind === "math") { this.root.append(makeEq(t.latex), anchor()); continue; }
      if (t.kind === "image") { this.root.append(this.makeImage(t.id), anchor()); continue; }
      let node: Node = document.createTextNode(t.text);
      if (t.italic) node = el("i", {}, node);
      if (t.bold) node = el("b", {}, node);
      this.root.append(node);
    }
    // Sans <br> final, une derniere ligne vide ne s'affiche pas.
    if (tokens[tokens.length - 1]?.kind === "br") this.root.append(el("br"));
  }

  private read(): DocToken[] {
    const out: DocToken[] = [];
    const walk = (node: Node, bold: boolean, italic: boolean) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = (child.textContent ?? "").replace(/ /g, " ").replace(/​/g, "");
          out.push({ kind: "text", text, bold, italic });
          continue;
        }
        if (child instanceof MathfieldElement) {
          out.push({ kind: "math", latex: child.getValue("latex") });
          continue;
        }
        if (!(child instanceof HTMLElement)) continue;
        if (child.classList.contains("doc-img")) {
          out.push({ kind: "image", id: child.dataset.id ?? "" });
          continue;
        }
        if (child.classList.contains("eq")) {
          out.push({ kind: "math", latex: child.dataset.latex ?? "" });
          continue;
        }
        const tag = child.tagName;
        if (tag === "BR") { out.push({ kind: "br" }); continue; }
        // Chrome cree parfois des <div> par ligne : chacun commence une ligne.
        const block = tag === "DIV" || tag === "P";
        if (block && out.length && out[out.length - 1].kind !== "br") out.push({ kind: "br" });
        const b = bold || tag === "B" || tag === "STRONG" || Number(child.style.fontWeight) >= 600;
        const i = italic || tag === "I" || tag === "EM" || child.style.fontStyle === "italic";
        walk(child, b, i);
      }
    };
    walk(this.root, false, false);
    // Le <br> de fin ajoute pour l'affichage n'est pas une ligne.
    if (out[out.length - 1]?.kind === "br") out.pop();
    return normalizeTokens(out);
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
      r.setStart(next, (next.textContent ?? "").startsWith("​") ? 1 : 0);
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
      dataset: { id }, title: info?.ocr ? `Texte lu : ${info.ocr}` : "Glisser pour deplacer",
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

  /* ---------------- formules ---------------- */

  /** Formule en cours d'edition, s'il y en a une. */
  get activeField(): MathfieldElement | null { return this.field; }

  /**
   * Rend une formule figee editable. `at` : ou poser le curseur dedans.
   * `template` : LaTeX MathLive a inserer aussitot (#? = case a remplir).
   */
  private editEq(eq: HTMLElement, at: "start" | "end", template = ""): void {
    if (editingDoc && editingDoc !== this) editingDoc.commit(null);
    if (this.field) this.commit(null);

    const mf = new MathfieldElement();
    mf.mathVirtualKeyboardPolicy = "manual";
    // Pas de fermeture automatique : [a,+∞[ s'ecrit tel quel en France.
    mf.smartFence = false;
    mf.value = eq.dataset.latex ?? "";
    eq.replaceWith(mf);
    this.field = mf;
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
        if (k.key.length === 1) mf.executeCommand(["typedText", k.key, { simulateKeystroke: true }]);
        else if (k.key === "Backspace") {
          if (mf.getValue("latex").trim()) mf.executeCommand("deleteBackward");
          else this.commit(false);
        } else this.onFieldKey(k, mf);
      }
      if (keys.length) this.emit();
    }, tries === 0 ? 70 : 30);
  }

  /**
   * Fige la formule en cours. `after` : curseur apres (true), avant (false),
   * ou laisse ou il est (null, focus parti ailleurs).
   */
  commit(after: boolean | null): void {
    const mf = this.field;
    if (!mf) return;
    this.field = null;
    if (editingDoc === this) editingDoc = null;
    const latex = mf.getValue("latex").trim();
    this.root.contentEditable = "true";

    let mark: Node;
    if (latex) {
      const eq = makeEq(latex);
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
  }

  private onFieldKey(e: KeyboardEvent, mf: MathfieldElement): void {
    // Tab : case suivante tant qu'il en reste, sinon sortie de la formule.
    const done = !mf.getValue("latex").includes("\\placeholder");
    if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && done)) {
      e.preventDefault();
      e.stopPropagation();
      this.commit(!(e.key === "Tab" && e.shiftKey));
      return;
    }
    if (e.key === "Backspace" && !mf.getValue("latex").trim()) {
      e.preventDefault();
      e.stopPropagation();
      this.commit(false);
    }
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

    // Texte selectionne ou mot colle au curseur : il entre dans la formule.
    let taken = range.collapsed ? "" : range.toString();
    if (taken) range.deleteContents();
    else if (template.includes("#@")) {
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const before = (node.textContent ?? "").slice(0, range.startOffset).replace(/​/g, "");
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

  private onKey(e: KeyboardEvent): void {
    if (this.field) return;
    // Retour a la ligne simple : pas de <div> par ligne, le texte reste plat
    // et se relit sans surprise.
    if (e.key === "Enter") {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      return;
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
function makeEq(latex: string): HTMLElement {
  const eq = el("span", { class: "eq", contenteditable: "false", dataset: { latex } });
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

/** Point d'ancrage invisible : le curseur a toujours un texte ou se poser. */
function anchor(): Text {
  return document.createTextNode("​");
}

function insertInField(mf: MathfieldElement, template: string): void {
  // Dans une formule, #@ prend ce qui precede (MathLive le gere).
  mf.insert(template, { selectionMode: "placeholder", focus: true });
  mf.dispatchEvent(new Event("input"));
}

/** Noeud colle au curseur, en ignorant les ancres invisibles. */
function neighbour(r: Range, forward: boolean): Node | null {
  const c = r.startContainer, o = r.startOffset;
  if (c.nodeType === Node.TEXT_NODE) {
    const text = (c.textContent ?? "");
    const rest = forward ? text.slice(o) : text.slice(0, o);
    if (rest.replace(/​/g, "")) return null;
    return forward ? c.nextSibling : c.previousSibling;
  }
  return forward ? c.childNodes[o] ?? null : c.childNodes[o - 1] ?? null;
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
