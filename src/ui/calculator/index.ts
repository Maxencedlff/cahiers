import { el, toast } from "../dom";
import { renderTex } from "../tex";
import { CalcEngine, normalizeInput, format, type AngleMode } from "../../core/calc/engine";
import { derivative, nthDerivative, simplifyExpr, substitute, type DerivStep } from "../../core/calc/derive";
import { antiderivative, definiteIntegral } from "../../core/calc/integrate";
import { solveEquation, solveSystem, type Root } from "../../core/calc/solve";
import { applyMatrixOp, multiply, addMatrices, readMatrix, toLatex, type MatrixOutcome } from "../../core/calc/matrix";
import {
  samplePlot, valueTable, rootsInWindow, extremaInWindow, stripY, autoWindow, niceTicks, tickLabel,
} from "../../core/calc/plot";
import {
  insertText, deleteBack, deleteForward, moveCaret, HistoryRecall, type EditState,
} from "../../core/calc/screen";
import { KEYPAD, FAMILY_CLASS, mapKey, type Key } from "./keys";

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
  /** Insere un bloc graph vivant dans la page courante. */
  insertGraph: (fn: string, domain: [number, number]) => void;
  /** Insere un bloc calc vivant dans la page courante. */
  insertCalc: (expr: string, result: string) => void;
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
  courbes: { fn: string; from: string; to: string };
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
  private state: TabState = {
    courbes: { fn: "", from: "-8", to: "8" },
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

  constructor(private host: CalculatorHost) {
    this.body = el("div", { class: "calc-body" });
    this.root = el("div", { class: "calc", style: { display: "none", left: "60px", top: "90px" } },
      this.head(),
      this.tabs(),
      this.body,
    );
    document.body.append(this.root);
    document.addEventListener("pointerdown", (e) => {
      this.armed = this.root.contains(e.target as Node);
    }, { capture: true });
    document.addEventListener("focusin", (e) => {
      if (!this.root.contains(e.target as Node)) this.armed = false;
    });
    // Ctrl+V dans l'ecran Calcul : une expression copiee (avec Ω, µ...).
    document.addEventListener("paste", (e) => {
      if (!this.visible || !this.armed || this.tab !== "calcul") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const text = e.clipboardData?.getData("text/plain").replace(/\s+/g, " ").trim();
      if (!text) return;
      e.preventDefault();
      this.type(text);
    });
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
      this.armed = true;
      // Le focus quitte la page : la frappe ne part pas aussi dans le texte.
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    this.host.onVisibility?.(true);
    if (this.root.classList.contains("docked")) return;
    // Toujours ramenee dans l'ecran : elle a pu etre laissee hors champ.
    const r = this.root.getBoundingClientRect();
    if (r.left + r.width > window.innerWidth) this.root.style.left = `${Math.max(8, window.innerWidth - r.width - 20)}px`;
    if (r.top + r.height > window.innerHeight) this.root.style.top = `${Math.max(8, window.innerHeight - r.height - 20)}px`;
  }

  hide(): void {
    this.visible = false;
    this.armed = false;
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
    return el("button", {
      class: "calc-send",
      onclick: () => {
        if (!this.host.canInsert()) { toast("Ouvre une page d'abord", "warn"); return; }
        send(expr, result, latex, { tab: this.tab, kind, angle: this.engine.angleMode });
      },
    }, "Envoyer dans la page");
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
        }, `${h.expr} = ${h.text}`));
      }
      // Curseur visible : on sait ou va le prochain chiffre.
      const { input, caret } = this.edit;
      screen.append(el("div", { class: "expr" },
        input.slice(0, caret), el("span", { class: "caret" }), input.slice(caret) || "​"));
      const last = this.engine.history.at(-1);
      screen.append(this.lastError
        ? el("div", { class: "err" }, this.lastError)
        : el("div", { class: "res" }, last ? last.text : ""));

      // Reafficher en permanence l'expression telle qu'elle a ete comprise :
      // "sin x^2" est ambigu, l'utilisateur doit voir ce que le moteur a lu.
      read.replaceChildren(el("span", { class: "lbl" }, "Lu par le moteur"));
      const latex = this.engine.toLatex(input);
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

    this.body.append(screen, read, keys);
    if (this.host.canInsert()) {
      this.body.append(el("button", {
        onclick: () => {
          const last = this.engine.history.at(-1);
          if (!last) { toast("Rien à insérer", "warn"); return; }
          this.host.insertCalc(last.expr, last.text);
          toast("Bloc calcul inséré dans la page");
        },
      }, "Envoyer dans la page"));
    }

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

  /** Saisie au clavier quand la calculatrice a le focus. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible || !this.armed || this.tab !== "calcul") return false;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return false;

    const cmd = mapKey(e);
    const afterDead = this.deadPending;
    this.deadPending = false;
    if (!cmd) return false;
    if (cmd.kind === "swallow") return true;
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
        this.armed = false;
        return false;
    }
    return false;
  }

  /* ---------------- onglet Courbes ---------------- */

  private renderCourbes() {
    const st = this.state.courbes;
    const fnInput = el("input", { type: "text", placeholder: "y = sin(x) * x / 2" });
    fnInput.value = st.fn;
    const fromInput = el("input", { type: "text", inputmode: "decimal", style: { width: "88px" } });
    const toInput = el("input", { type: "text", inputmode: "decimal", style: { width: "88px" } });
    fromInput.value = st.from;
    toInput.value = st.to;
    const canvas = el("canvas", { title: "Touche la courbe pour lire un point" });
    const info = el("div", { class: "small muted" });
    const box = el("div", { class: "plot-box" }, canvas);
    const table = el("div", { class: "small" });
    let readX: number | null = null;
    let view: { from: number; to: number; yMin: number; yMax: number; w: number; h: number } | null = null;

    const domain = (): [number, number] => {
      const a = this.readNumber(fromInput.value), b = this.readNumber(toInput.value);
      return a !== null && b !== null && a < b ? [a, b] : [-8, 8];
    };
    const fnText = () => fnInput.value.trim() || "";

    const draw = () => {
      const [from, to] = domain();
      const fn = fnText();
      const ctx = canvas.getContext("2d")!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = box.clientWidth || 400, h = 220;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      view = null;
      if (!fn) { info.textContent = "Tape une fonction de x."; return; }

      const plot = samplePlot(fn, from, to, 700);
      if (!plot.ok || !plot.samples) {
        info.textContent = plot.message ?? "Expression invalide";
        return;
      }
      // Fenetre calee sur les quantiles : une asymptote n'ecrase pas la
      // courbe, une courbe decalee (x + 100) reste a l'ecran.
      const { yMin, yMax } = autoWindow(plot.samples);
      view = { from, to, yMin, yMax, w, h };
      const X = (x: number) => ((x - from) / (to - from)) * w;
      const Y = (y: number) => h - ((y - yMin) / (yMax - yMin)) * h;

      // Grille et graduations rondes, etiquetees.
      const xt = niceTicks(from, to, Math.max(4, Math.floor(w / 50)));
      const yt = niceTicks(yMin, yMax, Math.max(3, Math.floor(h / 40)));
      ctx.strokeStyle = "#eceff4"; ctx.lineWidth = 1;
      for (const t of xt.ticks) { const gx = X(t); ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
      for (const t of yt.ticks) { const gy = Y(t); ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
      ctx.strokeStyle = "#9aa3b2"; ctx.lineWidth = 1.2;
      const axisY = 0 >= yMin && 0 <= yMax ? Y(0) : null;
      const axisX = 0 >= from && 0 <= to ? X(0) : null;
      if (axisY !== null) { ctx.beginPath(); ctx.moveTo(0, axisY); ctx.lineTo(w, axisY); ctx.stroke(); }
      if (axisX !== null) { ctx.beginPath(); ctx.moveTo(axisX, 0); ctx.lineTo(axisX, h); ctx.stroke(); }
      ctx.fillStyle = "#6b7487"; ctx.font = "10px system-ui, sans-serif";
      const labelY = Math.min(h - 3, Math.max(11, (axisY ?? h) + 11));
      ctx.textAlign = "center";
      for (const t of xt.ticks) {
        if (t === 0 && axisX !== null) continue;
        const gx = X(t);
        if (gx < 10 || gx > w - 10) continue;
        ctx.fillText(tickLabel(t, xt.step), gx, labelY);
      }
      ctx.textAlign = "left";
      const labelX = Math.min(w - 40, Math.max(3, (axisX ?? 0) + 3));
      for (const t of yt.ticks) {
        const gy = Y(t);
        if (gy < 8 || gy > h - 4) continue;
        ctx.fillText(tickLabel(t, yt.step), labelX, gy - 2);
      }

      // Courbe : le trait est coupe sur une asymptote (saut hors fenetre).
      ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2;
      ctx.beginPath();
      let prev: { py: number; out: boolean } | null = null;
      for (const s of plot.samples) {
        if (s.y === null) { prev = null; continue; }
        const px = X(s.x), py = Y(s.y);
        const out = py < -h || py > 2 * h;
        const cy = Math.max(-h, Math.min(2 * h, py));
        if (!prev || ((out || prev.out) && Math.abs(cy - prev.py) > h)) ctx.moveTo(px, cy);
        else ctx.lineTo(px, cy);
        prev = { py: cy, out };
      }
      ctx.stroke();

      const roots = rootsInWindow(fn, from, to);
      ctx.fillStyle = "#dc2626";
      if (axisY !== null) {
        for (const r of roots) { ctx.beginPath(); ctx.arc(X(r), axisY, 3.5, 0, Math.PI * 2); ctx.fill(); }
      }
      const ext = extremaInWindow(fn, from, to);
      const parts: string[] = [];
      parts.push(roots.length
        ? `Racines : ${roots.slice(0, 8).map((r) => fr(round4(r))).join(" ; ")}${roots.length > 8 ? ` … et ${roots.length - 8} autres` : ""}.`
        : "Aucune racine visible.");
      if (ext.length) {
        parts.push(ext.slice(0, 4).map((p) => `${p.kind} (${fr(round4(p.x))} ; ${fr(round4(p.y))})`).join(", ")
          + (ext.length > 4 ? ` … et ${ext.length - 4} autres` : "") + ".");
      }

      // Lecture d'un point au toucher.
      if (readX !== null && readX >= from && readX <= to) {
        const row = valueTable(fn, readX, readX, 1)[0];
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
      const [from, to] = domain();
      const step = (to - from) / 10;
      const rows = valueTable(fnText(), from, to, step);
      table.replaceChildren(el("table", { class: "tbl" },
        el("tr", {}, el("th", {}, "x"), el("th", {}, "y")),
        ...rows.map((r) => el("tr", {}, el("td", {}, fr(r.x)), el("td", {}, r.y.replace(".", ",")))),
      ));
    };

    const lu = this.readLine(() => stripY(fnInput.value), (s) => this.engine.toLatex(s));
    const sync = () => { st.fn = fnInput.value; st.from = fromInput.value; st.to = toInput.value; };
    // Le trace se redessine pendant la frappe (section 7).
    fnInput.addEventListener("input", () => { sync(); lu.update(); draw(); });
    fromInput.addEventListener("input", () => { sync(); draw(); });
    toInput.addEventListener("input", () => { sync(); draw(); });
    onEnter(fnInput, showTable);

    const zoom = (factor: number) => {
      const [from, to] = domain();
      const mid = (from + to) / 2, half = ((to - from) / 2) * factor;
      fromInput.value = String(round4(mid - half));
      toInput.value = String(round4(mid + half));
      sync();
      draw();
    };

    this.body.append(
      el("div", { class: "row" }, el("span", { class: "muted" }, "y ="), fnInput),
      lu.node,
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "de"), fromInput,
        el("span", { class: "muted small" }, "à"), toInput,
        el("button", { title: "Zoom avant", onclick: () => zoom(0.5) }, "+"),
        el("button", { title: "Zoom arrière", onclick: () => zoom(2) }, "−"),
      ),
      box, info,
      el("div", { class: "row" },
        el("button", { onclick: showTable }, "Tableau de valeurs"),
        el("div", { class: "spacer" }),
        el("button", {
          class: "primary",
          onclick: () => {
            if (!this.host.canInsert()) { toast("Ouvre une page d'abord", "warn"); return; }
            if (!fnText()) { toast("Tape une fonction d'abord", "warn"); return; }
            this.host.insertGraph(stripY(fnText()), domain());
            toast("Bloc courbe inséré dans la page");
          },
        }, "Envoyer dans la page"),
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

function round4(v: number): number { return Math.round(v * 1e4) / 1e4; }
/** Nombre a la francaise pour les textes : virgule decimale. */
function fr(v: number): string { return String(v).replace(".", ","); }
