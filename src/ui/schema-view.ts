/**
 * Schemas dans la page (bloc `schema`) : dessin du bloc dans le texte, et
 * l'editeur qui s'ouvre par-dessus (clavier « tortue » et souris, sans
 * mode). Logique dans core/schema (model, render, symbols).
 *
 * Clavier : fleches = fil (Maj : deplacer le curseur sans fil), lettre =
 * composant pose dans le sens du trace (puis sa valeur tapee, une fleche
 * ou Entree la valide), « . » = noeud, Tab = borne libre suivante,
 * Entree = la relier, Ctrl+R tourner, Ctrl+M miroir, Alt+U tension,
 * Alt+I courant, Alt+T texte, Suppr, Ctrl+Z / Ctrl+Y, Echap = fermer.
 * Souris : glisser depuis un point = fil a angles droits, glisser une
 * piece = la deplacer (ses fils suivent), lettre au-dessus d'un fil = la
 * piece posee sur ce fil, double-clic = valeur, clic droit = menu.
 */
import { el, contextMenu, toast } from "./dom";
import { renderTex } from "./tex";
import { forceFormula } from "../core/text/automath";
import type { SchemaBlock, SchemaPart } from "../core/types";
import { drawSchema, type SchemaLabel } from "../core/schema/render";
import {
  addCurrent, addText, addVoltage, addWire, deletePart, deleteWire, freePorts, insertOnWire, mirrorPart, movePart,
  newTurtle, partAt, partBox, partPorts, rotatePart, routeOrtho, schemaBounds, turtleConnect, turtleJump, turtleMove,
  turtleNextFree, turtleNode, turtlePlace, wireAt, wirePts, DIRS, type Dir, type Pt, type Turtle,
} from "../core/schema/model";
export { schemaWidth } from "../core/schema/model";
import { SYMBOLS, symbolByLetter, type SymKey } from "../core/schema/symbols";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Etiquette tapee lue en formule (« R1 » -> R_1, « 10k » -> 10 k), texte tel quel sinon. */
/**
 * Reference de composant (« 1N4148 », « BC547 », « TL081 ») ou parametre
 * LTspice (« {R1/2} ») : du texte, jamais une formule (1 N_4148).
 */
export function isPartRef(line: string): boolean {
  const t = line.trim();
  return /[{}]/.test(t) || /^\d?[A-Za-z]{1,4}\d{2,}[A-Za-z0-9-]*$/.test(t) && !/^[A-Za-z]\d{1,2}$/.test(t);
}

function labelNode(line: string): Node {
  if (isPartRef(line)) return el("span", { class: "sch-ref" }, line);
  const tex = forceFormula(line);
  return tex ? renderTex(tex) : document.createTextNode(line);
}

function svgEl(body: string, box: { x: number; y: number; w: number; h: number }): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
  svg.setAttribute("class", "sch-svg");
  svg.innerHTML = body;
  return svg;
}

function placeLabels(layer: HTMLElement, labels: SchemaLabel[], box: { x: number; y: number; w: number; h: number }): void {
  for (const l of labels) {
    const node = el("div", { class: `sch-label sch-${l.anchor}` }, ...l.lines.map((t) => el("div", {}, labelNode(t))));
    node.style.left = `${((l.x - box.x) / box.w) * 100}%`;
    node.style.top = `${((l.y - box.y) / box.h) * 100}%`;
    if (l.part) node.dataset.part = l.part;
    if (l.note !== undefined) node.dataset.note = String(l.note);
    layer.append(node);
  }
}

/** Dessine le schema dans `node` (bloc de la page : largeur fixee par la figure, hauteur au rapport). */
export function paintSchema(node: HTMLElement, b: SchemaBlock): void {
  const d = drawSchema(b);
  const svg = svgEl(d.body, d.box);
  const labels = el("div", { class: "sch-labels" });
  placeLabels(labels, d.labels, d.box);
  const frame = el("div", { class: "sch-frame" }, svg, labels);
  frame.style.aspectRatio = `${d.box.w} / ${d.box.h}`;
  // Etiquettes a la taille du schema : une case vaut SCHEMA_UNIT unites de page.
  frame.style.setProperty("--sch-cells", String(d.box.w));
  if (!b.parts.length && !b.wires.length) {
    node.replaceChildren(el("div", { class: "sch-empty" }, "Schéma vide : un appui l'ouvre"));
    return;
  }
  node.replaceChildren(frame);
}

/* ---------------- editeur ---------------- */

interface EditorOptions {
  block: SchemaBlock;
  /** Figure du bloc dans la page : l'editeur s'ouvre par-dessus. */
  anchor: HTMLElement;
  /** Apres chaque modification : redessiner le bloc, enregistrer. */
  onChange: () => void;
  onClose: () => void;
}

let openEditor: { close: () => void } | null = null;

/** Un editeur de schema est ouvert (les raccourcis de l'appli le laissent faire). */
export function schemaEditing(): boolean { return !!openEditor; }

/** Valeur tapee juste apres la pose : les pieces qui en ont une. */
const HAS_VALUE = new Set<SymKey>(["R", "C", "Cp", "L", "Pot", "V", "Vdc", "I", "B", "F", "Lamp"]);

const PALETTE: { sym: SymKey; hint: string }[] = [
  { sym: "R", hint: "r" }, { sym: "C", hint: "c" }, { sym: "L", hint: "l" }, { sym: "D", hint: "d" },
  { sym: "V", hint: "v" }, { sym: "Vdc", hint: "u" }, { sym: "K", hint: "k" }, { sym: "A", hint: "a" },
  { sym: "Q", hint: "q" }, { sym: "G", hint: "g" }, { sym: "O", hint: "o" }, { sym: "B", hint: "b" }, { sym: "S", hint: "s" },
];

export function openSchemaEditor(o: EditorOptions): void {
  openEditor?.close();
  const s = o.block;
  const U = 22; // pixels par case dans l'editeur
  const undo: string[] = [];
  const redo: string[] = [];
  const snap = () => JSON.stringify({ parts: s.parts, wires: s.wires, notes: s.notes ?? null });
  const restore = (j: string) => {
    const v = JSON.parse(j) as { parts: SchemaPart[]; wires: { pts: number[] }[]; notes: SchemaBlock["notes"] | null };
    s.parts = v.parts; s.wires = v.wires;
    if (v.notes) s.notes = v.notes; else delete s.notes;
  };
  /** Une modification : instantane pour Ctrl+Z, puis redessin et enregistrement. */
  const edit = (fn: () => void) => {
    const before = snap();
    fn();
    if (snap() === before) { paint(); return; }
    undo.push(before);
    if (undo.length > 200) undo.shift();
    redo.length = 0;
    paint();
    o.onChange();
  };

  // Curseur clavier : sur la premiere borne libre, sinon a droite du schema.
  const startAt = (): Pt => {
    const f = freePorts(s)[0];
    if (f) return { x: f.port.x, y: f.port.y };
    if (!s.parts.length && !s.wires.length) return { x: 2, y: 4 };
    const b = schemaBounds(s, 0);
    return { x: b.x + b.w + 3, y: b.y + 2 };
  };
  const t: Turtle = newTurtle(startAt());
  let selected: string | null = null;
  let hover: { part?: string; wire?: { wire: number; seg: number }; pt: Pt; fresh: boolean } | null = null;
  let view = { x: 0, y: 0, w: 30, h: 16 };
  let valueBox: HTMLInputElement | null = null;

  const head = el("div", { class: "sch-head" },
    el("div", { class: "sch-pal" }, ...PALETTE.map((p) => el("button", {
      class: "sch-pal-btn", title: `${SYMBOLS[p.sym].label} (${p.hint})`,
      onclick: () => { place(p.sym); root.focus(); },
    }, el("span", { class: "sch-pal-k" }, p.hint), SYMBOLS[p.sym].label))),
    el("div", { class: "sch-hint" },
      "Flèches : fil · lettre : composant puis sa valeur · « . » : nœud · Tab, Entrée : relier · Maj+flèche : aller sans fil · Ctrl+R : tourner · Alt+U : tension (encore : autre côté, Maj : sens) · Alt+I : courant · Suppr · Ctrl+Z · Échap : fermer"),
    el("button", { class: "sch-close", onclick: () => close() }, "Terminé"),
  );
  const stage = el("div", { class: "sch-stage" });
  const root = el("div", { class: "sch-editor", tabindex: "0", role: "application", "aria-label": "Éditeur de schéma" }, head, stage);
  const scrim = el("div", { class: "sch-scrim", onpointerdown: () => close() });

  const toGrid = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const svg = stage.querySelector("svg");
    const r = svg?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: view.x + (e.clientX - r.left) / U, y: view.y + (e.clientY - r.top) / U };
  };
  const snapPt = (p: { x: number; y: number }): Pt => ({ x: Math.round(p.x), y: Math.round(p.y) });

  let preview: Pt[] | null = null;

  function paint(): void {
    const d = drawSchema(s);
    // Vue qui ne fait que grandir pendant la seance : le dessin ne saute pas.
    const want = { x: Math.min(d.box.x, t.at.x - 4), y: Math.min(d.box.y, t.at.y - 4), x1: Math.max(d.box.x + d.box.w, t.at.x + 8), y1: Math.max(d.box.y + d.box.h, t.at.y + 6) };
    const x0 = Math.min(view.x, want.x), y0 = Math.min(view.y, want.y);
    const x1 = Math.max(view.x + view.w, want.x1, x0 + 30), y1 = Math.max(view.y + view.h, want.y1, y0 + 14);
    view = { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
    const extra: string[] = [];
    // Points de la grille.
    extra.unshift(`<pattern id="sch-grid" x="0" y="0" width="1" height="1" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.06" fill="currentColor" opacity="0.35"/></pattern><rect class="sch-grid" x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}" fill="url(#sch-grid)"/>`);
    if (selected) {
      const p = s.parts.find((q) => q.id === selected);
      if (p) { const b = partBox(p); extra.push(`<rect class="sch-sel" x="${b.x - 0.3}" y="${b.y - 0.3}" width="${b.w + 0.6}" height="${b.h + 0.6}" rx="0.3"/>`); }
    }
    if (hover?.part && hover.part !== selected) {
      const p = s.parts.find((q) => q.id === hover!.part);
      if (p) { const b = partBox(p); extra.push(`<rect class="sch-hov" x="${b.x - 0.3}" y="${b.y - 0.3}" width="${b.w + 0.6}" height="${b.h + 0.6}" rx="0.3"/>`); }
    } else if (hover?.wire) {
      const q = wirePts(s.wires[hover.wire.wire]);
      const a = q[hover.wire.seg], b = q[hover.wire.seg + 1];
      if (a && b) extra.push(`<line class="sch-hov-wire" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
    }
    if (preview) extra.push(`<polyline class="sch-preview" points="${preview.map((p) => `${p.x},${p.y}`).join(" ")}"/>`);
    if (t.pick) extra.push(`<circle class="sch-pick" cx="${t.pick.x}" cy="${t.pick.y}" r="0.45"/>`);
    // Curseur clavier : point bleu et petite fleche dans le sens du trace.
    const dv = DIRS[t.dir];
    extra.push(`<circle class="sch-cursor" cx="${t.at.x}" cy="${t.at.y}" r="0.32"/><line class="sch-cursor-dir" x1="${t.at.x}" y1="${t.at.y}" x2="${t.at.x + dv.x * 0.9}" y2="${t.at.y + dv.y * 0.9}"/>`);
    const svg = svgEl(`<g class="sch-under">${extra[0]}</g>${d.body}<g class="sch-over">${extra.slice(1).join("")}</g>`, view);
    svg.style.width = `${view.w * U}px`;
    svg.style.height = `${view.h * U}px`;
    const labels = el("div", { class: "sch-labels" });
    placeLabels(labels, d.labels, view);
    const frame = el("div", { class: "sch-frame sch-frame-edit" }, svg, labels);
    frame.style.width = `${view.w * U}px`;
    frame.style.height = `${view.h * U}px`;
    frame.style.setProperty("--sch-cells", String(view.w));
    const keep = valueBox;
    stage.replaceChildren(frame);
    if (keep) frame.append(keep);
    // Le curseur reste visible.
    const cx = (t.at.x - view.x) * U, cy = (t.at.y - view.y) * U;
    if (cx < stage.scrollLeft + 40 || cx > stage.scrollLeft + stage.clientWidth - 40) stage.scrollLeft = cx - stage.clientWidth / 2;
    if (cy < stage.scrollTop + 40 || cy > stage.scrollTop + stage.clientHeight - 40) stage.scrollTop = cy - stage.clientHeight / 2;
  }

  /* ---- valeur tapee juste apres la pose (pas de boite de dialogue) ---- */
  const askValue = (part: SchemaPart, field: "value" | "name" = "value", then?: (key: string) => void) => {
    valueBox?.remove();
    const b = partBox(part);
    const input = el("input", {
      class: "sch-value", type: "text", spellcheck: "false",
      placeholder: field === "name" ? "nom" : part.sym === "B" ? "fonction de transfert, ex. K/(1+tau p)" : "valeur, ex. 10k",
    }) as HTMLInputElement;
    input.value = (field === "name" ? part.name : part.value) ?? "";
    input.style.left = `${(b.x + b.w + 0.4 - view.x) * U}px`;
    input.style.top = `${(b.y + b.h / 2 - view.y) * U - 14}px`;
    valueBox = input;
    const done = (save: boolean, key?: string) => {
      if (valueBox !== input) return;
      valueBox = null;
      input.remove();
      const v = input.value.trim();
      const cur = (field === "name" ? part.name : part.value) ?? "";
      if (save && v !== cur) {
        edit(() => {
          if (field === "name") { if (v) part.name = v; else delete part.name; }
          else if (v) part.value = v; else delete part.value;
        });
      }
      root.focus();
      if (key) then?.(key);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(false); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); done(true); return; }
      if (e.key.startsWith("Arrow") && !e.shiftKey) { e.preventDefault(); done(true, e.key); }
    });
    input.addEventListener("blur", () => done(true));
    stage.querySelector(".sch-frame")?.append(input);
    input.focus();
  };

  /** Texte libre (Alt+T) : un champ au curseur, lu en formule a l'affichage. */
  const askText = (at: Pt) => {
    valueBox?.remove();
    const input = el("input", { class: "sch-value", type: "text", spellcheck: "false", placeholder: "texte, ex. Ve ou Ra = 1k" }) as HTMLInputElement;
    input.style.left = `${(at.x - view.x) * U}px`;
    input.style.top = `${(at.y - view.y) * U - 14}px`;
    valueBox = input;
    const done = (save: boolean) => {
      if (valueBox !== input) return;
      valueBox = null;
      input.remove();
      const v = input.value.trim();
      if (save && v) edit(() => { addText(s, at, v); });
      root.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); done(true); }
    });
    input.addEventListener("blur", () => done(true));
    stage.querySelector(".sch-frame")?.append(input);
    input.focus();
  };

  /* ---- actions ---- */
  function place(sym: SymKey): void {
    let placed: SchemaPart | null = null;
    edit(() => {
      // Lettre tapee au-dessus d'un fil (souris) : la piece se pose sur ce fil.
      if (hover?.wire && hover.fresh && SYMBOLS[sym].through) {
        placed = insertOnWire(s, sym, hover.wire.wire, hover.wire.seg, hover.pt);
        if (placed) {
          const out = partPorts(placed).find((q) => q.name === SYMBOLS[sym].through![1]);
          if (out) t.at = { x: out.x, y: out.y };
        }
      }
      if (!placed) placed = turtlePlace(s, t, sym);
    });
    if (hover) hover.fresh = false;
    if (!placed) return;
    selected = (placed as SchemaPart).id;
    paint();
    if (HAS_VALUE.has(sym)) askValue(placed, "value", (key) => arrowKey(key, false));
  }

  const arrowDir = (key: string): Dir | null =>
    key === "ArrowRight" ? "right" : key === "ArrowLeft" ? "left" : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
  function arrowKey(key: string, shift: boolean): void {
    const d = arrowDir(key);
    if (!d) return;
    if (shift) { turtleJump(t, d); paint(); return; }
    edit(() => turtleMove(s, t, d));
  }

  const sel = (): SchemaPart | undefined => s.parts.find((p) => p.id === selected);

  function onKey(e: KeyboardEvent): void {
    if (valueBox) return;
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); close(); return; }
    if (ctrl && !e.altKey && k.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (ctrl && !e.altKey && k.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    if (ctrl && k.toLowerCase() === "r") { e.preventDefault(); const p = sel(); if (p) edit(() => rotatePart(s, p.id)); return; }
    if (ctrl && k.toLowerCase() === "m") { e.preventDefault(); const p = sel(); if (p) edit(() => mirrorPart(s, p.id)); return; }
    if (ctrl && arrowDir(k)) {
      e.preventDefault();
      const p = sel();
      const dv = DIRS[arrowDir(k)!];
      if (p) edit(() => movePart(s, p.id, dv.x, dv.y));
      return;
    }
    if (e.altKey && !ctrl) {
      const low = (e.code.startsWith("Key") ? e.code.slice(3) : k).toLowerCase();
      if (low === "u") {
        e.preventDefault();
        const p = sel();
        if (!p) { toast("Choisis d'abord un composant (clic ou le dernier posé)", "info", 3000); return; }
        // Deja une fleche : Alt+U la passe de l'autre cote, Maj+Alt+U inverse son sens.
        const have = (s.notes ?? []).find((n) => n.kind === "u" && n.part === p.id);
        edit(() => {
          if (!have) { const n = addVoltage(s, p); if (e.shiftKey) n.flip = true; }
          else if (e.shiftKey) { if (have.flip) delete have.flip; else have.flip = true; }
          else if (have.other) delete have.other; else have.other = true;
        });
        return;
      }
      if (low === "i") { e.preventDefault(); edit(() => { addCurrent(s, t.at, t.dir); }); return; }
      if (low === "t") { e.preventDefault(); askText({ x: t.at.x, y: t.at.y - 1 }); return; }
      return;
    }
    if (ctrl) return;
    if (arrowDir(k)) { e.preventDefault(); arrowKey(k, e.shiftKey); return; }
    if (k === "Tab") { e.preventDefault(); turtleNextFree(s, t, e.shiftKey); paint(); return; }
    if (k === "Enter") {
      e.preventDefault();
      if (t.pick) { edit(() => { turtleConnect(s, t); }); return; }
      const p = sel();
      if (p) askValue(p, "value");
      return;
    }
    if (k === "F2") { e.preventDefault(); const p = sel(); if (p) askValue(p, "name"); return; }
    if (k === ".") { e.preventDefault(); turtleNode(t); paint(); return; }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      const p = sel();
      if (p) { edit(() => deletePart(s, p.id)); selected = null; paint(); return; }
      if (hover?.wire) { const w = hover.wire.wire; edit(() => deleteWire(s, w)); hover = null; paint(); }
      return;
    }
    if (k.length === 1 && /[a-z]/i.test(k)) {
      const def = symbolByLetter(k);
      if (def) { e.preventDefault(); place(def.key); }
    }
  }

  function doUndo(): void {
    const prev = undo.pop();
    if (!prev) return;
    redo.push(snap());
    restore(prev);
    selected = null;
    paint();
    o.onChange();
  }
  function doRedo(): void {
    const next = redo.pop();
    if (!next) return;
    undo.push(snap());
    restore(next);
    paint();
    o.onChange();
  }

  /* ---- souris ---- */
  let drag: { kind: "part"; id: string; last: Pt; moved: boolean } | { kind: "wire"; from: Pt; moved: boolean; vertical?: boolean } | null = null;

  stage.addEventListener("pointermove", (e) => {
    const g = toGrid(e);
    if (drag?.kind === "part") {
      const p = snapPt(g);
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      if (dx || dy) {
        if (!drag.moved) undo.push(snap());
        drag.moved = true;
        movePart(s, drag.id, dx, dy);
        drag.last = p;
        paint();
      }
      return;
    }
    if (drag?.kind === "wire") {
      const p = snapPt(g);
      if (!drag.moved && (p.x !== drag.from.x || p.y !== drag.from.y)) {
        drag.moved = true;
        // Premier mouvement : il decide si le fil part a l'horizontale ou a la verticale.
        drag.vertical = Math.abs(g.y - drag.from.y) > Math.abs(g.x - drag.from.x);
      }
      preview = drag.moved ? routeOrtho(drag.from, p, drag.vertical) : null;
      paint();
      return;
    }
    const part = partAt(s, g);
    const wire = part ? null : wireAt(s, g);
    const prevKey = JSON.stringify([hover?.part, hover?.wire]);
    hover = { pt: g, fresh: true, ...(part ? { part: part.id } : {}), ...(wire ? { wire } : {}) };
    if (JSON.stringify([hover.part, hover.wire]) !== prevKey) paint();
  });
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".sch-value")) return;
    e.preventDefault();
    root.focus();
    stage.setPointerCapture(e.pointerId);
    const g = toGrid(e);
    const part = partAt(s, g);
    if (part) {
      selected = part.id;
      drag = { kind: "part", id: part.id, last: snapPt(g), moved: false };
      paint();
      return;
    }
    selected = null;
    drag = { kind: "wire", from: snapPt(g), moved: false };
  });
  stage.addEventListener("pointerup", (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "part") {
      if (d.moved) { redo.length = 0; o.onChange(); }
      return;
    }
    const to = snapPt(toGrid(e));
    preview = null;
    if (d.moved && (to.x !== d.from.x || to.y !== d.from.y)) {
      edit(() => addWire(s, routeOrtho(d.from, to, d.vertical)));
      t.at = to;
      t.dir = to.x !== d.from.x && !d.vertical ? (to.x > d.from.x ? "right" : "left") : (to.y > d.from.y ? "down" : "up");
    } else {
      // Simple clic : le curseur clavier vient ici.
      t.at = d.from;
      t.pick = undefined;
    }
    paint();
  });
  stage.addEventListener("dblclick", (e) => {
    const part = partAt(s, toGrid(e));
    if (part) { selected = part.id; paint(); askValue(part, "value"); }
  });
  stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const g = toGrid(e);
    const part = partAt(s, g);
    if (part) {
      selected = part.id;
      paint();
      contextMenu({ x: e.clientX, y: e.clientY }, [
        { label: "Valeur…", keys: "Entrée", run: () => askValue(part, "value") },
        { label: "Renommer…", keys: "F2", run: () => askValue(part, "name") },
        { label: "Tourner", keys: "Ctrl+R", run: () => edit(() => rotatePart(s, part.id)) },
        { label: "Miroir", keys: "Ctrl+M", run: () => edit(() => mirrorPart(s, part.id)) },
        { label: "Flèche de tension", keys: "Alt+U", run: () => edit(() => { addVoltage(s, part); }) },
        "sep",
        { label: "Supprimer", keys: "Suppr", danger: true, run: () => { edit(() => deletePart(s, part.id)); selected = null; paint(); } },
      ], { label: SYMBOLS[part.sym as SymKey]?.label ?? "Composant", onClose: () => root.focus() });
      return;
    }
    const w = wireAt(s, g);
    if (w) {
      const q = wirePts(s.wires[w.wire]);
      const a = q[w.seg], b = q[w.seg + 1];
      const dir: Dir = a.y === b.y ? (b.x > a.x ? "right" : "left") : (b.y > a.y ? "down" : "up");
      contextMenu({ x: e.clientX, y: e.clientY }, [
        { label: "Flèche de courant ici", keys: "Alt+I", run: () => edit(() => { addCurrent(s, snapPt(g), dir); }) },
        { label: "Supprimer le fil", danger: true, run: () => edit(() => deleteWire(s, w.wire)) },
      ], { label: "Fil", onClose: () => root.focus() });
    }
  });
  root.addEventListener("keydown", onKey);

  /* ---- place et fermeture ---- */
  const r = o.anchor.getBoundingClientRect();
  const W = Math.min(window.innerWidth - 32, Math.max(720, r.width + 40));
  const H = Math.min(window.innerHeight - 96, 480);
  root.style.width = `${W}px`;
  root.style.height = `${H}px`;
  root.style.left = `${Math.max(16, Math.min(r.left - 20, window.innerWidth - W - 16))}px`;
  root.style.top = `${Math.max(64, Math.min(r.top - 50, window.innerHeight - H - 16))}px`;
  document.body.append(scrim, root);
  paint();
  root.focus();

  function close(): void {
    if (openEditor !== handle) return;
    openEditor = null;
    valueBox?.blur();
    root.remove();
    scrim.remove();
    o.onClose();
  }
  const handle = { close };
  openEditor = handle;
}

/* ---------------- export (Word) ---------------- */

const TEX_CHARS: Record<string, string> = {
  Omega: "Ω", mu: "µ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", tau: "τ", omega: "ω",
  varepsilon: "ε", epsilon: "ε", theta: "θ", lambda: "λ", pi: "π", phi: "φ", varphi: "φ", rho: "ρ", sigma: "σ",
  infty: "∞", cdot: "·", times: "×", pm: "±",
};

/**
 * Etiquette en texte SVG (indices en <tspan>), pour une image sans KaTeX :
 * « R1 » -> R puis 1 en indice, « 10 kΩ », « K/(1+τp) » tel quel.
 */
function labelSvgText(line: string): string {
  if (isPartRef(line)) return line.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  const tex = forceFormula(line) ?? line;
  let s = tex
    .replace(/\\(?:mathrm|text|operatorname)\{([^{}]*)\}/g, "$1")
    .replace(/\\left|\\right/g, "")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\[,;: !]/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_a, n: string) => TEX_CHARS[n] ?? n);
  const out: string[] = [];
  const escx = (x: string) => x.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;")).replace(/[{}]/g, "");
  // Indices : _{abc} ou _a, en petit et decales vers le bas.
  for (;;) {
    const m = /_(\{[^{}]*\}|.)/.exec(s);
    if (!m) break;
    out.push(escx(s.slice(0, m.index)));
    const sub = m[1].startsWith("{") ? m[1].slice(1, -1) : m[1];
    out.push(`<tspan font-size="70%" dy="0.3em">${escx(sub)}</tspan><tspan dy="-0.3em">​</tspan>`);
    s = s.slice(m.index + m[0].length);
  }
  out.push(escx(s.replace(/\^\{([^{}]*)\}/g, "^$1")));
  return out.join("");
}

/**
 * Schema complet en SVG autonome (geometrie + etiquettes en <text>), fond
 * blanc, `px` pixels par case : pour l'export Word (rendu en PNG).
 */
export function schemaSvgString(b: SchemaBlock, px = 16): { svg: string; w: number; h: number } {
  const d = drawSchema(b);
  const w = Math.round(d.box.w * px), h = Math.round(d.box.h * px);
  const texts = d.labels.map((l) => {
    const anchor = l.anchor === "start" ? "start" : l.anchor === "end" ? "end" : "middle";
    const n = l.lines.length;
    return l.lines.map((line, i) => {
      const y = l.y + (i - (n - 1) / 2) * 1.15;
      return `<text x="${l.x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" font-size="0.95" font-family="Cambria, 'Times New Roman', serif" font-style="italic" fill="#16181d" stroke="none">${labelSvgText(line)}</text>`;
    }).join("");
  }).join("");
  const svg = `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="${d.box.x} ${d.box.y} ${d.box.w} ${d.box.h}" style="color:#16181d"><rect x="${d.box.x}" y="${d.box.y}" width="${d.box.w}" height="${d.box.h}" fill="#ffffff"/>${d.body}${texts}</svg>`;
  return { svg, w, h };
}

/* ---------------- import LTspice ---------------- */

/** Selecteur de fichier .asc ; null : ferme sans choix. */
export function pickAsc(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept: ".asc", style: { display: "none" } }) as HTMLInputElement;
    let done = false;
    const finish = (f: File | null) => { if (done) return; done = true; input.remove(); resolve(f); };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** Texte d'un .asc : ASCII ou UTF-16 (selon la version de LTspice). */
async function ascText(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 3 && buf[1] === 0 && buf[3] === 0);
  if (utf16) return new TextDecoder("utf-16le").decode(buf).replace(/^\uFEFF/, "");
  // Anciennes versions : Windows-1252 (« µ » sur un octet) ; UTF-8 sinon.
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, ""); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

/** Schema LTspice lu en bloc schema (symboles francais), avec les symboles non reconnus. */
export async function importLtspiceFile(file: File, id: string): Promise<{ block: SchemaBlock; skipped: string[] } | null> {
  const { importAsc } = await import("../core/schema/ltspice");
  const r = importAsc(await ascText(file), id);
  return r.block.parts.length || r.block.wires.length ? r : null;
}
