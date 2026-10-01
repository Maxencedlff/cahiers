import type { Repo } from "./repo";
import type { Block, ColorKey, Page } from "../types";
import { docImageIds, parseDoc, texToPlain } from "../text/doc";
import {
  fold, makeExcerpt, matchesAll, notebookMatches, parseQuery, queryReady,
  type ExcerptPart,
} from "../text/find";

export { normalize } from "../text/find";

export interface SearchHit {
  notebook: string;
  notebookTitle: string;
  divider: string;
  page: number;
  blockId: string;
  blockType: Block["type"];
  /** Extrait avec le terme en contexte, en texte simple. */
  excerpt: string;
  /** Le meme extrait, termes cherches marques (surlignes a l'ecran). */
  parts: ExcerptPart[];
  /** Derniere modification de la page : les resultats recents d'abord. */
  modified: string;
}

export interface FlagHit {
  notebook: string;
  notebookTitle: string;
  divider: string;
  page: number;
  blockId: string;
  note: string;
  /** La ligne ou le repere a ete pose (repere recent). */
  context?: string;
  created?: string;
}

/** Note posee par defaut : elle ne dit rien, on montre plutot la ligne. */
export const DEFAULT_FLAG_NOTE = "À revoir";

/** Bloc tel que la recherche le voit : son texte simple, deja relu. */
export interface IndexedBlock {
  id: string;
  type: Block["type"];
  text: string;
  /** Texte tape en couleur, par couleur, pour le filtre #theoreme. */
  colors?: Partial<Record<ColorKey, string>>;
}

/** Repere non resolu d'une page. */
export interface PageFlag {
  blockId: string;
  note: string;
  context?: string;
  created?: string;
}

/**
 * Ce que le menu et la recherche lisent d'une page. Calcule une fois par
 * version du fichier (cache de session de Repo), jamais ecrit sur le disque.
 */
export interface PageIndex {
  modified: string;
  flags: PageFlag[];
  blocks: IndexedBlock[];
}

export function indexPage(page: Page): PageIndex {
  const body = page.blocks.find((b) => b.type === "text" && !b.rect);
  const inText = new Set(body?.type === "text" ? docImageIds(body.content) : []);
  const blocks: IndexedBlock[] = [];
  const flags: PageFlag[] = [];
  for (const b of page.blocks) {
    if (b.type === "flag" && !b.resolved) {
      flags.push({
        blockId: b.id, note: b.note,
        ...(b.context ? { context: b.context } : {}),
        ...(b.created ? { created: b.created } : {}),
      });
    }
    // Photo retiree du texte : le bloc reste (l'annulation de l'editeur
    // peut la ramener), mais son OCR ne doit plus remonter.
    if (b.type === "image" && !b.rect && !inText.has(b.id)) continue;
    if (b.type === "text") {
      const { text, colors } = plainOfText(b.content, b.color);
      if (text.trim()) blocks.push({ id: b.id, type: b.type, text, ...(colors ? { colors } : {}) });
      continue;
    }
    const text = searchableText(b);
    if (text.trim()) blocks.push({ id: b.id, type: b.type, text });
  }
  return { modified: page.modified ?? "", flags, blocks };
}

/**
 * Texte simple d'un texte tape, tel qu'on le lit : sans **, sans
 * [..]{.couleur}, sans marqueur de photo, formules relues ("V_{be}" donne
 * "Vbe"). Les couleurs a part, pour le filtre.
 */
function plainOfText(content: string, blockColor?: ColorKey): { text: string; colors?: Partial<Record<ColorKey, string>> } {
  let text = "";
  const colors: Partial<Record<ColorKey, string>> = {};
  for (const t of parseDoc(content)) {
    const piece = t.kind === "br" ? "\n" : t.kind === "math" ? texToPlain(t.latex)
      : t.kind === "text" ? t.text : "";
    text += piece;
    const c = (t.kind === "text" || t.kind === "math") ? t.color ?? blockColor : undefined;
    if (c && piece) colors[c] = (colors[c] ? colors[c] + " " : "") + piece;
  }
  if (blockColor && !colors[blockColor]) colors[blockColor] = text;
  return Object.keys(colors).length ? { text, colors } : { text };
}

/**
 * Texte indexable d'un bloc. Une image sans OCR est un trou noir dans la
 * recherche (section 6) : c'est pour ca que le champ ocr existe.
 */
export function searchableText(b: Block): string {
  switch (b.type) {
    case "text":  return plainOfText(b.content, b.color).text;
    case "math":  return b.latex ? texToPlain(b.latex) : "";
    case "ink":   return b.recognized ?? "";
    case "image": return b.ocr ?? "";
    case "calc":  return `${b.expr} = ${b.result ?? ""}`;
    case "graph": return `y = ${b.fn}`;
    case "link":  return b.label;
    // La ligne du repere est deja dans le texte de la page : seule une note
    // ecrite a la main merite un resultat a part.
    case "flag":  return b.note === DEFAULT_FLAG_NOTE ? "" : b.note;
    case "pdf":   return "";
  }
}

export interface SearchOptions {
  /** Une frappe plus recente a pris la main : on arrete de lire le disque. */
  isStale?: () => boolean;
  /** Seulement ce cahier (dossier), quand la recherche part d'un cahier. */
  notebook?: string;
}

/**
 * Recherche plein texte sur tous les cahiers (priorite 1). Mots en ET,
 * "phrase exacte", @matiere, #couleur (voir parseQuery). Le disque fait
 * autorite : chaque page est revérifiée (date et taille du fichier), seul
 * son resume deja lu est reutilise quand le fichier n'a pas bouge.
 * Resultats tries du plus recent au plus ancien.
 */
export async function searchAll(repo: Repo, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const q = parseQuery(query);
  if (!queryReady(q)) return [];
  const hits: SearchHit[] = [];

  const dirs = opts.notebook ? [opts.notebook] : await repo.listNotebookDirs();
  for (const dir of dirs) {
    if (opts.isStale?.()) return [];
    const meta = await repo.readMeta(dir);
    if (!notebookMatches(q, dir, meta.title)) continue;
    for (const divider of await repo.listDividers(dir)) {
      const pages = await repo.scanDivider(dir, divider, opts.isStale);
      if (!pages) return [];
      for (const { n, index } of pages) {
        if (!index) continue;
        for (const b of index.blocks) {
          const text = q.color ? b.colors?.[q.color] : b.text;
          if (!text?.trim() || !matchesAll(fold(text).text, q.terms)) continue;
          const parts = makeExcerpt(text, q.terms);
          hits.push({
            notebook: dir,
            notebookTitle: meta.title,
            divider,
            page: n,
            blockId: b.id,
            blockType: b.type,
            excerpt: parts.map((p) => p.text).join(""),
            parts,
            modified: index.modified,
          });
        }
      }
    }
  }
  // Tri stable : a date egale, l'ordre du disque (matiere, intercalaire, page).
  return hits.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
}

/** Tous les reperes "pas compris" non resolus, par matiere (section 6). */
export async function listFlags(repo: Repo, notebook?: string): Promise<FlagHit[]> {
  const dirs = notebook ? [notebook] : await repo.listNotebookDirs();
  const out: FlagHit[] = [];
  for (const dir of dirs) out.push(...(await repo.summary(dir)).flags);
  return out;
}

/**
 * Reperes du plus recent au plus ancien ; ceux d'avant la date de pose
 * (anciens fichiers) a la fin, dans l'ordre des pages.
 */
export function sortFlags(flags: FlagHit[]): FlagHit[] {
  return flags
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (b.f.created ?? "").localeCompare(a.f.created ?? "") || a.i - b.i)
    .map((x) => x.f);
}
