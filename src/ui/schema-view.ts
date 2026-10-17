/**
 * Schemas dans la page (bloc `schema`) : dessin du bloc dans le texte, et
 * l'editeur qui s'ouvre par-dessus (clavier « tortue » et souris, sans
 * mode). Logique dans core/schema (model, render, symbols, label, templates).
 *
 * Clavier : fleches = fil (Maj : deplacer le curseur sans fil), lettre =
 * composant pose dans le sens du trace (puis sa valeur tapee, une fleche
 * ou Entree la valide), « . » = noeud, Tab = borne libre suivante,
 * Entree = la relier, Ctrl+R tourner, Ctrl+M miroir, Alt+U tension,
 * Alt+I courant, Alt+T texte, Alt+O circuit ouvert, Alt+F court-circuit,
 * Suppr, Ctrl+Z / Ctrl+Y, Ctrl+C / Ctrl+V, Echap = fermer, ? = aide.
 * Souris : glisser depuis un point = fil a angles droits, glisser une
 * piece = la deplacer (ses fils suivent, molette = tourner), glisser un
 * symbole ou une fleche de la palette = le poser la, Alt+glisser le long
 * d'une piece / d'un fil = tension / courant dans le sens du geste,
 * glisser une fleche ou un texte = le deplacer, Ctrl+glisser = selection,
 * double-clic = modifier (nom, valeur, etiquette), clic droit = menu.
 */
import { el, contextMenu, toast } from "./dom";
import { renderTex } from "./tex";
import { altKeyName } from "../core/shortcuts";
import type { SchemaBlock, SchemaPart } from "../core/types";
import { drawSchema, labelBox, type SchemaDrawing, type SchemaLabel } from "../core/schema/render";
import {
  addArrow, addCurrent, addPart, addText, SCHEMA_UNIT, addVoltage, addWire, currentOnWire, deletePart, deleteWire, extractGroup, flipNote,
  freePorts, insertOnWire, mirrorPart, moveGroup, moveNote, movePart, newTurtle, partAt, partBox, partPorts, partsIn, pasteGroup,
  rotatePart, routeOrtho, schemaBounds, shortPart, toggleOpen, turtleConnect, turtleJump, turtleMove,
  turtleNextFree, turtleNode, turtlePlace, wireAt, wirePts, DIRS, type Dir, type Pt, type Rect, type Turtle,
  blockInputAt, freePortNear, portAt, routeAround, samePt, setPartValue, toggleSign,
} from "../core/schema/model";
export { schemaWidth } from "../core/schema/model";
import { PRESETS, SYMBOLS, fitWidth, presetByKey, symbolByLetter, type SymKey } from "../core/schema/symbols";
import { isPartRef, labelTex, labelWidth } from "../core/schema/label";
import { TEMPLATES, templateByKey } from "../core/schema/templates";
export { isPartRef };

const SVG_NS = "http://www.w3.org/2000/svg";

/** Etiquette tapee lue en formule (« R1 » -> R_1, « i_L max » -> i_{L max}), texte tel quel sinon. */
function labelNode(line: string): Node {
  if (isPartRef(line)) return el("span", { class: "sch-ref" }, line);
  const tex = labelTex(line);
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

/** Photo annotee : l'image en fond, sur tout le cadre (unites de grille). */
function bgImage(b: SchemaBlock, url?: string): string {
  if (!b.under || !url) return "";
  const w = b.under.w / SCHEMA_UNIT, h = b.under.h / SCHEMA_UNIT;
  return `<image href="${url.replace(/"/g, "&quot;")}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/>`;
}

/** Dessine le schema dans `node` (bloc de la page : largeur fixee par la figure, hauteur au rapport). */
export function paintSchema(node: HTMLElement, b: SchemaBlock, bg?: string): void {
  const d = drawSchema(b);
  const svg = svgEl(`${bgImage(b, bg)}${d.body}`, d.box);
  const labels = el("div", { class: "sch-labels" });
  placeLabels(labels, d.labels, d.box);
  const frame = el("div", { class: `sch-frame${b.under ? " sch-photo" : ""}` }, svg, labels);
  frame.style.aspectRatio = `${d.box.w} / ${d.box.h}`;
  // Etiquettes a la taille du schema : une case vaut SCHEMA_UNIT unites de page.
  frame.style.setProperty("--sch-cells", String(d.box.w));
  // Courbe ou chronogramme : seulement des annotations (axes, traits, textes), on la dessine.
  if (!b.parts.length && !b.wires.length && !(b.notes ?? []).length && !b.under) {
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
  /** Photo annotee : URL de l'image de fond. */
  background?: string;
}

let openEditor: { close: () => void } | null = null;

/** Un editeur de schema est ouvert (les raccourcis de l'appli le laissent faire). */
export function schemaEditing(): boolean { return !!openEditor; }

/** Valeur tapee juste apres la pose : les pieces qui en ont une. */
const HAS_VALUE = new Set<SymKey>(["R", "C", "Cp", "L", "Pot", "V", "Vdc", "I", "B", "F", "Lamp", "Gain"]);

const INTEGRATOR = PRESETS.B!;

const PALETTE: { sym: SymKey; hint: string; value?: string; label?: string }[] = [
  { sym: "R", hint: "r" }, { sym: "C", hint: "c" }, { sym: "L", hint: "l" }, { sym: "D", hint: "d" },
  { sym: "V", hint: "v" }, { sym: "Vdc", hint: "u" }, { sym: "K", hint: "k" }, { sym: "A", hint: "a" },
  { sym: "Q", hint: "q" }, { sym: "G", hint: "g" }, { sym: "O", hint: "o" }, { sym: "X", hint: "⇧O" },
  { sym: "B", hint: "b" }, { sym: "Gain", hint: "⇧G" }, { sym: "S", hint: "s" },
  { sym: INTEGRATOR.sym, hint: "⇧B", value: INTEGRATOR.value, label: INTEGRATOR.label },
];

/** Outils d'annotation de la palette (un clic les arme, ou les glisser sur la piece ou le fil). */
type Tool = "u" | "i" | "text";
const TOOLS: { tool: Tool; label: string; keys: string; title: string }[] = [
  { tool: "u", label: "Tension", keys: "Alt+U", title: "Flèche de tension : la glisser sur une pièce (ou Alt+glisser le long de la pièce)" },
  { tool: "i", label: "Courant", keys: "Alt+I", title: "Flèche de courant : la glisser sur un fil (ou Alt+glisser le long du fil)" },
  { tool: "text", label: "Texte", keys: "Alt+T", title: "Texte libre : la glisser à sa place" },
];

/** Aide complete (bouton ? ou touche ?). */
const HELP: [string, string][] = [
  ["Glisser depuis un point", "fil à angles droits (accroché aux bornes)"],
  ["Glisser une pièce", "la déplacer, ses fils suivent (molette pendant le geste : tourner)"],
  ["Glisser un symbole de la palette", "le poser là (sur un fil : il s'insère dans le fil)"],
  ["Alt+glisser le long d'une pièce", "flèche de tension dans le sens du geste"],
  ["Alt+glisser le long d'un fil", "flèche de courant dans le sens du geste"],
  ["Alt+glisser ailleurs · Maj+glisser", "flèche libre (axe) · trait droit"],
  ["Glisser une flèche, un texte", "le déplacer (un courant suit les fils, une tension change de côté)"],
  ["Double-clic", "modifier un nom, une valeur, une étiquette (formule : U_K, i_L(t), Δi_L)"],
  ["Ctrl+glisser", "sélectionner plusieurs pièces, puis les glisser ensemble"],
  ["Ctrl+C · Ctrl+V · Ctrl+A", "copier · coller · tout sélectionner"],
  ["Flèches · Maj+flèche", "fil au clavier · aller sans fil"],
  ["Lettre", "composant (r, c, l, d, v, k...) puis sa valeur ; au-dessus d'un fil : posé sur le fil"],
  ["b · Maj+G · s · Maj+B", "schéma-bloc : bloc (s'élargit selon son texte) · gain (triangle) · comparateur · intégrateur ∫dt"],
  ["Clic sur un signe du comparateur", "+ devient −, − devient +"],
  ["Glisser d'une sortie vers une entrée", "boucle de retour tracée seule, par-dessous ou par-dessus (Ctrl+R sur un gain : il pointe à gauche)"],
  ["« . » · Tab · Entrée", "retenir un nœud · borne libre suivante · la relier"],
  ["Ctrl+R · Ctrl+M · Ctrl+flèche", "tourner (une flèche : la retourner) · miroir · déplacer"],
  ["Alt+U · Alt+I · Alt+T", "tension (encore : autre côté) · courant · texte"],
  ["Alt+O · Alt+F", "circuit ouvert à la place de la pièce (encore : la pièce revient) · court-circuit (fil)"],
  ["F2 · Entrée", "renommer · valeur (ou l'étiquette de la flèche choisie)"],
  ["Suppr · Ctrl+Z · Ctrl+Y · Échap", "effacer · annuler · rétablir · fermer"],
];

export function openSchemaEditor(o: EditorOptions): void {
  openEditor?.close();
  const s = o.block;
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
  /** Annotation choisie (clic) : Suppr, Entree, Ctrl+R s'y appliquent. */
  let selNote: number | null = null;
  /** Selection multiple (Ctrl+glisser, Ctrl+A) : pieces et rectangle. */
  let group: { ids: string[]; rect: Rect } | null = null;
  let hover: { part?: string; wire?: { wire: number; seg: number }; pt: Pt; fresh: boolean } | null = null;
  let view = { x: 0, y: 0, w: 30, h: 16 };
  let valueBox: HTMLInputElement | null = null;
  let armed: Tool | null = null;
  let last: SchemaDrawing | null = null;
  let clip: ReturnType<typeof extractGroup> | null = null;
  /** Derniere saisie au clavier : le curseur de trace ne se montre qu'alors (a la souris il ne sert a rien). */
  let kb = false;

  const photoHint = "Glisser : flèche · Maj+glisser : trait droit · clic : texte · Suppr sur une annotation : l'effacer · Ctrl+Z · Échap : fermer (sans annotation, la photo redevient normale)";
  const hintText = "Glisser : fil · Alt+glisser sur une pièce : tension, le long d'un fil : courant · double-clic : modifier · Ctrl+glisser : sélection · ? : tous les raccourcis";
  const hint = el("div", { class: "sch-hint" }, s.under ? photoHint : hintText);
  const help = el("div", { class: "sch-help", hidden: true }, ...HELP.map(([k, v]) => el("div", { class: "sch-help-row" }, el("b", {}, k), el("span", {}, v))));
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  const head = el("div", { class: "sch-head" },
    s.under ? null : el("div", { class: "sch-pal" },
      ...PALETTE.map((p) => {
        const label = p.label ?? SYMBOLS[p.sym].label;
        const btn = el("button", { class: "sch-pal-btn", title: `${label} (${p.hint}) : cliquer pour le poser au curseur, ou le glisser à sa place` },
          el("span", { class: "sch-pal-k" }, p.hint), label);
        paletteDrag(btn, () => { place(p.sym, p.value); root.focus(); }, (at) => dropPart(p.sym, at, p.value));
        return btn;
      }),
      el("span", { class: "sch-pal-sep" }),
      ...TOOLS.map((x) => {
        const btn = el("button", { class: "sch-pal-btn sch-tool", title: x.title }, el("span", { class: "sch-pal-k" }, x.keys), x.label);
        paletteDrag(btn, () => { arm(armed === x.tool ? null : x.tool); root.focus(); }, (at) => dropTool(x.tool, at));
        toolBtns.set(x.tool, btn);
        return btn;
      }),
      el("span", { class: "sch-pal-sep" }),
      el("button", { class: "sch-pal-btn sch-models", title: "Montages, schémas-blocs et chronogrammes prêts à modifier", onclick: (e: MouseEvent) => templatesMenu(e.currentTarget as HTMLElement) }, "Modèles ▾"),
    ),
    hint,
    s.under ? null : el("button", { class: "sch-help-btn", title: "Tous les raccourcis (?)", onclick: () => { help.hidden = !help.hidden; root.focus(); } }, "?"),
    el("button", { class: "sch-close", onclick: () => close() }, "Terminé"),
  );
  const stage = el("div", { class: "sch-stage" });
  const root = el("div", { class: "sch-editor", tabindex: "0", role: "application", "aria-label": "Éditeur de schéma" }, head, help, stage);
  const scrim = el("div", { class: "sch-scrim", onpointerdown: () => close() });

  // Pixels par case : le schema tient dans la largeur (16 a 26 px) ; photo : elle tient dans la largeur.
  let U = 22;
  const fitScale = () => {
    if (s.under) { U = Math.max(8, Math.min(30, (Math.min(window.innerWidth - 64, 1100)) / (s.under.w / SCHEMA_UNIT))); return; }
    const d = drawSchema(s);
    const avail = Math.max(300, (stage.clientWidth || root.clientWidth || 900) - 24);
    U = Math.max(14, Math.min(26, Math.floor(avail / Math.max(20, d.box.w + 6))));
  };

  const toGrid = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const svg = stage.querySelector("svg");
    const r = svg?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: view.x + (e.clientX - r.left) / U, y: view.y + (e.clientY - r.top) / U };
  };
  const overStage = (e: { clientX: number; clientY: number }): boolean => {
    const r = stage.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  const snapPt = (p: { x: number; y: number }): Pt => ({ x: Math.round(p.x), y: Math.round(p.y) });

  let preview: Pt[] | null = null;
  let band: Rect | null = null;
  /** Redessin en cours : le champ de saisie deplace perd le focus, ce n'est pas une validation. */
  let repainting = false;

  const boxRect = (b: { x: number; y: number; w: number; h: number }, cls: string) =>
    `<rect class="${cls}" x="${b.x - 0.3}" y="${b.y - 0.3}" width="${b.w + 0.6}" height="${b.h + 0.6}" rx="0.3"/>`;

  function paint(): void {
    const d = drawSchema(s);
    last = d;
    // Vue qui ne fait que grandir pendant la seance : le dessin ne saute pas.
    const want = { x: Math.min(d.box.x, t.at.x - 4), y: Math.min(d.box.y, t.at.y - 4), x1: Math.max(d.box.x + d.box.w, t.at.x + 8), y1: Math.max(d.box.y + d.box.h, t.at.y + 6) };
    const x0 = Math.min(view.x, want.x), y0 = Math.min(view.y, want.y);
    const minW = Math.max(30, Math.floor(((stage.clientWidth || 700) - 4) / U));
    const minH = Math.max(14, Math.floor(((stage.clientHeight || 300) - 4) / U));
    const x1 = Math.max(view.x + view.w, want.x1, x0 + minW), y1 = Math.max(view.y + view.h, want.y1, y0 + minH);
    view = { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
    // Photo annotee : le cadre de la photo, toujours.
    if (s.under) view = { ...d.box };
    const extra: string[] = [];
    // Points de la grille.
    extra.push(`<pattern id="sch-grid" x="0" y="0" width="1" height="1" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.06" fill="currentColor" opacity="0.35"/></pattern><rect class="sch-grid" x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}" fill="url(#sch-grid)"/>`);
    if (selected) {
      const p = s.parts.find((q) => q.id === selected);
      if (p) extra.push(boxRect(partBox(p), "sch-sel"));
    }
    if (group) {
      for (const id of group.ids) { const p = s.parts.find((q) => q.id === id); if (p) extra.push(boxRect(partBox(p), "sch-sel")); }
      extra.push(`<rect class="sch-band" x="${group.rect.x}" y="${group.rect.y}" width="${group.rect.w}" height="${group.rect.h}"/>`);
    }
    if (band) extra.push(`<rect class="sch-band" x="${band.x}" y="${band.y}" width="${band.w}" height="${band.h}"/>`);
    if (selNote !== null) {
      for (const h of d.hits) if (h.note === selNote) extra.push(`<line class="sch-sel-note" x1="${h.a.x}" y1="${h.a.y}" x2="${h.b.x}" y2="${h.b.y}"/>`);
      for (const l of d.labels) if (l.note === selNote) { const b = labelBox(l); extra.push(`<rect class="sch-sel-note-box" x="${b.x - 0.15}" y="${b.y - 0.1}" width="${b.w + 0.3}" height="${b.h + 0.2}" rx="0.2"/>`); }
    }
    if (hover?.part && hover.part !== selected) {
      const p = s.parts.find((q) => q.id === hover!.part);
      if (p) extra.push(boxRect(partBox(p), "sch-hov"));
    } else if (hover?.wire && s.wires[hover.wire.wire]) {
      const q = wirePts(s.wires[hover.wire.wire]);
      const a = q[hover.wire.seg], b = q[hover.wire.seg + 1];
      if (a && b) extra.push(`<line class="sch-hov-wire" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
    }
    if (preview) extra.push(`<polyline class="sch-preview" points="${preview.map((p) => `${p.x},${p.y}`).join(" ")}"/>`);
    if (t.pick) extra.push(`<circle class="sch-pick" cx="${t.pick.x}" cy="${t.pick.y}" r="0.45"/>`);
    // Bornes libres : un petit rond discret ou accrocher un fil.
    if (!s.under) for (const f of freePorts(s)) extra.push(`<circle class="sch-free" cx="${f.port.x}" cy="${f.port.y}" r="0.2"/>`);
    // Curseur clavier (seulement apres une touche) : un anneau et une pointe
    // de fleche dans le sens ou partira le prochain fil.
    if (kb) {
      const dv = DIRS[t.dir], nx = -dv.y, ny = dv.x;
      const tip = { x: t.at.x + dv.x * 1.1, y: t.at.y + dv.y * 1.1 }, base = { x: t.at.x + dv.x * 0.55, y: t.at.y + dv.y * 0.55 };
      extra.push(`<circle class="sch-cursor" cx="${t.at.x}" cy="${t.at.y}" r="0.3"/><polygon class="sch-cursor-dir" points="${tip.x},${tip.y} ${base.x + nx * 0.3},${base.y + ny * 0.3} ${base.x - nx * 0.3},${base.y - ny * 0.3}"/>`);
    }
    const svg = svgEl(`${bgImage(s, o.background)}<g class="sch-under">${s.under ? "" : extra[0]}</g>${d.body}<g class="sch-over">${extra.slice(1).join("")}</g>`, view);
    svg.style.width = `${view.w * U}px`;
    svg.style.height = `${view.h * U}px`;
    const labels = el("div", { class: "sch-labels" });
    placeLabels(labels, d.labels, view);
    const frame = el("div", { class: `sch-frame sch-frame-edit${s.under ? " sch-photo" : ""}${armed ? " sch-armed" : ""}` }, svg, labels);
    frame.style.width = `${view.w * U}px`;
    frame.style.height = `${view.h * U}px`;
    frame.style.setProperty("--sch-cells", String(view.w));
    const keep = valueBox;
    repainting = true;
    stage.replaceChildren(frame);
    if (keep) { frame.append(keep); keep.focus(); }
    repainting = false;
    for (const [k, btn] of toolBtns) btn.classList.toggle("on", armed === k);
    // Le curseur reste visible.
    const cx = (t.at.x - view.x) * U, cy = (t.at.y - view.y) * U;
    if (cx < stage.scrollLeft + 40 || cx > stage.scrollLeft + stage.clientWidth - 40) stage.scrollLeft = cx - stage.clientWidth / 2;
    if (cy < stage.scrollTop + 40 || cy > stage.scrollTop + stage.clientHeight - 40) stage.scrollTop = cy - stage.clientHeight / 2;
  }

  /* ---- champ de saisie au bon endroit (pas de boite de dialogue) ---- */
  /**
   * Champ pose en (x, y) de la grille ; Entree, Tab ou un clic ailleurs le
   * valident, Echap l'abandonne ; une fleche le valide et la passe (`then`).
   */
  const field = (at: Pt, value: string, placeholder: string, save: (v: string) => void, then?: (key: string) => void) => {
    valueBox?.remove();
    const input = el("input", { class: "sch-value", type: "text", spellcheck: "false", placeholder }) as HTMLInputElement;
    input.value = value;
    input.style.left = `${(at.x - view.x) * U}px`;
    input.style.top = `${(at.y - view.y) * U - 14}px`;
    valueBox = input;
    const done = (ok: boolean, key?: string) => {
      if (valueBox !== input) return;
      valueBox = null;
      input.remove();
      if (ok) save(input.value.trim());
      root.focus();
      if (key) then?.(key);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(false); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); done(true); return; }
      if (then && e.key.startsWith("Arrow") && !e.shiftKey) { e.preventDefault(); done(true, e.key); }
    });
    input.addEventListener("blur", () => { if (!repainting) done(true); });
    stage.querySelector(".sch-frame")?.append(input);
    input.focus();
    input.select();
  };

  /* ---- valeur (ou nom) d'une piece, tapee juste apres la pose ---- */
  const askValue = (part: SchemaPart, which: "value" | "name" = "value", then?: (key: string) => void) => {
    const b = partBox(part);
    const ph = which === "name" ? "nom, ex. R1 ou R_f" : part.sym === "B" ? "fonction de transfert, ex. K/(1+tau p)" : part.sym === "Gain" ? "gain, ex. K, 1/τ, 2mω_0, ω_0^2" : "valeur, ex. 10k";
    field({ x: b.x + b.w + 0.4, y: b.y + b.h / 2 }, (which === "name" ? part.name : part.value) ?? "", ph, (v) => {
      const cur = (which === "name" ? part.name : part.value) ?? "";
      if (v === cur) return;
      edit(() => {
        if (which === "name") { if (v) part.name = v; else delete part.name; }
        else valueOf(part, v);
      });
    }, then);
  };

  /** Etiquette d'une annotation (tension, courant, fleche, texte), lue en formule. */
  const askNote = (i: number) => {
    const n = s.notes?.[i];
    if (!n) return;
    selNote = i;
    paint();
    const l = last?.labels.find((x) => x.note === i);
    const at = l ? { x: l.anchor === "end" ? l.x - 4 : l.anchor === "middle" ? l.x - 2 : l.x, y: l.y } : { x: n.x ?? t.at.x, y: n.y ?? t.at.y };
    field(at, n.label, n.kind === "u" ? "tension, ex. U_K ou u_L(t)" : n.kind === "i" ? "courant, ex. i_L(t)" : "texte, ex. Δi_L ou t_ON", (v) => {
      if (n.kind === "text" && !v) { edit(() => { s.notes!.splice(i, 1); if (!s.notes!.length) delete s.notes; }); selNote = null; return; }
      if (v !== n.label && (v || n.kind === "arrow" || n.kind === "line")) edit(() => { n.label = v; });
    });
  };

  /** Texte libre (Alt+T, outil Texte) : un champ a l'endroit vise, lu en formule a l'affichage. */
  const askText = (at: Pt) => {
    field(at, "", "texte, ex. Ve, K fermé ou Δi_L = i_L max − i_L min", (v) => {
      if (v) edit(() => { addText(s, at, v); });
    });
  };

  /** Valeur d'une piece ; bloc et gain s'elargissent, le curseur clavier suit leur sortie. */
  const valueOf = (part: SchemaPart, v: string) => {
    const moved = setPartValue(s, part.id, v);
    if (moved && samePt(t.at, moved.from)) t.at = { ...moved.to };
  };

  /** Bloc pre-rempli (integrateur) pose sur un fil : deja a la largeur de son texte. */
  const presetWidth = (sym: SymKey, value?: string) => (value ? fitWidth(sym, labelWidth(value) * 0.95) : undefined);

  /* ---- actions ---- */
  function place(sym: SymKey, value?: string): void {
    let placed: SchemaPart | null = null;
    edit(() => {
      // Lettre tapee au-dessus d'un fil (souris) : la piece se pose sur ce fil.
      if (hover?.wire && hover.fresh && SYMBOLS[sym].through) {
        const a0 = wirePts(s.wires[hover.wire.wire])[hover.wire.seg];
        placed = insertOnWire(s, sym, hover.wire.wire, hover.wire.seg, hover.pt, presetWidth(sym, value));
        if (placed && a0) {
          // Le curseur repart de la borne la plus loin du debut du segment (sens du fil).
          const th = SYMBOLS[sym].through!;
          const ends = partPorts(placed).filter((q) => th.includes(q.name));
          const out = ends.sort((p, q) => (Math.abs(q.x - a0.x) + Math.abs(q.y - a0.y)) - (Math.abs(p.x - a0.x) + Math.abs(p.y - a0.y)))[0];
          if (out) t.at = { x: out.x, y: out.y };
        }
      }
      if (!placed) placed = turtlePlace(s, t, sym);
      if (placed && value) valueOf(placed, value);
    });
    if (hover) hover.fresh = false;
    if (!placed) return;
    selected = (placed as SchemaPart).id;
    selNote = null;
    paint();
    if (value) return;
    if (HAS_VALUE.has(sym)) askValue(placed, "value", (key) => arrowKey(key, false));
  }

  /** Symbole glisse depuis la palette : pose la ou on le lache (sur un fil : insere dans le fil). */
  function dropPart(sym: SymKey, g: { x: number; y: number }, value?: string): void {
    let placed: SchemaPart | null = null;
    edit(() => {
      const w = wireAt(s, g, 0.6);
      if (w && SYMBOLS[sym].through) placed = insertOnWire(s, sym, w.wire, w.seg, snapPt(g), presetWidth(sym, value));
      if (!placed) {
        const d = SYMBOLS[sym];
        placed = addPart(s, sym, { x: Math.round(g.x - d.w / 2), y: Math.round(g.y - d.h / 2) });
      }
      if (placed && value) valueOf(placed, value);
    });
    if (!placed) return;
    selected = (placed as SchemaPart).id;
    selNote = null;
    group = null;
    paint();
  }

  /** Piece visee par une commande : celle sous la souris, sinon la piece choisie. */
  const target = (): SchemaPart | undefined =>
    s.parts.find((p) => p.id === hover?.part) ?? s.parts.find((p) => p.id === selected);

  /** Fleche de tension sur une piece, puis son etiquette tapee tout de suite. */
  function voltageOn(p: SchemaPart, flip = false): void {
    let idx = -1;
    edit(() => { const n = addVoltage(s, p); if (flip) n.flip = true; idx = s.notes!.length - 1; });
    selected = p.id;
    if (idx >= 0) askNote(idx);
  }

  /** Fleche de courant sur le fil le plus proche, puis son etiquette. */
  function currentNear(g: { x: number; y: number }, dir?: Dir): boolean {
    let idx = -1;
    edit(() => { if (currentOnWire(s, g, dir)) idx = s.notes!.length - 1; });
    if (idx < 0) return false;
    askNote(idx);
    return true;
  }

  function dropTool(tool: Tool, g: { x: number; y: number }): void {
    arm(null);
    if (tool === "text") { askText(fine(g)); return; }
    if (tool === "u") {
      const p = partAt(s, g);
      if (p) voltageOn(p); else toast("Lâche la flèche de tension sur une pièce", "info", 2500);
      return;
    }
    if (!currentNear(g)) toast("Lâche la flèche de courant sur un fil", "info", 2500);
  }

  function arm(tool: Tool | null): void {
    armed = tool;
    paint();
  }

  /**
   * Bouton de la palette : un clic fait `click`, le glisser jusque sur le
   * schema fait `drop` au point lache (comme on pose une piece dans LTspice).
   */
  function paletteDrag(btn: HTMLElement, click: () => void, drop: (g: { x: number; y: number }) => void): void {
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY;
      let ghost: HTMLElement | null = null;
      const move = (ev: PointerEvent) => {
        if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) {
          ghost = el("div", { class: "sch-ghost" }, btn.textContent?.replace(/^\S+\s*/, "") ?? "");
          document.body.append(ghost);
        }
        if (ghost) { ghost.style.left = `${ev.clientX + 12}px`; ghost.style.top = `${ev.clientY + 8}px`; }
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up, true);
        if (!ghost) { click(); return; }
        ghost.remove();
        if (overStage(ev)) { drop(toGrid(ev)); root.focus(); }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, true);
    });
  }

  function templatesMenu(at: HTMLElement): void {
    const item = (tp: typeof TEMPLATES[number]) => ({ label: tp.label, run: () => insertTemplate(tp.key) });
    contextMenu(at, [
      { title: "Montages" }, ...TEMPLATES.filter((x) => x.group === "Montages").map(item),
      "sep", { title: "Schémas-blocs" }, ...TEMPLATES.filter((x) => x.group === "Schémas-blocs").map(item),
      "sep", { title: "Chronogrammes" }, ...TEMPLATES.filter((x) => x.group === "Chronogrammes").map(item),
    ], { label: "Modèles", onClose: () => root.focus() });
  }

  /** Modele : pose sous le schema existant (ou seul), garde ses noms si libres, choisi en groupe. */
  function insertTemplate(key: string): void {
    const tp = templateByKey(key);
    if (!tp) return;
    const g = tp.build();
    const empty = !s.parts.length && !s.wires.length && !(s.notes ?? []).length;
    let dy = 0;
    if (!empty) {
      const b = schemaBounds(s, 0);
      const gy = Math.min(...g.wires.flatMap((w) => w.pts.filter((_v, k) => k % 2 === 1)), ...g.parts.map((p) => p.y), ...(g.notes ?? []).map((n) => Math.min(n.y ?? Infinity, n.y2 ?? Infinity)));
      dy = Math.ceil(b.y + b.h + 3 - (Number.isFinite(gy) ? gy : 0));
    }
    let ids: string[] = [];
    edit(() => { ids = pasteGroup(s, g, 0, dy, true); });
    selected = null; selNote = null; group = null;
    // Schema vide : la vue repart du modele, a la bonne echelle.
    if (empty) { fitScale(); const d = drawSchema(s); view = { x: Math.floor(d.box.x), y: Math.floor(d.box.y), w: 1, h: 1 }; t.at = startAt(); }
    if (ids.length) {
      const boxes = ids.map((id) => partBox(s.parts.find((p) => p.id === id)!));
      const gx0 = Math.min(...boxes.map((b) => b.x)), gy0 = Math.min(...boxes.map((b) => b.y));
      const gx1 = Math.max(...boxes.map((b) => b.x + b.w)), gy1 = Math.max(...boxes.map((b) => b.y + b.h));
      group = { ids, rect: { x: gx0 - 1, y: gy0 - 1, w: gx1 - gx0 + 2, h: gy1 - gy0 + 2 } };
    }
    paint();
    toast(`${tp.label} : double-clic sur un nom ou une flèche pour le changer`, "info", 3500);
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

  const deleteNote = (i: number) => edit(() => { s.notes!.splice(i, 1); if (!s.notes!.length) delete s.notes; });

  function deleteGroup(): void {
    const g = group;
    if (!g) return;
    edit(() => {
      const inR = (p: { x: number; y: number }) => p.x >= g.rect.x && p.x <= g.rect.x + g.rect.w && p.y >= g.rect.y && p.y <= g.rect.y + g.rect.h;
      s.wires = s.wires.filter((w) => !wirePts(w).every(inR));
      s.notes = (s.notes ?? []).filter((n) => !(n.part ? g.ids.includes(n.part) : n.x !== undefined && n.y !== undefined && inR({ x: n.x, y: n.y })));
      if (!s.notes.length) delete s.notes;
      for (const id of g.ids) deletePart(s, id);
    });
    group = null;
    paint();
  }

  function onKey(e: KeyboardEvent): void {
    if (valueBox) return;
    if (!kb && !["Control", "Shift", "Alt", "Meta"].includes(e.key)) { kb = true; paint(); }
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      if (armed) { arm(null); return; }
      if (group || selNote !== null) { group = null; selNote = null; paint(); return; }
      if (!help.hidden) { help.hidden = true; return; }
      close();
      return;
    }
    if (k === "?" || k === "F1") { e.preventDefault(); help.hidden = !help.hidden; return; }
    if (ctrl && !e.altKey && k.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (ctrl && !e.altKey && k.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    if (ctrl && k.toLowerCase() === "a") {
      e.preventDefault();
      const b = schemaBounds(s, 1);
      group = { ids: s.parts.map((p) => p.id), rect: b };
      selected = null; selNote = null;
      paint();
      return;
    }
    if (ctrl && k.toLowerCase() === "c") {
      e.preventDefault();
      const p = sel();
      clip = group ? extractGroup(s, group.ids, group.rect) : p ? extractGroup(s, [p.id], null) : null;
      if (clip) toast("Copié : Ctrl+V pour coller", "info", 1500);
      return;
    }
    if (ctrl && k.toLowerCase() === "v") {
      e.preventDefault();
      if (!clip) return;
      const c = clip;
      let ids: string[] = [];
      edit(() => { ids = pasteGroup(s, c, 3, 3); });
      // Le morceau colle devient la selection : on le glisse a sa place.
      const boxes = ids.map((id) => partBox(s.parts.find((p) => p.id === id)!));
      if (boxes.length) {
        const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
        group = { ids, rect: { x: x0 - 1, y: y0 - 1, w: Math.max(...boxes.map((b) => b.x + b.w)) - x0 + 2, h: Math.max(...boxes.map((b) => b.y + b.h)) - y0 + 2 } };
        selected = null;
      }
      paint();
      return;
    }
    if (ctrl && k.toLowerCase() === "r") {
      e.preventDefault();
      if (selNote !== null) { const i = selNote; edit(() => flipNote(s, i)); return; }
      const p = sel(); if (p) edit(() => rotatePart(s, p.id));
      return;
    }
    if (ctrl && k.toLowerCase() === "m") { e.preventDefault(); const p = sel(); if (p) edit(() => mirrorPart(s, p.id)); return; }
    if (ctrl && arrowDir(k)) {
      e.preventDefault();
      const dv = DIRS[arrowDir(k)!];
      if (group) { const g = group; edit(() => moveGroup(s, g.ids, g.rect, dv.x, dv.y)); g.rect = { ...g.rect, x: g.rect.x + dv.x, y: g.rect.y + dv.y }; paint(); return; }
      const p = sel();
      if (p) edit(() => movePart(s, p.id, dv.x, dv.y));
      return;
    }
    if (e.altKey && !ctrl) {
      // Option sur Mac tape un autre caractere : touche physique (altKeyName).
      const low = altKeyName(e);
      if (low === "u") {
        e.preventDefault();
        const p = target();
        if (!p) { toast("Survole ou choisis d'abord un composant", "info", 3000); return; }
        // Deja une fleche : Alt+U la passe de l'autre cote, Maj+Alt+U inverse son sens.
        const have = (s.notes ?? []).find((n) => n.kind === "u" && n.part === p.id);
        if (!have) { voltageOn(p, e.shiftKey); return; }
        edit(() => {
          if (e.shiftKey) { if (have.flip) delete have.flip; else have.flip = true; }
          else if (have.other) delete have.other; else have.other = true;
        });
        return;
      }
      if (low === "i") {
        e.preventDefault();
        // Souris sur un fil : la fleche s'y pose ; sinon au curseur clavier.
        if (hover?.wire && currentNear(hover.pt)) return;
        let idx = -1;
        edit(() => { addCurrent(s, t.at, t.dir); idx = s.notes!.length - 1; });
        if (idx >= 0) askNote(idx);
        return;
      }
      if (low === "t") { e.preventDefault(); askText(hover && !hover.part ? fine(hover.pt) : { x: t.at.x, y: t.at.y - 1 }); return; }
      if (low === "o") {
        e.preventDefault();
        const p = target();
        if (!p) { toast("Survole ou choisis d'abord un composant", "info", 3000); return; }
        let ok = false;
        edit(() => { ok = toggleOpen(s, p.id); });
        if (!ok) toast("Seul un dipôle se remplace par un circuit ouvert", "info", 2500);
        return;
      }
      if (low === "f") {
        e.preventDefault();
        const p = target();
        if (p) { edit(() => shortPart(s, p.id)); selected = null; paint(); }
        return;
      }
      return;
    }
    if (ctrl) return;
    if (arrowDir(k)) { e.preventDefault(); arrowKey(k, e.shiftKey); return; }
    if (k === "Tab") { e.preventDefault(); turtleNextFree(s, t, e.shiftKey); paint(); return; }
    if (k === "Enter") {
      e.preventDefault();
      if (t.pick) { edit(() => { turtleConnect(s, t); }); return; }
      if (selNote !== null) { askNote(selNote); return; }
      const p = sel();
      if (p) askValue(p, "value");
      return;
    }
    if (k === "F2") {
      e.preventDefault();
      if (selNote !== null) { askNote(selNote); return; }
      const p = sel(); if (p) askValue(p, "name");
      return;
    }
    if (k === ".") { e.preventDefault(); turtleNode(t); paint(); return; }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      if (group) { deleteGroup(); return; }
      if (selNote !== null) { const i = selNote; selNote = null; deleteNote(i); return; }
      const p = sel();
      if (p) { edit(() => deletePart(s, p.id)); selected = null; paint(); return; }
      // Annotation sous la souris (fleche, trait, texte), sinon le fil survole.
      const ni = hover ? noteUnder(hover.pt) : -1;
      if (ni >= 0) { deleteNote(ni); return; }
      if (hover?.wire) { const w = hover.wire.wire; edit(() => deleteWire(s, w)); hover = null; paint(); }
      return;
    }
    if (k.length === 1 && /[a-z]/i.test(k)) {
      const pre = presetByKey(k);
      if (pre) { e.preventDefault(); place(pre.sym, pre.value); return; }
      const def = symbolByLetter(k);
      if (def) { e.preventDefault(); place(def.key); }
    }
  }

  function doUndo(): void {
    const prev = undo.pop();
    if (!prev) return;
    redo.push(snap());
    restore(prev);
    selected = null; selNote = null; group = null;
    paint();
    o.onChange();
  }
  function doRedo(): void {
    const next = redo.pop();
    if (!next) return;
    undo.push(snap());
    restore(next);
    selNote = null; group = null;
    paint();
    o.onChange();
  }

  /* ---- souris ---- */
  /** Annotation sous le point : trait d'une fleche (tension, courant, libre), puis son etiquette. */
  function noteUnder(g: { x: number; y: number }): number {
    if (!last) return -1;
    for (let k = last.hits.length - 1; k >= 0; k--) {
      const h = last.hits[k];
      const dx = h.b.x - h.a.x, dy = h.b.y - h.a.y;
      const L = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((g.x - h.a.x) * dx + (g.y - h.a.y) * dy) / L));
      if (Math.hypot(g.x - (h.a.x + u * dx), g.y - (h.a.y + u * dy)) <= 0.4) return h.note;
    }
    const l = labelUnder(g);
    return l?.note ?? -1;
  }
  function labelUnder(g: { x: number; y: number }): SchemaLabel | null {
    if (!last) return null;
    for (let k = last.labels.length - 1; k >= 0; k--) {
      const b = labelBox(last.labels[k]);
      if (g.x >= b.x - 0.15 && g.x <= b.x + b.w + 0.15 && g.y >= b.y - 0.1 && g.y <= b.y + b.h + 0.1) return last.labels[k];
    }
    return null;
  }

  let drag: { kind: "part"; id: string; last: Pt; moved: boolean }
    | { kind: "group"; last: Pt; moved: boolean }
    | { kind: "note"; index: number; from: { x: number; y: number }; moved: boolean }
    | { kind: "band"; from: { x: number; y: number }; moved: boolean }
    | { kind: "wire"; from: Pt; moved: boolean; vertical?: boolean }
    | { kind: "arrow" | "line"; from: { x: number; y: number }; to: { x: number; y: number }; moved: boolean; part?: string; onWire?: boolean }
    | null = null;
  /** Annotation : au quart de case pres (une photo n'a pas de grille). */
  const fine = (p: { x: number; y: number }) => ({ x: Math.round(p.x * 4) / 4, y: Math.round(p.y * 4) / 4 });
  /** Trait droit : aimante a l'horizontale, la verticale ou 45 degres. */
  const straight = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return fine({ x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len });
  };
  const startUndo = () => undo.push(snap());
  /**
   * Fil glisse : a angles droits (le 1er mouvement choisit). Vers l'entree
   * d'un schema-bloc (bloc, gain, comparateur : aimantee a pres d'une case)
   * ou depuis une sortie de schema-bloc : chemin qui contourne les pieces,
   * par-dessous ou par-dessus (boucle de retour en un geste).
   */
  const wireRoute = (from: Pt, g: { x: number; y: number }, vertical?: boolean): Pt[] => {
    const near = freePortNear(s, g, 0.9);
    const to = near && blockInputAt(s, near) ? near : snapPt(g);
    const src = portAt(s, from);
    const fromOut = !!src && ["B", "Gain", "S"].includes(src.part.sym) && src.port.name === "out";
    if (!samePt(from, to) && (blockInputAt(s, to) || (fromOut && portAt(s, to)))) return routeAround(s, from, to);
    return routeOrtho(from, to, vertical);
  };

  stage.addEventListener("pointermove", (e) => {
    const g = toGrid(e);
    if (drag?.kind === "part" || drag?.kind === "group") {
      const p = snapPt(g);
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      if (dx || dy) {
        if (!drag.moved) startUndo();
        drag.moved = true;
        if (drag.kind === "part") movePart(s, drag.id, dx, dy);
        else if (group) { moveGroup(s, group.ids, group.rect, dx, dy); group.rect = { ...group.rect, x: group.rect.x + dx, y: group.rect.y + dy }; }
        drag.last = p;
        paint();
      }
      return;
    }
    if (drag?.kind === "note") {
      const dn = drag;
      const n = s.notes?.[dn.index];
      if (!n) return;
      if (!drag.moved && Math.hypot(g.x - drag.from.x, g.y - drag.from.y) < 0.35) return;
      if (!drag.moved) startUndo();
      drag.moved = true;
      if (n.kind === "u") {
        // Tension : la glisser de l'autre cote de la piece la change de cote.
        const part = s.parts.find((p) => p.id === n.part);
        const h = last?.hits.find((x) => x.note === dn.index);
        if (part && h) {
          const b = partBox(part);
          const horizontal = h.a.y === h.b.y;
          const axis = horizontal ? b.y + b.h / 2 : b.x + b.w / 2;
          const arrowSide = Math.sign((horizontal ? h.a.y : h.a.x) - axis);
          const mouseSide = Math.sign((horizontal ? g.y : g.x) - axis);
          if (mouseSide && arrowSide && mouseSide !== arrowSide) { if (n.other) delete n.other; else n.other = true; }
        }
      } else {
        moveNote(s, drag.index, g, drag.from);
        if (n.kind !== "i") drag.from = { x: drag.from.x + (Math.round((g.x - drag.from.x) * 4) / 4), y: drag.from.y + (Math.round((g.y - drag.from.y) * 4) / 4) };
      }
      paint();
      return;
    }
    if (drag?.kind === "band") {
      drag.moved = true;
      band = { x: Math.min(drag.from.x, g.x), y: Math.min(drag.from.y, g.y), w: Math.abs(g.x - drag.from.x), h: Math.abs(g.y - drag.from.y) };
      paint();
      return;
    }
    if (drag && (drag.kind === "arrow" || drag.kind === "line")) {
      drag.to = drag.kind === "line" ? straight(drag.from, g) : fine(g);
      drag.moved = drag.moved || Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y) > 0.4;
      preview = drag.moved ? [drag.from as Pt, drag.to as Pt] : null;
      paint();
      return;
    }
    if (drag?.kind === "wire") {
      const p = snapPt(g);
      if (!drag.moved && (p.x !== drag.from.x || p.y !== drag.from.y)) {
        drag.moved = true;
        // Premier mouvement : il decide si le fil part a l'horizontale ou a la verticale.
        drag.vertical = Math.abs(g.y - drag.from.y) > Math.abs(g.x - drag.from.x);
      }
      preview = drag.moved ? wireRoute(drag.from, g, drag.vertical) : null;
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
    kb = false;
    root.focus();
    stage.setPointerCapture(e.pointerId);
    const g = toGrid(e);
    const ctrl = e.ctrlKey || e.metaKey;
    const now = performance.now();
    const twice = now - lastDown.t < 450 && Math.hypot(g.x - lastDown.x, g.y - lastDown.y) < 0.6;
    lastDown = twice ? { t: 0, x: 0, y: 0 } : { t: now, x: g.x, y: g.y };
    if (twice && !armed && !e.altKey && !e.shiftKey && !ctrl && !s.under) { drag = null; onDouble(g); return; }
    // Outil arme (clic dans la palette) : il se pose la ou on clique.
    if (armed) { dropTool(armed, g); return; }
    const part = partAt(s, g);
    if (!e.altKey && !e.shiftKey && !ctrl && !s.under) {
      // Une fleche ou une etiquette d'annotation : la choisir, la glisser.
      const ni = noteUnder(g);
      const lab = ni < 0 ? labelUnder(g) : null;
      if (ni >= 0) {
        selNote = ni; selected = null; group = null;
        drag = { kind: "note", index: ni, from: g, moved: false };
        paint();
        return;
      }
      if (lab?.sign && lab.part) {
        const id = lab.part, port = lab.sign;
        drag = null;
        edit(() => { toggleSign(s, id, port); });
        return;
      }
      if (lab?.part) { selected = lab.part; selNote = null; group = null; drag = { kind: "part", id: lab.part, last: snapPt(g), moved: false }; paint(); return; }
    }
    if (part && group?.ids.includes(part.id) && !e.altKey) { drag = { kind: "group", last: snapPt(g), moved: false }; return; }
    if (part && !e.altKey && !e.shiftKey && !ctrl) {
      selected = part.id; selNote = null; group = null;
      drag = { kind: "part", id: part.id, last: snapPt(g), moved: false };
      paint();
      return;
    }
    selected = null; selNote = null;
    if (group && !ctrl) { group = null; }
    // Ctrl+glisser : rectangle de selection.
    if (ctrl && !s.under) { drag = { kind: "band", from: g, moved: false }; return; }
    // Alt+glisser : tension (sur une piece), courant (le long d'un fil), sinon fleche libre ;
    // Maj+glisser : trait droit ; sur une photo, glisser = fleche.
    if (e.shiftKey) drag = { kind: "line", from: fine(g), to: fine(g), moved: false };
    else if (e.altKey && !s.under && part) drag = { kind: "arrow", from: g, to: g, moved: false, part: part.id };
    else if (e.altKey && !s.under && wireAt(s, g, 0.5)) drag = { kind: "arrow", from: g, to: g, moved: false, onWire: true };
    else if (e.altKey || s.under) drag = { kind: "arrow", from: fine(g), to: fine(g), moved: false };
    else drag = { kind: "wire", from: snapPt(g), moved: false };
    paint();
  });
  stage.addEventListener("pointerup", (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "part" || d.kind === "group") {
      if (d.moved) { redo.length = 0; o.onChange(); }
      return;
    }
    if (d.kind === "note") {
      if (d.moved) { redo.length = 0; o.onChange(); }
      return;
    }
    if (d.kind === "band") {
      const r = band;
      band = null;
      if (r && d.moved) {
        const ids = partsIn(s, r);
        group = ids.length || r.w * r.h > 1 ? { ids, rect: r } : null;
      }
      paint();
      return;
    }
    if (d.kind === "arrow" || d.kind === "line") {
      preview = null;
      const g = toGrid(e);
      // Geste le long d'une piece : tension, dans le sens du geste.
      if (d.part) {
        const p = s.parts.find((x) => x.id === d.part);
        const def = p && SYMBOLS[p.sym as SymKey];
        if (p && def?.through && Math.hypot(g.x - d.from.x, g.y - d.from.y) > 0.4) {
          const ports = partPorts(p);
          const pa = ports.find((q) => q.name === def.through![0])!, pb = ports.find((q) => q.name === def.through![1])!;
          // Sans retournement la fleche va de b vers a.
          const flip = (g.x - d.from.x) * (pa.x - pb.x) + (g.y - d.from.y) * (pa.y - pb.y) < 0;
          const have = (s.notes ?? []).findIndex((n) => n.kind === "u" && n.part === p.id);
          if (have >= 0) { edit(() => { const n = s.notes![have]; if (flip) n.flip = true; else delete n.flip; }); return; }
          voltageOn(p, flip);
          return;
        }
        paint();
        return;
      }
      // Geste le long d'un fil : courant dans le sens du geste.
      if (d.onWire) {
        const dx = g.x - d.from.x, dy = g.y - d.from.y;
        if (Math.hypot(dx, dy) > 0.4) {
          const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
          currentNear(d.from, dir);
          return;
        }
        paint();
        return;
      }
      if (d.moved) {
        let idx = -1;
        edit(() => { addArrow(s, d.from, d.to, d.kind === "line"); idx = s.notes!.length - 1; });
        // Axe d'un chronogramme : on tape son nom tout de suite (Echap : sans nom).
        if (!s.under && d.kind === "arrow" && idx >= 0) askNote(idx);
        return;
      }
      paint();
      // Simple clic sur une photo : un texte a cet endroit (apres le redessin, qui remplacerait le champ).
      if (s.under) askText(fine(toGrid(e)));
      return;
    }
    if (d.kind !== "wire") return;
    const wd = d;
    const route = wireRoute(wd.from, toGrid(e), wd.vertical);
    const to = route[route.length - 1];
    preview = null;
    if (wd.moved && (to.x !== wd.from.x || to.y !== wd.from.y)) {
      edit(() => addWire(s, route));
      t.at = to;
      t.dir = to.x !== wd.from.x && !wd.vertical ? (to.x > wd.from.x ? "right" : "left") : (to.y > wd.from.y ? "down" : "up");
    } else {
      // Simple clic : le curseur clavier vient ici.
      t.at = wd.from;
      t.pick = undefined;
    }
    paint();
  });
  // Molette pendant qu'on glisse une piece : elle tourne (comme dans LTspice avec Ctrl+R).
  stage.addEventListener("wheel", (e) => {
    if (drag?.kind !== "part") return;
    e.preventDefault();
    if (!drag.moved) { startUndo(); drag.moved = true; }
    rotatePart(s, drag.id);
    paint();
  }, { passive: false });
  /**
   * Double appui : le dessin est refait a chaque appui (l'element vise est
   * remplace), le navigateur ne voit donc jamais de « dblclick » ; on le
   * reconnait nous-memes (deux appuis a moins de 450 ms, au meme endroit).
   */
  let lastDown = { t: 0, x: 0, y: 0 };
  function onDouble(g: { x: number; y: number }): void {
    const ni = noteUnder(g);
    if (ni >= 0) { askNote(ni); return; }
    const lab = labelUnder(g);
    const part = lab?.part ? s.parts.find((p) => p.id === lab.part) : partAt(s, g);
    if (part) { selected = part.id; selNote = null; paint(); askValue(part, lab?.field === "name" ? "name" : "value"); }
  }
  stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const g = toGrid(e);
    const ni = noteUnder(g);
    if (ni >= 0) {
      const n = s.notes![ni];
      selNote = ni; selected = null;
      paint();
      contextMenu({ x: e.clientX, y: e.clientY }, [
        { label: "Modifier l'étiquette…", keys: "Entrée", run: () => askNote(ni) },
        ...(n.kind === "text" ? [] : [{ label: "Inverser le sens", keys: "Ctrl+R", run: () => edit(() => flipNote(s, ni)) }]),
        ...(n.kind === "u" ? [{ label: "Autre côté", keys: "Alt+U", run: () => edit(() => { if (n.other) delete n.other; else n.other = true; }) }] : []),
        ...(n.kind === "line" || n.kind === "arrow" ? [{ label: n.dash ? "Trait plein" : "Pointillés", run: () => edit(() => { if (n.dash) delete n.dash; else n.dash = true; }) }] : []),
        "sep",
        { label: "Supprimer", keys: "Suppr", danger: true, run: () => { selNote = null; deleteNote(ni); } },
      ], { label: "Annotation", onClose: () => root.focus() });
      return;
    }
    const part = partAt(s, g);
    if (part) {
      selected = part.id;
      paint();
      const dip = !!SYMBOLS[part.sym as SymKey]?.through;
      contextMenu({ x: e.clientX, y: e.clientY }, [
        { label: "Valeur…", keys: "Entrée", run: () => askValue(part, "value") },
        { label: "Renommer…", keys: "F2", run: () => askValue(part, "name") },
        { label: "Tourner", keys: "Ctrl+R", run: () => edit(() => rotatePart(s, part.id)) },
        { label: "Miroir", keys: "Ctrl+M", run: () => edit(() => mirrorPart(s, part.id)) },
        { label: "Flèche de tension", keys: "Alt+U", run: () => voltageOn(part) },
        ...(dip ? [
          { label: part.sym === "X" ? "Remettre la pièce" : "Circuit ouvert à sa place", keys: "Alt+O", run: () => edit(() => toggleOpen(s, part.id)) },
          { label: "Court-circuit (un fil à sa place)", keys: "Alt+F", run: () => { edit(() => shortPart(s, part.id)); selected = null; paint(); } },
        ] : []),
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
        { label: "Flèche de courant ici", keys: "Alt+I", run: () => { currentNear(g, dir); } },
        { label: "Supprimer le fil", danger: true, run: () => edit(() => deleteWire(s, w.wire)) },
      ], { label: "Fil", onClose: () => root.focus() });
    }
  });
  root.addEventListener("keydown", onKey);

  /* ---- place et fermeture ---- */
  // Grand editeur, centre : le schema entier se voit, la page reste derriere.
  const W = Math.min(window.innerWidth - 32, 1180);
  const H = Math.min(window.innerHeight - 72, 760);
  root.style.width = `${W}px`;
  root.style.height = `${H}px`;
  root.style.left = `${Math.max(16, (window.innerWidth - W) / 2)}px`;
  root.style.top = `${Math.max(56, (window.innerHeight - H) / 2 + 16)}px`;
  document.body.append(scrim, root);
  fitScale();
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
  const tex = labelTex(line) ?? line;
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
export function schemaSvgString(b: SchemaBlock, px = 16, bg?: string): { svg: string; w: number; h: number } {
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
  const svg = `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="${d.box.x} ${d.box.y} ${d.box.w} ${d.box.h}" style="color:#16181d"><rect x="${d.box.x}" y="${d.box.y}" width="${d.box.w}" height="${d.box.h}" fill="#ffffff"/>${bgImage(b, bg)}<g style="color:${b.under ? "#d92d20" : "#16181d"}">${d.body}</g>${texts}</svg>`;
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
