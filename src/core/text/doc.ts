/**
 * Texte tape au clavier sur la page, facon traitement de texte.
 *
 * Stocke dans le `content` d'un bloc `text` sans `rect`, en markdown
 * restreint pour rester lisible dans le JSON (section 1) :
 *   **gras**, *italique*, $formule LaTeX$, retour a la ligne = "\n",
 *   ![](img:<id>) = photo posee dans le texte (bloc image de meme id),
 *   [texte en couleur]{.theoreme} = une des 5 couleurs de la palette.
 * Les caracteres speciaux du texte (\ $ * [ ]) sont echappes par un
 * antislash.
 *
 * Module sans DOM : l'interface lit et ecrit des jetons, pas du markdown.
 */

import type { ColorKey } from "../types";
import { PALETTE } from "../palette";

export type DocToken =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean; color?: ColorKey }
  | { kind: "math"; latex: string; color?: ColorKey }
  | { kind: "image"; id: string }
  | { kind: "br" };

const IMG_OPEN = "![](img:";

const ESCAPED = /[\\$*[\]]/g;
const COLOR_KEYS = new Set<string>(PALETTE.map((p) => p.key));

function colorOfToken(t: DocToken): ColorKey | undefined {
  return t.kind === "text" || t.kind === "math" ? t.color : undefined;
}

export function serializeDoc(tokens: DocToken[]): string {
  // Les suites de meme couleur forment un seul groupe [..]{.couleur}.
  let out = "";
  const list = normalizeTokens(tokens);
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
    if (t.kind === "image") { out += `${IMG_OPEN}${t.id})`; continue; }
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
  const out: DocToken[] = [];
  let bold = false, italic = false, buf = "";
  const flush = () => {
    if (!buf) return;
    out.push({ kind: "text", text: buf, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
    buf = "";
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) { buf += src[++i]; continue; }
    if (c === "\n") { flush(); out.push({ kind: "br" }); continue; }
    if (c === "[") {
      const group = colorGroup(src, i);
      if (group) {
        flush();
        for (const t of parseDoc(src.slice(i + 1, group.innerEnd))) {
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
    t.kind === "br" ? "\n" : t.kind === "math" ? t.latex : t.kind === "image" ? "" : t.text).join("");
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
 * Texte d'un morceau copie, pour le presse-papiers des autres logiciels :
 * les formules en $LaTeX$, les photos omises.
 */
export function docClipboardText(tokens: DocToken[]): string {
  return tokens.map((t) =>
    t.kind === "br" ? "\n" : t.kind === "math" ? `$${t.latex}$` : t.kind === "image" ? "" : t.text).join("");
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
  // Parentheses autour d'un numerateur ou denominateur compose, pas autour
  // de ce qui est deja entre parentheses.
  const wrap = (x: string) => {
    let top = x.trim();
    for (let k = 0; k < 10 && /\([^()]*\)/.test(top); k++) top = top.replace(/\([^()]*\)/g, "");
    return /[\s+\-=<>]/.test(top) ? `(${x.trim()})` : x.trim();
  };
  let s = tex.replace(/\\left|\\right|\\displaystyle/g, "");
  // De l'interieur vers l'exterieur : un groupe sans accolade a la fois.
  for (let k = 0; k < 30; k++) {
    const next = s
      .replace(/\\(?:mathrm|text|operatorname|mathbf|mathit|mathbb|vec|overline)\{([^{}]*)\}/g, "$1")
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_a, n: string, d: string) => `${wrap(n)}/${wrap(d)}`)
      .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
      .replace(/_\{([^{}]*)\}/g, "$1")
      .replace(/\^\{([^{}]*)\}/g, (_a, e: string) => `^${wrap(e)}`)
      .replace(/\{,\}/g, ",");
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_a, name: string) => TEX_WORDS[name] ?? name)
    .replace(/[_{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
