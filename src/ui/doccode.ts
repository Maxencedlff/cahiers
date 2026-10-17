/**
 * Bloc de code dans le texte tape (DOM) : ``` puis Entree (```python pour
 * la coloration). Format dans src/core/text/doc.ts (jeton `codeblock`),
 * coloration dans src/core/text/codehl.ts.
 *
 * Bloc non editable du texte de la page (`div.doc-code.doc-island`) ; on
 * tape dans une vraie zone de texte transparente posee sur le rendu colore
 * (meme police, memes retours a la ligne) : aucune formule, aucun symbole,
 * Tab = 4 espaces, Entree garde le retrait. Le texte vit dans
 * `data-code` (une copie du bloc le garde, contrairement a la valeur d'une
 * zone de texte).
 */
import { codeLang, highlight } from "../core/text/codehl";
import { askText, el } from "./dom";

export interface CodeHost {
  changed(): void;
  /** Curseur rendu au texte de la page, juste avant ou juste apres le bloc. */
  leave(wrap: HTMLElement, after: boolean): void;
  /** Bloc vide, Retour arriere : la page le retire. */
  remove(wrap: HTMLElement): void;
}

const INDENT = "    ";

export const CODE_HELP = "Tab : 4 espaces (Maj+Tab : en retirer) · Entrée garde le retrait · "
  + "Échap ou Ctrl+Entrée : sortir · flèche haut/bas au bord : sortir · Retour arrière dans un bloc vide : le retirer";

export function buildCode(lang: string, text: string, host: CodeHost): HTMLElement {
  const label = el("button", { type: "button", class: "doc-code-lang", title: "Langage (coloration) : cliquer pour changer" });
  const hl = el("pre", { class: "doc-code-hl", "aria-hidden": "true" });
  const input = el("textarea", { class: "doc-code-input", spellcheck: "false", autocapitalize: "off", autocomplete: "off", rows: "1", "aria-label": "Code" });
  input.value = text;
  const wrap = el("div", { class: "doc-code doc-island", contenteditable: "false", dataset: { lang, code: text } },
    el("div", { class: "doc-code-head" }, label, el("span", { class: "doc-code-help", title: CODE_HELP }, "?")),
    el("div", { class: "doc-code-box" }, hl, input));
  const paint = () => {
    const l = wrap.dataset.lang ?? "";
    label.textContent = l || "code";
    hl.replaceChildren(...highlight(wrap.dataset.code ?? "", l).map((p) => (p.kind ? el("span", { class: `hl-${p.kind}` }, p.text) : document.createTextNode(p.text))),
      // Derniere ligne vide : elle a sa hauteur, comme dans la zone de texte.
      document.createTextNode("\n"));
  };
  paint();
  const changed = () => {
    wrap.dataset.code = input.value;
    paint();
    host.changed();
  };
  input.addEventListener("input", changed);
  label.addEventListener("pointerdown", (e) => e.preventDefault());
  label.addEventListener("click", () => {
    void askText("Langage du bloc", "python, c, cpp, java, js, matlab, sql, bash, vhdl (vide : sans coloration)", wrap.dataset.lang ?? "").then((v) => {
      if (v === null) return;
      const name = v.trim();
      wrap.dataset.lang = codeLang(name) ?? name.replace(/[^\w+#.-]/g, "");
      paint();
      host.changed();
      input.focus({ preventScroll: true });
    });
  });
  input.addEventListener("keydown", (e) => {
    if (codeKey(e, input, wrap, host)) { e.preventDefault(); e.stopPropagation(); if (wrap.dataset.code !== input.value) changed(); }
  });
  return wrap;
}

/** Ligne du curseur dans la zone de texte : debut, fin, texte. */
function lineAt(input: HTMLTextAreaElement): { start: number; end: number; text: string } {
  const v = input.value, at = input.selectionStart;
  const start = v.lastIndexOf("\n", at - 1) + 1;
  const e = v.indexOf("\n", at);
  const end = e < 0 ? v.length : e;
  return { start, end, text: v.slice(start, end) };
}

/** Frappe annulable par Ctrl+Z (editeur du navigateur), sinon remplacement direct. */
function insert(input: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand("insertText", false, text)) input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
}

function codeKey(e: KeyboardEvent, input: HTMLTextAreaElement, wrap: HTMLElement, host: CodeHost): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === "Escape" || (e.key === "Enter" && ctrl)) { host.leave(wrap, true); return true; }
  if (ctrl || e.altKey) return false;
  const collapsed = input.selectionStart === input.selectionEnd;
  switch (e.key) {
    case "Tab": {
      const line = lineAt(input);
      if (e.shiftKey) {
        const n = /^ {0,4}/.exec(line.text)![0].length || (line.text.startsWith("\t") ? 1 : 0);
        if (!n) return true;
        const at = input.selectionStart;
        input.setSelectionRange(line.start, line.start + n);
        insert(input, "");
        input.setSelectionRange(Math.max(line.start, at - n), Math.max(line.start, at - n));
        return true;
      }
      insert(input, INDENT);
      return true;
    }
    case "Enter": {
      if (e.shiftKey) return false;
      const line = lineAt(input);
      const before = line.text.slice(0, input.selectionStart - line.start);
      const pad = /^[ \t]*/.exec(line.text)![0];
      insert(input, "\n" + pad + (/[:{([]\s*$/.test(before) ? INDENT : ""));
      return true;
    }
    case "ArrowUp":
    case "ArrowDown": {
      if (!collapsed || e.shiftKey) return false;
      const v = input.value, at = input.selectionStart;
      const first = v.lastIndexOf("\n", at - 1) < 0, last = v.indexOf("\n", at) < 0;
      if (e.key === "ArrowUp" && first) { host.leave(wrap, false); return true; }
      if (e.key === "ArrowDown" && last) { host.leave(wrap, true); return true; }
      return false;
    }
    case "Backspace":
      if (input.value === "") { host.remove(wrap); return true; }
      return false;
    default:
      return false;
  }
}

/** Curseur dans le bloc, au debut ou a la fin. */
export function focusCode(wrap: HTMLElement, atEnd = true): void {
  const input = wrap.querySelector<HTMLTextAreaElement>(".doc-code-input");
  if (!input) return;
  input.focus({ preventScroll: true });
  const at = atEnd ? input.value.length : 0;
  input.setSelectionRange(at, at);
  wrap.scrollIntoView({ block: "nearest" });
}
