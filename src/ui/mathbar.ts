import { el } from "./dom";
import { renderTex } from "./tex";
import { insertMathTemplate, type TextDoc } from "./textdoc";
import { recordSymbol, SYMBOLS_CHANGED, usageScores } from "../core/symbols";
import { CATALOG, filterCatalog, keyTitle, type MathKey, type MathSection, ALL_KEYS } from "../core/mathcatalog";

export { MATH_TEMPLATES, type MathTemplate } from "../core/templates";

/** Touches de la ligne « Récents », au plus (une ligne et demie du volet). */
const RECENT_MAX = 12;
/** Usage oublie en dessous (environ deux mois sans s'en servir). */
const RECENT_MIN_SCORE = 0.05;

/**
 * Contenu du volet des formules (Σ) : une recherche (« omega », « fl »,
 * « norme »), les touches recemment utilisees, puis les sections du
 * catalogue (core/mathcatalog.ts). Dans chaque section, les plus utilisees
 * passent devant.
 *
 * Les touches ne prennent jamais le focus : le curseur reste dans le
 * texte (ou dans la formule ouverte). Depuis la recherche, Entree pose la
 * premiere touche trouvee et rend le clavier au texte, Echap aussi.
 */
export function buildFormulaPanel(getDoc: () => TextDoc | undefined): HTMLElement {
  const search = el("input", {
    class: "fp-search", type: "search", placeholder: "Chercher : omega, flèche, norme…",
    "aria-label": "Chercher un symbole", spellcheck: "false", autocomplete: "off",
  }) as HTMLInputElement;
  const body = el("div", { class: "fp-body" });
  const root = el("div", { class: "formula-panel" }, el("div", { class: "fp-find" }, search), body);

  /** Rend le clavier au texte, la ou etait le curseur. */
  const backToText = () => { if (document.activeElement === search) getDoc()?.focus(); };
  const insert = (k: MathKey) => {
    backToText();
    insertMathTemplate(k.insert, getDoc());
    recordSymbol(k.insert);
  };
  const keep = (b: HTMLElement) => {
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  };
  const keyButton = (k: MathKey) => {
    const title = keyTitle(k);
    const b = keep(el("button", { class: `mathkey${k.wide ? " wide" : ""}`, title, "aria-label": title }, renderTex(k.label ?? k.insert)));
    b.addEventListener("click", () => insert(k));
    return b;
  };
  const section = (title: string, keys: HTMLElement[]) =>
    el("section", { class: "fp-section" }, el("h4", { class: "fp-title" }, title), el("div", { class: "fp-keys" }, ...keys));

  // Actions des modeles : nouvelle formule vide, encadrer la derniere.
  const actions = (): HTMLElement[] => {
    const eq = keep(el("button", { class: "mathkey eq", title: "Nouvelle formule (Alt+=)", "aria-label": "Nouvelle formule (Alt+=)" }, "Équation"));
    eq.addEventListener("click", () => { backToText(); getDoc()?.insertMath(""); });
    const boxTitle = "Encadrer la formule avant le curseur (Ctrl+Maj+B)";
    const boxed = keep(el("button", { class: "mathkey", title: boxTitle, "aria-label": boxTitle }, renderTex("\\boxed{x}")));
    boxed.addEventListener("click", () => { backToText(); getDoc()?.boxFormula(); });
    return [eq, boxed];
  };

  /** Premiere touche montree : celle qu'Entree pose depuis la recherche. */
  let first: MathKey | undefined;
  const paint = () => {
    const score = usageScores();
    const byUse = (keys: MathKey[]) => keys
      .map((k, i) => ({ k, i, s: score(k.insert) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.k);
    const query = search.value.trim();
    const sections: MathSection[] = query ? filterCatalog(query) : CATALOG;
    const parts: HTMLElement[] = [];
    first = undefined;
    if (!query) {
      const recent = byUse(ALL_KEYS.filter((k) => score(k.insert) >= RECENT_MIN_SCORE)).slice(0, RECENT_MAX);
      if (recent.length) parts.push(section("Récents", recent.map(keyButton)));
    }
    for (const s of sections) {
      const keys = byUse(s.keys);
      first ??= keys[0];
      const extra = s.id === "models" && !query ? actions() : [];
      parts.push(section(s.title, [...extra, ...keys.map(keyButton)]));
    }
    if (!parts.length) parts.push(el("p", { class: "fp-empty" }, `Aucun symbole pour « ${query} »`));
    body.replaceChildren(...parts);
  };

  search.addEventListener("input", () => { paint(); body.scrollTop = 0; });
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
  // clic ne doit pas tomber sur une autre touche que la premiere.
  let stale = false;
  const onChange = () => {
    if (!root.isConnected) { window.removeEventListener(SYMBOLS_CHANGED, onChange); return; }
    if (root.matches(":hover")) stale = true;
    else paint();
  };
  root.addEventListener("pointerleave", () => { if (stale) { stale = false; paint(); } });
  window.addEventListener(SYMBOLS_CHANGED, onChange);
  paint();
  return root;
}
