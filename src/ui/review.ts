/**
 * Vue de revision filtree par couleur (lot 11) : « tous les theoremes de
 * Maths », « toutes les definitions d'Elec ». Logique dans core/review.ts
 * (extraction, groupement) et storage/search.ts (collectReview) ; ici le
 * DOM : filtres en puces (44 px), extraits groupes par intercalaire et
 * page, vignettes d'encre redessinees depuis les points, export PDF.
 * Clavier : fleches haut/bas entre les extraits, gauche/droite dans une
 * rangee de puces, Entree ouvre, 1 a 5 basculent une couleur, Echap revient.
 */

import { el, toast } from "./dom";
import { renderTex } from "./tex";
import { PALETTE, colorOf, labelOf } from "../core/palette";
import { PAGE_W } from "../core/ink/sheet";
import { widthAt, type Bounds } from "../core/ink/stroke";
import { REVIEW_COLORS, whereLabel, type ReviewItem, type ReviewResult } from "../core/review";
import { collectReview } from "../core/storage/search";
import type { Repo } from "../core/storage/repo";
import type { ColorKey, InkPoint, Stroke } from "../core/types";

/** Filtres de la vue, gardes par l'appli d'une ouverture a l'autre (Alt+← y revient). */
export interface ReviewState {
  /** Matiere (dossier) ; absente = toutes. */
  notebook?: string;
  colors: ColorKey[];
  /** Intercalaire ou dossier parent ; absent = tous. */
  divider?: string;
  /** Extrait qui avait le clavier, et defilement : retrouves au retour. */
  focusKey?: string;
  scroll?: number;
}

/** Ou est un extrait. */
export interface ReviewWhere { notebook: string; divider: string; page: number }

export interface ReviewHost {
  repo: Repo;
  /** Ouvre la page a l'endroit de l'extrait (Alt+← revient ici). */
  openItem: (where: ReviewWhere, item: ReviewItem) => void;
  /** Ouvre la page en haut (titre « Cours p. 4 »). */
  openPage: (where: ReviewWhere) => void;
}

/** Points d'un trait (passe par ici seulement : le format des points peut changer). */
function pointsOf(s: Stroke): readonly InkPoint[] {
  return s.points;
}

/** Opacite du surligneur, comme sur la page (canvas.ts). */
const HIGHLIGHT_ALPHA = 0.4;
/** Marge autour de l'encre recadree, en unites de page. */
const CROP_PAD = 10;
/** Echelle d'une vignette (px CSS par unite de page) et bornes d'affichage. */
const VIGNETTE_SCALE = 0.8;
const VIGNETTE_MAX_W = 620;
const VIGNETTE_MAX_H = 280;

/**
 * Vignette d'un extrait d'encre : les traits redessines depuis leurs points
 * (jamais une capture de la page), recadres sur leur cadre, a la densite de
 * l'ecran (ou 3 pour l'impression) : nets a tout zoom.
 */
export function drawVignette(item: ReviewItem, density = window.devicePixelRatio || 1): HTMLCanvasElement {
  const canvas = el("canvas", { class: "review-ink" });
  const box = item.box;
  const strokes = item.strokes ?? [];
  if (!box || !strokes.length) return canvas;
  const crop: Bounds = { x: box.x - CROP_PAD, y: box.y - CROP_PAD, w: box.w + 2 * CROP_PAD, h: box.h + 2 * CROP_PAD };
  const s = Math.min(VIGNETTE_SCALE, VIGNETTE_MAX_W / crop.w, VIGNETTE_MAX_H / crop.h);
  const cssW = Math.max(1, Math.round(crop.w * s)), cssH = Math.max(1, Math.round(crop.h * s));
  canvas.width = Math.round(cssW * density);
  canvas.height = Math.round(cssH * density);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const k = s * density;
  ctx.setTransform(k, 0, 0, k, -crop.x * k, -crop.y * k);
  ctx.lineJoin = "round";
  // Surligneur d'abord, sous l'encre, comme sur la page.
  for (const st of strokes) if (st.tool === "highlighter") paintStroke(ctx, st);
  for (const st of strokes) if (st.tool !== "highlighter") paintStroke(ctx, st);
  return canvas;
}

function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const pts = pointsOf(s);
  if (!pts.length) return;
  ctx.strokeStyle = colorOf(s.color, s.tool);
  if (s.tool === "highlighter") {
    ctx.globalAlpha = HIGHLIGHT_ALPHA;
    ctx.lineCap = "butt";
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.lineCap = "round";
  if (pts.length === 1) {
    // Un point seul (point du i) : un disque.
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, widthAt(s.width, pts[0].p) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    ctx.lineWidth = widthAt(s.width, (a.p + b.p) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

/** Texte tape d'un extrait : formules rendues (KaTeX), jamais le LaTeX brut. */
function textNode(item: ReviewItem): HTMLElement {
  const out = el("div", { class: "review-text" });
  for (const t of item.tokens ?? []) {
    if (t.kind === "br") out.append(el("br"));
    else if (t.kind === "math") out.append(renderTex(t.latex));
    else {
      let n: HTMLElement | Text = document.createTextNode(t.text);
      if (t.italic) n = el("i", {}, n);
      if (t.bold) n = el("b", {}, n);
      out.append(n);
    }
  }
  return out;
}

const KIND_LABEL: Record<ReviewItem["kind"], string> = {
  text: "", ink: "écriture", math: "formule manuscrite", zone: "zone texte", highlight: "surlignage",
};

/**
 * Corps d'un extrait. `vignette` dessine l'encre (a l'ecran : a la demande,
 * quand l'extrait arrive a l'ecran ; a l'impression : tout de suite, en
 * densite 3, en image).
 */
function itemBody(item: ReviewItem, vignette: (item: ReviewItem) => HTMLElement): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (item.kind === "text") parts.push(textNode(item));
  else if (item.kind === "math" && item.latex) {
    const tex = renderTex(item.latex);
    tex.classList.add("review-tex");
    parts.push(tex);
  } else if (item.kind === "zone" && item.plain) parts.push(el("div", { class: "review-text" }, item.plain));
  else {
    parts.push(vignette(item));
    const under = (item.strokes ?? []).some((s) => s.tool === "pen");
    if (item.plain) parts.push(el("div", { class: "review-caption" }, `Lu : ${item.plain}`));
    else if (item.kind === "highlight" && !under) {
      parts.push(el("div", { class: "review-caption" }, "Surlignage sur le texte tapé : ouvrir la page pour le lire"));
    }
  }
  return parts;
}

function chip(label: string | Node, on: boolean, onclick: () => void, extra: Record<string, unknown> = {}): HTMLButtonElement {
  return el("button", {
    class: `review-chip${on ? " on" : ""}`, "aria-pressed": String(on), onclick, ...extra,
  }, label);
}

/** Intercalaires proposes : chacun, et leurs dossiers parents (« S1 » pour « S1/Chapitre 1 »). */
function dividerOptions(dividers: string[]): string[] {
  const out: string[] = [];
  for (const d of dividers) {
    const parts = d.replace(/\\/g, "/").split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** Libelle des couleurs choisies, pour le titre et le nom du PDF. */
function colorsTitle(colors: readonly ColorKey[]): string {
  if (colors.length === REVIEW_COLORS.length) return "Toutes les couleurs";
  return colors.map((c) => labelOf(c)).join(", ");
}

export function buildReviewView(host: ReviewHost, onBack: () => void, state: ReviewState): HTMLElement {
  const inner = el("div", { class: "screen-inner review" });
  const screen = el("div", { class: "screen review-screen" }, inner);
  const exportBtn = el("button", { title: "Exporter cette fiche de révision en PDF" }, "Exporter en PDF");
  inner.append(el("div", { class: "row" },
    el("button", { onclick: onBack, title: "Retour (Échap)" }, "Retour"),
    el("h1", { style: { margin: "0 0 0 8px" } }, "Réviser"),
    el("div", { class: "spacer" }),
    exportBtn,
  ));
  const nbRow = el("div", { class: "review-chips", role: "group", "aria-label": "Matière" });
  const colorRow = el("div", { class: "review-chips", role: "group", "aria-label": "Couleurs" });
  const divRow = el("div", { class: "review-chips", role: "group", "aria-label": "Intercalaire" });
  const info = el("div", { class: "muted small review-info" });
  const list = el("div", { class: "review-list" });
  inner.append(
    el("div", { class: "review-filters" },
      el("div", { class: "review-filter" }, el("span", { class: "review-filter-label" }, "Matière"), nbRow),
      el("div", { class: "review-filter" }, el("span", { class: "review-filter-label" }, "Couleurs"), colorRow),
      el("div", { class: "review-filter", hidden: true }, el("span", { class: "review-filter-label" }, "Intercalaire"), divRow),
    ),
    info, list,
  );

  let notebooks: { dir: string; title: string; color: string }[] = [];
  let dividers: string[] = [];
  let result: (ReviewResult & { pages: number }) | null = null;
  let token = 0;
  let restore = state.focusKey != null || state.scroll != null;

  /** Vignettes dessinees quand elles arrivent a l'ecran : 400 extraits ne coutent rien d'avance. */
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const slot = e.target as HTMLElement & { draw?: () => void };
          io?.unobserve(slot);
          slot.draw?.();
        }
      }, { root: screen, rootMargin: "400px" })
    : null;
  const lazyVignette = (item: ReviewItem): HTMLElement => {
    const box = item.box;
    const slot = el("div", { class: "review-ink-slot" }) as HTMLElement & { draw?: () => void };
    if (box) {
      const s = Math.min(VIGNETTE_SCALE, VIGNETTE_MAX_W / (box.w + 2 * CROP_PAD), VIGNETTE_MAX_H / (box.h + 2 * CROP_PAD));
      slot.style.width = `${Math.round((box.w + 2 * CROP_PAD) * s)}px`;
      slot.style.height = `${Math.round((box.h + 2 * CROP_PAD) * s)}px`;
    }
    slot.draw = () => slot.replaceChildren(drawVignette(item));
    if (io) io.observe(slot); else slot.draw();
    return slot;
  };

  const paintFilters = () => {
    // La puce qui avait le clavier le garde apres le repeint (rangee, rang).
    const active = document.activeElement as HTMLElement | null;
    const row = [nbRow, colorRow, divRow].find((r) => active && r.contains(active));
    const at = row ? [...row.children].indexOf(active!) : -1;
    nbRow.replaceChildren(
      chip("Toutes", !state.notebook, () => setNotebook(undefined)),
      ...notebooks.map((n) => chip(
        el("span", { class: "review-chip-in" }, el("i", { class: "dot", style: { background: n.color } }), n.title),
        state.notebook === n.dir, () => setNotebook(n.dir),
      )),
    );
    const counts = result?.byColor;
    colorRow.replaceChildren(
      chip("Toutes", state.colors.length === REVIEW_COLORS.length, () => setColors([...REVIEW_COLORS])),
      ...PALETTE.map((p) => chip(
        el("span", { class: "review-chip-in" },
          el("i", { class: "dot", style: { background: p.ink } }), p.label,
          counts ? el("span", { class: "review-count" }, String(counts[p.key] ?? 0)) : null),
        state.colors.includes(p.key),
        () => toggleColor(p.key),
        { title: `${p.label} : afficher ou masquer (touche ${p.shortcut})`, style: `--c: ${p.ink}` },
      )),
    );
    const showDiv = !!state.notebook && dividers.length > 1;
    (divRow.parentElement as HTMLElement).hidden = !showDiv;
    if (showDiv) {
      divRow.replaceChildren(
        chip("Tous", !state.divider, () => setDivider(undefined)),
        ...dividerOptions(dividers).map((d) => chip(d.replace(/\//g, " › "), state.divider === d, () => setDivider(d))),
      );
    }
    if (row && at >= 0) (row.children[at] as HTMLElement | undefined)?.focus({ preventScroll: true });
  };

  const setNotebook = (dir: string | undefined) => {
    if (state.notebook === dir) return;
    state.notebook = dir;
    state.divider = undefined;
    void load(true);
  };
  const setDivider = (d: string | undefined) => {
    state.divider = d;
    void load(false);
  };
  const setColors = (colors: ColorKey[]) => {
    state.colors = colors;
    void load(false);
  };
  const toggleColor = (c: ColorKey) => {
    // Une seule couleur affichee : un appui sur une autre la remplace
    // (« tous les theoremes » en un geste) ; toutes affichees : idem.
    const all = state.colors.length === REVIEW_COLORS.length;
    if (all) setColors([c]);
    else if (state.colors.includes(c)) setColors(state.colors.filter((x) => x !== c));
    else setColors(REVIEW_COLORS.filter((x) => x === c || state.colors.includes(x)));
  };

  const navRows = () => [...list.querySelectorAll<HTMLElement>(".review-nav")];

  const paintList = () => {
    list.replaceChildren();
    if (!result) return;
    if (!state.colors.length) {
      list.append(el("div", { class: "empty" }, "Choisis au moins une couleur."));
      return;
    }
    if (!result.count) {
      list.append(el("div", { class: "empty" },
        `Aucun extrait ${colorsTitle(state.colors).toLowerCase()} ici. Écris en couleur (Alt+1 à Alt+5) pour le retrouver dans cette vue.`));
      return;
    }
    for (const nb of result.notebooks) {
      if (!state.notebook) list.append(el("h2", { class: "review-nb" }, nb.notebookTitle));
      for (const dv of nb.dividers) {
        for (const pg of dv.pages) {
          const where: ReviewWhere = { notebook: nb.notebook, divider: dv.divider, page: pg.page };
          const head = el("button", {
            class: "review-where review-nav", tabindex: "-1",
            dataset: { key: `${nb.notebook}|${dv.divider}|${pg.page}` },
            title: "Ouvrir la page",
            onclick: () => { remember(head.dataset.key!); host.openPage(where); },
          }, whereLabel(dv.divider, pg.page));
          const items = pg.items.map((it) => {
            const key = `${nb.notebook}|${dv.divider}|${pg.page}|${it.key}`;
            const kind = KIND_LABEL[it.kind];
            const row = el("button", {
              class: "review-item review-nav", tabindex: "-1",
              dataset: { key },
              style: `--c: ${colorOf(it.color)}`,
              title: `Ouvrir ${whereLabel(dv.divider, pg.page)} à cet endroit`,
              onclick: () => { remember(key); host.openItem(where, it); },
            },
              el("div", { class: "review-tag" }, labelOf(it.color), kind ? el("span", { class: "muted" }, ` · ${kind}`) : null),
              ...itemBody(it, lazyVignette),
            );
            return row;
          });
          list.append(el("section", { class: "review-page" }, head, ...items));
        }
      }
    }
  };

  const remember = (key: string) => {
    state.focusKey = key;
    state.scroll = screen.scrollTop;
  };

  const load = async (filtersChanged: boolean) => {
    const mine = ++token;
    paintFilters();
    info.textContent = "Lecture des cahiers…";
    const t0 = performance.now();
    if (filtersChanged || !notebooks.length) {
      const dirs = await host.repo.listNotebookDirs();
      const metas = await Promise.all(dirs.map(async (dir) => {
        try { const m = await host.repo.readMeta(dir); return { dir, title: m.title || dir, color: m.color }; }
        catch { return { dir, title: dir, color: "#9ca3af" }; }
      }));
      if (mine !== token) return;
      notebooks = metas;
      if (state.notebook && !dirs.includes(state.notebook)) state.notebook = undefined;
      dividers = state.notebook ? await host.repo.listDividers(state.notebook) : [];
      if (state.divider && !dividerOptions(dividers).includes(state.divider)) state.divider = undefined;
    }
    const found = await collectReview(host.repo, { colors: state.colors, divider: state.divider }, {
      notebook: state.notebook, isStale: () => mine !== token,
    });
    if (!found || mine !== token) return;
    result = found;
    const ms = Math.round(performance.now() - t0);
    paintFilters();
    paintList();
    const where = state.notebook ? ` · ${notebooks.find((n) => n.dir === state.notebook)?.title ?? state.notebook}` : "";
    info.textContent = `${found.count} extrait${found.count > 1 ? "s" : ""}${where} · ${found.pages} page${found.pages > 1 ? "s" : ""} lue${found.pages > 1 ? "s" : ""} en ${ms} ms`
      + " · ↑↓ pour choisir, Entrée ouvre, 1 à 5 : couleurs, Alt+← revient ici";
    exportBtn.disabled = !found.count;
    if (restore) {
      restore = false;
      const target = state.focusKey ? list.querySelector<HTMLElement>(`[data-key="${CSS.escape(state.focusKey)}"]`) : null;
      if (state.scroll != null) screen.scrollTop = state.scroll;
      target?.focus({ preventScroll: state.scroll != null });
    }
  };

  exportBtn.addEventListener("click", () => {
    if (!result?.count) return;
    const nbTitle = state.notebook ? notebooks.find((n) => n.dir === state.notebook)?.title ?? state.notebook : "Toutes les matières";
    const title = `Révision · ${nbTitle}${state.divider ? ` · ${state.divider.replace(/\//g, " › ")}` : ""} · ${colorsTitle(state.colors)}`;
    void printReview(result, title, !state.notebook);
  });

  // Sur le document : une puce repeinte perd le clavier, la vue le garde.
  const onKey = (e: KeyboardEvent) => {
    if (!screen.isConnected) { document.removeEventListener("keydown", onKey); io?.disconnect(); return; }
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || document.querySelector(".backdrop")) return;
    const active = document.activeElement as HTMLElement | null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = navRows();
      if (!rows.length) return;
      e.preventDefault();
      const i = rows.indexOf(active as HTMLElement);
      const next = i === -1 ? (e.key === "ArrowDown" ? 0 : rows.length - 1)
        : Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      rows[next].focus();
      rows[next].scrollIntoView({ block: "nearest" });
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && active?.classList.contains("review-chip")) {
      const chips = [...(active.parentElement?.querySelectorAll<HTMLElement>(".review-chip") ?? [])];
      const i = chips.indexOf(active);
      const next = chips[Math.max(0, Math.min(chips.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))];
      e.preventDefault();
      next?.focus();
      return;
    }
    const n = Number(e.key);
    if (e.key.length === 1 && n >= 1 && n <= REVIEW_COLORS.length) {
      e.preventDefault();
      toggleColor(PALETTE[n - 1].key);
    }
  };
  document.addEventListener("keydown", onKey);
  // Le clavier va a la vue des l'ouverture (fleches tout de suite).
  screen.tabIndex = -1;
  setTimeout(() => { if (!restore && !screen.contains(document.activeElement)) screen.focus({ preventScroll: true }); }, 40);
  void load(true);
  return screen;
}

/**
 * Cadre un instant l'extrait d'encre sur la page ouverte (comme le fait
 * focusBlock pour un bloc a cadre) et l'amene au centre de l'ecran.
 */
export function markRect(viewRoot: HTMLElement, page: number, rect: Bounds): void {
  const sheet = viewRoot.querySelector<HTMLElement>(`.page-wrap[data-page="${page}"]:not(.print-slice) .sheet`);
  if (!sheet) return;
  const scale = (sheet.clientWidth || PAGE_W) / PAGE_W;
  const pad = 8;
  const mark = el("div", {
    class: "review-mark",
    style: {
      left: `${(rect.x - pad) * scale}px`, top: `${(rect.y - pad) * scale}px`,
      width: `${(rect.w + 2 * pad) * scale}px`, height: `${(rect.h + 2 * pad) * scale}px`,
    },
  });
  sheet.append(mark);
  mark.scrollIntoView({ block: "center" });
  setTimeout(() => mark.remove(), 1800);
}

/**
 * Fiche de revision en PDF : la vue imprimee seule, par le meme chemin que
 * l'export des pages (body.printing + .print-host, feuille A4 de style.css).
 * Encre en image a densite 3 : nette a l'impression.
 */
async function printReview(result: ReviewResult, title: string, showNotebook: boolean): Promise<void> {
  if (document.body.classList.contains("printing")) return;
  const hostEl = el("div", { class: "print-host review-print" }, el("h1", {}, title));
  const printVignette = (item: ReviewItem): HTMLElement => {
    const c = drawVignette(item, 3);
    const img = el("img", { class: "review-ink", alt: "" });
    img.src = c.toDataURL("image/png");
    img.style.width = c.style.width;
    img.style.height = c.style.height;
    return img;
  };
  for (const nb of result.notebooks) {
    if (showNotebook) hostEl.append(el("h2", {}, nb.notebookTitle));
    for (const dv of nb.dividers) {
      for (const pg of dv.pages) {
        hostEl.append(el("section", { class: "review-page" },
          el("div", { class: "review-where" }, whereLabel(dv.divider, pg.page)),
          ...pg.items.map((it) => el("div", { class: "review-item", style: `--c: ${colorOf(it.color)}` },
            el("div", { class: "review-tag" }, labelOf(it.color)),
            ...itemBody(it, printVignette),
          )),
        ));
      }
    }
  }
  const prevTitle = document.title;
  document.body.append(hostEl);
  try {
    await Promise.all([...hostEl.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
    document.title = title.replace(/[\\/:*?"<>|·]+/g, "-").replace(/\s*-\s*/g, " - ");
    document.body.classList.add("printing");
    const done = new Promise<void>((r) => window.addEventListener("afterprint", () => r(), { once: true }));
    window.print();
    await done;
  } catch (e) {
    toast(`Export impossible : ${(e as Error).message}`, "err", 5000);
  } finally {
    document.body.classList.remove("printing");
    document.title = prevTitle;
    hostEl.remove();
  }
}
