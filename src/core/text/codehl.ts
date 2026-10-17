/**
 * Coloration simple des blocs de code du texte (``` puis langage), pour les
 * cours d'info : mots-cles, chaines, nombres, commentaires. Logique pure,
 * sans DOM ; la vue (src/ui/textdoc.ts) pose un <span class="hl-…"> par
 * morceau. Volontairement modeste : jamais d'analyse complete, une erreur
 * de coloration ne touche jamais au texte.
 */

export type HlKind = "kw" | "str" | "num" | "com" | "fn" | "type";
export interface HlPiece { text: string; kind?: HlKind }

interface Lang {
  keywords: Set<string>;
  types?: Set<string>;
  /** Commentaire de fin de ligne. */
  line: string[];
  /** Commentaire de bloc [ouvrant, fermant]. */
  block?: [string, string];
  /** Chaines : delimiteurs acceptes (triples d'abord). */
  quotes: string[];
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_TYPES = words("int char float double long short unsigned signed void bool size_t uint8_t uint16_t uint32_t int8_t int16_t int32_t uint64_t int64_t FILE");
const C_KW = words("if else for while do switch case default break continue return goto sizeof struct union enum typedef static const volatile extern register inline include define ifdef ifndef endif pragma NULL true false");

const LANGS: Record<string, Lang> = {
  python: {
    keywords: words("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self print range len"),
    line: ["#"], quotes: ['"""', "'''", '"', "'"],
  },
  c: { keywords: C_KW, types: C_TYPES, line: ["//"], block: ["/*", "*/"], quotes: ['"', "'"] },
  cpp: {
    keywords: new Set([...C_KW, ...words("class public private protected virtual override template typename namespace using new delete this nullptr try catch throw auto constexpr std cout cin endl")]),
    types: new Set([...C_TYPES, ...words("string vector map")]), line: ["//"], block: ["/*", "*/"], quotes: ['"', "'"],
  },
  java: {
    keywords: words("abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface new package private protected public return static super switch this throw throws try while null true false var"),
    types: words("int long short byte char float double boolean void String Integer List ArrayList Map HashMap Object"),
    line: ["//"], block: ["/*", "*/"], quotes: ['"', "'"],
  },
  js: {
    keywords: words("async await break case catch class const continue default delete do else export extends finally for function if import in instanceof let new of return super switch this throw try typeof var void while yield null undefined true false console"),
    types: words("number string boolean any unknown never interface type"),
    line: ["//"], block: ["/*", "*/"], quotes: ["`", '"', "'"],
  },
  matlab: {
    keywords: words("function end if elseif else for while switch case otherwise break continue return try catch global persistent true false disp plot figure hold on off grid xlabel ylabel title legend zeros ones linspace tf step bode"),
    line: ["%"], block: ["%{", "%}"], quotes: ["'", '"'],
  },
  sql: {
    keywords: words("select from where insert into values update set delete create table drop alter primary key foreign references join left right inner outer on group by order having as and or not null is in like distinct count sum avg min max limit"),
    line: ["--"], block: ["/*", "*/"], quotes: ["'", '"'],
  },
  bash: {
    keywords: words("if then else elif fi for while do done case esac function in echo cd ls export sudo apt git grep cat"),
    line: ["#"], quotes: ['"', "'"],
  },
  vhdl: {
    keywords: words("library use entity is port in out inout end architecture of signal begin process if then else elsif case when others loop for generate component map std_logic std_logic_vector downto to rising_edge and or not xor"),
    line: ["--"], quotes: ['"', "'"],
  },
};

const ALIASES: Record<string, string> = {
  py: "python", python3: "python", h: "c", "c++": "cpp", cc: "cpp", hpp: "cpp",
  javascript: "js", ts: "js", typescript: "js", m: "matlab", octave: "matlab", sh: "bash", shell: "bash", zsh: "bash",
};

/** Langage connu d'un nom tape apres ``` (casse ignoree), sinon null. */
export function codeLang(name: string): string | null {
  const k = name.trim().toLowerCase();
  const key = ALIASES[k] ?? k;
  return key in LANGS ? key : null;
}

/** Sans langage : chaines, nombres et commentaires # ou //, aucun mot-cle. */
const PLAIN: Lang = { keywords: new Set(), line: ["//", "#"], quotes: ['"', "'"] };

export function highlight(code: string, lang: string): HlPiece[] {
  const L = LANGS[codeLang(lang) ?? ""] ?? PLAIN;
  const out: HlPiece[] = [];
  const push = (text: string, kind?: HlKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push(kind ? { text, kind } : { text });
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    // Commentaire de bloc, puis de fin de ligne.
    if (L.block && rest.startsWith(L.block[0])) {
      const end = code.indexOf(L.block[1], i + L.block[0].length);
      const stop = end < 0 ? code.length : end + L.block[1].length;
      push(code.slice(i, stop), "com");
      i = stop;
      continue;
    }
    const lc = L.line.find((m) => rest.startsWith(m));
    if (lc) {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      push(code.slice(i, stop), "com");
      i = stop;
      continue;
    }
    const q = L.quotes.find((m) => rest.startsWith(m));
    // MATLAB : « A' » est une transposee, pas le debut d'une chaine.
    const transpose = q === "'" && L === LANGS.matlab && /[\w)\]'.]/.test(code[i - 1] ?? "");
    if (q && !transpose) {
      let j = i + q.length;
      while (j < code.length && !code.startsWith(q, j) && (q.length === 3 || q === "`" || code[j] !== "\n")) j += code[j] === "\\" ? 2 : 1;
      const stop = Math.min(code.length, j + (code.startsWith(q, j) ? q.length : 0));
      push(code.slice(i, stop), "str");
      i = stop;
      continue;
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num && !/[\w$]/.test(code[i - 1] ?? "")) {
      push(num[0], "num");
      i += num[0].length;
      continue;
    }
    const w = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (w) {
      const word = w[0];
      const kind: HlKind | undefined = L.keywords.has(word) || (L === LANGS.sql && L.keywords.has(word.toLowerCase())) ? "kw"
        : L.types?.has(word) ? "type"
        : /^\s*\(/.test(code.slice(i + word.length)) && L !== PLAIN ? "fn" : undefined;
      push(word, kind);
      i += word.length;
      continue;
    }
    push(code[i]);
    i++;
  }
  return out;
}
