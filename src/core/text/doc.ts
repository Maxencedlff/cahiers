/**
 * Texte tape au clavier sur la page, facon traitement de texte.
 *
 * Stocke dans le `content` d'un bloc `text` sans `rect`, en markdown
 * restreint pour rester lisible dans le JSON (section 1) :
 *   **gras**, *italique*, $formule LaTeX$, retour a la ligne = "\n",
 *   ![](img:<id>) = photo posee dans le texte (bloc image de meme id),
 *   [texte en couleur]{.theoreme} = une des 5 couleurs de la palette,
 *   [libellé](cahiers:<pageId>#<blockId> "Maths/Cours/0012") = lien vers
 *   une page (core/links.ts : cible par id de page, chemin lisible en repli),
 *   en debut de ligne (D11) : "# ", "## ", "### " = titres, "- " = puce,
 *   "1. " = liste numerotee, deux espaces devant par niveau de liste.
 * Les caracteres speciaux du texte (\ $ * [ ]) sont echappes par un
 * antislash, et un debut de ligne qui ressemblerait a un marqueur aussi
 * ("\# ", "\- ", "1\. ") : il reste du texte.
 *
 * Module sans DOM : l'interface lit et ecrit des jetons, pas du markdown.
 */

import type { ColorKey } from "../types";
import { PALETTE } from "../palette";

/** Mise en forme d'une ligne entiere (D11) : titre 1 a 3, puce, numero. */
export type LineStyle = "h1" | "h2" | "h3" | "ul" | "ol";

export interface LineFormat {
  style: LineStyle;
  /** Niveau d'une liste, 0 (absent) a MAX_LIST_LEVEL. */
  level?: number;
  /** Liste numerotee : numero lu ou tape, sert de depart a la liste. */
  num?: number;
}

/**
 * Jeton `line` : toujours en debut de ligne (debut du texte ou juste apres
 * un `br`), il met en forme toute la ligne jusqu'au `br` suivant.
 */
export type DocToken =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean; color?: ColorKey }
  | { kind: "math"; latex: string; color?: ColorKey }
  | { kind: "image"; id: string }
  /**
   * Lien vers une page (core/links.ts) : `href` = « cahiers:<pageId>… »,
   * `hint` = chemin lisible « Maths/Cours/0012 » au moment de la pose.
   */
  | { kind: "link"; label: string; href: string; hint?: string }
  | { kind: "br" }
  | ({ kind: "line" } & LineFormat);

/** Profondeur maximale d'une liste (Tab). */
export const MAX_LIST_LEVEL = 4;

/** Marqueur de debut de ligne : titre (sans retrait), puce ou numero. */
const MARKER = /^( *)(?:(#{1,3}) |(-) |(\d{1,3})[.)] )/;

/** Marqueur de debut de ligne lu dans le texte, et sa longueur. */
function matchMarker(s: string): { format: LineFormat; length: number; escapeAt: number } | null {
  const m = MARKER.exec(s);
  if (!m) return null;
  const pad = m[1].length;
  if (m[2]) {
    // Un titre ne se retire pas : "  # x" reste du texte.
    if (pad) return null;
    return { format: { style: `h${m[2].length}` as LineStyle }, length: m[0].length, escapeAt: 0 };
  }
  const level = Math.min(MAX_LIST_LEVEL, Math.floor(pad / 2));
  const lvl = level ? { level } : {};
  if (m[3]) return { format: { style: "ul", ...lvl }, length: m[0].length, escapeAt: pad };
  return {
    format: { style: "ol", ...lvl, num: Number(m[4]) },
    length: m[0].length, escapeAt: pad + m[4].length,
  };
}

/**
 * Marqueur tape juste avant l'Espace en debut de ligne : "#", "##", "###",
 * "-" ou "*", "1." ou "1)". null si ce n'en est pas un.
 */
export function markerStyle(typed: string): LineFormat | null {
  if (/^#{1,3}$/.test(typed)) return { style: `h${typed.length}` as LineStyle };
  if (typed === "-" || typed === "*") return { style: "ul" };
  const m = /^(\d{1,3})[.)]$/.exec(typed);
  return m ? { style: "ol", num: Number(m[1]) } : null;
}

/** Debut de ligne ecrit sur le disque : "## ", "  - ", "3. ". */
function lineMarker(f: LineFormat, num: number | null): string {
  if (f.style === "ul" || f.style === "ol") {
    const pad = "  ".repeat(f.level ?? 0);
    return f.style === "ul" ? `${pad}- ` : `${pad}${num ?? f.num ?? 1}. `;
  }
  return `${"#".repeat(Number(f.style[1]))} `;
}

/** Une ligne du texte : sa mise en forme (null = paragraphe) et ses jetons. */
export interface DocLine { format: LineFormat | null; tokens: DocToken[] }

/** Le texte ligne par ligne (les `br` separent, ils ne figurent pas). */
export function docLines(tokens: DocToken[]): DocLine[] {
  const lines: DocLine[] = [{ format: null, tokens: [] }];
  for (const t of tokens) {
    let cur = lines[lines.length - 1];
    if (t.kind === "br") { lines.push({ format: null, tokens: [] }); continue; }
    if (t.kind === "line") {
      // Mise en forme au milieu d'une ligne : elle commence une ligne.
      if (cur.tokens.length || cur.format) { cur = { format: null, tokens: [] }; lines.push(cur); }
      cur.format = lineFormatOf(t);
      continue;
    }
    if (t.kind === "text" && t.text.includes("\n")) {
      t.text.split("\n").forEach((part, i) => {
        if (i) lines.push({ format: null, tokens: [] });
        if (part) lines[lines.length - 1].tokens.push({ ...t, text: part });
      });
      continue;
    }
    cur.tokens.push(t);
  }
  return lines;
}

/** Mise en forme propre : niveau borne, et seulement pour une liste. */
function lineFormatOf(t: LineFormat): LineFormat {
  const out: LineFormat = { style: t.style };
  if (t.style === "ul" || t.style === "ol") {
    const level = Math.max(0, Math.min(MAX_LIST_LEVEL, Math.round(t.level ?? 0)));
    if (level) out.level = level;
    if (t.style === "ol" && t.num !== undefined) out.num = t.num;
  }
  return out;
}

/**
 * Numeros affiches des lignes (null hors liste numerotee). Une liste
 * numerotee se suit tant que les lignes sont des elements de liste ; une
 * ligne normale ou un titre la coupe, une sous-liste ne la coupe pas. Le
 * premier element donne le depart (son `num`), les suivants s'incrementent.
 */
export function listNumbers(formats: (LineFormat | null)[]): (number | null)[] {
  const counters: ({ ol: boolean; n: number } | undefined)[] = [];
  return formats.map((f) => {
    if (!f || (f.style !== "ul" && f.style !== "ol")) { counters.length = 0; return null; }
    const level = f.level ?? 0;
    if (counters.length > level + 1) counters.length = level + 1;
    if (f.style === "ul") { counters[level] = { ol: false, n: 0 }; return null; }
    const prev = counters[level];
    const n = prev?.ol ? prev.n + 1 : f.num ?? 1;
    counters[level] = { ol: true, n };
    return n;
  });
}

/** Texte du premier titre de plus haut niveau (formules relues), "" sans titre. */
export function docTitle(tokens: DocToken[]): string {
  let best = "", rank = 4;
  for (const line of docLines(tokens)) {
    const f = line.format;
    if (!f || f.style[0] !== "h") continue;
    const r = Number(f.style[1]);
    if (r >= rank) continue;
    const text = lineText(line.tokens);
    if (!text) continue;
    best = text;
    rank = r;
  }
  return best;
}

/** Texte lisible d'une ligne : formules relues, liens par leur libelle. */
function lineText(tokens: DocToken[]): string {
  return tokens.map((t) =>
    t.kind === "math" ? texToPlain(t.latex) : t.kind === "text" ? t.text : t.kind === "link" ? t.label : "")
    .join("").replace(/\s+/g, " ").trim();
}

/** Tous les titres # du texte, dans l'ordre (cibles de liens, selecteur `[[`). */
export function docHeadings(tokens: DocToken[]): string[] {
  const out: string[] = [];
  for (const line of docLines(tokens)) {
    if (!line.format || line.format.style[0] !== "h") continue;
    const text = lineText(line.tokens);
    if (text) out.push(text);
  }
  return out;
}

/** Liens poses dans le texte. */
export function docLinks(tokens: DocToken[]): Extract<DocToken, { kind: "link" }>[] {
  return tokens.filter((t): t is Extract<DocToken, { kind: "link" }> => t.kind === "link");
}

const IMG_OPEN = "![](img:";
const LINK_OPEN = "](cahiers:";

const ESCAPED = /[\\$*[\]]/g;
const COLOR_KEYS = new Set<string>(PALETTE.map((p) => p.key));

function colorOfToken(t: DocToken): ColorKey | undefined {
  return t.kind === "text" || t.kind === "math" ? t.color : undefined;
}

export function serializeDoc(tokens: DocToken[]): string {
  const lines = docLines(normalizeTokens(tokens));
  const nums = listNumbers(lines.map((l) => l.format));
  return lines.map((line, k) => {
    const body = serializeLine(line.tokens);
    if (line.format) return lineMarker(line.format, nums[k]) + body;
    // Texte qui ressemblerait a un marqueur : echappe, il reste du texte.
    const m = matchMarker(body);
    return m ? `${body.slice(0, m.escapeAt)}\\${body.slice(m.escapeAt)}` : body;
  }).join("\n");
}

/** Une ligne sans sa mise en forme : les suites de meme couleur forment un groupe [..]{.couleur}. */
function serializeLine(list: DocToken[]): string {
  let out = "";
  for (let i = 0; i < list.length;) {
    const color = colorOfToken(list[i]);
    let j = i;
    while (j < list.length && colorOfToken(list[j]) === color) j++;
    const body = serializePlain(list.slice(i, j));
    out += color ? `[${body}]{.${color}}` : body;
    i = j;
  }
  return out;
}

function serializePlain(tokens: DocToken[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.kind === "br") { out += "\n"; continue; }
    if (t.kind === "line") continue;
    if (t.kind === "image") { out += `${IMG_OPEN}${t.id})`; continue; }
    if (t.kind === "link") {
      // href deja encode par core/links.ts : ni blanc, ni parenthese, ni guillemet.
      const href = t.href.replace(/[\s()"]/g, encodeURIComponent);
      const hint = t.hint ? ` "${t.hint.replace(/["\n\r]/g, "")}"` : "";
      out += `[${t.label.replace(ESCAPED, (c) => `\\${c}`)}](${href}${hint})`;
      continue;
    }
    // Le LaTeX passe tel quel : un $ n'y apparait jamais seul, toujours en \$.
    if (t.kind === "math") { out += `$${t.latex.replace(/(^|[^\\])\$/g, "$1\\$")}$`; continue; }
    // Les retours a la ligne d'un texte deviennent des jetons br a la lecture.
    const parts = t.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) out += "\n";
      if (!part) return;
      let s = part.replace(ESCAPED, (c) => `\\${c}`);
      if (t.italic) s = `*${s}*`;
      if (t.bold) s = `**${s}**`;
      out += s;
    });
  }
  return out;
}

export function parseDoc(src: string): DocToken[] {
  return parseFrom(src, true);
}

/** `lineStart` : le debut de `src` est un debut de ligne (faux dans un groupe de couleur). */
function parseFrom(src: string, lineStart: boolean): DocToken[] {
  const out: DocToken[] = [];
  let bold = false, italic = false, buf = "";
  const flush = () => {
    if (!buf) return;
    out.push({ kind: "text", text: buf, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
    buf = "";
  };

  for (let i = 0; i < src.length; i++) {
    if (i === 0 ? lineStart : src[i - 1] === "\n") {
      const m = matchMarker(src.slice(i, i + 16));
      if (m) {
        flush();
        out.push({ kind: "line", ...m.format });
        i += m.length - 1;
        continue;
      }
    }
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) { buf += src[++i]; continue; }
    if (c === "\n") { flush(); out.push({ kind: "br" }); continue; }
    if (c === "[") {
      // Lien d'abord : son "]" n'est jamais suivi de {.couleur}.
      const link = linkAt(src, i);
      if (link) {
        flush();
        out.push(link.token);
        i = link.end - 1;
        continue;
      }
      const group = colorGroup(src, i);
      if (group) {
        flush();
        for (const t of parseFrom(src.slice(i + 1, group.innerEnd), false)) {
          out.push(t.kind === "text" || t.kind === "math" ? { ...t, color: group.color } : t);
        }
        i = group.end - 1;
        continue;
      }
    }
    if (c === "!" && src.startsWith(IMG_OPEN, i)) {
      const end = src.indexOf(")", i + IMG_OPEN.length);
      if (end !== -1) {
        flush();
        out.push({ kind: "image", id: src.slice(i + IMG_OPEN.length, end) });
        i = end;
        continue;
      }
    }
    if (c === "$") {
      // Formule jusqu'au prochain $ non echappe. Les \x du LaTeX passent
      // tels quels, \$ compris.
      let j = i + 1, latex = "";
      while (j < src.length && src[j] !== "$") {
        if (src[j] === "\\" && j + 1 < src.length) {
          latex += src[j] + src[j + 1];
          j += 2;
        } else {
          latex += src[j++];
        }
      }
      if (j >= src.length) { buf += c; continue; } // $ isole : du texte
      flush();
      out.push({ kind: "math", latex });
      i = j;
      continue;
    }
    if (c === "*") {
      flush();
      if (src[i + 1] === "*") { bold = !bold; i++; } else italic = !italic;
      continue;
    }
    buf += c;
  }
  flush();
  return normalizeTokens(out);
}

/** Lien [libellé](cahiers:…) ou [libellé](cahiers:… "chemin") ouvert en `start`. */
function linkAt(src: string, start: number): { token: DocToken; end: number } | null {
  let label = "";
  let j = start + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\" && j + 1 < src.length) { label += src[++j]; continue; }
    if (c === "]" || c === "[" || c === "\n") break;
    label += c;
  }
  if (src[j] !== "]" || !src.startsWith(LINK_OPEN, j)) return null;
  const m = /^\]\((cahiers:[^\s)"]+)(?: "([^"\n]*)")?\)/.exec(src.slice(j, j + 600));
  if (!m) return null;
  const token: DocToken = { kind: "link", label, href: m[1], ...(m[2] ? { hint: m[2] } : {}) };
  return { token, end: j + m[0].length };
}

/**
 * Groupe de couleur ouvert en `start` : [ ... ]{.cle}. Les formules $..$ et
 * les caracteres echappes a l'interieur sont sautes. null si ce [ n'ouvre
 * pas de groupe (un crochet ancien, tape avant les couleurs).
 */
function colorGroup(src: string, start: number): { innerEnd: number; end: number; color: ColorKey } | null {
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "$") {
      let k = j + 1;
      while (k < src.length && src[k] !== "$") k += src[k] === "\\" ? 2 : 1;
      if (k < src.length) j = k;
      continue;
    }
    if (c === "]") {
      const m = /^\]\{\.([a-z]+)\}/.exec(src.slice(j));
      if (m && COLOR_KEYS.has(m[1])) return { innerEnd: j, end: j + m[0].length, color: m[1] as ColorKey };
    }
  }
  return null;
}

/** Fusionne les textes voisins de meme style, retire les textes et formules vides. */
export function normalizeTokens(tokens: DocToken[]): DocToken[] {
  const out: DocToken[] = [];
  for (const t of tokens) {
    if (t.kind === "text") {
      if (!t.text) continue;
      const prev = out[out.length - 1];
      if (prev?.kind === "text" && !!prev.bold === !!t.bold && !!prev.italic === !!t.italic
          && prev.color === t.color) {
        out[out.length - 1] = { ...prev, text: prev.text + t.text };
        continue;
      }
      out.push({
        kind: "text", text: t.text,
        ...(t.bold ? { bold: true } : {}), ...(t.italic ? { italic: true } : {}),
        ...(t.color ? { color: t.color } : {}),
      });
      continue;
    }
    if (t.kind === "math") {
      if (!t.latex.trim()) continue;
      out.push({ kind: "math", latex: t.latex, ...(t.color ? { color: t.color } : {}) });
      continue;
    }
    if (t.kind === "line") { out.push({ kind: "line", ...lineFormatOf(t) }); continue; }
    if (t.kind === "link") {
      if (!t.href) continue;
      out.push({ kind: "link", label: t.label, href: t.href, ...(t.hint ? { hint: t.hint } : {}) });
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Ids des photos posees dans le texte. */
export function docImageIds(src: string): string[] {
  return parseDoc(src).flatMap((t) => (t.kind === "image" ? [t.id] : []));
}

/** Texte brut pour la recherche : les formules gardent leur LaTeX. */
export function docPlainText(src: string): string {
  return parseDoc(src).map((t) =>
    t.kind === "br" ? "\n" : t.kind === "math" ? t.latex : t.kind === "text" ? t.text
      : t.kind === "link" ? t.label : "").join("");
}

/**
 * Fin de mot juste avant le curseur, reprise comme numerateur d'une fraction
 * (Alt+F apres "3x" donne 3x sur une barre de fraction, curseur en bas).
 */
export function trailingOperand(text: string): string {
  const m = /[\p{L}\p{N}.,]+$/u.exec(text);
  if (!m) return "";
  // Un point ou une virgule en fin de phrase ne fait pas partie du nombre.
  return m[0].replace(/^[.,]+/, "").replace(/[.,]+$/, "");
}

/**
 * Anciennes zones "Texte" (blocs text avec rect) : elles se posaient
 * par-dessus la page et cachent desormais le texte tape dessous. Leur
 * contenu rejoint le texte de la page, dans l'ordre de haut en bas ; les
 * zones vides disparaissent. Rien n'est perdu. Renvoie true si la page a change.
 */
export function absorbTextBoxes(
  blocks: { type: string; rect?: { y: number }; content?: string; id: string }[],
  newId: () => string,
): boolean {
  const boxes = blocks.filter((b) => b.type === "text" && b.rect);
  if (!boxes.length) return false;
  const texts = boxes
    .sort((a, b) => a.rect!.y - b.rect!.y)
    .map((b) => (b.content ?? "").trim())
    .filter(Boolean)
    .map((t) => serializeDoc([{ kind: "text", text: t }]));
  for (const b of boxes) blocks.splice(blocks.indexOf(b), 1);
  if (texts.length) {
    let body = blocks.find((b) => b.type === "text" && !b.rect);
    if (!body) { body = { id: newId(), type: "text", content: "" }; blocks.push(body); }
    body.content = [body.content, ...texts].filter(Boolean).join("\n");
  }
  return true;
}

/**
 * Texte colle d'ailleurs (ChatGPT, Overleaf, un cours en Markdown) : le
 * LaTeX entre $…$, $$…$$, \(…\) ou \[…\] devient une formule. Les formules
 * centrees ($$ et \[) gardent leur grande taille (\displaystyle). Un $ seul
 * n'ouvre une formule que s'il est colle a son contenu ($x$, pas « 5 $ et
 * 10 $ ») et sur la meme ligne. null s'il n'y a aucune formule : le texte est
 * alors colle tel quel.
 */
export function pastedMath(src: string): DocToken[] | null {
  const out: DocToken[] = [];
  let buf = "";
  let found = false;
  const flush = (): void => {
    buf.split("\n").forEach((part, k) => {
      if (k) out.push({ kind: "br" });
      if (part) out.push({ kind: "text", text: part });
    });
    buf = "";
  };
  const push = (latex: string, display: boolean): void => {
    const body = latex.replace(/\s+/g, " ").trim();
    flush();
    out.push({ kind: "math", latex: display ? `\\displaystyle ${body}` : body });
    found = true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const display = src.startsWith("$$", i) ? "$$" : src.startsWith("\\[", i) ? "\\]" : null;
    if (display) {
      const end = src.indexOf(display, i + 2);
      if (end > i + 2 && src.slice(i + 2, end).trim()) {
        push(src.slice(i + 2, end), true);
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("\\(", i)) {
      const end = src.indexOf("\\)", i + 2);
      if (end > i + 2 && src.slice(i + 2, end).trim()) {
        push(src.slice(i + 2, end), false);
        i = end + 1;
        continue;
      }
    }
    if (c === "\\" && src[i + 1] === "$") { buf += "$"; i++; continue; }
    if (c === "$" && src[i + 1] !== "$") {
      let j = i + 1;
      while (j < src.length && src[j] !== "$" && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const body = src.slice(i + 1, j);
      if (src[j] === "$" && body && !/^\s|\s$/.test(body) && !/\d/.test(src[j + 1] ?? "")) {
        push(body, false);
        i = j;
        continue;
      }
    }
    buf += c;
  }
  if (!found) return null;
  flush();
  return out;
}

/**
 * Texte d'un morceau copie, pour le presse-papiers des autres logiciels :
 * les formules en $LaTeX$, les photos omises.
 */
export function docClipboardText(tokens: DocToken[], math: (latex: string) => string = (l) => `$${l}$`): string {
  const lines = docLines(tokens);
  const nums = listNumbers(lines.map((l) => l.format));
  return lines.map((line, k) => (line.format ? lineMarker(line.format, nums[k]) : "") + line.tokens.map((t) =>
    t.kind === "math" ? math(t.latex) : t.kind === "text" ? t.text : t.kind === "link" ? t.label : "").join("")).join("\n");
}

/**
 * Lignes d'un morceau copie, pour le HTML du presse-papiers : texte et
 * formules a part, marqueur de titre ou de puce compris.
 */
export function docClipboardLines(tokens: DocToken[]): { marker: string; parts: ({ text: string } | { latex: string })[] }[] {
  const lines = docLines(tokens);
  const nums = listNumbers(lines.map((l) => l.format));
  return lines.map((line, k) => ({
    marker: line.format ? lineMarker(line.format, nums[k]) : "",
    parts: line.tokens.flatMap((t): ({ text: string } | { latex: string })[] =>
      t.kind === "math" ? [{ latex: t.latex }] : t.kind === "text" ? [{ text: t.text }] : t.kind === "link" ? [{ text: t.label }] : []),
  }));
}

/** Commandes LaTeX relues en texte : lettres grecques par leur nom, relations en ASCII. */
const TEX_WORDS: Record<string, string> = {
  varepsilon: "epsilon", epsilon: "epsilon", varphi: "phi", cdot: "·", times: "×",
  leq: "<=", geq: ">=", neq: "!=", approx: "~=", ll: "<<", gg: ">>", to: "->",
  Rightarrow: "=>", Leftrightarrow: "<=>", infty: "infini", pm: "+-", partial: "d",
};

/**
 * Formule LaTeX relue en texte simple, comme on l'aurait tapee :
 * "V_{be}" -> "Vbe", "\frac{V_z - V_{be}}{R}" -> "(Vz - Vbe)/R",
 * "\beta" -> "beta". Sert a la recherche : "vbe" doit trouver V_{be}.
 */
export function texToPlain(tex: string): string {
  // Ce qui reste une fois les groupes entre parentheses retires.
  const top = (x: string) => {
    let t = x.trim();
    for (let k = 0; k < 10 && /\([^()]*\)/.test(t); k++) t = t.replace(/\([^()]*\)/g, "");
    return t;
  };
  // Numerateur : parentheses seulement autour d'une somme ou d'une
  // relation ("Ve.R2/(R1+R2)" se tape sans parentheses en haut, "-R2/R1"
  // aussi). Denominateur : autour de tout ce qui n'est pas un seul terme.
  const wrapNum = (x: string) => {
    const t = top(x).replace(/^[-−+]\s*/, "");
    return /[+\-−=<>]|\\(?:pm|leq|geq|neq|approx|to|ll|gg)(?![A-Za-z])/.test(t) ? `(${x.trim()})` : x.trim();
  };
  const wrapDen = (x: string) =>
    (/[\s+\-−=<>]|\\[,;:! ]|\\(?:cdot|times)(?![A-Za-z])/.test(top(x)) ? `(${x.trim()})` : x.trim());
  // Indice compose : entre parentheses, comme on le tape ("u_(n+1)").
  const sub = (x: string) => (/[\s+\-−=<>]/.test(x.trim()) ? `(${x.trim()})` : x.trim());
  let s = tex.replace(/\\left|\\right|\\displaystyle/g, "")
    // Fractions abregees de MathLive : \frac12, \frac1{x}, \frac{a}2.
    .replace(/\\frac\s*([0-9A-Za-z])\s*([0-9A-Za-z])/g, "\\frac{$1}{$2}")
    .replace(/\\frac\s*([0-9A-Za-z])\s*\{/g, "\\frac{$1}{");
  // De l'interieur vers l'exterieur : un groupe sans accolade a la fois.
  for (let k = 0; k < 30; k++) {
    const next = s
      .replace(/\\(?:mathrm|text|operatorname|mathbf|mathit|mathbb|vec|overline)\{([^{}]*)\}/g, "$1")
      .replace(/(\\frac\{[^{}]*\})\s*([0-9A-Za-z])/g, "$1{$2}")
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_a, n: string, d: string) => `${wrapNum(n)}/${wrapDen(d)}`)
      .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
      // Bornes d'une integrale, d'une somme : le "_" reste ("int_0^1").
      .replace(/\\(int|sum|prod|lim)_\{([^{}]*)\}/g, (_a, op: string, b: string) => `\\${op}\u0001${sub(b)}`)
      .replace(/\\(int|sum|prod|lim)_/g, "\\$1\u0001")
      .replace(/_\{([^{}]*)\}/g, (_a, x: string) => (/[\s+\-−=<>]/.test(x.trim()) ? `_${sub(x)}` : x))
      .replace(/\^\{([^{}]*)\}/g, (_a, e: string) => `^${wrapDen(e)}`)
      .replace(/\{,\}/g, ",");
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_a, name: string) => TEX_WORDS[name] ?? name)
    .replace(/_(?=\()/g, "\u0001")
    .replace(/[_{}]/g, "")
    .replace(/\u0001/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}
