/**
 * Vue de revision filtree par couleur (lot 11, manque-filtre-couleur) :
 * « tous les theoremes de Maths », « toutes les definitions d'Elec ».
 * Logique pure, sans DOM : extraction par couleur depuis une page (texte
 * tape colore, encre de cette couleur, zones reconnues, surligneur), puis
 * groupement matiere > intercalaire > page dans l'ordre du cahier.
 *
 * L'extraction est faite une fois par version du fichier, dans indexPage
 * (cache de session de Repo.scanDivider) : ouvrir la vue sur 200 pages ne
 * relit que les pages modifiees.
 */

import type { Block, ColorKey, Page, Stroke } from "./types";
import { PALETTE } from "./palette";
import { flattenTables, parseDoc, texToPlain } from "./text/doc";
import { cachedBounds, unionBounds, type Bounds } from "./ink/stroke";

/** Les 5 couleurs filtrables, dans l'ordre de la palette. */
export const REVIEW_COLORS: readonly ColorKey[] = PALETTE.map((p) => p.key);

/** Morceau de texte d'un extrait tape : texte, formule (rendue en KaTeX) ou retour a la ligne. */
export type ReviewToken =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean }
  | { kind: "math"; latex: string }
  | { kind: "br" };

/**
 * Extrait d'une couleur sur une page.
 * - text : texte tape colore (`tokens`) ;
 * - ink : traits de stylo de cette couleur (`strokes`), groupes par proximite ;
 * - math : zone math reconnue de cette couleur (`latex`, encre en secours) ;
 * - zone : zone texte reconnue de cette couleur (`plain`) ;
 * - highlight : surligneur de cette couleur, avec l'encre qu'il recouvre.
 */
export interface ReviewItem {
  /** Cle stable dans la page (bloc + premier trait) : focus clavier gardé. */
  key: string;
  kind: "text" | "ink" | "math" | "zone" | "highlight";
  color: ColorKey;
  /** Bloc qui porte l'extrait : celui qu'ouvre focusBlock. */
  blockId: string;
  /** Texte simple (formules relues), pour l'impression et le passage a retrouver. */
  plain: string;
  tokens?: ReviewToken[];
  latex?: string;
  /** Traits a peindre dans la vignette (surligneur sous l'encre). */
  strokes?: Stroke[];
  /** Cadre sur la page, en unites de page : recadrage et saut au bon endroit. */
  box?: Bounds;
}

/** Marge autour d'un trait pour le rattacher a ses voisins (une ligne = 34 unites). */
export const CLUSTER_PAD = 18;

/** Part des traits d'une zone reconnue qu'il faut dans une couleur pour qu'elle soit de cette couleur. */
const ZONE_SHARE = 0.5;

const SEMANTIC = new Set<string>(REVIEW_COLORS);
const isSemantic = (c: unknown): c is ColorKey => typeof c === "string" && SEMANTIC.has(c);

/** Couleur effective d'un trait : une cle inconnue n'est pas filtrable. */
function strokeColor(s: Stroke): ColorKey | null {
  return isSemantic(s.color) ? s.color : null;
}

/**
 * Traits groupes par proximite : deux traits dont les cadres (agrandis de
 * `pad`) se touchent vont ensemble, de proche en proche. Une definition
 * ecrite sur trois lignes donne un seul extrait. Ordre : de haut en bas.
 */
export function clusterStrokes(strokes: readonly Stroke[], pad = CLUSTER_PAD): Stroke[][] {
  const n = strokes.length;
  const boxes = strokes.map((s) => cachedBounds(s, pad));
  const parent = strokes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let i = 0; i < n; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < n; j++) {
      const b = boxes[j];
      if (a.x > b.x + b.w || b.x > a.x + a.w || a.y > b.y + b.h || b.y > a.y + a.h) continue;
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[rj] = ri;
    }
  }
  const groups = new Map<number, Stroke[]>();
  strokes.forEach((s, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(s); else groups.set(r, [s]);
  });
  return [...groups.values()]
    .map((g) => ({ g, b: boundsOf(g) }))
    .sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x)
    .map((x) => x.g);
}

/** Cadre d'un groupe de traits, epaisseur comprise. */
export function boundsOf(strokes: readonly Stroke[]): Bounds {
  return unionBounds(strokes.map((s) => cachedBounds(s)));
}

/** Traits avec au moins un point (un trait vide n'a ni cadre ni dessin). */
function drawn(s: Stroke): boolean {
  return cachedBounds(s).w > 0 || cachedBounds(s).h > 0;
}

/**
 * Couleur d'une zone reconnue : celle d'au moins la moitie de ses traits de
 * stylo. Une zone ecrite en noir avec un mot rouge reste une zone neutre :
 * son mot rouge sort alors comme encre.
 */
export function zoneColor(strokes: readonly Stroke[]): ColorKey | null {
  const pens = strokes.filter((s) => s.tool === "pen" && drawn(s));
  if (!pens.length) return null;
  const count = new Map<ColorKey, number>();
  for (const s of pens) {
    const c = strokeColor(s);
    if (c) count.set(c, (count.get(c) ?? 0) + 1);
  }
  let best: ColorKey | null = null, most = 0;
  for (const [c, k] of count) if (k > most) { best = c; most = k; }
  return best && most / pens.length >= ZONE_SHARE ? best : null;
}

/* ---------------- texte tape ---------------- */

/**
 * Passages tapes en couleur d'un bloc texte, dans l'ordre du texte. Un
 * passage continue par-dessus un retour a la ligne si la ligne suivante
 * commence dans la meme couleur ; une photo ou du texte neutre le coupe.
 */
export function textRuns(content: string, blockColor?: ColorKey): { color: ColorKey; tokens: ReviewToken[] }[] {
  const out: { color: ColorKey; tokens: ReviewToken[] }[] = [];
  let run: { color: ColorKey; tokens: ReviewToken[] } | null = null;
  /** Retours a la ligne vus depuis le dernier morceau colore du passage. */
  let pendingBr = 0;
  const close = () => {
    if (run && run.tokens.some((t) => t.kind === "math" || (t.kind === "text" && t.text.trim()))) out.push(run);
    run = null;
    pendingBr = 0;
  };
  for (const t of flattenTables(parseDoc(content))) {
    if (t.kind === "line" || t.kind === "table" || t.kind === "codeblock") continue;
    if (t.kind === "br") { if (run) pendingBr++; continue; }
    if (t.kind === "image" || t.kind === "link") { close(); continue; }
    const c = t.color ?? blockColor;
    const blank = t.kind === "text" && !t.text.trim();
    if (!isSemantic(c)) {
      // Un blanc neutre entre deux morceaux de la meme couleur ne coupe pas.
      if (blank && run && !pendingBr) continue;
      close();
      continue;
    }
    if (!run || run.color !== c) { close(); run = { color: c, tokens: [] }; }
    const r: { color: ColorKey; tokens: ReviewToken[] } = run;
    for (; pendingBr > 0; pendingBr--) r.tokens.push({ kind: "br" });
    if (t.kind === "math") r.tokens.push({ kind: "math", latex: t.latex });
    else {
      const tok: ReviewToken = { kind: "text", text: t.text };
      if (t.bold) tok.bold = true;
      if (t.italic) tok.italic = true;
      r.tokens.push(tok);
    }
  }
  close();
  for (const r of out) trimTokens(r.tokens);
  return out;
}

function trimTokens(tokens: ReviewToken[]): void {
  while (tokens.length && tokens[0].kind === "br") tokens.shift();
  while (tokens.length && tokens[tokens.length - 1].kind === "br") tokens.pop();
}

/** Texte simple d'un passage : formules relues comme tapees. */
export function tokensPlain(tokens: readonly ReviewToken[]): string {
  return tokens.map((t) => (t.kind === "br" ? "\n" : t.kind === "math" ? texToPlain(t.latex) : t.text))
    .join("").replace(/[ \t]+/g, " ").trim();
}

/* ---------------- encre ---------------- */

/** Mots reconnus portes par ces traits (au moins la moitie de leurs traits). */
function wordsOf(blocks: readonly Block[], ids: Set<string>): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type !== "ink" || !b.words) continue;
    for (const w of b.words) {
      if (!w.strokeIds.length) continue;
      const k = w.strokeIds.filter((id) => ids.has(id)).length;
      if (k * 2 >= w.strokeIds.length && w.label.trim()) out.push(w.label.trim());
    }
  }
  return out.join(" ");
}

function intersects(a: Bounds, b: Bounds): boolean {
  return !(a.x > b.x + b.w || b.x > a.x + a.w || a.y > b.y + b.h || b.y > a.y + a.h);
}

/** Centre d'un cadre dans un autre. */
function centerIn(inner: Bounds, outer: Bounds): boolean {
  const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

/**
 * Tous les extraits colores d'une page, dans l'ordre de lecture : le texte
 * tape d'abord (dans l'ordre du texte), puis l'encre et les zones de haut
 * en bas. L'encre neutre (« normal ») n'en donne jamais.
 */
export function extractReview(page: Page): ReviewItem[] {
  const textItems: ReviewItem[] = [];
  const inkItems: ReviewItem[] = [];
  /** Traits de stylo hors zones colorees, par couleur : groupes plus bas. */
  const loose = new Map<ColorKey, { stroke: Stroke; blockId: string }[]>();
  const highlights = new Map<ColorKey, { stroke: Stroke; blockId: string }[]>();
  /** Tous les traits de stylo de la page : ceux qu'un surlignage recouvre. */
  const pens: Stroke[] = [];

  for (const b of page.blocks) {
    if (b.type === "text") {
      textRuns(b.content, isSemantic(b.color) ? b.color : undefined).forEach((r, i) => {
        textItems.push({
          key: `${b.id}#${i}`, kind: "text", color: r.color, blockId: b.id,
          plain: tokensPlain(r.tokens), tokens: r.tokens,
        });
      });
      continue;
    }
    if (b.type !== "ink" && b.type !== "math") continue;
    const strokes = (b.strokes ?? []).filter(drawn);
    for (const s of strokes) if (s.tool === "pen") pens.push(s);
    // Zone reconnue (math, ou texte avec cadre) de cette couleur : un seul extrait.
    const zone = b.type === "math" || (b.type === "ink" && !!b.rect);
    const zc = zone ? zoneColor(strokes) : null;
    if (zc) {
      const box = b.rect ?? boundsOf(strokes);
      const pensHere = strokes.filter((s) => s.tool === "pen");
      if (b.type === "math") {
        const latex = b.latex?.trim() || "";
        inkItems.push({
          key: b.id, kind: "math", color: zc, blockId: b.id,
          plain: latex ? texToPlain(latex) : "", ...(latex ? { latex } : {}),
          strokes: pensHere, box,
        });
      } else if (b.type === "ink") {
        const plain = (b.recognized ?? "").trim();
        inkItems.push({ key: b.id, kind: "zone", color: zc, blockId: b.id, plain, strokes: pensHere, box });
      }
    }
    for (const s of strokes) {
      const c = strokeColor(s);
      if (!c) continue;
      if (s.tool === "highlighter") {
        const l = highlights.get(c) ?? [];
        l.push({ stroke: s, blockId: b.id });
        highlights.set(c, l);
      } else if (!zc) {
        const l = loose.get(c) ?? [];
        l.push({ stroke: s, blockId: b.id });
        loose.set(c, l);
      }
    }
  }

  for (const [color, list] of loose) {
    const blockOf = new Map(list.map((x) => [x.stroke, x.blockId] as const));
    for (const group of clusterStrokes(list.map((x) => x.stroke))) {
      const ids = new Set(group.map((s) => s.id));
      inkItems.push({
        key: `${blockOf.get(group[0])}#${group[0].id}`, kind: "ink", color,
        blockId: blockOf.get(group[0])!, plain: wordsOf(page.blocks, ids),
        strokes: group, box: boundsOf(group),
      });
    }
  }

  for (const [color, list] of highlights) {
    const blockOf = new Map(list.map((x) => [x.stroke, x.blockId] as const));
    for (const group of clusterStrokes(list.map((x) => x.stroke), 4)) {
      const box = boundsOf(group);
      // L'encre recouverte : les traits dont le centre est sous la bande.
      const under = pens.filter((s) => intersects(cachedBounds(s), box) && centerIn(cachedBounds(s), box));
      const ids = new Set(under.map((s) => s.id));
      inkItems.push({
        key: `${blockOf.get(group[0])}#${group[0].id}`, kind: "highlight", color,
        blockId: blockOf.get(group[0])!, plain: wordsOf(page.blocks, ids),
        strokes: [...group, ...under], box: under.length ? unionBounds([box, boundsOf(under)]) : box,
      });
    }
  }

  inkItems.sort((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0));
  return [...textItems, ...inkItems];
}

/* ---------------- filtres et groupement ---------------- */

export interface ReviewFilter {
  /** Couleurs gardees (vide = aucune). */
  colors: readonly ColorKey[];
  /**
   * Intercalaire (ou prefixe d'arborescence : « S1 » garde « S1/Chapitre 1 »).
   * Absent = tous.
   */
  divider?: string;
}

/** L'intercalaire passe-t-il le filtre ? Exact, ou sous-dossier du filtre. */
export function dividerMatches(divider: string, filter?: string): boolean {
  if (!filter) return true;
  const d = divider.replace(/\\/g, "/"), f = filter.replace(/\\/g, "/").replace(/\/+$/, "");
  return d === f || d.startsWith(f + "/");
}

/** Une page lue par la vue : ou elle est, et tous ses extraits. */
export interface ReviewSource {
  notebook: string;
  notebookTitle: string;
  divider: string;
  page: number;
  items: readonly ReviewItem[];
}

export interface ReviewPage { page: number; items: ReviewItem[] }
export interface ReviewDivider { divider: string; pages: ReviewPage[] }
export interface ReviewNotebook { notebook: string; notebookTitle: string; dividers: ReviewDivider[] }

export interface ReviewResult {
  notebooks: ReviewNotebook[];
  /** Nombre d'extraits gardes. */
  count: number;
  /** Extraits par couleur, filtre de couleur ignore (compteurs des puces). */
  byColor: Record<ColorKey, number>;
}

/**
 * Groupe les extraits matiere > intercalaire > page, dans l'ordre recu
 * (celui du cahier : intercalaires dans leur ordre, pages par numero).
 * Pages, intercalaires et matieres sans extrait sont omis.
 */
export function groupReview(sources: readonly ReviewSource[], filter: ReviewFilter): ReviewResult {
  const keep = new Set(filter.colors);
  const byColor = Object.fromEntries(REVIEW_COLORS.map((c) => [c, 0])) as Record<ColorKey, number>;
  const notebooks: ReviewNotebook[] = [];
  let count = 0;
  for (const s of sources) {
    if (!dividerMatches(s.divider, filter.divider)) continue;
    for (const it of s.items) byColor[it.color] = (byColor[it.color] ?? 0) + 1;
    const items = s.items.filter((it) => keep.has(it.color));
    if (!items.length) continue;
    let nb = notebooks[notebooks.length - 1];
    if (!nb || nb.notebook !== s.notebook) {
      nb = { notebook: s.notebook, notebookTitle: s.notebookTitle, dividers: [] };
      notebooks.push(nb);
    }
    let dv = nb.dividers[nb.dividers.length - 1];
    if (!dv || dv.divider !== s.divider) {
      dv = { divider: s.divider, pages: [] };
      nb.dividers.push(dv);
    }
    dv.pages.push({ page: s.page, items });
    count += items.length;
  }
  return { notebooks, count, byColor };
}

/**
 * Passage a retrouver dans le texte de la page (focusBlock) : le debut de
 * l'extrait entre guillemets, coupe sur un mot. Une phrase, pas des mots
 * epars : sinon le premier « de » de la page serait surligne.
 */
export function focusQuery(plain: string, max = 48): string {
  const line = plain.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  let s = line.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    s = sp > max * 0.5 ? cut.slice(0, sp) : cut;
  }
  return s ? `"${s}"` : "";
}

/** Libelle d'un intercalaire dans la vue : « Cours p. 4 ». */
export function whereLabel(divider: string, page: number): string {
  return `${divider.replace(/\//g, " › ")} p. ${page}`;
}
