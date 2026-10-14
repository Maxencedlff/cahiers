import { el, toast, contextMenu } from "./dom";
import { icon } from "./icons";
import { renderTex } from "./tex";
import { notebookSquare } from "./sidebar";
import type { Repo } from "../core/storage/repo";
import type { SearchHit, SearchOptions } from "../core/storage/search";
import { fold, matchesAll, notebookMatches, parseQuery, queryReady, type ExcerptPart } from "../core/text/find";
import { texToPlain } from "../core/text/doc";
import { dividerLabel } from "../core/dividers";
import { linkMarkdown, pagePathOf, type LinkRef } from "../core/links";
import { keysOf } from "../core/shortcuts";
import type { Block } from "../core/types";

/**
 * Recherche facon Spotlight : un panneau de 640 px par-dessus l'ecran (le
 * cahier reste derriere, rien ne le remplace). Jeton de portee retirable
 * (« Dans Linux ✕ », Retour arriere sur un champ vide), resultats groupes
 * par matiere, formules rendues en KaTeX, filtre « Formules », clic droit :
 * Ouvrir, Copier le lien. Clavier : fleches, Entree, Echap.
 */

export interface SpotlightOptions {
  repo: Repo;
  /** Derniere recherche, reproposee (selectionnee : on tape par-dessus). */
  initial: string;
  onQuery: (q: string) => void;
  /** Cahier d'ou part la recherche : elle commence dans cette matiere. */
  scope?: { dir: string; title: string; color: string };
  search: (q: string, opts: SearchOptions & { notebook?: string }) => Promise<SearchHit[]>;
  openAt: (dir: string, divider: string, page: number, blockId: string, query?: string) => void;
  /** Fermee (Echap, appui a cote, resultat ouvert). */
  onClose?: () => void;
}

/** Nombre de resultats affiches ; le reste est annonce, jamais coupe en silence. */
const MAX_HITS = 200;
/** Formules montrees en tete quand le filtre est « Tout ». */
const FORMULAS_IN_ALL = 6;

/** Formule trouvee dans une page : texte et $latex$ (core/suggest.ts). */
interface FormulaHit {
  notebook: string;
  notebookTitle: string;
  color: string;
  divider: string;
  page: number;
  insert: string;
  modified: string;
}

const BLOCK_LABEL: Record<Block["type"], string> = {
  text: "texte", ink: "écriture", math: "formule", image: "photo", pdf: "PDF",
  calc: "calcul", graph: "courbe", link: "lien", flag: "repère", schema: "schéma",
};

let current: { close: (restore?: boolean) => void } | null = null;

/** Une recherche est ouverte. */
export function spotlightOpen(): boolean { return !!current; }

export function openSpotlight(o: SpotlightOptions): void {
  if (current) { current.close(); }
  // Le clavier revient ou il etait (curseur du texte) si l'on ferme sans ouvrir.
  const back = document.activeElement as HTMLElement | null;
  const sel = document.getSelection();
  const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  let scope = o.scope ?? null;
  let filter: "all" | "formulas" = "all";
  const input = el("input", {
    type: "text", class: "spot-field", spellcheck: "false", autocomplete: "off",
    placeholder: "Rechercher dans les cahiers", "aria-label": "Rechercher",
  });
  input.value = o.initial;
  const token = el("span", { class: "spot-token" });
  const paintToken = () => {
    token.hidden = !scope;
    if (!scope) return;
    const s = scope;
    token.replaceChildren(notebookSquare(s.color, 10), el("span", {}, `Dans ${s.title}`),
      el("button", {
        class: "spot-token-x", "aria-label": `Chercher dans tous les cahiers`, title: "Chercher dans tous les cahiers",
        onclick: () => { scope = null; paintToken(); void run(); input.focus(); },
      }, icon("close", 14)));
  };
  paintToken();
  const chips = el("div", { class: "spot-filters", role: "group", "aria-label": "Filtre" });
  const info = el("span", { class: "spot-info" });
  const paintChips = () => {
    chips.replaceChildren(
      ...([["all", "Tout"], ["formulas", "Formules"]] as const).map(([id, label]) => el("button", {
        class: `chip${filter === id ? " on" : ""}`, "aria-pressed": String(filter === id),
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: () => { filter = id; paintChips(); void run(); },
      }, label)),
      info,
    );
  };
  paintChips();
  const results = el("div", { class: "spot-results", role: "listbox", "aria-label": "Résultats" });
  const panel = el("div", { class: "spotlight", role: "dialog", "aria-label": "Rechercher" },
    el("div", { class: "spot-input" }, icon("search", 20), token, input, el("kbd", {}, "Échap")),
    chips,
    results,
    el("div", { class: "spot-foot" },
      "↑↓ choisir · Entrée ouvrir · clic droit : copier le lien · @matière, #couleur, \"phrase\""),
  );
  const backdrop = el("div", { class: "spot-backdrop" }, panel);

  let rows: { node: HTMLElement; open: () => void; link?: () => void }[] = [];
  let at = 0;
  let token2 = 0;
  let shownFor: string | null = null;
  let firstOpen: (() => void) | null = null;
  const key = () => `${scope?.dir ?? ""}|${filter}|${input.value.trim()}`;

  const select = (i: number) => {
    if (!rows.length) return;
    at = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => {
      r.node.classList.toggle("sel", k === at);
      r.node.setAttribute("aria-selected", String(k === at));
    });
    rows[at].node.scrollIntoView({ block: "nearest" });
  };

  const close = (restore = false) => {
    if (current?.close !== close) return;
    current = null;
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    if (restore && back?.isConnected && back !== document.body) {
      back.focus({ preventScroll: true });
      if (range && range.startContainer.isConnected) { sel?.removeAllRanges(); sel?.addRange(range); }
    }
    o.onClose?.();
  };
  current = { close };

  const addRow = (node: HTMLElement, open: () => void, link?: () => void) => {
    const i = rows.length;
    rows.push({ node, open, link });
    node.addEventListener("mouseenter", () => select(i));
    node.addEventListener("click", () => { close(); open(); });
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      select(i);
      contextMenu({ x: e.clientX, y: e.clientY }, [
        { label: "Ouvrir", icon: "fileText", run: () => { close(); open(); } },
        ...(link ? [{ label: "Copier le lien", icon: "link" as const, keys: "Ctrl+Maj+C", run: link }] : []),
      ], { label: "Résultat" });
    });
  };

  const run = async (): Promise<boolean> => {
    const q = input.value.trim();
    o.onQuery(input.value);
    const mine = ++token2;
    const k = key();
    const parsed = parseQuery(q);
    if (!queryReady(parsed)) {
      results.replaceChildren(el("div", { class: "spot-empty" }, "Tape au moins deux caractères."));
      rows = [];
      info.textContent = "";
      shownFor = k;
      return true;
    }
    info.textContent = "Recherche…";
    const stale = () => mine !== token2;
    const [hits, formulas] = await Promise.all([
      filter === "all" ? o.search(q, { isStale: stale, notebook: scope?.dir }) : Promise.resolve([] as SearchHit[]),
      findFormulas(o.repo, q, scope?.dir, stale),
    ]);
    if (stale()) return false;
    shownFor = k;
    rows = [];
    results.replaceChildren();
    const fshown = filter === "formulas" ? formulas.slice(0, MAX_HITS) : formulas.slice(0, FORMULAS_IN_ALL);
    if (fshown.length) {
      const g = el("div", { class: "spot-group" },
        el("div", { class: "spot-gh" }, icon("sigma", 14), el("span", {}, "Formules"),
          el("span", { class: "spot-count" }, String(formulas.length))));
      for (const f of fshown) {
        const row = el("div", { class: "spot-row formula", role: "option" },
          el("div", { class: "spot-what" }, formulaNode(f.insert)),
          el("div", { class: "spot-where" }, notebookSquare(f.color, 9), `${f.notebookTitle} › ${dividerLabel(f.divider)} · p. ${f.page}`));
        g.append(row);
        addRow(row, () => o.openAt(f.notebook, f.divider, f.page, "", plainOf(f.insert).slice(0, 40)));
      }
      results.append(g);
    }
    const colors = new Map<string, string>();
    if (hits.length) {
      for (const dir of new Set(hits.map((h) => h.notebook))) {
        try { colors.set(dir, (await o.repo.readMeta(dir)).color); } catch { colors.set(dir, "#94a3b8"); }
      }
    }
    if (stale()) return false;
    const byNb = new Map<string, SearchHit[]>();
    for (const h of hits.slice(0, MAX_HITS)) {
      const l = byNb.get(h.notebook) ?? [];
      l.push(h);
      byNb.set(h.notebook, l);
    }
    for (const [dir, group] of byNb) {
      const g = el("div", { class: "spot-group" },
        el("div", { class: "spot-gh" }, notebookSquare(colors.get(dir) ?? "#94a3b8", 10), el("span", {}, group[0].notebookTitle),
          el("span", { class: "spot-count" }, String(group.length))));
      for (const h of group) {
        const row = el("div", { class: "spot-row", role: "option" },
          el("div", { class: "spot-what" }, ...excerptNodes(h.parts)),
          el("div", { class: "spot-where" },
            `${dividerLabel(h.divider)} · p. ${h.page}${h.pageTitle ? ` · ${h.pageTitle}` : ""}`,
            el("span", { class: "spot-kind" }, BLOCK_LABEL[h.blockType] ?? h.blockType)));
        g.append(row);
        addRow(row, () => o.openAt(h.notebook, h.divider, h.page, h.blockId, q),
          h.pageId ? () => void copyHitLink(h) : undefined);
      }
      results.append(g);
    }
    const n = (filter === "all" ? hits.length : 0) + (filter === "formulas" ? formulas.length : 0);
    const where = scope ? ` dans ${scope.title}` : "";
    info.textContent = !n && !fshown.length ? "" : n > MAX_HITS ? `${MAX_HITS} premiers sur ${n}` : `${n || fshown.length} résultat${(n || fshown.length) > 1 ? "s" : ""}${where}`;
    if (!rows.length) {
      results.append(el("div", { class: "spot-empty" },
        `Aucun résultat${where}.`,
        scope ? el("button", {
          class: "spot-wider", onclick: () => { scope = null; paintToken(); void run(); input.focus(); },
        }, "Chercher dans tous les cahiers") : null));
    }
    firstOpen = rows[0]?.open ?? null;
    select(0);
    return true;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, 200);
  });

  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector(".ctx-menu")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      select(at + (e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      // Resultats pas encore a jour (frappe dans les 200 ms) : on cherche
      // d'abord, puis on ouvre le premier.
      if (shownFor !== key()) {
        if (timer) { clearTimeout(timer); timer = null; }
        void run().then((ok) => { if (ok && shownFor === key() && firstOpen) { const f = firstOpen; close(); f(); } });
      } else if (rows[at]) { const r = rows[at]; close(); r.open(); }
      return;
    }
    if (e.key === "Backspace" && scope && document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      scope = null;
      paintToken();
      void run();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && rows[at]?.link) {
      e.preventDefault(); e.stopPropagation();
      rows[at].link!();
      return;
    }
    // Les commandes de l'appli (Ctrl+F, Ctrl+K...) ne passent pas dessous.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ["f", "k", "g", "p", "e", "n"].includes(e.key.toLowerCase())) {
      e.preventDefault(); e.stopPropagation();
      input.focus(); input.select();
    }
  };
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(true); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  input.focus();
  input.select();
  if (input.value.trim()) void run();
  else results.append(el("div", { class: "spot-empty" },
    `Mots en vrac, "phrase exacte", @matière, #couleur. ${keysOf("search")} ouvre cette recherche partout.`));
}

/** Extrait avec les termes cherches en surbrillance. */
function excerptNodes(parts: ExcerptPart[]): (Node | string)[] {
  return parts.map((p) => (p.mark ? el("mark", {}, p.text) : p.text));
}

/** Texte et formules ($…$) : formules en KaTeX, jamais le LaTeX brut. */
function formulaNode(insert: string): HTMLElement {
  const out = el("span", { class: "spot-formula" });
  insert.split(/(\$[^$]+\$)/).forEach((part) => {
    if (!part) return;
    if (part.startsWith("$") && part.endsWith("$") && part.length > 2) out.append(renderTex(part.slice(1, -1)));
    else out.append(part);
  });
  return out;
}

function plainOf(insert: string): string {
  return insert.replace(/\$([^$]+)\$/g, (_m, t: string) => texToPlain(t));
}

/**
 * Formules des pages (relations « X = … » relevees par l'index, cache de
 * session de Repo.scanDivider) dont le texte en clair contient tous les mots.
 */
async function findFormulas(repo: Repo, query: string, only: string | undefined, stale: () => boolean): Promise<FormulaHit[]> {
  const q = parseQuery(query);
  if (!queryReady(q) || q.color) return [];
  const out: FormulaHit[] = [];
  const seen = new Set<string>();
  const dirs = only ? [only] : await repo.listNotebookDirs();
  for (const dir of dirs) {
    if (stale()) return [];
    let meta;
    try { meta = await repo.readMeta(dir); } catch { continue; }
    if (!notebookMatches(q, dir, meta.title)) continue;
    for (const divider of await repo.listDividers(dir)) {
      const pages = await repo.scanDivider(dir, divider, stale);
      if (!pages) return [];
      for (const { n, index } of pages) {
        for (const f of index?.formulas ?? []) {
          const plain = plainOf(f.insert);
          if (!matchesAll(fold(plain).text, q.terms)) continue;
          const k = `${dir}|${f.insert}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ notebook: dir, notebookTitle: meta.title, color: meta.color, divider, page: n, insert: f.insert, modified: index?.modified ?? "" });
        }
      }
    }
  }
  return out.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
}

/**
 * « Copier le lien » d'un resultat : le lien en markdown (core/links.ts),
 * qu'un Ctrl+V dans le texte d'une page colle en puce. Texte tape : la page
 * (son titre en libelle) ; formule, zone, photo : ce bloc (son extrait).
 */
export async function copyHitLink(h: SearchHit): Promise<void> {
  if (!h.pageId) return;
  const path = pagePathOf({ notebook: h.notebook, divider: h.divider, number: h.page });
  const toPage = h.blockType === "text";
  const ref: LinkRef = toPage ? { pageId: h.pageId, path } : { pageId: h.pageId, blockId: h.blockId, path };
  const label = (toPage ? h.pageTitle : h.excerpt.replace(/…/g, "").trim()) || `${dividerLabel(h.divider)} p. ${h.page}`;
  try {
    await writeClipboard(linkMarkdown(label.slice(0, 80).trim(), ref));
    toast(`Lien copié : « ${label.slice(0, 50)} ». Ctrl+V dans une page le colle.`, "info", 3000, undefined, "link-copied");
  } catch {
    toast("Impossible d'écrire dans le presse-papiers", "warn", 3000);
  }
}

/** Presse-papiers : l'API asynchrone, sinon l'ancienne copie par selection. */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* repli ci-dessous */ }
  }
  const area = el("textarea", { style: { position: "fixed", left: "-9999px", top: "0" } });
  area.value = text;
  const back = document.activeElement as HTMLElement | null;
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  back?.focus?.();
  if (!ok) throw new Error("copie refusee");
}
