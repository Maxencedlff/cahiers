/**
 * Texte tape au clavier sur la page, facon traitement de texte.
 *
 * Stocke dans le `content` d'un bloc `text` sans `rect`, en markdown
 * restreint pour rester lisible dans le JSON (section 1) :
 *   **gras**, *italique*, $formule LaTeX$, retour a la ligne = "\n",
 *   `code` = commande ou chemin en chasse fixe (jamais converti en formule ;
 *   dedans, seuls \ et ` sont echappes),
 *   ![](img:<id>) = photo posee dans le texte (bloc image de meme id),
 *   [texte en couleur]{.theoreme} = une des 5 couleurs de la palette,
 *   [texte]{.s18} = taille en points facon Word (FONT_SIZES, 14 = normal,
 *   jamais ecrite), [texte]{.theoreme .s18} = les deux,
 *   [libellé](cahiers:<pageId>#<blockId> "Maths/Cours/0012") = lien vers
 *   une page (core/links.ts : cible par id de page, chemin lisible en repli),
 *   en debut de ligne (D11) : "# ", "## ", "### " = titres, "- " = puce,
 *   "> " = ligne encadree (conclusion),
 *   "1. " = liste numerotee, deux espaces devant par niveau de liste,
 *   "| a | b |" + "| --- | --- |" + lignes "| … |" = tableau (jeton `table`,
 *   un "|" du texte d'une case ecrit "\|", une ligne de texte qui commence
 *   par "|" ecrite "\|"),
 *   "```lang" … "```" = bloc de code (jeton `codeblock`, texte brut ; une
 *   ligne de texte "```" est toujours ecrite echappee, jamais lue en bloc).
 * Les caracteres speciaux du texte (\ $ * [ ] `) sont echappes par un
 * antislash, et un debut de ligne qui ressemblerait a un marqueur aussi
 * ("\# ", "\- ", "1\. ") : il reste du texte.
 *
 * Module sans DOM : l'interface lit et ecrit des jetons, pas du markdown.
 */

import type { ColorKey } from "../types";
import { PALETTE } from "../palette";

/** Mise en forme d'une ligne entiere (D11) : titre 1 a 3, puce, numero. */
export type LineStyle = "h1" | "h2" | "h3" | "ul" | "ol" | "box";

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
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean; code?: boolean; color?: ColorKey; size?: number }
  | { kind: "math"; latex: string; color?: ColorKey; size?: number }
  | { kind: "image"; id: string }
  /**
   * Lien vers une page (core/links.ts) : `href` = « cahiers:<pageId>… »,
   * `hint` = chemin lisible « Maths/Cours/0012 » au moment de la pose.
   */
  | { kind: "link"; label: string; href: string; hint?: string }
  | { kind: "br" }
  | ({ kind: "line" } & LineFormat)
  /**
   * Tableau (toujours seul sur sa ligne) : lignes de cases, chaque case =
   * texte et formules sur une ligne (ni saut, ni photo, ni tableau). Disque :
   * tableau « pipe » lisible (`| a | b |`, puis `| --- | --- |`).
   */
  | { kind: "table"; rows: DocToken[][][] }
  /**
   * Bloc de code (toujours seul sur ses lignes), texte brut colore a
   * l'affichage selon `lang` (core/text/codehl.ts). Disque : ```lang, le
   * code tel quel, puis ``` (plus de ` si le code contient une telle ligne).
   */
  | { kind: "codeblock"; lang: string; text: string };

/** Profondeur maximale d'une liste (Tab). */
export const MAX_LIST_LEVEL = 4;

/** Marqueur de debut de ligne : titre (sans retrait), puce ou numero. */
const MARKER = /^( *)(?:(#{1,3}) |(-) |(\d{1,3})[.)] |(>) )/;

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
  // « > » : ligne encadree (conclusion, resultat), sans retrait.
  if (m[5]) return pad ? null : { format: { style: "box" }, length: m[0].length, escapeAt: 0 };
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
  if (f.style === "box") return "> ";
  return `${"#".repeat(Number(f.style[1]))} `;
}

/** Une ligne du texte : sa mise en forme (null = paragraphe) et ses jetons. */
export interface DocLine { format: LineFormat | null; tokens: DocToken[] }

/** Le texte ligne par ligne (les `br` separent, ils ne figurent pas). */
export function docLines(tokens: DocToken[]): DocLine[] {
  const lines: DocLine[] = [{ format: null, tokens: [] }];
  // Juste apres un tableau : ce qui suit (hors saut) commence une ligne.
  let afterTable = false;
  for (const t of tokens) {
    let cur = lines[lines.length - 1];
    if (t.kind === "br") { lines.push({ format: null, tokens: [] }); afterTable = false; continue; }
    const own = t.kind === "table" || t.kind === "codeblock";
    if (afterTable || own) {
      if (cur.tokens.length || cur.format) { cur = { format: null, tokens: [] }; lines.push(cur); }
      afterTable = own;
      if (own) { cur.tokens.push(t); continue; }
    }
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

const ESCAPED = /[\\$*[\]`]/g;
const COLOR_KEYS = new Set<string>(PALETTE.map((p) => p.key));

function colorOfToken(t: DocToken): ColorKey | undefined {
  return t.kind === "text" || t.kind === "math" ? t.color : undefined;
}

/**
 * Tailles de texte proposees, en points comme dans Word ; 14 = texte
 * normal de la page (corps 18 px), jamais ecrite dans le fichier.
 */
export const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 22] as const;
export const NORMAL_SIZE = 14;

function sizeOfToken(t: DocToken): number | undefined {
  return t.kind === "text" || t.kind === "math" ? t.size : undefined;
}

export function serializeDoc(tokens: DocToken[]): string {
  const lines = docLines(normalizeTokens(tokens));
  const nums = listNumbers(lines.map((l) => l.format));
  return lines.map((line, k) => {
    const table = line.tokens.find((t) => t.kind === "table" || t.kind === "codeblock");
    if (table?.kind === "table") return serializeTable(table.rows);
    if (table?.kind === "codeblock") return serializeCode(table.lang, table.text);
    const body = serializeLine(line.tokens);
    if (line.format) return lineMarker(line.format, nums[k]) + body;
    // Une ligne de texte qui commence par « | » ne devient jamais un tableau.
    if (body.startsWith("|")) return `\\${body}`;
    // Texte qui ressemblerait a un marqueur : echappe, il reste du texte.
    const m = matchMarker(body);
    return m ? `${body.slice(0, m.escapeAt)}\\${body.slice(m.escapeAt)}` : body;
  }).join("\n");
}

/** Une ligne sans sa mise en forme : les suites de meme couleur et taille forment un groupe [..]{.couleur .s16}. */
function serializeLine(list: DocToken[]): string {
  let out = "";
  for (let i = 0; i < list.length;) {
    const color = colorOfToken(list[i]);
    const size = sizeOfToken(list[i]);
    let j = i;
    while (j < list.length && colorOfToken(list[j]) === color && sizeOfToken(list[j]) === size) j++;
    const body = serializePlain(list.slice(i, j));
    const attrs = [color ? `.${color}` : "", size ? `.s${size}` : ""].filter(Boolean).join(" ");
    out += attrs ? `[${body}]{${attrs}}` : body;
    i = j;
  }
  return out;
}

function serializePlain(tokens: DocToken[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.kind === "br") { out += "\n"; continue; }
    if (t.kind === "line" || t.kind === "table" || t.kind === "codeblock") continue;
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
      let s = t.code ? `\`${part.replace(/[\\`]/g, (c) => `\\${c}`)}\`` : part.replace(ESCAPED, (c) => `\\${c}`);
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
      if (src.startsWith("```", i)) {
        const cb = codeAt(src, i);
        if (cb) {
          flush();
          out.push(cb.token);
          i = cb.end - 1;
          continue;
        }
      }
      if (src[i] === "|") {
        const tb = tableAt(src, i);
        if (tb) {
          flush();
          out.push(tb.token);
          i = tb.end - 1;
          continue;
        }
      }
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
          out.push(t.kind === "text" || t.kind === "math"
            ? { ...t, ...(group.color ? { color: group.color } : {}), ...(group.size ? { size: group.size } : {}) }
            : t);
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
    if (c === "`") {
      // Code jusqu'au prochain ` non echappe de la meme ligne ; seul : du texte.
      let j = i + 1, code = "";
      while (j < src.length && src[j] !== "`" && src[j] !== "\n") {
        if (src[j] === "\\" && j + 1 < src.length && src[j + 1] !== "\n") { code += src[j + 1]; j += 2; } else code += src[j++];
      }
      if (src[j] !== "`") { buf += c; continue; }
      flush();
      if (code) out.push({ kind: "text", text: code, code: true, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
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
function colorGroup(src: string, start: number): { innerEnd: number; end: number; color?: ColorKey; size?: number } | null {
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "$" || c === "`") {
      let k = j + 1;
      while (k < src.length && src[k] !== c) k += src[k] === "\\" ? 2 : 1;
      if (k < src.length) j = k;
      continue;
    }
    if (c === "]") {
      const m = /^\]\{(\.[a-z0-9]+(?: \.[a-z0-9]+)?)\}/.exec(src.slice(j));
      if (m) {
        let color: ColorKey | undefined, size: number | undefined, bad = false;
        for (const cls of m[1].split(" ").map((x) => x.slice(1))) {
          if (COLOR_KEYS.has(cls) && !color) color = cls as ColorKey;
          else if (/^s\d{1,2}$/.test(cls) && (FONT_SIZES as readonly number[]).includes(Number(cls.slice(1))) && !size) size = Number(cls.slice(1));
          else bad = true;
        }
        if (!bad && (color || size)) return { innerEnd: j, end: j + m[0].length, ...(color ? { color } : {}), ...(size ? { size } : {}) };
      }
    }
  }
  return null;
}

/* ---------------- tableaux ---------------- */

/** Ligne de separation sous l'en-tete : « | --- | :---: | ». */
const TABLE_SEP = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** Tableau vide de `rows` × `cols` cases. */
export function emptyTable(rows: number, cols: number): Extract<DocToken, { kind: "table" }> {
  return { kind: "table", rows: Array.from({ length: Math.max(1, rows) }, () => Array.from({ length: Math.max(1, cols) }, () => [])) };
}

/** Case propre : texte et formules sur une ligne (un saut devient une espace). */
function normalizeCell(cell: DocToken[]): DocToken[] {
  const flat = cell.flatMap((t): DocToken[] => {
    if (t.kind === "br") return [{ kind: "text", text: " " }];
    if (t.kind === "text") return [{ ...t, text: t.text.replace(/\n/g, " ") }];
    return t.kind === "math" || t.kind === "link" ? [t] : [];
  });
  const out = normalizeTokens(flat);
  // Blancs du bord : le format pipe les retire a la lecture, on les retire tout de suite.
  const first = out[0];
  if (first?.kind === "text") out[0] = { ...first, text: first.text.replace(/^\s+/, "") };
  const last = out[out.length - 1];
  if (last?.kind === "text") out[out.length - 1] = { ...last, text: last.text.replace(/\s+$/, "") };
  return out.filter((t) => t.kind !== "text" || t.text);
}

/**
 * Parcourt une ligne ecrite en sautant les caracteres echappes, les
 * formules $…$ et le code `…` ; `bar(i)` pour chaque « | » nu.
 */
function scanBars(s: string, bar: (i: number) => void): void {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" || c === "`") {
      let k = i + 1;
      while (k < s.length && s[k] !== c) k += s[k] === "\\" ? 2 : 1;
      if (k < s.length) i = k;
      continue;
    }
    if (c === "|") bar(i);
  }
}

/** Cases d'une ligne « | a | b | » (texte brut de chaque case, blancs retires). */
function splitRow(line: string): string[] {
  const bars: number[] = [];
  scanBars(line, (i) => bars.push(i));
  if (bars[0] !== 0) return [];
  const cells: string[] = [];
  for (let k = 0; k < bars.length; k++) {
    const end = k + 1 < bars.length ? bars[k + 1] : line.length;
    const cell = line.slice(bars[k] + 1, end);
    if (k + 1 === bars.length && !cell.trim()) break;
    cells.push(cell.trim());
  }
  return cells;
}

/** Tableau pipe qui commence en `start` (debut de ligne), ou null. */
function tableAt(src: string, start: number): { token: DocToken; end: number } | null {
  const lineEnd = (from: number) => { const e = src.indexOf("\n", from); return e < 0 ? src.length : e; };
  const e0 = lineEnd(start);
  if (e0 >= src.length) return null;
  const e1 = lineEnd(e0 + 1);
  const head = splitRow(src.slice(start, e0));
  const sep = src.slice(e0 + 1, e1);
  if (!head.length || !TABLE_SEP.test(sep) || splitRow(sep).length !== head.length) return null;
  const rows = [head];
  let end = e1;
  while (end < src.length && src[end + 1] === "|") {
    const e = lineEnd(end + 1);
    const cells = splitRow(src.slice(end + 1, e));
    if (!cells.length) break;
    rows.push(cells);
    end = e;
  }
  const token: DocToken = { kind: "table", rows: rows.map((r) => r.map((c) => normalizeCell(parseFrom(c, false)))) };
  return { token: normalizeTokens([token])[0] ?? token, end };
}

/** Une case ecrite : comme une ligne, avec ses « | » de texte echappes. */
function serializeCell(cell: DocToken[]): string {
  const s = serializeLine(normalizeCell(cell));
  const bars: number[] = [];
  scanBars(s, (i) => bars.push(i));
  let out = s;
  for (const i of bars.reverse()) out = `${out.slice(0, i)}\\${out.slice(i)}`;
  return out;
}

/** Tableau ecrit : en-tete (1re ligne), separation, puis les autres lignes. */
function serializeTable(rows: DocToken[][][]): string {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const line = (r: DocToken[][]) => `| ${Array.from({ length: cols }, (_, k) => serializeCell(r[k] ?? [])).join(" | ")} |`;
  return [line(rows[0] ?? []), `|${" --- |".repeat(cols)}`, ...rows.slice(1).map(line)].join("\n");
}

/* ---------------- blocs de code ---------------- */

/** Bloc ```lang … ``` ouvert en `start` (debut de ligne), ou null (pas de fin : du texte). */
function codeAt(src: string, start: number): { token: DocToken; end: number } | null {
  const m = /^(`{3,})([\w+#.-]*)[ \t]*\n/.exec(src.slice(start, start + 80));
  if (!m) return null;
  const fence = m[1];
  const bodyStart = start + m[0].length;
  // Fin : une ligne faite d'autant de ` (ou plus), seule. Code vide : la ligne juste apres.
  for (let at = bodyStart; at <= src.length;) {
    const e = src.indexOf("\n", at);
    const lineEnd = e < 0 ? src.length : e;
    const line = src.slice(at, lineEnd);
    if (line.startsWith(fence) && /^`+[ \t]*$/.test(line)) {
      const text = at > bodyStart ? src.slice(bodyStart, at - 1) : "";
      return { token: { kind: "codeblock", lang: m[2], text }, end: lineEnd };
    }
    if (e < 0) break;
    at = e + 1;
  }
  return null;
}

/** Bloc de code ecrit : ``` assez longs pour ne jamais etre pris dans le code. */
function serializeCode(lang: string, text: string): string {
  let fence = "```";
  while (text.split("\n").some((l) => l.startsWith(fence))) fence += "`";
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * Tableaux mis a plat : chaque ligne du tableau devient une ligne de texte,
 * cases separees par « | » (revision, suggestions : ce qui est ecrit dans
 * un tableau compte comme le reste).
 */
export function flattenTables(tokens: DocToken[]): DocToken[] {
  return tokens.flatMap((t): DocToken[] => t.kind === "codeblock" ? [{ kind: "br" }] : t.kind !== "table" ? [t]
    : t.rows.flatMap((r): DocToken[] => [
      ...r.flatMap((c, i): DocToken[] => (i ? [{ kind: "text", text: " | " }, ...c] : c)),
      { kind: "br" },
    ]));
}

/** Texte d'une case : formules relues par `math`, liens par leur libelle. */
export function cellText(cell: DocToken[], math: (latex: string) => string = texToPlain): string {
  return cell.map((t) => (t.kind === "math" ? math(t.latex) : t.kind === "text" ? t.text : t.kind === "link" ? t.label : "")).join("");
}

/** Fusionne les textes voisins de meme style, retire les textes et formules vides. */
export function normalizeTokens(tokens: DocToken[]): DocToken[] {
  const out: DocToken[] = [];
  for (const t of tokens) {
    if (t.kind === "text") {
      if (!t.text) continue;
      const prev = out[out.length - 1];
      if (prev?.kind === "text" && !!prev.bold === !!t.bold && !!prev.italic === !!t.italic
          && !!prev.code === !!t.code && prev.color === t.color && prev.size === (t.size === NORMAL_SIZE ? undefined : t.size)) {
        out[out.length - 1] = { ...prev, text: prev.text + t.text };
        continue;
      }
      out.push({
        kind: "text", text: t.text,
        ...(t.bold ? { bold: true } : {}), ...(t.italic ? { italic: true } : {}),
        ...(t.code ? { code: true } : {}), ...(t.color ? { color: t.color } : {}),
        ...(t.size && t.size !== NORMAL_SIZE ? { size: t.size } : {}),
      });
      continue;
    }
    if (t.kind === "math") {
      if (!t.latex.trim()) continue;
      out.push({ kind: "math", latex: t.latex, ...(t.color ? { color: t.color } : {}), ...(t.size && t.size !== NORMAL_SIZE ? { size: t.size } : {}) });
      continue;
    }
    if (t.kind === "line") { out.push({ kind: "line", ...lineFormatOf(t) }); continue; }
    if (t.kind === "table") {
      const rows = t.rows.filter((r) => r.length).map((r) => r.map(normalizeCell));
      if (!rows.length) continue;
      const cols = Math.max(...rows.map((r) => r.length));
      out.push({ kind: "table", rows: rows.map((r) => [...r, ...Array.from({ length: cols - r.length }, () => [])]) });
      continue;
    }
    if (t.kind === "codeblock") {
      out.push({ kind: "codeblock", lang: t.lang.trim(), text: t.text.replace(/\r\n?/g, "\n") });
      continue;
    }
    if (t.kind === "link") {
      if (!t.href) continue;
      out.push({ kind: "link", label: t.label, href: t.href, ...(t.hint ? { hint: t.hint } : {}) });
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Ponctuation francaise, comme Word : l'espace tapee devant « : ; ? ! »
 * devient une espace fine insecable (U+202F), qui ne coupe plus la ligne
 * avant le signe. `before` = texte avant le curseur, signe compris ; null
 * si rien ne change.
 */
export function frenchSpaceAtEnd(before: string): string | null {
  const m = /[ \u00a0]([:;?!])$/.exec(before);
  if (!m || before.length < 3 || /\s/.test(before[before.length - 3])) return null;
  return `${before.slice(0, -2)}\u202f${m[1]}`;
}

/** Ids des photos posees dans le texte. */
export function docImageIds(src: string): string[] {
  return parseDoc(src).flatMap((t) => (t.kind === "image" ? [t.id] : []));
}

/** Texte brut pour la recherche : les formules gardent leur LaTeX. */
export function docPlainText(src: string): string {
  return parseDoc(src).map((t) =>
    t.kind === "br" ? "\n" : t.kind === "math" ? t.latex : t.kind === "text" ? t.text
      : t.kind === "link" ? t.label
      : t.kind === "table" ? t.rows.map((r) => r.map((c) => cellText(c, (l) => l)).join(" | ")).join("\n")
      : t.kind === "codeblock" ? t.text : "").join("");
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
  // Tableau : une ligne par rangee, cases separees par des tabulations (Excel, Word).
  return lines.map((line, k) => (line.format ? lineMarker(line.format, nums[k]) : "") + line.tokens.map((t) =>
    t.kind === "math" ? math(t.latex) : t.kind === "text" ? t.text : t.kind === "link" ? t.label
      : t.kind === "table" ? t.rows.map((r) => r.map((c) => cellText(c, math)).join("\t")).join("\n")
      : t.kind === "codeblock" ? t.text : "").join("")).join("\n");
}

/**
 * Lignes d'un morceau copie, pour le HTML du presse-papiers : texte et
 * formules a part, marqueur de titre ou de puce compris.
 */
export type ClipPart = { text: string } | { latex: string };
export function docClipboardLines(tokens: DocToken[]): { marker: string; parts: ClipPart[]; table?: ClipPart[][][]; code?: string }[] {
  const lines = docLines(tokens);
  const nums = listNumbers(lines.map((l) => l.format));
  const partsOf = (list: DocToken[]): ClipPart[] => list.flatMap((t): ClipPart[] =>
    t.kind === "math" ? [{ latex: t.latex }] : t.kind === "text" ? [{ text: t.text }] : t.kind === "link" ? [{ text: t.label }] : []);
  return lines.map((line, k) => ({
    ...(line.tokens[0]?.kind === "table" ? { table: line.tokens[0].rows.map((r) => r.map(partsOf)) } : {}),
    ...(line.tokens[0]?.kind === "codeblock" ? { code: line.tokens[0].text } : {}),
    marker: line.format ? lineMarker(line.format, nums[k]) : "",
    parts: partsOf(line.tokens),
  }));
}

/** Commandes LaTeX relues en texte : lettres grecques par leur nom, relations en ASCII. */
const TEX_WORDS: Record<string, string> = {
  varepsilon: "epsilon", epsilon: "epsilon", varphi: "phi", cdot: "·", times: "×",
  leq: "<=", geq: ">=", neq: "!=", approx: "~=", ll: "<<", gg: ">>", to: "->",
  Rightarrow: "=>", Leftrightarrow: "<=>", infty: "infini", pm: "+-", partial: "d",
};

/** Point de multiplication a la francaise : « R.C », « 10.10^3 », « 10^5.0,1 » ; jamais « 3.5 ». */
const FR_DOT = /(?<!\d)\.|\.(?!\d)|\d\.(?=10\^)|\^\{?-?\d+\}?\.(?=\d)/;
/** Ce qui suit une fraction et la multiplie (lettre, chiffre, parenthese, commande qui n'est pas un operateur ; pas « dx »). */
const FACTOR_AHEAD = /^(?:\s|\\[,;:! ])*(?!d[A-Za-z](?![A-Za-z]))(?:[A-Za-z0-9({]|\\(?!(?:cdot|times|div|pm|mp|leq|geq|neq|approx|ll|gg|to|Rightarrow|Leftrightarrow|right|quad|qquad|end|text|mbox)(?![A-Za-z])|mathrm\{d\})[A-Za-z])/;
/** Facteur juste avant une fraction : chiffre, lettre, parenthese ou groupe ferme. */
const FACTOR_BEHIND = /[A-Za-z0-9)}](?:\s|\\[,;:! ])*$/;
/** Sauf apres une fonction ou une borne (« \sin\frac{\pi}{2} », « \int_0^1\frac1x »). */
const NO_FACTOR_BEHIND = /\\(?:sin|cos|tan|cot|sh|ch|th|sinh|cosh|tanh|arcsin|arccos|arctan|exp|ln|log|lim|int|iint|oint|sum|prod|left|right|mathrm|text|operatorname|displaystyle)(?:\s|\\[,;:! ])*$|\\(?:int|iint|oint|sum|prod|lim)\s*(?:[_^\u0001]\s*(?:\{[^{}]*\}|\([^()]*\)|\\?[A-Za-z0-9]+)\s*)*(?:\s|\\[,;:! ])*$/;

/** Commandes qui valent une grandeur (lettres grecques, π, ∞) : un facteur ; les autres (\cdot, \sin, \int…) non. */
const VALUE_CMD = /^(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega|infty|ell|hbar)$/;
function factorBehind(before: string): boolean {
  const cmd = /\\([A-Za-z]+)(?:\s|\\[,;:! ])*$/.exec(before);
  if (cmd) return VALUE_CMD.test(cmd[1]);
  return FACTOR_BEHIND.test(before) && !NO_FACTOR_BEHIND.test(before);
}

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
  // Produit avec des parentheses (« p(p-1)(p+2) ») : entre parentheses
  // aussi, sinon « 2/p(p-1) » se relirait (2/p)(p-1). Un appel de fonction seul reste nu.
  const productParens = (x: string) => /[\w)}]\s*\(/.test(x)
    && !/^\\?(?:sqrt|sin|cos|tan|exp|ln|log|sh|ch|th|arcsin|arccos|arctan)\s*\([^()]*\)$/.test(x.trim());
  // Nombre colle a une lettre (« 2p ») : un produit, entre parentheses (« 1/(2p) »).
  // Une fraction (« 3/4 ») ou un produit au point (« R.C », « 10.10^3 »,
  // « 10^5.0,1 ») aussi : « 1/(R.C) », jamais « 1/R.C » relu (1/R).C.
  const wrapDen = (x: string) =>
    (/[\s+\-−=<>/·×*]|\\[,;:! ]|\\(?:cdot|times)(?![A-Za-z])/.test(top(x)) || FR_DOT.test(top(x)) || productParens(x)
      || /^\d+(?:[.,]\d+)?\s*\\?[A-Za-z]/.test(x.trim())
      ? `(${x.trim()})` : x.trim());
  // Fraction dans son contexte : elevee a une puissance (« (3/4)^2 ») ;
  // collee a un facteur devant (« 2\frac34 » = « 2 · 3/4 », jamais « 23/4 »)
  // ou derriere quand son denominateur n'est pas un nombre (« K/p · T »,
  // jamais « K/pT » ; « 1/2C » reste : mathjs lit (1/2)C).
  // « d/dt (…) » (derivee notee en operateur) n'est pas un produit.
  const fracInContext = (f: string, num: string, den: string, before: string, after: string) => {
    if (/^\s*\^/.test(after)) f = `(${f})`;
    else if (!/^\d+(?:[.,]\d+)?$/.test(den) && !/^\s*(?:d|\\partial)(?:\^\S+)?\s*$/.test(num) && FACTOR_AHEAD.test(after)) f = `${f} · `;
    if (factorBehind(before)) f = ` · ${f}`;
    else if (/[A-Za-z0-9}]$/.test(before)) f = ` ${f}`; // « int_0^1 1/x », jamais « int_0^11/x »
    return f;
  };
  // Indice compose : entre parentheses, comme on le tape ("u_(n+1)").
  const sub = (x: string) => (/[\s+\-−=<>]/.test(x.trim()) ? `(${x.trim()})` : x.trim());
  // \dfrac, \tfrac : des fractions comme les autres (« \dfrac1p » -> « 1/p »).
  let s = tex.replace(/\\left|\\right|\\displaystyle/g, "").replace(/\\[dt]frac(?![A-Za-z])/g, "\\frac")
    // Fractions abregees de MathLive : \frac12, \frac1{x}, \frac{a}2.
    .replace(/\\frac\s*([0-9A-Za-z])\s*([0-9A-Za-z])/g, "\\frac{$1}{$2}")
    .replace(/\\frac\s*([0-9A-Za-z])\s*\{/g, "\\frac{$1}{")
    // Racine abregee : « \sqrt7 », « \sqrt x » -> « \sqrt{7} ».
    .replace(/\\sqrt\s*([0-9A-Za-z])/g, "\\sqrt{$1}");
  // De l'interieur vers l'exterieur : un groupe sans accolade a la fois.
  for (let k = 0; k < 30; k++) {
    const next = s
      .replace(/\\(?:mathrm|text|operatorname|mathbf|mathit|mathbb|vec|overline)\{([^{}]*)\}/g, "$1")
      // Groupe nu (« { p}^{2} » de MathLive), pas l'argument d'une commande ni d'un ^ ou _.
      .replace(/(^|[^\\A-Za-z^_}])\{([^{}]*)\}/g, "$1$2")
      .replace(/(\\frac\{[^{}]*\})\s*([0-9A-Za-z])/g, "$1{$2}")
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (a: string, n: string, d: string, off: number, all: string) =>
        fracInContext(`${wrapNum(n)}/${wrapDen(d)}`, n, wrapDen(d), all.slice(0, off), all.slice(off + a.length)))
      // « i\sqrt{7} » -> « i sqrt(7) », jamais « isqrt(7) ».
      .replace(/\\sqrt\{([^{}]*)\}/g, (_a, x: string, off: number, all: string) => `${/[A-Za-z0-9)]/.test(all[off - 1] ?? "") ? " " : ""}sqrt(${x})`)
      // Bornes d'une integrale, d'une somme : le "_" reste ("int_0^1").
      .replace(/\\(int|sum|prod|lim)_\{([^{}]*)\}/g, (_a, op: string, b: string) => `\\${op}\u0001${sub(b)}`)
      .replace(/\\(int|sum|prod|lim)_/g, "\\$1\u0001")
      .replace(/_\{([^{}]*)\}/g, (_a, x: string) => (/[\s+\-−=<>]/.test(x.trim()) ? `_${sub(x)}` : x))
      // Exposant : nu s'il tient en un nombre ou une lettre (« e^(2t) », « x^10 »).
      .replace(/\^\{([^{}]*)\}/g, (_a, e: string) => `^${/^\s*(?:-?\d+(?:,\d+)?|\\?[A-Za-z]+|[A-Za-z])\s*$/.test(e) && !/^\s*[A-Za-z]{2,}\s*$/.test(e) ? e.trim() : wrapDen(e).startsWith("(") ? wrapDen(e) : `(${e.trim()})`}`)
      .replace(/\{,\}/g, ",");
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/\\[,;:! ]/g, " ")
    // Mot colle a une lettre ou un chiffre (« 2\alpha », « i\pi ») : separe par un espace.
    .replace(/\\([A-Za-z]+)/g, (_a, name: string, off: number, all: string) => {
      const w = TEX_WORDS[name] ?? name;
      return /^[A-Za-z]/.test(w) && /[A-Za-z0-9]/.test(all[off - 1] ?? "") ? ` ${w}` : w;
    })
    .replace(/_(?=\()/g, "\u0001")
    .replace(/[_{}]/g, "")
    .replace(/\u0001/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}
