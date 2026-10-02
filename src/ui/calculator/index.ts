import { el, toast } from "../dom";
import { renderTex } from "../tex";
import { CalcEngine, normalizeInput, format, type AngleMode } from "../../core/calc/engine";
import { derivative, nthDerivative, simplifyExpr, substitute, type DerivStep } from "../../core/calc/derive";
import { antiderivative, definiteIntegral } from "../../core/calc/integrate";
import { solveEquation, solveSystem, type Root } from "../../core/calc/solve";
import { applyMatrixOp, multiply, addMatrices, readMatrix, toLatex, type MatrixOutcome } from "../../core/calc/matrix";
import {
  samplePlot, valueTable, rootsInWindow, extremaInWindow, stripY, plotWindow, readRange,
} from "../../core/calc/plot";
import type { CalcSpec, GraphSpec } from "../../core/liveblock";
import { drawPlot } from "../plotdraw";
import {
  insertText, deleteBack, deleteForward, moveCaret, HistoryRecall, type EditState,
} from "../../core/calc/screen";
import { KEYPAD, FAMILY_CLASS, mapKey, acceptText, type Key } from "./keys";

/**
 * Calculatrice flottante (section 7). Fenetre deplacable, positionnable
 * n'importe ou sur la page, ouverte au raccourci clavier.
 *
 * Toute la logique vit dans core/calc : ce fichier ne fait que la montrer.
 */

export type Tab = "calcul" | "courbes" | "matrices" | "resoudre" | "litteral";

/** Contexte d'un resultat envoye dans la page. */
export interface CalcSendMeta {
  /** Onglet d'origine. */
  tab: Tab;
  /** Ce qui a ete calcule : "derivee", "primitive", "integrale", "solution"... */
  kind: string;
  /** Mode d'angle au moment du calcul. */
  angle: AngleMode;
}

export interface CalculatorHost {
  /** Insere un bloc graph vivant dans la page courante (au curseur du texte, sinon en bas). */
  insertGraph: (g: GraphSpec) => void;
  /** Insere un bloc calc vivant dans la page courante (au curseur du texte, sinon en bas). */
  insertCalc: (c: CalcSpec) => void;
  canInsert: () => boolean;
  /** Ouverture ou fermeture, pour replier la colonne qui l'accueille. */
  onVisibility?: (visible: boolean) => void;
  /**
   * « Envoyer dans la page » sur un resultat des onglets Matrices, Résoudre
   * et Littéral. `expr` = saisie (texte), `result` = resultat (texte),
   * `latex` = la ligne complete prete a poser dans un bloc math
   * (ex. « \frac{d}{dx}(x\sin x) = \sin x + x\cos x »).
   * Absent : le bouton n'est pas affiche.
   */
  onSend?: (expr: string, result: string, latex: string, meta: CalcSendMeta) => void;
}

/** Saisies conservees par onglet : changer d'onglet ne perd rien. */
interface TabState {
  courbes: { fn: string; from: string; to: string; ymin: string; ymax: string };
  matrices: { a: string; b: string };
  resoudre: { eq: string; sys: string };
  litteral: { expr: string; v: string; subst: string; a: string; b: string };
}

export class Calculator {
  readonly root: HTMLElement;
  private engine = new CalcEngine();
  private tab: Tab = "calcul";
  private second = false;
  private edit: EditState = { input: "", caret: 0 };
  private lastError: string | null = null;
  private recall = new HistoryRecall();
  private deadPending = false;
  private body: HTMLElement;
  private visible = false;
  /**
   * Bloc de la page rouvert par un appui (section 2, blocs vivants) :
   * « Envoyer » devient « Mettre à jour », qui le recalcule sur place.
   * `update` rend false si le bloc n'existe plus.
   */
  private editing:
    | { kind: "calc"; update: (c: CalcSpec) => boolean }
    | { kind: "graph"; update: (g: GraphSpec) => boolean }
    | null = null;
  /** Envoi du dernier resultat de l'onglet affiche (Ctrl+Maj+L), s'il y en a un. */
  private lastSend: (() => void) | null = null;
  private state: TabState = {
    courbes: { fn: "", from: "-8", to: "8", ymin: "", ymax: "" },
    matrices: { a: "", b: "" },
    resoudre: { eq: "", sys: "" },
    litteral: { expr: "", v: "x", subst: "", a: "0", b: "1" },
  };
  /**
   * Le pave ne prend le clavier qu'apres un appui dedans, ou a l'ouverture
   * au clavier (Ctrl+L). Ancree a cote de la page, la calculatrice reste
   * visible en permanence : sans cela elle volerait chaque lettre tapee
   * dans le cours.
   */
  private _armed = false;
  private get armed(): boolean { return this._armed; }
  private set armed(v: boolean) {
    this._armed = v;
    this.root?.classList.toggle("armed", v);
  }

  /**
   * Recepteur invisible du clavier de l'onglet Calcul. Armee, la
   * calculatrice y met le focus ET la selection : un caractere qui arrive
   * sans keydown utilisable (Ω par insertText, IME, AltGr, clavier tactile
   * Windows) a toujours une cible qui est a elle. Sans lui, la selection
   * restait dans la page apres blur() : Chromium y inserait le caractere et
   * donnait le focus a la page (desarmement), toute la suite de la frappe
   * fuyait dans les notes. Rien n'y reste jamais ecrit.
   */
  private sink: HTMLElement;
  /** Curseur de la page au moment d'armer, rendu par Echap. */
  private savedRange: Range | null = null;

  constructor(private host: CalculatorHost) {
    this.body = el("div", { class: "calc-body" });
    this.sink = el("div", {
      class: "calc-sink", contenteditable: "true", tabindex: "-1", inputmode: "none",
      spellcheck: "false", autocapitalize: "off", autocorrect: "off", "aria-label": "Saisie de la calculatrice",
    });
    this.root = el("div", { class: "calc", style: { display: "none", left: "60px", top: "90px" } },
      this.head(),
      this.tabs(),
      this.body,
      this.sink,
    );
    // Composition (IME, touche morte) : le texte compose est repris a la fin.
    let composing = false;
    this.sink.addEventListener("compositionstart", () => { composing = true; });
    this.sink.addEventListener("compositionend", (e) => {
      composing = false;
      this.sink.textContent = "";
      if (this.capturesText(this.sink) && e.data) this.typeText(e.data);
    });
    this.sink.addEventListener("input", () => {
      if (!composing) this.sink.textContent = "";
    });
    // Un appui sur le pave rend le clavier au recepteur (pas au bouton).
    this.root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (this.tab === "calcul" && this.armed && t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") this.focusSink();
    });
    document.body.append(this.root);
    document.addEventListener("pointerdown", (e) => {
      this.armed = this.root.contains(e.target as Node);
    }, { capture: true });
    document.addEventListener("focusin", (e) => {
      if (!this.root.contains(e.target as Node)) this.armed = false;
    });
    // Ctrl+V dans l'ecran Calcul : une expression copiee (avec Ω, µ...).
    document.addEventListener("paste", (e) => {
      if (!this.capturesText(e.target)) return;
      const text = e.clipboardData?.getData("text/plain").replace(/\s+/g, " ").trim();
      if (!text) return;
      e.preventDefault();
      this.typeText(text);
    });
    // Texte qui arrive sans keydown utilisable (voir `sink`) : repris avant
    // toute insertion. textInput (Chromium, WebView2) precede l'insertion et
    // s'annule ; beforeinput en secours. Une composition en cours (IME) n'est
    // pas annulable : elle se finit dans le recepteur (compositionend).
    const intercept = (e: Event, data: string | null | undefined) => {
      if (!this.capturesText(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (data) this.typeText(data);
    };
    window.addEventListener("textInput", (e) => intercept(e, (e as any).data as string | undefined), { capture: true });
    window.addEventListener("beforeinput", (e) => {
      const ie = e as InputEvent;
      if (!/^insert(Text|ReplacementText|Paragraph|LineBreak)$/.test(ie.inputType)) return;
      // Entree arrive deja par keydown : un saut de ligne est seulement retenu.
      const text = /Text$/.test(ie.inputType) ? ie.data ?? ie.dataTransfer?.getData("text/plain") : null;
      intercept(e, text);
    }, { capture: true });
    this.render();
  }

  /** Pose la calculatrice dans une colonne fixe au lieu d'une fenetre flottante. */
  dock(container: HTMLElement): void {
    this.root.classList.add("docked");
    this.root.style.left = "";
    this.root.style.top = "";
    container.append(this.root);
  }

  /**
   * Fenetre flottante, posee dans ce conteneur (ecran etroit) : la feuille
   * garde toute sa largeur. Le conteneur la retire de l'ecran avec lui.
   */
  float(container: HTMLElement): void {
    const wasDocked = this.root.classList.contains("docked");
    this.root.classList.remove("docked");
    container.append(this.root);
    // Premiere fois : a droite, loin de la colonne d'outils. Ensuite elle
    // reste la ou on l'a deplacee.
    if (wasDocked || !this.floatPlaced) {
      this.floatPlaced = true;
      this.root.style.left = `${Math.max(8, window.innerWidth - 428 - 16)}px`;
      this.root.style.top = "110px";
    }
  }
  private floatPlaced = false;

  /* ---------------- fenetre ---------------- */

  /** Ouverte par le raccourci : elle prend le clavier tout de suite. */
  toggle(): void { this.visible ? this.hide() : this.show(true); }

  show(arm = false): void {
    this.visible = true;
    this.root.style.display = "flex";
    if (arm) {
      // Le curseur de la page est garde pour Echap, puis le focus et la
      // selection passent au recepteur : rien ne peut plus partir dans le texte.
      const sel = document.getSelection();
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      this.savedRange = range && !this.root.contains(range.startContainer) ? range.cloneRange() : null;
      this.armed = true;
    }
    this.host.onVisibility?.(true);
    // Apres onVisibility : ancree, sa colonne vient seulement d'etre ouverte
    // (un element masque ne prend pas le focus).
    if (arm) this.focusSink();
    if (this.root.classList.contains("docked")) return;
    // Toujours ramenee dans l'ecran : elle a pu etre laissee hors champ.
    const r = this.root.getBoundingClientRect();
    if (r.left + r.width > window.innerWidth) this.root.style.left = `${Math.max(8, window.innerWidth - r.width - 20)}px`;
    if (r.top + r.height > window.innerHeight) this.root.style.top = `${Math.max(8, window.innerHeight - r.height - 20)}px`;
  }

  /** Focus et selection dans le recepteur, sans defiler. */
  private focusSink(): void {
    if (document.activeElement !== this.sink) this.sink.focus({ preventScroll: true });
    const sel = document.getSelection();
    if (sel && !(sel.rangeCount && this.sink.contains(sel.anchorNode))) sel.selectAllChildren(this.sink);
  }

  /**
   * Echap sur une saisie vide : le clavier retourne au curseur de la page.
   * False s'il n'y en avait pas : Echap suit alors son cours dans l'appli.
   */
  private giveBack(): boolean {
    this.armed = false;
    const range = this.savedRange;
    this.savedRange = null;
    const host = range?.startContainer.isConnected
      ? (range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement)
        ?.closest<HTMLElement>("[contenteditable=true]")
      : null;
    if (!range || !host || host.closest(".calc")) { this.sink.blur(); return false; }
    host.focus({ preventScroll: true });
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return true;
  }

  hide(): void {
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.visible = false;
    this.armed = false;
    // Fermee : le bloc rouvert n'est plus en cours de modification.
    if (this.editing) { this.editing = null; this.render(); }
    this.root.style.display = "none";
    this.host.onVisibility?.(false);
  }

  get isVisible(): boolean { return this.visible; }
  get isDocked(): boolean { return this.root.classList.contains("docked"); }
  /** Deja posee dans ce conteneur (colonne ou zone de travail). */
  isIn(container: HTMLElement): boolean { return this.root.parentElement === container; }

  private head(): HTMLElement {
    const head = el("div", { class: "calc-head" },
      el("strong", {}, "Calculatrice"),
      el("div", { class: "spacer" }),
      el("button", { class: "ghost", title: "Fermer", onclick: () => this.hide() }, "✕"),
    );
    // Deplacement au doigt comme a la souris.
    let start: { x: number; y: number; left: number; top: number } | null = null;
    head.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      if (this.root.classList.contains("docked")) return;
      head.setPointerCapture(e.pointerId);
      head.classList.add("dragging");
      const r = this.root.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    });
    head.addEventListener("pointermove", (e) => {
      if (!start) return;
      const left = Math.max(0, Math.min(window.innerWidth - 80, start.left + e.clientX - start.x));
      const top = Math.max(0, Math.min(window.innerHeight - 50, start.top + e.clientY - start.y));
      this.root.style.left = `${left}px`;
      this.root.style.top = `${top}px`;
    });
    const stop = () => { start = null; head.classList.remove("dragging"); };
    head.addEventListener("pointerup", stop);
    head.addEventListener("pointercancel", stop);
    return head;
  }

  private tabs(): HTMLElement {
    const labels: [Tab, string][] = [
      ["calcul", "Calcul"],
      ["courbes", "Courbes"],
      ["matrices", "Matrices"],
      ["resoudre", "Résoudre"],
      ["litteral", "Littéral"],
    ];
    return el("div", { class: "calc-tabs" },
      ...labels.map(([id, label]) =>
        el("button", {
          class: this.tab === id ? "on" : "",
          dataset: { tab: id },
          onclick: () => this.selectTab(id),
        }, label)),
    );
  }

  /** Change d'onglet ; le premier champ prend le focus (sauf au pave). */
  selectTab(id: Tab): void {
    this.tab = id;
    this.refreshTabs();
    this.render();
    if (id !== "calcul") {
      this.body.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus();
    }
  }

  private refreshTabs() {
    this.root.querySelectorAll<HTMLElement>(".calc-tabs button").forEach((b) => {
      b.classList.toggle("on", b.dataset.tab === this.tab);
    });
  }

  private render() {
    this.body.replaceChildren();
    this.repaint = () => {};
    this.lastSend = null;
    switch (this.tab) {
      case "calcul":   this.renderCalcul(); break;
      case "courbes":  this.renderCourbes(); break;
      case "matrices": this.renderMatrices(); break;
      case "resoudre": this.renderResoudre(); break;
      case "litteral": this.renderLitteral(); break;
    }
  }

  /** Bouton « Envoyer dans la page » d'un resultat, si l'hote le permet. */
  private sendButton(kind: string, expr: string, result: string, latex: string): HTMLElement | null {
    const send = this.host.onSend;
    if (!send) return null;
    const tab = this.tab;
    const run = () => {
      if (!this.host.canInsert()) { toast("Ouvre une page d'abord", "warn"); return; }
      send(expr, result, latex, { tab, kind, angle: this.engine.angleMode });
    };
    this.lastSend = run;
    return el("button", { class: "calc-send", title: "Envoyer dans la page (Ctrl+Maj+L)", onclick: run }, "Envoyer dans la page");
  }

  /* ---------------- blocs vivants de la page ---------------- */

  /**
   * Appui sur un bloc calcul de la page : la calculatrice s'ouvre sur
   * l'onglet Calcul, saisie preremplie, dans le mode d'angle du bloc.
   */
  editCalc(spec: CalcSpec, update: (c: CalcSpec) => boolean): void {
    this.editing = { kind: "calc", update };
    this.engine.angleMode = spec.angle;
    this.edit = { input: spec.expr, caret: spec.expr.length };
    this.lastError = null;
    this.recall.reset();
    this.second = false;
    this.show(true);
    this.selectTab("calcul");
  }

  /** Appui sur un bloc courbe : onglet Courbes prerempli (fonction, bornes, fenetre, angle). */
  editGraph(spec: GraphSpec, update: (g: GraphSpec) => boolean): void {
    this.editing = { kind: "graph", update };
    this.engine.angleMode = spec.angle;
    const n = (v: number) => String(round4(v)).replace(".", ",");
    this.state.courbes = {
      fn: spec.fn, from: n(spec.domain[0]), to: n(spec.domain[1]),
      ymin: spec.range ? n(spec.range[0]) : "", ymax: spec.range ? n(spec.range[1]) : "",
    };
    this.show();
    this.selectTab("courbes");
  }

  /** Bandeau du bloc en cours de modification, avec « Annuler ». */
  private editBar(kind: "calc" | "graph"): HTMLElement | null {
    if (this.editing?.kind !== kind) return null;
    return el("div", { class: "calc-editing" },
      el("span", {}, kind === "calc" ? "Modification du calcul de la page" : "Modification de la courbe de la page"),
      el("div", { class: "spacer" }),
      el("button", { title: "Garder le bloc tel quel", onclick: () => { this.editing = null; this.render(); } }, "Annuler"),
    );
  }

  /** Ctrl+Maj+L : envoie le dernier resultat de l'onglet affiche. */
  sendLast(): void {
    if (this.tab === "calcul") { this.sendCalc(); return; }
    if (this.tab === "courbes") { this.sendGraph(); return; }
    if (this.lastSend) { this.lastSend(); return; }
    toast("Rien à envoyer : calcule d'abord un résultat", "warn");
  }

  /** Onglet Calcul : bloc calc vivant (ou mise a jour du bloc rouvert). */
  private sendCalc(): void {
    if (!this.host.canInsert()) { toast("Ouvre une page d'abord", "warn"); return; }
    // Saisie pas encore calculee : elle l'est d'abord.
    if (this.edit.input.trim()) this.compute();
    if (this.lastError) { toast(this.lastError, "warn"); return; }
    const last = this.engine.history.at(-1);
    if (!last) { toast("Rien à envoyer : calcule d'abord", "warn"); return; }
    const spec: CalcSpec = { expr: last.expr, result: last.text, angle: this.engine.angleMode };
    const ed = this.editing;
    if (ed?.kind === "calc") {
      this.editing = null;
      if (ed.update(spec)) toast("Calcul mis à jour dans la page");
      this.render();
      return;
    }
    this.host.insertCalc(spec);
  }

  /** Onglet Courbes : bloc graph vivant (ou mise a jour du bloc rouvert). */
  private sendGraph(): void {
    if (!this.host.canInsert()) { toast("Ouvre une page d'abord", "warn"); return; }
    const spec = this.graphSpec();
    if (!spec) return;
    const ed = this.editing;
    if (ed?.kind === "graph") {
      this.editing = null;
      if (ed.update(spec)) toast("Courbe mise à jour dans la page");
      this.render();
      return;
    }
    this.host.insertGraph(spec);
  }

  /** Bornes de l'onglet Courbes, lues dans les champs gardes. */
  private courbesDomain(): [number, number] {
    const st = this.state.courbes;
    const a = this.readNumber(st.from), b = this.readNumber(st.to);
    return a !== null && b !== null && a < b ? [a, b] : [-8, 8];
  }

  /** Fenetre ymin / ymax saisie : undefined = auto, null = saisie fautive. */
  private courbesRange(): { range?: [number, number]; error?: string } {
    const st = this.state.courbes;
    return readRange(this.readNumber(st.ymin), this.readNumber(st.ymax), !st.ymin.trim(), !st.ymax.trim());
  }

  private graphSpec(): GraphSpec | null {
    const fn = stripY(this.state.courbes.fn.trim());
    if (!fn) { toast("Tape une fonction d'abord", "warn"); return null; }
    const plot = samplePlot(fn, ...this.courbesDomain(), 50, "x", this.engine.angleMode);
    if (!plot.ok) { toast(plot.message ?? "Expression invalide", "warn"); return null; }
    const r = this.courbesRange();
    if (r.error) { toast(r.error, "warn"); return null; }
    const spec: GraphSpec = { fn, domain: this.courbesDomain(), angle: this.engine.angleMode };
    if (r.range) spec.range = r.range;
    return spec;
  }

  /** Ligne « Lu par le moteur » sous un champ, mise a jour a la frappe. */
  private readLine(get: () => string, toTex: (s: string) => string | null): { node: HTMLElement; update: () => void } {
    const node = el("div", { class: "calc-read calc-lu" });
    const update = () => {
      const s = get();
      node.replaceChildren(el("span", { class: "lbl" }, "Lu par le moteur"));
      if (!s.trim()) { node.append(el("span", { class: "muted" }, "-")); return; }
      const tex = toTex(s);
      node.append(tex ? renderTex(tex) : el("span", { class: "muted" }, "expression incomplète"));
    };
    update();
    return { node, update };
  }

  /** Une egalite « a = b » lue membre par membre. */
  private equationTex(eq: string): string | null {
    const parts = eq.split(/(?<![=<>!])=(?!=)/);
    if (parts.length > 2) return null;
    const tex = parts.map((p) => this.engine.toLatex(p));
    return tex.every(Boolean) ? tex.join(" = ") : null;
  }

  /* ---------------- onglet Calcul ---------------- */

  private repaint: () => void = () => {};
  private compute: () => void = () => {};

  private renderCalcul() {
    const screen = el("div", { class: "calc-screen" });
    const read = el("div", { class: "calc-read" });
    const keys = el("div", { class: "keys" });

    const paintScreen = () => {
      screen.replaceChildren();
      // Historique de 3 lignes minimum (section 7). Un clic reprend la ligne.
      for (const h of this.engine.lastLines(3)) {
        screen.append(el("div", {
          class: "hist",
          title: "Reprendre cette expression",
          onclick: () => this.setInput(insertText(this.edit, h.expr)),
        }, `${h.expr} = ${h.eng ?? h.text}`));
      }
      // Curseur visible : on sait ou va le prochain chiffre.
      const { input, caret } = this.edit;
      screen.append(el("div", { class: "expr" },
        input.slice(0, caret), el("span", { class: "caret" }), input.slice(caret) || "​"));
      const last = this.engine.history.at(-1);
      // Lecture ingenieur en grand (7,234 kHz), valeur complete en dessous.
      screen.append(this.lastError
        ? el("div", { class: "err" }, this.lastError)
        : el("div", { class: "res", title: last?.text ?? "" }, last ? last.eng ?? last.text : "",
          last?.eng !== undefined && !sameReading(last.eng, last.text) ? el("span", { class: "eng-full" }, `= ${last.text}`) : null));

      // Reafficher en permanence l'expression telle qu'elle a ete comprise :
      // "sin x^2" est ambigu, l'utilisateur doit voir ce que le moteur a lu.
      read.replaceChildren(el("span", { class: "lbl" }, "Lu par le moteur"));
      const latex = this.engine.toLatex(input, true);
      read.append(latex
        ? renderTex(latex)
        : el("span", { class: "muted" }, input ? "expression incomplète" : "-"));
    };
    this.repaint = paintScreen;

    const press = (k: Key) => {
      const active = this.second && k.second ? k.second : k;
      if (k.action === "second") { this.second = !this.second; paintKeys(); return; }
      if (this.second && k.action === "del") {
        this.setInput({ input: "", caret: 0 });
        this.second = false;
        paintKeys();
        return;
      }
      if (k.action === "del") this.setInput(deleteBack(this.edit));
      else if (k.action === "left") this.setInput(moveCaret(this.edit, this.edit.caret - 1));
      else if (k.action === "right") this.setInput(moveCaret(this.edit, this.edit.caret + 1));
      else if (k.action === "mode") {
        this.engine.angleMode = this.engine.angleMode === "RAD" ? "DEG" : "RAD";
        paintKeys();
      } else if (k.action === "equals") { this.compute(); }
      else if (active.insert) this.type(active.insert);
      if (this.second) { this.second = false; paintKeys(); }
    };

    const paintKeys = () => {
      keys.replaceChildren();
      for (const k of KEYPAD) {
        const shifted = this.second && k.second;
        const label = k.action === "mode" ? this.engine.angleMode : (shifted ? k.second!.label : k.label);
        const cls = [
          FAMILY_CLASS[k.family],
          k.action === "second" && this.second ? "on" : "",
          k.second ? "shifted" : "",
        ].filter(Boolean).join(" ");
        const btn = el("button", {
          class: cls,
          style: k.span ? { gridColumn: `span ${k.span}` } : {},
          onclick: () => press(k),
        });
        // La touche 2nd modifie l'affichage des touches concernees :
        // elle ne laisse pas deviner ce qu'elles vont faire.
        if (k.second && !shifted) btn.append(el("span", { class: "second" }, k.second.label));
        btn.append(document.createTextNode(label));
        keys.append(btn);
      }
    };

    const bar = this.editBar("calc");
    if (bar) this.body.append(bar);
    this.body.append(screen, read, keys);
    // Toujours present : sans page ouverte, l'appui le dit (toast).
    const updating = this.editing?.kind === "calc";
    this.body.append(el("button", {
      class: updating ? "primary calc-send" : "calc-send",
      title: updating ? "Recalcule le bloc de la page avec cette saisie" : "Le dernier résultat, au curseur du texte (Ctrl+Maj+L)",
      onclick: () => this.sendCalc(),
    }, updating ? "Mettre à jour" : "Envoyer dans la page"));

    this.compute = () => {
      const r = this.engine.evaluate(this.edit.input);
      this.lastError = r.ok ? null : r.message;
      this.recall.reset();
      if (r.ok) this.edit = { input: "", caret: 0 };
      paintScreen();
    };

    paintKeys();
    paintScreen();
  }

  /** Nouvelle saisie : l'erreur affichee s'efface des qu'on corrige. */
  private setInput(next: EditState): void {
    this.edit = next;
    this.lastError = null;
    this.repaint();
  }

  /** Frappe au pave ou au clavier ; « +1 » apres un resultat reprend ans (D10). */
  private type(text: string): void {
    this.recall.reset();
    this.setInput(insertText(this.edit, text, this.engine.history.length > 0));
  }

  /**
   * Texte colle ou insere hors keydown : lu caractere par caractere, ce qui
   * ne se lit pas est ecarte et signale, jamais rendu a la page.
   */
  private typeText(text: string): void {
    const t = acceptText(text.replace(/\s+/g, " "));
    if (t.text) this.type(t.text);
    if (t.rejected) this.reject(t.rejected);
  }

  /** Retour discret : l'ecran clignote, le caractere refuse est nomme. */
  private reject(chars: string): void {
    const screen = this.body.querySelector<HTMLElement>(".calc-screen");
    if (!screen) return;
    screen.classList.remove("reject");
    void screen.offsetWidth; // relance l'animation
    screen.classList.add("reject");
    screen.title = `Caractère ignoré : ${chars}`;
    clearTimeout(this.rejectTimer);
    this.rejectTimer = setTimeout(() => { screen.classList.remove("reject"); screen.title = ""; }, 600);
  }
  private rejectTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * La calculatrice armee prend toute la frappe de l'onglet Calcul, sauf
   * dans un champ de saisie : le sien (autres onglets) ou celui d'un dialogue.
   * Une page de notes n'est jamais une cible tant qu'elle est armee.
   */
  private capturesText(target: EventTarget | null): boolean {
    if (!this.visible || !this.armed || this.tab !== "calcul") return false;
    if (target === this.sink) return true;
    const t = target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return false;
    if (t && t.isContentEditable && document.activeElement === t) return false;
    return true;
  }

  /** Saisie au clavier quand la calculatrice a le focus. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.capturesText(e.target)) return false;
    // Composition en cours (IME) : elle se finit dans le recepteur.
    if (e.isComposing || e.key === "Process") return false;

    const cmd = mapKey(e);
    const afterDead = this.deadPending;
    this.deadPending = false;
    if (!cmd) return false;
    if (cmd.kind === "swallow") return true;
    if (cmd.kind === "reject") { this.reject(cmd.text); return true; }
    if (cmd.kind === "insert") {
      // Touche morte suivie d'Espace ou de ^ : le ^ est deja pose.
      if (afterDead && cmd.text === "^") return true;
      if (e.key === "Dead") this.deadPending = true;
      this.type(cmd.text);
      return true;
    }
    const ed = this.edit;
    switch (cmd.action) {
      case "equals": this.compute(); return true;
      case "back": this.setInput(deleteBack(ed)); return true;
      case "delete": this.setInput(deleteForward(ed)); return true;
      case "left": this.setInput(moveCaret(ed, ed.caret - 1)); return true;
      case "right": this.setInput(moveCaret(ed, ed.caret + 1)); return true;
      case "home": this.setInput(moveCaret(ed, 0)); return true;
      case "end": this.setInput(moveCaret(ed, ed.input.length)); return true;
      case "up":
      case "down": {
        const list = this.engine.history.map((h) => h.expr);
        const next = this.recall.step(list, ed.input, cmd.action === "up" ? -1 : 1);
        if (next !== null) this.setInput({ input: next, caret: next.length });
        return true;
      }
      case "escape":
        // Echap vide la saisie ; sur une saisie vide, rend le clavier.
        if (ed.input || this.lastError) { this.recall.reset(); this.setInput({ input: "", caret: 0 }); return true; }
        return this.giveBack();
    }
    return false;
  }

  /* ---------------- onglet Courbes ---------------- */

  private renderCourbes() {
    const st = this.state.courbes;
    const fnInput = el("input", { type: "text", placeholder: "y = sin(x) * x / 2" });
    fnInput.value = st.fn;
    const small = (title: string, placeholder = "") =>
      el("input", { type: "text", inputmode: "decimal", title, placeholder, style: { width: "72px" } });
    const fromInput = small("x minimum"), toInput = small("x maximum");
    const yminInput = small("y minimum (vide = auto)", "auto"), ymaxInput = small("y maximum (vide = auto)", "auto");
    fromInput.value = st.from;
    toInput.value = st.to;
    yminInput.value = st.ymin;
    ymaxInput.value = st.ymax;
    const canvas = el("canvas", { title: "Touche la courbe pour lire un point" });
    const info = el("div", { class: "small muted" });
    const box = el("div", { class: "plot-box" }, canvas);
    const table = el("div", { class: "small" });
    // sin(x) en degres ou en radians : le meme mode que l'onglet Calcul.
    const angleBtn = el("button", {
      class: "calc-angle", title: "Mode d'angle de sin, cos, tan (le même que l'onglet Calcul)",
      onclick: () => {
        this.engine.angleMode = this.engine.angleMode === "RAD" ? "DEG" : "RAD";
        angleBtn.textContent = this.engine.angleMode;
        draw();
      },
    }, this.engine.angleMode);
    let readX: number | null = null;
    let view: { from: number; to: number } | null = null;

    const fnText = () => fnInput.value.trim() || "";

    const draw = () => {
      const [from, to] = this.courbesDomain();
      const fn = fnText();
      const angle = this.engine.angleMode;
      const ctx = canvas.getContext("2d")!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = box.clientWidth || 400, h = 220;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      view = null;
      if (!fn) { info.textContent = "Tape une fonction de x."; return; }

      const plot = samplePlot(fn, from, to, 700, "x", angle);
      if (!plot.ok || !plot.samples) {
        info.textContent = plot.message ?? "Expression invalide";
        return;
      }
      // Fenetre fixee (ymin / ymax) ou calee sur les quantiles : une
      // asymptote n'ecrase pas la courbe, x + 100 reste a l'ecran.
      const range = this.courbesRange();
      const win = plotWindow(plot.samples, range.range);
      const frame = drawPlot(ctx, w, h, plot.samples, { from, to, ...win });
      view = { from, to };
      const { X, Y, axisY } = frame;

      const roots = rootsInWindow(fn, from, to, "x", angle);
      ctx.fillStyle = "#dc2626";
      if (axisY !== null) {
        for (const r of roots) { ctx.beginPath(); ctx.arc(X(r), axisY, 3.5, 0, Math.PI * 2); ctx.fill(); }
      }
      const ext = extremaInWindow(fn, from, to, "x", 800, angle);
      const parts: string[] = [];
      if (range.error) parts.push(`${range.error}.`);
      parts.push(roots.length
        ? `Racines : ${roots.slice(0, 8).map((r) => fr(round4(r))).join(" ; ")}${roots.length > 8 ? ` … et ${roots.length - 8} autres` : ""}.`
        : "Aucune racine visible.");
      if (ext.length) {
        parts.push(ext.slice(0, 4).map((p) => `${p.kind} (${fr(round4(p.x))} ; ${fr(round4(p.y))})`).join(", ")
          + (ext.length > 4 ? ` … et ${ext.length - 4} autres` : "") + ".");
      }

      // Lecture d'un point au toucher.
      if (readX !== null && readX >= from && readX <= to) {
        const row = valueTable(fn, readX, readX, 1, "x", angle)[0];
        const y = row ? Number(row.y) : NaN;
        if (Number.isFinite(y)) {
          ctx.fillStyle = "#0f172a";
          ctx.beginPath(); ctx.arc(X(readX), Y(y), 4, 0, Math.PI * 2); ctx.fill();
          parts.unshift(`Point : x = ${fr(round4(readX))}, y = ${fr(round4(y))}.`);
        }
      }
      info.textContent = parts.join(" ");
    };

    canvas.addEventListener("pointerdown", (e) => {
      if (!view) return;
      const r = canvas.getBoundingClientRect();
      readX = view.from + ((e.clientX - r.left) / r.width) * (view.to - view.from);
      draw();
    });

    const showTable = () => {
      const [from, to] = this.courbesDomain();
      const step = (to - from) / 10;
      const rows = valueTable(fnText(), from, to, step, "x", this.engine.angleMode);
      table.replaceChildren(el("table", { class: "tbl" },
        el("tr", {}, el("th", {}, "x"), el("th", {}, "y")),
        ...rows.map((r) => el("tr", {}, el("td", {}, fr(r.x)), el("td", {}, r.y.replace(".", ",")))),
      ));
    };

    const lu = this.readLine(() => stripY(fnInput.value), (s) => this.engine.toLatex(s));
    const sync = () => {
      st.fn = fnInput.value; st.from = fromInput.value; st.to = toInput.value;
      st.ymin = yminInput.value; st.ymax = ymaxInput.value;
    };
    // Le trace se redessine pendant la frappe (section 7).
    fnInput.addEventListener("input", () => { sync(); lu.update(); draw(); });
    for (const input of [fromInput, toInput, yminInput, ymaxInput]) input.addEventListener("input", () => { sync(); draw(); });
    onEnter(fnInput, showTable);

    const zoom = (factor: number) => {
      const [from, to] = this.courbesDomain();
      const mid = (from + to) / 2, half = ((to - from) / 2) * factor;
      fromInput.value = String(round4(mid - half)).replace(".", ",");
      toInput.value = String(round4(mid + half)).replace(".", ",");
      sync();
      draw();
    };

    const updating = this.editing?.kind === "graph";
    const bar = this.editBar("graph");
    if (bar) this.body.append(bar);
    this.body.append(
      el("div", { class: "row" }, el("span", { class: "muted" }, "y ="), fnInput, angleBtn),
      lu.node,
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "x de"), fromInput,
        el("span", { class: "muted small" }, "à"), toInput,
        el("button", { title: "Zoom avant", onclick: () => zoom(0.5) }, "+"),
        el("button", { title: "Zoom arrière", onclick: () => zoom(2) }, "−"),
      ),
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "y de"), yminInput,
        el("span", { class: "muted small" }, "à"), ymaxInput,
        el("button", {
          title: "Fenêtre verticale automatique",
          onclick: () => { yminInput.value = ""; ymaxInput.value = ""; sync(); draw(); },
        }, "Auto"),
      ),
      box, info,
      el("div", { class: "row" },
        el("button", { onclick: showTable }, "Tableau de valeurs"),
        el("div", { class: "spacer" }),
        el("button", {
          class: "primary",
          title: updating ? "Redessine la courbe de la page" : "Courbe vivante, au curseur du texte (Ctrl+Maj+L)",
          onclick: () => this.sendGraph(),
        }, updating ? "Mettre à jour" : "Envoyer dans la page"),
      ),
      table,
    );
    queueMicrotask(draw);
  }

  /** Nombre saisi dans un champ : « 1,5 », « pi/2 », « -3 ». */
  private readNumber(s: string): number | null {
    if (!s.trim()) return null;
    try {
      const v = Number(this.engine.math.evaluate(normalizeInput(s)));
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  /* ---------------- onglet Matrices ---------------- */

  private renderMatrices() {
    const st = this.state.matrices;
    const a = el("textarea", { rows: "3", placeholder: "1 2\n3 4   (Ctrl+Entrée : déterminant)" });
    const b = el("textarea", { rows: "3", placeholder: "0 1\n1 0" });
    a.value = st.a;
    b.value = st.b;
    const out = el("div", {});

    const preview = (t: HTMLTextAreaElement) => {
      const node = el("div", { class: "calc-read calc-lu" });
      const update = () => {
        node.replaceChildren(el("span", { class: "lbl" }, "Lu par le moteur"));
        if (!t.value.trim()) { node.append(el("span", { class: "muted" }, "-")); return; }
        const r = readMatrix(t.value);
        node.append(r.ok ? renderTex(toLatex(r.matrix!)) : el("span", { class: "err" }, r.message ?? "Matrice illisible"));
      };
      update();
      return { node, update };
    };
    const pa = preview(a), pb = preview(b);
    a.addEventListener("input", () => { st.a = a.value; pa.update(); });
    b.addEventListener("input", () => { st.b = b.value; pb.update(); });

    const read = (t: HTMLTextAreaElement, name: string): number[][] | null => {
      const r = readMatrix(t.value);
      if (!r.ok) { show(`${name} : ${r.message}`); return null; }
      return r.matrix!;
    };
    const show = (message: string) => {
      out.replaceChildren(el("div", { class: "calc-read" }, el("span", { class: "err" }, message)));
    };
    const result = (r: MatrixOutcome, lhs: string, kind: string, exprText: string) => {
      if (!r.ok || r.latex === undefined) { show(r.message ?? "Échec"); return; }
      const latex = `${lhs} = ${r.latex}`;
      const box = el("div", { class: "calc-read" }, renderTex(latex));
      out.replaceChildren(box);
      const send = this.sendButton(kind, exprText, r.latex, latex);
      if (send) out.append(send);
    };
    const texA = () => { const m = readMatrix(a.value); return m.ok ? toLatex(m.matrix!) : "A"; };
    const texB = () => { const m = readMatrix(b.value); return m.ok ? toLatex(m.matrix!) : "B"; };
    const unary = (op: "det" | "inv" | "transpose" | "rank" | "trace") => {
      const m = read(a, "Matrice A");
      if (!m) return;
      const lhs: Record<typeof op, string> = {
        det: `\\det ${texA()}`,
        inv: `${texA()}^{-1}`,
        transpose: `${texA()}^{\\mathsf{T}}`,
        rank: `\\operatorname{rg} ${texA()}`,
        trace: `\\operatorname{tr} ${texA()}`,
      };
      result(applyMatrixOp(m, op), lhs[op], op, a.value);
    };
    const binary = (op: "mul" | "add" | "sub") => {
      const ma = read(a, "Matrice A");
      const mb = ma && read(b, "Matrice B");
      if (!ma || !mb) return;
      const r = op === "mul" ? multiply(ma, mb) : addMatrices(ma, mb, op === "add" ? 1 : -1);
      const sign = op === "mul" ? " \\times " : op === "add" ? " + " : " - ";
      result(r, `${texA()}${sign}${texB()}`, op, `${a.value} | ${b.value}`);
    };
    onEnter(a, () => unary("det"));
    onEnter(b, () => binary("mul"));

    this.body.append(
      el("span", { class: "lbl small muted" }, "Matrice A : une ligne par ligne, cellules séparées par des espaces"), a, pa.node,
      el("div", { class: "row" },
        el("button", { onclick: () => unary("det") }, "det"),
        el("button", { onclick: () => unary("inv") }, "A⁻¹"),
        el("button", { onclick: () => unary("transpose") }, "Aᵀ"),
        el("button", { onclick: () => unary("rank") }, "rang"),
        el("button", { onclick: () => unary("trace") }, "trace"),
      ),
      el("span", { class: "lbl small muted" }, "Matrice B"), b, pb.node,
      el("div", { class: "row" },
        el("button", { onclick: () => binary("mul") }, "A × B"),
        el("button", { onclick: () => binary("add") }, "A + B"),
        el("button", { onclick: () => binary("sub") }, "A − B"),
      ),
      out,
    );
  }

  /* ---------------- onglet Resoudre ---------------- */

  private renderResoudre() {
    const st = this.state.resoudre;
    const eq = el("input", { type: "text", placeholder: "x^2 - 3x + 2 = 0" });
    eq.value = st.eq;
    const sys = el("textarea", { rows: "3", placeholder: "x + y = 10\nx - y = 2   (Ctrl+Entrée)" });
    sys.value = st.sys;
    const out = el("div", {});
    const lu = this.readLine(() => eq.value, (s) => this.equationTex(s));
    eq.addEventListener("input", () => { st.eq = eq.value; lu.update(); });
    sys.addEventListener("input", () => { st.sys = sys.value; });

    const rootLine = (v: string, root: Root, index: number, count: number): { node: HTMLElement; tex: string } => {
      const name = count > 1 ? `${v}_{${index + 1}}` : v;
      const tex = root.latex && root.latex !== root.text
        ? `${name} = ${root.latex} \\approx ${root.text.replace(/i$/, "\\,i")}`
        : `${name} = ${root.text.replace(/i$/, "\\,i")}`;
      const mult = root.multiplicity
        ? el("span", { class: "small muted" }, ` racine ${multName(root.multiplicity)}`)
        : null;
      return { node: el("div", {}, renderTex(tex), mult), tex };
    };

    const solveOne = () => {
      out.replaceChildren();
      if (!eq.value.trim()) return;
      const r = solveEquation(eq.value);
      if (!r.ok) { out.append(el("div", { class: "calc-read err" }, r.message ?? "Échec")); return; }
      const v = r.variable ?? "x";
      const box = el("div", { class: "calc-read" });
      const lines: string[] = [];
      // Le discriminant et la nature des racines : c'est ce qu'on ecrit
      // sur la copie, pas seulement le resultat.
      if (r.discriminant !== undefined) {
        box.append(renderTex(`\\Delta = ${r.discriminant}`));
        lines.push(`\\Delta = ${r.discriminant}`);
        if (r.nature) box.append(el("div", { class: "small muted" }, r.nature));
      }
      if (r.method === "numerique") {
        box.append(el("div", { class: "small muted" }, "Résolution numérique sur [-100, 100]"));
      }
      const roots = r.roots ?? [];
      roots.forEach((root, i) => {
        const line = rootLine(v, root, i, roots.length);
        box.append(line.node);
        lines.push(line.tex);
      });
      if (r.more) box.append(el("div", { class: "small muted" }, `… et ${r.more} autres racines (les plus proches de 0 sont affichées)`));
      if (!roots.length) box.append(el("div", { class: "muted" }, r.message ?? "Aucune solution"));
      out.append(box);
      const eqTex = this.equationTex(eq.value) ?? eq.value;
      const latex = lines.length ? `${eqTex} \\;:\\; ${lines.join(",\\; ")}` : `${eqTex} \\;:\\; \\text{${r.message ?? ""}}`;
      const send = this.sendButton("solution", eq.value, roots.map((x) => x.text).join(" ; ") || (r.message ?? ""), latex);
      if (send) out.append(send);
    };

    const solveSys = () => {
      out.replaceChildren();
      const lines = sys.value.split("\n").filter((l) => l.trim());
      if (!lines.length) return;
      const r = solveSystem(lines);
      if (!r.ok) { out.append(el("div", { class: "calc-read err" }, r.message ?? "Échec")); return; }
      const sol = Object.entries(r.solution ?? {});
      const solTex = sol.map(([k, v]) => `${k} = ${v}`).join(",\\; ");
      out.append(el("div", { class: "calc-read" }, renderTex(solTex)));
      const casesTex = lines.map((l) => this.equationTex(l) ?? l).join(" \\\\ ");
      const send = this.sendButton("systeme", sys.value, sol.map(([k, v]) => `${k} = ${v}`).join(", "),
        `\\begin{cases} ${casesTex} \\end{cases} \\iff ${solTex}`);
      if (send) out.append(send);
    };
    onEnter(eq, solveOne);
    onEnter(sys, solveSys);

    this.body.append(
      el("span", { class: "lbl small muted" }, "Équation (l'inconnue est déduite)"),
      eq,
      lu.node,
      el("div", { class: "row" }, el("button", { class: "primary", onclick: solveOne }, "Résoudre")),
      el("span", { class: "lbl small muted" }, "Système, une équation par ligne"),
      sys,
      el("div", { class: "row" }, el("button", { onclick: solveSys }, "Résoudre le système")),
      out,
    );
  }

  /* ---------------- onglet Calcul litteral ---------------- */

  private renderLitteral() {
    const st = this.state.litteral;
    const expr = el("input", { type: "text", placeholder: "x * sin(x)   (Entrée : dériver)" });
    expr.value = st.expr;
    const varInput = el("input", { type: "text", style: { width: "64px" } });
    varInput.value = st.v;
    const subst = el("input", { type: "text", placeholder: "a=2 ; b=3" });
    subst.value = st.subst;
    const intA = el("input", { type: "text", inputmode: "decimal", style: { width: "78px" } });
    const intB = el("input", { type: "text", inputmode: "decimal", style: { width: "78px" } });
    intA.value = st.a;
    intB.value = st.b;
    const out = el("div", {});
    let details = false;
    const lu = this.readLine(() => expr.value, (s) => this.engine.toLatex(s));
    expr.addEventListener("input", () => { st.expr = expr.value; lu.update(); });
    varInput.addEventListener("input", () => { st.v = varInput.value; });
    subst.addEventListener("input", () => { st.subst = subst.value; });
    intA.addEventListener("input", () => { st.a = intA.value; });
    intB.addEventListener("input", () => { st.b = intB.value; });
    const v = () => varInput.value.trim() || "x";
    const inTex = () => this.engine.toLatex(expr.value) ?? expr.value;

    const showResult = (
      title: string, latex: string | undefined, message?: string,
      send?: { kind: string; result: string; line: string },
    ) => {
      const box = el("div", { class: "calc-read" }, el("span", { class: "lbl" }, title));
      if (message) box.append(el("span", { class: "err" }, message));
      else if (latex) box.append(renderTex(latex));
      out.replaceChildren(box);
      if (!message && send) {
        const btn = this.sendButton(send.kind, expr.value, send.result, send.line);
        if (btn) out.append(btn);
      }
      return box;
    };

    const doDerive = (order: number) => {
      if (!expr.value.trim()) return;
      const r = order === 1 ? derivative(expr.value, v()) : nthDerivative(expr.value, v(), order);
      const title = order === 1 ? "Dérivée" : `Dérivée ${order}e`;
      const d = order === 1 ? `\\frac{\\mathrm{d}}{\\mathrm{d}${v()}}` : `\\frac{\\mathrm{d}^{${order}}}{\\mathrm{d}${v()}^{${order}}}`;
      showResult(title, r.resultLatex, r.ok ? undefined : r.message, r.ok
        ? { kind: order === 1 ? "derivee" : "derivee2", result: r.result ?? "", line: `${d}\\left(${inTex()}\\right) = ${r.resultLatex}` }
        : undefined);
      if (r.ok && r.steps && order === 1) {
        const btn = el("button", {
          onclick: () => {
            details = !details;
            stepsBox.style.display = details ? "block" : "none";
            btn.textContent = details ? "Masquer les détails" : "Afficher les détails";
          },
        }, details ? "Masquer les détails" : "Afficher les détails");
        const stepsBox = el("div", { class: "steps", style: { display: details ? "block" : "none" } },
          renderSteps(r.steps));
        out.append(btn, stepsBox);
      }
    };
    onEnter(expr, () => doDerive(1));

    const doPrimitive = () => {
      if (!expr.value.trim()) return;
      const r = antiderivative(expr.value, v());
      const box = showResult("Primitive", r.ok ? `${r.resultLatex} + C` : undefined, r.ok ? undefined : r.message, r.ok
        ? { kind: "primitive", result: r.result ?? "", line: `\\int ${inTex()} \\,\\mathrm{d}${v()} = ${r.resultLatex} + C` }
        : undefined);
      if (r.ok && r.rule) box.append(el("div", { class: "small muted" }, `Règle : ${r.rule}`));
      if (!r.ok) {
        box.append(el("div", { class: "small muted" },
          "Une intégrale définie reste possible ci-dessous, par calcul numérique."));
      }
    };

    const doIntegral = () => {
      if (!expr.value.trim()) return;
      const a = this.readNumber(intA.value), b = this.readNumber(intB.value);
      if (a === null || b === null) { showResult("Intégrale définie", undefined, "Bornes illisibles"); return; }
      const r = definiteIntegral(expr.value, v(), a, b);
      const value = r.ok ? format(r.value!) : "";
      const rel = r.method === "exacte" ? "=" : "\\approx";
      const box = showResult("Intégrale définie", r.ok ? value : undefined, r.ok ? undefined : r.message, r.ok
        ? {
          kind: "integrale", result: value,
          line: `\\int_{${this.engine.toLatex(intA.value) ?? a}}^{${this.engine.toLatex(intB.value) ?? b}} ${inTex()} \\,\\mathrm{d}${v()} ${rel} ${value}`,
        }
        : undefined);
      if (r.ok) box.append(el("div", { class: "small muted" }, `Méthode : ${r.method === "exacte" ? "exacte (primitive)" : "numérique (Simpson)"}`));
      if (r.warning) box.append(el("div", { class: "warn small" }, r.warning));
    };
    onEnter(intA, doIntegral);
    onEnter(intB, doIntegral);

    const doSubst = () => {
      if (!expr.value.trim()) return;
      const values: Record<string, string> = {};
      // « a=2,5 ; b=3 » : la virgule decimale reste dans la valeur ; une
      // virgule suivie d'un « nom = » separe deux affectations.
      for (const part of subst.value.split(/;|,(?=\s*[A-Za-z_]\w*\s*=)/)) {
        const [k, val] = part.split("=").map((s) => s.trim());
        if (k && val) values[k] = normalizeInput(val);
      }
      if (!Object.keys(values).length) {
        showResult("Substitution", undefined, "Indique les valeurs, par exemple a=2 ; b=3");
        return;
      }
      const r = substitute(expr.value, values);
      const at = Object.entries(values).map(([k, val]) => `${k} = ${this.engine.toLatex(val) ?? val}`).join(",\\,");
      showResult("Substitution", r.resultLatex, r.ok ? undefined : r.message, r.ok
        ? { kind: "substitution", result: r.result ?? "", line: `\\left.${inTex()}\\right|_{${at}} = ${r.resultLatex}` }
        : undefined);
    };
    onEnter(subst, doSubst);

    this.body.append(
      el("span", { class: "lbl small muted" }, "Expression"),
      expr,
      lu.node,
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "variable"), varInput,
        el("button", { class: "primary", onclick: () => doDerive(1) }, "Dériver"),
        el("button", { onclick: () => doDerive(2) }, "Dérivée 2e"),
      ),
      el("div", { class: "row" },
        el("button", {
          onclick: () => {
            if (!expr.value.trim()) return;
            const r = simplifyExpr(expr.value);
            showResult("Simplifié", r.resultLatex, r.ok ? undefined : r.message, r.ok
              ? { kind: "simplification", result: r.result ?? "", line: `${inTex()} = ${r.resultLatex}` }
              : undefined);
          },
        }, "Simplifier"),
        el("button", { onclick: doPrimitive }, "Primitive"),
      ),
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "de"), intA,
        el("span", { class: "muted small" }, "à"), intB,
        el("button", { onclick: doIntegral }, "Intégrale définie"),
      ),
      el("div", { class: "row" },
        subst,
        el("button", { onclick: doSubst }, "Substituer"),
      ),
      out,
    );
  }
}

/* ---------------- rendu ---------------- */

/**
 * Entrée lance l'action principale d'un champ ; dans une zone de texte
 * multiligne, c'est Ctrl+Entrée (Entrée y passe a la ligne).
 */
function onEnter(field: HTMLInputElement | HTMLTextAreaElement, action: () => void): void {
  field.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key !== "Enter" || e.isComposing) return;
    const multi = field.tagName === "TEXTAREA";
    if (multi && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    action();
  });
}

function multName(m: number): string {
  return ({ 2: "double", 3: "triple", 4: "quadruple" } as Record<number, string>)[m] ?? `d'ordre ${m}`;
}

/** Arbre des regles de derivation, replie par defaut au dela du premier niveau. */
function renderSteps(step: DerivStep, depth = 0): HTMLElement {
  const node = el("div", { class: "step" },
    el("div", { class: "rule" }, step.label),
    step.formulaLatex ? renderTex(step.formulaLatex) : null,
    el("div", { class: "parts" },
      ...step.parts.map((p) =>
        el("span", {}, `${p.name} = `, renderTex(p.latex))),
    ),
    el("div", { class: "small" }, "donne ", renderTex(step.resultLatex)),
  );
  const kids = step.children.filter((c) => c.rule !== "constante" && c.rule !== "variable");
  if (kids.length && depth < 3) {
    node.append(el("div", { class: "kids" }, ...kids.map((c) => renderSteps(c, depth + 1))));
  }
  return node;
}

/** « 0,282 Ω » et « 0.282 ohm » : meme valeur, ecrite autrement. */
function sameReading(eng: string, text: string): boolean {
  const n = (s: string) => s.replace(/,/g, ".").replace(/µ/g, "u").replace(/Ω/g, "ohm").replace(/\s+/g, " ");
  return n(eng) === n(text);
}

function round4(v: number): number { return Math.round(v * 1e4) / 1e4; }
/** Nombre a la francaise pour les textes : virgule decimale. */
function fr(v: number): string { return String(v).replace(".", ","); }
