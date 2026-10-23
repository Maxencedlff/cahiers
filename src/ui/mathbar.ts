import { el } from "./dom";
import { renderTex } from "./tex";
import { icon } from "./icons";
import { insertMathTemplate, type TextDoc } from "./textdoc";
import { recordSymbol, SYMBOLS_CHANGED, usageScores } from "../core/symbols";
import {
  ALL_KEYS, RIBBON_TABS, keyTitle, searchKeys, sectionById, shiftOf, tabOf, type MathKey,
} from "../core/mathcatalog";
import { ribbonCapacity, ribbonColumns } from "../core/chrome";

export { MATH_TEMPLATES } from "../core/templates";

/** Onglet des touches recemment utilisees (pas une section du catalogue). */
const RECENT_TAB = "recent";
/** Touches de l'onglet « Récents », au plus (une rangee a 1536 px). */
const RECENT_MAX = 16;
/** Usage oublie en dessous (environ deux mois sans s'en servir). */
const RECENT_MIN_SCORE = 0.05;

export interface FormulaRibbonHost {
  /** Texte qui recoit les touches (page ou case de tableau). */
  getDoc: () => TextDoc | undefined;
  /** Onglet retenu (null : Récents s'il y en a, sinon Modèles). */
  tab: string | null;
  /** Onglet choisi : a retenir sur la machine. */
  onTab: (id: string) => void;
}

/** Une touche de la rangee : un symbole du catalogue, ou une action du ruban. */
interface Slot {
  node: HTMLElement;
  units: number;
}

/**
 * Ruban des formules (Σ), facon onglet Equation de Word : une rangee
 * d'onglets (Récents, Modèles, Calcul, Grec…) et la recherche a droite,
 * puis les touches de l'onglet choisi sur une ou deux rangees, sans
 * defilement (colonnes : core/chrome.ts, ribbonColumns). La
 * recherche couvre tout le catalogue et montre ce qui tient sur les deux
 * rangees, le plus probable d'abord (searchKeys) ; Entree pose le premier.
 *
 * Rien ici ne prend le focus a la souris : le curseur reste dans le texte
 * (ou dans la formule ouverte). Depuis la recherche, Entree et Echap
 * rendent le clavier au texte.
 */
export function buildFormulaRibbon(host: FormulaRibbonHost): HTMLElement {
  const search = el("input", {
    class: "fr-search", type: "search", placeholder: "Chercher un symbole",
    "aria-label": "Chercher un symbole", spellcheck: "false", autocomplete: "off",
  }) as HTMLInputElement;
  const tabs = el("div", { class: "fr-tabs", role: "tablist", "aria-label": "Catégories de symboles" });
  const keys = el("div", { class: "fr-keys", role: "tabpanel" });
  const root = el("section", { class: "formula-ribbon", "aria-label": "Formules" },
    el("div", { class: "fr-bar" }, tabs, el("label", { class: "fr-find" }, icon("search", 15), search)),
    keys);

  let tab = host.tab;
  /** Largeur de la rangee de touches (avant la pose : celle de la fenetre). */
  const rowWidth = () => keys.clientWidth || root.clientWidth || window.innerWidth;

  /** Rend le clavier au texte, la ou etait le curseur. */
  const backToText = () => { if (document.activeElement === search) host.getDoc()?.focus(); };
  const insert = (k: MathKey) => {
    backToText();
    insertMathTemplate(k.insert, host.getDoc());
    recordSymbol(k.insert);
  };
  /** Jamais le focus au pointeur : le curseur du texte ne bouge pas. */
  const keep = <T extends HTMLElement>(b: T): T => {
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  };
  const keyButton = (k: MathKey): Slot => {
    const title = keyTitle(k);
    const b = keep(el("button", { class: `mathkey${k.wide ? " wide" : ""}`, title, "aria-label": title }, renderTex(k.label ?? k.insert)));
    b.addEventListener("click", () => insert(k));
    return { node: b, units: k.wide ? 2 : 1 };
  };
  const action = (label: Node | string, title: string, cls: string, run: () => void, units = 1): Slot => {
    const b = keep(el("button", { class: `mathkey ${cls}`, title, "aria-label": title }, label));
    b.addEventListener("click", run);
    return { node: b, units };
  };

  // Modeles : nouvelle formule vide, encadrer la derniere.
  const modelActions = (): Slot[] => [
    action("Équation", "Nouvelle formule (Alt+=)", "eq", () => { backToText(); host.getDoc()?.insertMath(""); }, 2),
    action(renderTex("\\boxed{x}"), "Encadrer la formule avant le curseur (Ctrl+Maj+B)", "", () => { backToText(); host.getDoc()?.boxFormula(); }),
  ];
  // Grec : Maj bascule minuscules / majuscules (retenu comme un onglet).
  const shiftKey = (id: string, other: string): Slot => {
    const upper = id !== tabOf(id);
    const b = action("⇧", upper ? "Minuscules (Maj)" : "Majuscules (Maj)", `shift${upper ? " on" : ""}`, () => choose(other));
    b.node.setAttribute("aria-pressed", String(upper));
    return b;
  };

  const choose = (id: string) => {
    tab = id;
    host.onTab(id);
    if (search.value) search.value = "";
    paint();
  };

  /** Plus utilisees d'abord, sinon l'ordre du catalogue. */
  const byUse = (list: readonly MathKey[], score: (insert: string) => number) => list
    .map((k, i) => ({ k, i, s: score(k.insert) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.k);

  /** Premiere touche montree par la recherche : celle qu'Entree pose. */
  let first: MathKey | undefined;
  const paint = () => {
    const score = usageScores();
    const recent = byUse(ALL_KEYS.filter((k) => score(k.insert) >= RECENT_MIN_SCORE), score).slice(0, RECENT_MAX);
    const query = search.value.trim();
    // Onglet retenu ; Récents par defaut s'il y en a, jamais un onglet vide.
    let current = tab ?? (recent.length ? RECENT_TAB : RIBBON_TABS[0].id);
    if ((current === RECENT_TAB && !recent.length) || (current !== RECENT_TAB && !sectionById(current))) current = RIBBON_TABS[0].id;

    const tabList: { id: string; label: string; title: string; glyph: Node }[] = [
      ...(recent.length ? [{ id: RECENT_TAB, label: "Récents", title: "Récents", glyph: icon("history", 15) as Node }] : []),
      ...RIBBON_TABS.map((s) => ({ id: s.id, label: s.tab, title: s.title, glyph: renderTex(s.glyph) as Node })),
    ];
    tabs.replaceChildren(...tabList.map((t) => {
      const on = !query && tabOf(current) === t.id;
      const b = keep(el("button", {
        class: `fr-tab${on ? " on" : ""}`, role: "tab", "aria-selected": String(on), title: t.title,
      }, el("span", { class: "fr-word" }, t.label), el("span", { class: "fr-glyph", "aria-hidden": "true" }, t.glyph)));
      b.addEventListener("click", () => choose(t.id === tabOf(current) && t.id !== current ? current : t.id));
      return b;
    }));

    let slots: Slot[];
    first = undefined;
    if (query) {
      // Ce qui tient sur les deux rangees ; au-dela, « +N » invite a preciser.
      const found = searchKeys(query, score);
      const cap = ribbonCapacity(rowWidth());
      let room = cap;
      const shown: MathKey[] = [];
      for (const k of found) {
        const u = k.wide ? 2 : 1;
        // Une place gardee pour « +N » s'il en reste apres.
        if (u > room - (shown.length + 1 < found.length ? 1 : 0)) break;
        shown.push(k);
        room -= u;
      }
      first = shown[0];
      slots = shown.map(keyButton);
      const more = found.length - shown.length;
      if (more > 0) slots.push({ node: el("span", { class: "fr-more", title: "Préciser la recherche" }, `+${more}`), units: 1 });
      if (!found.length) slots = [{ node: el("span", { class: "fr-empty" }, `Aucun symbole pour « ${query} »`), units: 1 }];
    } else if (current === RECENT_TAB) {
      slots = recent.map(keyButton);
    } else {
      const section = sectionById(current)!;
      const other = shiftOf(current);
      slots = [
        ...(current === "models" ? modelActions() : []),
        ...(other ? [shiftKey(current, other)] : []),
        ...byUse(section.keys, score).map(keyButton),
      ];
    }
    const units = slots.reduce((n, s) => n + s.units, 0);
    keys.style.setProperty("--cols", String(ribbonColumns(rowWidth(), units)));
    keys.replaceChildren(...slots.map((s) => s.node));
  };

  search.addEventListener("input", paint);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && first) {
      e.preventDefault();
      const k = first;
      search.value = "";
      paint();
      insert(k);
    } else if (e.key === "Escape") {
      // Pris ici (defaultPrevented) : l'Echap de l'appli ne va pas plus loin.
      e.preventDefault();
      if (search.value) { search.value = ""; paint(); }
      backToText();
    }
  });

  // Reordonne apres un usage, mais jamais sous le pointeur : un second
  // clic ne doit pas tomber sur une autre touche que la premiere. Ruban
  // ferme (construit une fois, garde par l'appli) : a sa reouverture.
  let stale = false;
  window.addEventListener(SYMBOLS_CHANGED, () => {
    if (!root.isConnected || root.matches(":hover")) stale = true;
    else paint();
  });
  root.addEventListener("pointerleave", () => { if (stale) { stale = false; paint(); } });
  // Largeur changee (fenetre, barre laterale, calculatrice, reouverture) :
  // colonnes et resultats de recherche montres dependent de la place.
  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = keys.clientWidth;
    if (w === lastWidth) return;
    lastWidth = w;
    if (w) { stale = false; paint(); }
  }).observe(keys);
  paint();
  return root;
}
