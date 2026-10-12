import type { Repo } from "./repo";
import type { Block, ColorKey, Page } from "../types";
import { dividerMatches, extractReview, groupReview, type ReviewFilter, type ReviewItem, type ReviewResult, type ReviewSource } from "../review";
import { docHeadings, docLinks, docTitle, parseDoc, texToPlain, type DocToken } from "../text/doc";
import { extractFormulas, type Formula } from "../suggest";
import { blockLinkRef, parseLinkUrl, type IndexedLink, type LinkAnchor, type LinkPage } from "../links";
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
  /** Id de la page (cible d'un lien, « Copier le lien »). Absent : ancien resume. */
  pageId?: string;
  /** Titre (ou premiere ligne) de la page : libelle du lien copie. */
  pageTitle?: string;
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
  /** Date de creation de la page (liste des pages). */
  created: string;
  /**
   * Premiere ligne lisible de la page : son titre (D11) s'il y en a un,
   * sinon la premiere ligne du texte tape, sinon l'ecriture reconnue.
   */
  firstLine: string;
  /** Titre de la page (premier titre de plus haut niveau, sans les #), si elle en a un. */
  title?: string;
  flags: PageFlag[];
  blocks: IndexedBlock[];
  /** Extraits en couleur (vue de revision, core/review.ts). Absent : aucun. */
  review?: ReviewItem[];
  /** Id de la page : les liens la visent par lui (core/links.ts). */
  id?: string;
  /** Titres # du texte tape, dans l'ordre (selecteur `[[`). Absent : aucun. */
  headings?: string[];
  /** Liens poses dans la page (retroliens). Absent : aucun. */
  links?: IndexedLink[];
  /** Formules et zones reconnues, cibles possibles d'un lien. Absent : aucune. */
  anchors?: LinkAnchor[];
  /** Relations du texte tape (core/suggest.ts), reproposees en grise. Absent : aucune. */
  formulas?: Formula[];
}

/** Longueur de la premiere ligne montree dans la liste des pages. */
const FIRST_LINE_MAX = 90;

/**
 * Premiere ligne non vide d'un texte, coupee sur un mot. Sert a la liste
 * des pages : on reconnait une page a ce qu'elle dit en haut.
 */
export function firstLineOf(text: string, max = FIRST_LINE_MAX): string {
  const line = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find((l) => l) ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

export function indexPage(page: Page): PageIndex {
  const body = page.blocks.find((b) => b.type === "text" && !b.rect);
  const tokens: DocToken[] = body?.type === "text" ? parseDoc(body.content) : [];
  const inText = new Set(tokens.flatMap((t) => (t.kind === "image" ? [t.id] : [])));
  const links: IndexedLink[] = [];
  const anchors: LinkAnchor[] = [];
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
    // Photo, calcul ou courbe retire du texte : le bloc reste (l'annulation
    // de l'editeur peut le ramener), mais il ne doit plus remonter.
    if ((b.type === "image" || b.type === "calc" || b.type === "graph") && !b.rect && !inText.has(b.id)) continue;
    if (b.type === "link") {
      const ref = blockLinkRef(b);
      if (ref.pageId) links.push(indexedLink(ref, b.label));
    }
    if (b.type === "text") {
      const { text, colors } = plainOfText(b.content, b.color);
      if (text.trim()) blocks.push({ id: b.id, type: b.type, text, ...(colors ? { colors } : {}) });
      continue;
    }
    const text = searchableText(b);
    if (text.trim()) blocks.push({ id: b.id, type: b.type, text });
    // Formule, zone manuscrite reconnue : un lien peut les viser.
    if (text.trim() && (b.type === "math" || (b.type === "ink" && b.rect))) {
      anchors.push({ blockId: b.id, kind: b.type === "math" ? "math" : "zone", text: text.trim() });
    }
  }
  for (const t of docLinks(tokens)) {
    const ref = parseLinkUrl(t.href, t.hint);
    if (ref) links.push(indexedLink(ref, t.label));
  }
  const headings = docHeadings(tokens);
  // Le texte tape d'abord, puis l'ecriture reconnue, puis le reste.
  const lead = blocks.find((b) => b.id === body?.id) ?? blocks.find((b) => b.type === "ink")
    ?? blocks.find((b) => b.type !== "flag");
  const title = body?.type === "text" ? firstLineOf(docTitle(tokens)) : "";
  const review = extractReview(page);
  const formulas = body?.type === "text" ? extractFormulas(body.content) : [];
  return {
    modified: page.modified ?? "", created: page.created ?? "",
    firstLine: title || (lead ? firstLineOf(lead.text) : ""), ...(title ? { title } : {}), flags, blocks,
    ...(review.length ? { review } : {}),
    ...(page.id ? { id: page.id } : {}),
    ...(headings.length ? { headings } : {}),
    ...(links.length ? { links } : {}),
    ...(anchors.length ? { anchors } : {}),
    ...(formulas.length ? { formulas } : {}),
  };
}

function indexedLink(ref: { pageId: string; blockId?: string; heading?: string }, label: string): IndexedLink {
  return {
    pageId: ref.pageId, label,
    ...(ref.blockId ? { blockId: ref.blockId } : {}), ...(ref.heading ? { heading: ref.heading } : {}),
  };
}

/**
 * Texte simple d'un texte tape, tel qu'on le lit : sans **, sans
 * [..]{.couleur}, sans marqueur de photo ni de titre ou de liste (# - 1.),
 * formules relues ("V_{be}" donne
 * "Vbe"). Les couleurs a part, pour le filtre.
 */
function plainOfText(content: string, blockColor?: ColorKey): { text: string; colors?: Partial<Record<ColorKey, string>> } {
  let text = "";
  const colors: Partial<Record<ColorKey, string>> = {};
  for (const t of parseDoc(content)) {
    // Un lien se cherche par son libelle.
    const piece = t.kind === "br" ? "\n" : t.kind === "math" ? texToPlain(t.latex)
      : t.kind === "text" ? t.text : t.kind === "link" ? t.label : "";
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
    // Texte de la page du PDF, extrait par pdf.js a l'import (core/pdf).
    case "pdf":   return typeof b.text === "string" ? b.text : "";
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
            ...(index.id ? { pageId: index.id } : {}),
            ...(index.title || index.firstLine ? { pageTitle: index.title || index.firstLine } : {}),
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

export interface ReviewOptions {
  /** Seulement cette matiere (dossier). Absent = toutes. */
  notebook?: string;
  /** Une autre demande a pris la main : on arrete de lire le disque. */
  isStale?: () => boolean;
}

/**
 * Vue de revision (core/review.ts) : extraits des couleurs choisies, par
 * matiere, intercalaire et page, dans l'ordre des cahiers. Lit les pages par
 * Repo.scanDivider : seules les pages modifiees depuis la derniere lecture
 * sont relues. null si `isStale` a dit d'arreter.
 */
export async function collectReview(
  repo: Repo, filter: ReviewFilter, opts: ReviewOptions = {},
): Promise<(ReviewResult & { pages: number }) | null> {
  const dirs = opts.notebook ? [opts.notebook] : await repo.listNotebookDirs();
  const sources: ReviewSource[] = [];
  let pages = 0;
  for (const dir of dirs) {
    if (opts.isStale?.()) return null;
    const meta = await repo.readMeta(dir);
    for (const divider of await repo.listDividers(dir)) {
      if (!dividerMatches(divider, filter.divider)) continue;
      const scanned = await repo.scanDivider(dir, divider, opts.isStale);
      if (!scanned) return null;
      pages += scanned.length;
      for (const { n, index } of scanned) {
        if (index?.review?.length) {
          sources.push({ notebook: dir, notebookTitle: meta.title, divider, page: n, items: index.review });
        }
      }
    }
  }
  return { ...groupReview(sources, filter), pages };
}

/**
 * Toutes les pages, telles que les liens les voient (core/links.ts) : id,
 * endroit, titres, liens poses. Lu par Repo.scanDivider, donc depuis le
 * cache de session tant que les fichiers n'ont pas bouge. Sert a resoudre un
 * lien par id, aux retroliens et au selecteur `[[`. null si `isStale`.
 */
export async function collectLinkPages(repo: Repo, isStale?: () => boolean): Promise<LinkPage[] | null> {
  const out: LinkPage[] = [];
  for (const dir of await repo.listNotebookDirs()) {
    if (isStale?.()) return null;
    const meta = await repo.readMeta(dir);
    for (const divider of await repo.listDividers(dir)) {
      const scanned = await repo.scanDivider(dir, divider, isStale);
      if (!scanned) return null;
      for (const { n, index } of scanned) {
        if (!index?.id) continue;
        out.push({
          notebook: dir, notebookTitle: meta.title, divider, number: n, id: index.id,
          firstLine: index.firstLine, modified: index.modified,
          ...(index.title ? { title: index.title } : {}),
          ...(index.headings ? { headings: index.headings } : {}),
          ...(index.links ? { links: index.links } : {}),
          ...(index.anchors ? { anchors: index.anchors } : {}),
        });
      }
    }
  }
  return out;
}
