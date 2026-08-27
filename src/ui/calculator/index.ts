import katex from "katex";
import { el, toast } from "../dom";
import { CalcEngine } from "../../core/calc/engine";
import { derivative, nthDerivative, simplifyExpr, substitute, type DerivStep } from "../../core/calc/derive";
import { antiderivative, definiteIntegral } from "../../core/calc/integrate";
import { solveEquation, solveSystem } from "../../core/calc/solve";
import { applyMatrixOp, multiply, addMatrices, parseMatrix, toLatex } from "../../core/calc/matrix";
import { samplePlot, valueTable, rootsInWindow, extremaInWindow, stripY } from "../../core/calc/plot";
import { KEYPAD, FAMILY_CLASS, type Key } from "./keys";

/**
 * Calculatrice flottante (section 7). Fenetre deplacable, positionnable
 * n'importe ou sur la page, ouverte au raccourci clavier.
 *
 * Toute la logique vit dans core/calc : ce fichier ne fait que la montrer.
 */

type Tab = "calcul" | "courbes" | "matrices" | "resoudre" | "litteral";

export interface CalculatorHost {
  /** Insere un bloc graph vivant dans la page courante. */
  insertGraph: (fn: string, domain: [number, number]) => void;
  /** Insere un bloc calc vivant dans la page courante. */
  insertCalc: (expr: string, result: string) => void;
  canInsert: () => boolean;
}

export class Calculator {
  readonly root: HTMLElement;
  private engine = new CalcEngine();
  private tab: Tab = "calcul";
  private second = false;
  private input = "";
  private caret = 0;
  private lastError: string | null = null;
  private body: HTMLElement;
  private visible = false;

  constructor(private host: CalculatorHost) {
    this.body = el("div", { class: "calc-body" });
    this.root = el("div", { class: "calc", style: { display: "none", left: "60px", top: "90px" } },
      this.head(),
      this.tabs(),
      this.body,
    );
    document.body.append(this.root);
    this.render();
  }

  /* ---------------- fenetre ---------------- */

  toggle(): void { this.visible ? this.hide() : this.show(); }

  show(): void {
    this.visible = true;
    this.root.style.display = "flex";
    // Toujours ramenee dans l'ecran : elle a pu etre laissee hors champ.
    const r = this.root.getBoundingClientRect();
    if (r.left + r.width > window.innerWidth) this.root.style.left = `${Math.max(8, window.innerWidth - r.width - 20)}px`;
    if (r.top + r.height > window.innerHeight) this.root.style.top = `${Math.max(8, window.innerHeight - r.height - 20)}px`;
  }

  hide(): void { this.visible = false; this.root.style.display = "none"; }

  get isVisible(): boolean { return this.visible; }

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
      ["resoudre", "Resoudre"],
      ["litteral", "Litteral"],
    ];
    return el("div", { class: "calc-tabs" },
      ...labels.map(([id, label]) =>
        el("button", {
          class: this.tab === id ? "on" : "",
          dataset: { tab: id },
          onclick: () => { this.tab = id; this.refreshTabs(); this.render(); },
        }, label)),
    );
  }

  private refreshTabs() {
    this.root.querySelectorAll<HTMLElement>(".calc-tabs button").forEach((b) => {
      b.classList.toggle("on", b.dataset.tab === this.tab);
    });
  }

  private render() {
    this.body.replaceChildren();
    switch (this.tab) {
      case "calcul":   this.renderCalcul(); break;
      case "courbes":  this.renderCourbes(); break;
      case "matrices": this.renderMatrices(); break;
      case "resoudre": this.renderResoudre(); break;
      case "litteral": this.renderLitteral(); break;
    }
  }

  /* ---------------- onglet Calcul ---------------- */

  private renderCalcul() {
    const screen = el("div", { class: "calc-screen" });
    const read = el("div", { class: "calc-read" });
    const keys = el("div", { class: "keys" });

    const paintScreen = () => {
      screen.replaceChildren();
      // Historique de 3 lignes minimum (section 7).
      for (const h of this.engine.lastLines(3)) {
        screen.append(el("div", { class: "hist" }, `${h.expr} = ${h.text}`));
      }
      screen.append(el("div", { class: "expr" }, this.input || " "));
      const last = this.engine.history.at(-1);
      screen.append(this.lastError
        ? el("div", { class: "err" }, this.lastError)
        : el("div", { class: "res" }, last ? last.text : ""));

      // Reafficher en permanence l'expression telle qu'elle a ete comprise :
      // "sin x^2" est ambigu, l'utilisateur doit voir ce que le moteur a lu.
      read.replaceChildren(el("span", { class: "lbl" }, "Lu par le moteur"));
      const latex = this.engine.toLatex(this.input);
      read.append(latex
        ? renderTex(latex)
        : el("span", { class: "muted" }, this.input ? "expression incomplete" : "-"));
    };

    const press = (k: Key) => {
      const active = this.second && k.second ? k.second : k;
      if (k.action === "second") { this.second = !this.second; paintKeys(); return; }
      if (this.second && k.action === "del") {
        this.input = ""; this.caret = 0; this.lastError = null; this.second = false;
        paintKeys(); paintScreen(); return;
      }
      if (k.action === "del") {
        if (this.caret > 0) {
          this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
          this.caret--;
        }
      } else if (k.action === "left") { this.caret = Math.max(0, this.caret - 1); }
      else if (k.action === "right") { this.caret = Math.min(this.input.length, this.caret + 1); }
      else if (k.action === "mode") {
        this.engine.angleMode = this.engine.angleMode === "RAD" ? "DEG" : "RAD";
        paintKeys();
      } else if (k.action === "equals") { this.compute(); }
      else if (active.insert) {
        this.input = this.input.slice(0, this.caret) + active.insert + this.input.slice(this.caret);
        this.caret += active.insert.length;
      }
      if (this.second) { this.second = false; paintKeys(); }
      paintScreen();
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
          if (!last) { toast("Rien a inserer", "warn"); return; }
          this.host.insertCalc(last.expr, last.text);
          toast("Bloc calcul insere dans la page");
        },
      }, "Envoyer dans la page"));
    }

    this.compute = () => {
      const r = this.engine.evaluate(this.input);
      this.lastError = r.ok ? null : r.message;
      if (r.ok) { this.input = ""; this.caret = 0; }
      paintScreen();
    };

    paintKeys();
    paintScreen();
  }

  private compute: () => void = () => {};

  /** Saisie au clavier quand la calculatrice a le focus. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible || this.tab !== "calcul") return false;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return false;

    if (/^[0-9+\-*/^().,a-zA-Z]$/.test(e.key)) {
      this.input = this.input.slice(0, this.caret) + e.key + this.input.slice(this.caret);
      this.caret++;
      this.render();
      return true;
    }
    if (e.key === "Backspace") {
      if (this.caret > 0) {
        this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
        this.caret--;
      }
      this.render();
      return true;
    }
    if (e.key === "Enter") { this.compute(); this.render(); return true; }
    return false;
  }

  /* ---------------- onglet Courbes ---------------- */

  private renderCourbes() {
    const fnInput = el("input", { type: "text", value: "sin(x) * x / 2", placeholder: "y = f(x)" });
    const fromInput = el("input", { type: "number", value: "-8", style: { width: "88px" } });
    const toInput = el("input", { type: "number", value: "8", style: { width: "88px" } });
    const canvas = el("canvas");
    const info = el("div", { class: "small muted" });
    const box = el("div", { class: "plot-box" }, canvas);
    const table = el("div", { class: "small" });

    const domain = (): [number, number] => {
      const a = Number(fromInput.value), b = Number(toInput.value);
      return Number.isFinite(a) && Number.isFinite(b) && a < b ? [a, b] : [-8, 8];
    };

    const draw = () => {
      const [from, to] = domain();
      const fn = fnInput.value;
      const plot = samplePlot(fn, from, to, 700);
      const ctx = canvas.getContext("2d")!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = box.clientWidth || 400, h = 210;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (!plot.ok || !plot.samples) {
        info.textContent = plot.message ?? "Expression invalide";
        return;
      }
      // Fenetre verticale bornee : une asymptote ne doit pas ecraser la courbe.
      let yMin = plot.yMin!, yMax = plot.yMax!;
      const span = Math.max(Math.abs(yMin), Math.abs(yMax));
      if (span > 60) { yMin = Math.max(yMin, -60); yMax = Math.min(yMax, 60); }
      const pad = (yMax - yMin) * 0.08 || 1;
      yMin -= pad; yMax += pad;

      const X = (x: number) => ((x - from) / (to - from)) * w;
      const Y = (y: number) => h - ((y - yMin) / (yMax - yMin)) * h;

      ctx.strokeStyle = "#eceff4"; ctx.lineWidth = 1;
      for (let i = 0; i <= 10; i++) {
        const gx = (i / 10) * w, gy = (i / 10) * h;
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      }
      ctx.strokeStyle = "#9aa3b2"; ctx.lineWidth = 1.2;
      if (0 >= yMin && 0 <= yMax) { ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke(); }
      if (0 >= from && 0 <= to) { ctx.beginPath(); ctx.moveTo(X(0), 0); ctx.lineTo(X(0), h); ctx.stroke(); }

      ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2;
      ctx.beginPath();
      let pen = false;
      for (const s of plot.samples) {
        if (s.y === null || s.y < yMin - 1e6 || s.y > yMax + 1e6) { pen = false; continue; }
        const px = X(s.x), py = Y(s.y);
        if (!pen) { ctx.moveTo(px, py); pen = true; } else { ctx.lineTo(px, py); }
      }
      ctx.stroke();

      const roots = rootsInWindow(fn, from, to);
      ctx.fillStyle = "#dc2626";
      for (const r of roots) {
        if (0 < yMin || 0 > yMax) break;
        ctx.beginPath(); ctx.arc(X(r), Y(0), 3.5, 0, Math.PI * 2); ctx.fill();
      }
      const ext = extremaInWindow(fn, from, to);
      info.textContent =
        (roots.length ? `Racines : ${roots.map((r) => round4(r)).join(", ")}. ` : "Aucune racine visible. ") +
        (ext.length ? `${ext.length} extremum(s) local(aux).` : "");
    };

    const showTable = () => {
      const [from, to] = domain();
      const step = (to - from) / 10;
      const rows = valueTable(fnInput.value, from, to, step);
      table.replaceChildren(el("table", { class: "tbl" },
        el("tr", {}, el("th", {}, "x"), el("th", {}, "y")),
        ...rows.map((r) => el("tr", {}, el("td", {}, String(r.x)), el("td", {}, r.y))),
      ));
    };

    // Le trace se redessine pendant la frappe (section 7).
    fnInput.addEventListener("input", draw);
    fromInput.addEventListener("input", draw);
    toInput.addEventListener("input", draw);

    const zoom = (factor: number) => {
      const [from, to] = domain();
      const mid = (from + to) / 2, half = ((to - from) / 2) * factor;
      fromInput.value = String(round4(mid - half));
      toInput.value = String(round4(mid + half));
      draw();
    };

    this.body.append(
      el("div", { class: "row" }, el("span", { class: "muted" }, "y ="), fnInput),
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "de"), fromInput,
        el("span", { class: "muted small" }, "a"), toInput,
        el("button", { onclick: () => zoom(0.5) }, "+"),
        el("button", { onclick: () => zoom(2) }, "−"),
      ),
      box, info,
      el("div", { class: "row" },
        el("button", { onclick: showTable }, "Tableau de valeurs"),
        el("div", { class: "spacer" }),
        el("button", {
          class: "primary",
          onclick: () => {
            if (!this.host.canInsert()) { toast("Ouvre une page d'abord", "warn"); return; }
            this.host.insertGraph(stripY(fnInput.value), domain());
            toast("Bloc courbe insere : reouvrable et modifiable");
          },
        }, "Envoyer dans la page"),
      ),
      table,
    );
    queueMicrotask(draw);
  }

  /* ---------------- onglet Matrices ---------------- */

  private renderMatrices() {
    const a = el("textarea", { rows: "3", placeholder: "1 2\n3 4" });
    const b = el("textarea", { rows: "3", placeholder: "0 1\n1 0" });
    a.value = "1 2\n3 4";
    b.value = "0 1\n1 0";
    const out = el("div", { class: "calc-read" });

    const readA = () => parseMatrix(a.value);
    const show = (latex: string | undefined, message?: string) => {
      out.replaceChildren();
      if (message) { out.append(el("span", { class: "err" }, message)); return; }
      if (latex) out.append(renderTex(latex));
    };
    const unary = (op: "det" | "inv" | "transpose" | "rank" | "trace") => {
      const m = readA();
      if (!m) return show(undefined, "Matrice A illisible (lignes de meme longueur)");
      const r = applyMatrixOp(m, op);
      show(r.latex, r.ok ? undefined : r.message);
    };

    this.body.append(
      el("span", { class: "lbl small muted" }, "Matrice A"), a,
      el("div", { class: "row" },
        el("button", { onclick: () => unary("det") }, "det"),
        el("button", { onclick: () => unary("inv") }, "A⁻¹"),
        el("button", { onclick: () => unary("transpose") }, "Aᵀ"),
        el("button", { onclick: () => unary("rank") }, "rang"),
        el("button", { onclick: () => unary("trace") }, "trace"),
      ),
      el("span", { class: "lbl small muted" }, "Matrice B"), b,
      el("div", { class: "row" },
        el("button", {
          onclick: () => {
            const [ma, mb] = [readA(), parseMatrix(b.value)];
            if (!ma || !mb) return show(undefined, "Matrice illisible");
            const r = multiply(ma, mb);
            show(r.latex, r.ok ? undefined : r.message);
          },
        }, "A × B"),
        el("button", {
          onclick: () => {
            const [ma, mb] = [readA(), parseMatrix(b.value)];
            if (!ma || !mb) return show(undefined, "Matrice illisible");
            const r = addMatrices(ma, mb, 1);
            show(r.latex, r.ok ? undefined : r.message);
          },
        }, "A + B"),
        el("button", {
          onclick: () => {
            const [ma, mb] = [readA(), parseMatrix(b.value)];
            if (!ma || !mb) return show(undefined, "Matrice illisible");
            const r = addMatrices(ma, mb, -1);
            show(r.latex, r.ok ? undefined : r.message);
          },
        }, "A − B"),
        el("button", {
          onclick: () => {
            const m = readA();
            if (m) show(toLatex(m));
          },
        }, "Afficher A"),
      ),
      out,
    );
  }

  /* ---------------- onglet Resoudre ---------------- */

  private renderResoudre() {
    const eq = el("input", { type: "text", value: "x^2 - 3x + 2 = 0" });
    const sys = el("textarea", { rows: "3", placeholder: "x + y = 10\nx - y = 2" });
    const out = el("div", {});

    const solveOne = () => {
      const r = solveEquation(eq.value);
      out.replaceChildren();
      if (!r.ok) { out.append(el("div", { class: "calc-read err" }, r.message ?? "Echec")); return; }
      const box = el("div", { class: "calc-read" });
      // Le discriminant et la nature des racines : c'est ce qu'on ecrit
      // sur la copie, pas seulement le resultat.
      if (r.discriminant !== undefined) {
        box.append(el("div", {}, `Discriminant Δ = ${r.discriminant}`));
        if (r.nature) box.append(el("div", { class: "small muted" }, r.nature));
      }
      if (r.method === "numerique") {
        box.append(el("div", { class: "small muted" }, "Resolution numerique sur [-100, 100]"));
      }
      for (const root of r.roots ?? []) {
        box.append(el("div", {}, `x = ${root.text}`));
      }
      if (!r.roots?.length) box.append(el("div", { class: "muted" }, r.message ?? "Aucune solution"));
      out.append(box);
    };

    const solveSys = () => {
      const r = solveSystem(sys.value.split("\n"));
      out.replaceChildren();
      if (!r.ok) { out.append(el("div", { class: "calc-read err" }, r.message ?? "Echec")); return; }
      out.append(el("div", { class: "calc-read" },
        ...Object.entries(r.solution ?? {}).map(([k, v]) => el("div", {}, `${k} = ${v}`)),
      ));
    };

    this.body.append(
      el("span", { class: "lbl small muted" }, "Equation"),
      eq,
      el("div", { class: "row" }, el("button", { class: "primary", onclick: solveOne }, "Resoudre")),
      el("span", { class: "lbl small muted" }, "Systeme, une equation par ligne"),
      sys,
      el("div", { class: "row" }, el("button", { onclick: solveSys }, "Resoudre le systeme")),
      out,
    );
  }

  /* ---------------- onglet Calcul litteral ---------------- */

  private renderLitteral() {
    const expr = el("input", { type: "text", value: "x * sin(x)" });
    const varInput = el("input", { type: "text", value: "x", style: { width: "64px" } });
    const subst = el("input", { type: "text", placeholder: "a=2, b=3" });
    const out = el("div", {});
    let details = false;

    const showResult = (title: string, latex: string | undefined, message?: string) => {
      const box = el("div", { class: "calc-read" }, el("span", { class: "lbl" }, title));
      if (message) box.append(el("span", { class: "err" }, message));
      else if (latex) box.append(renderTex(latex));
      out.replaceChildren(box);
      return box;
    };

    const doDerive = (order: number) => {
      const r = order === 1
        ? derivative(expr.value, varInput.value)
        : nthDerivative(expr.value, varInput.value, order);
      const title = order === 1 ? "Derivee" : `Derivee ${order}e`;
      showResult(title, r.resultLatex, r.ok ? undefined : r.message);
      if (r.ok && r.steps && order === 1) {
        const btn = el("button", {
          onclick: () => {
            details = !details;
            stepsBox.style.display = details ? "block" : "none";
            btn.textContent = details ? "Masquer les details" : "Afficher les details";
          },
        }, details ? "Masquer les details" : "Afficher les details");
        const stepsBox = el("div", { class: "steps", style: { display: details ? "block" : "none" } },
          renderSteps(r.steps));
        out.append(btn, stepsBox);
      }
    };

    this.body.append(
      el("span", { class: "lbl small muted" }, "Expression"),
      expr,
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "variable"), varInput,
        el("button", { class: "primary", onclick: () => doDerive(1) }, "Deriver"),
        el("button", { onclick: () => doDerive(2) }, "Derivee 2e"),
      ),
      el("div", { class: "row" },
        el("button", {
          onclick: () => {
            const r = simplifyExpr(expr.value);
            showResult("Simplifie", r.resultLatex, r.ok ? undefined : r.message);
          },
        }, "Simplifier"),
        el("button", {
          onclick: () => {
            const r = antiderivative(expr.value, varInput.value);
            const box = showResult("Primitive", r.resultLatex, r.ok ? undefined : r.message);
            if (r.ok && r.rule) box.append(el("div", { class: "small muted" }, `Regle : ${r.rule}`));
            if (!r.ok) {
              box.append(el("div", { class: "small muted" },
                "Une integrale definie reste possible ci-dessous, par calcul numerique."));
            }
          },
        }, "Primitive"),
      ),
      el("div", { class: "row" },
        el("span", { class: "muted small" }, "de"),
        el("input", { type: "number", value: "0", id: "int-a", style: { width: "78px" } }),
        el("span", { class: "muted small" }, "a"),
        el("input", { type: "number", value: "1", id: "int-b", style: { width: "78px" } }),
        el("button", {
          onclick: () => {
            const a = Number((this.body.querySelector("#int-a") as HTMLInputElement).value);
            const b = Number((this.body.querySelector("#int-b") as HTMLInputElement).value);
            const r = definiteIntegral(expr.value, varInput.value, a, b);
            const box = showResult("Integrale definie",
              r.ok ? String(round8(r.value!)) : undefined, r.ok ? undefined : r.message);
            if (r.ok) box.append(el("div", { class: "small muted" }, `Methode : ${r.method}`));
          },
        }, "Integrale definie"),
      ),
      el("div", { class: "row" },
        subst,
        el("button", {
          onclick: () => {
            const values: Record<string, number> = {};
            for (const part of subst.value.split(",")) {
              const [k, v] = part.split("=").map((s) => s.trim());
              if (k && v && Number.isFinite(Number(v))) values[k] = Number(v);
            }
            const r = substitute(expr.value, values);
            showResult("Substitution", r.resultLatex, r.ok ? undefined : r.message);
          },
        }, "Substituer"),
      ),
      out,
    );
  }
}

/* ---------------- rendu ---------------- */

export function renderTex(latex: string): HTMLElement {
  const span = el("span", {});
  try {
    span.innerHTML = katex.renderToString(latex, { throwOnError: false, displayMode: false });
  } catch {
    span.textContent = latex;
  }
  return span;
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
function round8(v: number): number { return Math.round(v * 1e8) / 1e8; }
