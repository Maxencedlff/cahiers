/**
 * Pagination automatique facon Word, logique pure (le DOM est dans
 * src/ui/pagebreak.ts, l'orchestration dans PageView.flow*).
 *
 * Une page = une feuille A4 (PAGE_W x PAGE_H). Quand le texte tape, un bloc
 * pose dans le texte ou l'encre poussee par le texte depasse le bas de la
 * page, ce qui deborde passe en tete de la page suivante :
 *  - jamais au milieu d'une ligne, d'une formule, d'une photo ou d'un bloc
 *    (on coupe entre deux rangees du texte) ;
 *  - un schema (amas de traits) part entier ou reste entier ;
 *  - l'encre suit le texte au meme endroit relatif (decalage par lignes
 *    entieres : elle reste calee sur le fond de page) ;
 *  - les ids des traits sont gardes (fusion OneDrive par id, core/sync.ts).
 *
 * Toutes les longueurs sont en unites de page.
 */
import type { Block, FlagBlock, InkBlock, InkWord, Page } from "./types";
import { cachedBounds } from "./ink/stroke";
import { PAGE_H } from "./ink/sheet";
import { LINE, TEXT_TOP, rowAt } from "./textlayout";
import { dropStrokes, joinWords } from "./ink/words";
import { transformBlocks, translation } from "./ink/selection";

/**
 * Rangees de texte par page : la ligne de base de la derniere tombe sur la
 * 34e ligne du fond (8 mm), il reste ~2 lignes de marge en bas comme en haut.
 */
export const TEXT_ROWS = 33;
/** Bas de la zone de texte : une rangee qui descend plus bas passe a la page suivante. */
export const TEXT_LIMIT = TEXT_TOP + TEXT_ROWS * LINE;
/** L'encre peut aller jusqu'au bord de la feuille, pas au-dela. */
export const INK_LIMIT = PAGE_H;
/** Hauteur maximale d'une photo ou d'un bloc pose dans le texte (il tient sur une page). */
export const BLOCK_MAX_H = (TEXT_ROWS - 1) * LINE;
/** Une feuille plus haute que ca est une ancienne page longue (affichee avec reperes). */
export const LONG_PAGE = PAGE_H + 1;
/**
 * Ecart vertical maximal entre deux traits d'un meme amas (point du i,
 * accent, fil d'un schema) : un amas passe entier a la page suivante.
 */
export const CLUSTER_GAP = LINE * 0.25;

/**
 * Intervalle vertical. `keep` : un titre, qui ne reste jamais seul en bas
 * d'une page (il part avec la rangee qui le suit, comme dans Word).
 */
export interface Span { top: number; bottom: number; keep?: boolean }
/** Rangee de texte : intervalles fusionnes, `members` = indices des intervalles d'origine. */
export interface Row extends Span { members: number[] }

/**
 * Rangees visuelles du texte a partir des boites mesurees (lignes de texte,
 * formules, photos, sauts de ligne). Deux boites qui se chevauchent de plus
 * d'une unite sont dans la meme rangee (une fraction et le texte de sa
 * ligne) ; deux lignes voisines ne se chevauchent jamais (interligne 8 mm).
 */
export function groupRows(items: readonly Span[]): Row[] {
  const order = items
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => Number.isFinite(s.top) && Number.isFinite(s.bottom) && s.bottom >= s.top)
    .sort((a, b) => a.s.top - b.s.top || a.s.bottom - b.s.bottom);
  const rows: Row[] = [];
  for (const { s, i } of order) {
    const last = rows[rows.length - 1];
    if (last && s.top < last.bottom - 1) {
      last.bottom = Math.max(last.bottom, s.bottom);
      last.members.push(i);
      if (s.keep) last.keep = true;
    } else {
      rows.push({ top: s.top, bottom: s.bottom, members: [i], ...(s.keep ? { keep: true } : {}) });
    }
  }
  return rows;
}

/** Morceau d'encre qui bouge d'un bloc : un trait du fond, ou une zone entiere. */
export interface InkItem extends Span {
  strokeIds: string[];
  /** Zone reconnue (math ou texte) : indivisible, deplacee avec son bloc. */
  zone?: string;
}

/** Bloc d'encre du fond de page (sans cadre). */
function isMainInk(b: Block): b is InkBlock {
  return b.type === "ink" && !b.rect;
}

/** Morceaux d'encre de la page (les annotations PDF restent sur leur PDF). */
export function inkItems(blocks: readonly Block[]): InkItem[] {
  const out: InkItem[] = [];
  for (const b of blocks) {
    if (b.type !== "ink" && b.type !== "math") continue;
    const list = b.strokes.filter((s) => s.points.length);
    if (isMainInk(b)) {
      for (const s of list) {
        const r = cachedBounds(s);
        out.push({ top: r.y, bottom: r.y + r.h, strokeIds: [s.id] });
      }
      continue;
    }
    // Zone : sa boite et tous ses traits.
    let top = b.rect ? b.rect.y : Infinity, bottom = b.rect ? b.rect.y + b.rect.h : -Infinity;
    for (const s of list) {
      const r = cachedBounds(s);
      top = Math.min(top, r.y);
      bottom = Math.max(bottom, r.y + r.h);
    }
    if (top === Infinity) continue;
    out.push({ top, bottom, strokeIds: list.map((s) => s.id), zone: b.id });
  }
  return out;
}

/** Amas de traits : morceaux qui se chevauchent ou presque (ecart <= gap). */
export interface Cluster extends Span { items: InkItem[] }

export function clusterInk(items: readonly InkItem[], gap = CLUSTER_GAP): Cluster[] {
  const sorted = [...items].sort((a, b) => a.top - b.top);
  const out: Cluster[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.top <= last.bottom + gap) {
      last.bottom = Math.max(last.bottom, it.bottom);
      last.items.push(it);
    } else {
      out.push({ top: it.top, bottom: it.bottom, items: [it] });
    }
  }
  return out;
}

/** Ce qui passe a la page suivante, et comment. */
export interface FlowPlan {
  /** Tout ce qui commence a cette hauteur ou plus bas part. */
  cut: number;
  /** Haut de la rangee de la grille qui contient `cut` (arrive en haut de la page suivante). */
  cutGrid: number;
  /** Indice de la premiere rangee de texte qui part (rows.length : aucune). */
  firstRow: number;
  /** Traits du fond qui partent. */
  strokeIds: string[];
  /** Zones reconnues qui partent entieres. */
  zoneIds: string[];
  /** Reperes « pas compris » qui partent. */
  flagIds: string[];
  /** Decalage vertical de ce qui part (de cutGrid vers le haut de la page). */
  dy: number;
  /** Lignes vides a laisser avant le texte deplace (de l'encre est au-dessus). */
  lead: number;
  /** Lignes occupees par le texte deplace sur la page d'arrivee (lead compris), 0 sans texte. */
  textLines: number;
  /** Lignes a couvrir sous le haut du texte pour passer sous l'encre deplacee, 0 sans encre. */
  inkLines: number;
}

export interface FlowOptions {
  textLimit?: number;
  inkLimit?: number;
}

const EPS = 0.5;

/**
 * Plan de debordement d'une page. `rows` : rangees du texte (groupRows),
 * triees, en unites de page. null si rien ne deborde, ou si rien ne peut
 * partir sans vider la page (un seul bloc plus haut qu'une page : la
 * feuille s'allonge, rien n'est perdu).
 *
 * Coupe : la premiere rangee de texte qui depasse TEXT_LIMIT, ou le haut du
 * premier amas d'encre qui depasse le bas de la feuille. Une rangee ou un
 * amas qui deborde et chevauche la coupe la fait remonter a son haut ; un
 * amas qui chevauche la coupe sans deborder reste sur la page.
 * Si les amas sont trop gros (ecriture serree, lignes qui se touchent), on
 * retente avec des amas plus fins, puis trait par trait.
 */
export function planFlow(rows: readonly Span[], blocks: readonly Block[], opts: FlowOptions = {}): FlowPlan | null {
  const textLimit = opts.textLimit ?? TEXT_LIMIT;
  const inkLimit = opts.inkLimit ?? INK_LIMIT;
  const items = inkItems(blocks);
  const over = rows.findIndex((r) => r.bottom > textLimit + EPS);
  for (const gap of [CLUSTER_GAP, 0, -1]) {
    const clusters: Cluster[] = gap < 0
      ? items.map((it) => ({ top: it.top, bottom: it.bottom, items: [it] }))
      : clusterInk(items, gap);
    const overflows = (c: Cluster) => c.bottom > inkLimit + EPS;
    // Titre juste au-dessus de la coupe : il part avec ce qui le suit.
    let first = over;
    while (first > 1 && rows[first - 1].keep) first--;
    let cut = over >= 0 ? rows[first].top : Infinity;
    for (const c of clusters) if (overflows(c)) cut = Math.min(cut, c.top);
    if (cut === Infinity) return null;
    for (let guard = 0; guard < 200; guard++) {
      let next = cut;
      for (const r of rows) if (r.top < next - EPS && r.bottom > next + EPS) next = r.top;
      for (const c of clusters) if (overflows(c) && c.top < next - EPS && c.bottom > next + EPS) next = c.top;
      if (next === cut) break;
      cut = next;
    }
    const cutGrid = TEXT_TOP + Math.max(0, rowAt(cut + EPS)) * LINE;
    // Rien ne resterait : un bloc plus haut que la page. On essaie plus fin.
    const stays = rows.some((r) => r.bottom <= cut + EPS) || clusters.some((c) => c.top < cut - EPS);
    if (!stays || cutGrid <= TEXT_TOP + EPS) continue;

    const firstRow = rows.findIndex((r) => r.top >= cut - EPS);
    const moving = clusters.filter((c) => c.top >= cut - EPS);
    const strokeIds: string[] = [], zoneIds: string[] = [];
    let inkBottom = -Infinity;
    for (const c of moving) {
      inkBottom = Math.max(inkBottom, c.bottom);
      for (const it of c.items) {
        if (it.zone) zoneIds.push(it.zone);
        else strokeIds.push(...it.strokeIds);
      }
    }
    const flagIds = blocks
      .filter((b): b is FlagBlock => b.type === "flag" && !!b.rect && b.rect.y + b.rect.h / 2 >= cut - EPS)
      .map((b) => b.id);
    const dy = TEXT_TOP - cutGrid;
    const g = rowAt(cutGrid + EPS);
    const moved = firstRow >= 0 ? rows.slice(firstRow) : [];
    const lead = moved.length ? Math.max(0, rowAt(moved[0].top + EPS) - g) : 0;
    const lastBottom = moved.length ? Math.max(...moved.map((r) => r.bottom)) : 0;
    const textLines = moved.length ? Math.max(1, rowAt(lastBottom - EPS) - g + 1) : 0;
    const inkLines = inkBottom > -Infinity ? Math.max(0, Math.ceil((inkBottom + dy - TEXT_TOP) / LINE - 1e-6)) : 0;
    return {
      cut, cutGrid, firstRow: firstRow >= 0 ? firstRow : rows.length,
      strokeIds, zoneIds, flagIds, dy, lead, textLines, inkLines,
    };
  }
  return null;
}

/** Nombre de lignes d'un texte tape (un "\n" = un saut de ligne). */
export function lineCount(content: string): number {
  return content ? content.split("\n").length : 0;
}

/**
 * Texte de la page d'arrivee : `lead` lignes vides, le texte deplace, puis
 * l'ancien texte de la page. `movedRows` : rangees visuelles du texte
 * deplace, lead compris (un paragraphe replie en compte plusieurs, d'ou la
 * mesure plutot que les "\n") ; l'ancien texte commence au moins a la
 * rangee `atRows` (sous l'encre deplacee). Rend aussi la hauteur dont
 * l'ancien contenu de la page descend : son encre et ses reperes suivent.
 */
export function composeFlowText(moved: string, lead: number, existing: string, movedRows: number,
  atRows = 0): { text: string; shift: number } {
  const head = moved ? "\n".repeat(lead) + moved : "";
  const start = Math.max(head ? movedRows : 0, atRows);
  if (!existing) return { text: head, shift: start * LINE };
  if (!head) return { text: "\n".repeat(start) + existing, shift: start * LINE };
  const pad = Math.max(0, atRows - movedRows);
  return { text: head + "\n".repeat(pad) + "\n" + existing, shift: start * LINE };
}

/** Ce qui passe d'une page a l'autre (blocs entiers ou traits). */
export interface FlowSelection {
  strokeIds: readonly string[];
  zoneIds: readonly string[];
  flagIds: readonly string[];
  /** Photos, calculs, courbes poses dans le texte qui part (jeton img:). */
  blockIds: readonly string[];
}

/**
 * Deplace la selection de la page `from` vers la page `to` : les traits du
 * fond rejoignent le fond de `to` (ids gardes, mots reconnus avec eux), les
 * zones, reperes et blocs du texte passent entiers. L'ancien contenu de
 * `to` descend d'abord de `shift` (encre et reperes), puis ce qui arrive est
 * decale de `dy`. `newId` : id du fond d'encre s'il faut le creer.
 * Modifie les deux tableaux de blocs. Rend le nombre de traits deplaces.
 */
export function moveFlowBlocks(from: Page, to: Page, sel: FlowSelection, dy: number, shift: number,
  newId: () => string): number {
  if (shift) {
    // Tout l'ancien contenu descend : encre, zones, reperes (pas les PDF).
    const all = new Set<string>();
    for (const b of to.blocks) {
      if (b.type === "ink" || b.type === "math") for (const s of b.strokes) all.add(s.id);
    }
    transformBlocks(to.blocks, all, translation(0, shift));
    for (const b of to.blocks) if (b.type === "flag" && b.rect) b.rect = { ...b.rect, y: b.rect.y + shift };
  }
  const strokeSet = new Set(sel.strokeIds);
  const whole = new Set([...sel.zoneIds, ...sel.flagIds, ...sel.blockIds]);
  const arriving = new Set<string>();
  let count = 0;
  // Fond d'encre : traits et mots qui partent.
  const src = from.blocks.find(isMainInk);
  if (src && strokeSet.size) {
    const going = src.strokes.filter((s) => strokeSet.has(s.id));
    if (going.length) {
      let dst = to.blocks.find(isMainInk);
      if (!dst) {
        dst = { id: newId(), type: "ink", strokes: [], recognized: null, mode: "raw" };
        to.blocks.push(dst);
      }
      src.strokes = src.strokes.filter((s) => !strokeSet.has(s.id));
      dst.strokes.push(...going);
      for (const s of going) arriving.add(s.id);
      count += going.length;
      // Traits deja lus sans mot (schema, fleche : bands.ts recoSkip) : ils
      // restent lus sur la page d'arrivee, sinon ils repartiraient au moteur.
      const skip = (b: InkBlock) => (b as InkBlock & { recoSkip?: string[] });
      const skipped = skip(src).recoSkip?.filter((id) => strokeSet.has(id)) ?? [];
      if (skipped.length) {
        skip(src).recoSkip = skip(src).recoSkip!.filter((id) => !strokeSet.has(id));
        skip(dst).recoSkip = [...(skip(dst).recoSkip ?? []), ...skipped];
      }
      if (src.words) {
        // Mot entierement parti : il suit son encre ; a moitie : il perd ses traits partis.
        const moved: InkWord[] = src.words.filter((w) => w.box && w.strokeIds.length
          && w.strokeIds.every((id) => strokeSet.has(id)));
        src.words = dropStrokes(src.words, strokeSet);
        src.recognized = joinWords(src.words) || null;
        if (moved.length) {
          const sep: InkWord[] = dst.words?.length ? [{ label: "\n", strokeIds: [] }] : [];
          dst.words = [...moved.flatMap((w, i) => (i ? [{ label: " ", strokeIds: [] }, w] : [w])), ...sep, ...(dst.words ?? [])];
          dst.recognized = joinWords(dst.words) || null;
        }
      }
    }
  }
  // Blocs entiers : zones, reperes, photos et blocs vivants du texte.
  const keep: Block[] = [];
  for (const b of from.blocks) {
    if (!whole.has(b.id)) { keep.push(b); continue; }
    to.blocks.push(b);
    if (b.type === "ink" || b.type === "math") {
      for (const s of b.strokes) arriving.add(s.id);
      count += b.strokes.length;
    }
    if (b.type === "flag" && b.rect) b.rect = { ...b.rect, y: Math.max(0, b.rect.y + dy) };
  }
  from.blocks = keep;
  if (dy) transformBlocks(to.blocks, arriving, translation(0, dy));
  return count;
}

/**
 * Hauteur de la page reellement occupee par son encre la plus basse, 0 sans
 * encre. Sert a savoir si une page est une ancienne page longue.
 */
export function inkExtent(blocks: readonly Block[]): number {
  let bottom = 0;
  for (const it of inkItems(blocks)) bottom = Math.max(bottom, it.bottom);
  return bottom;
}

/** Hauteurs (unites de page) des reperes de saut de page d'une feuille de hauteur h. */
export function pageBreaks(h: number): number[] {
  const out: number[] = [];
  for (let y = PAGE_H; y < h - 1; y += PAGE_H) out.push(y);
  return out;
}

/** Une page est-elle une ancienne page longue (plus haute qu'une A4) ? */
export function isLongPage(sheetH: number): boolean {
  return sheetH > LONG_PAGE;
}

/*
 * Remontee automatique de la suite (facon Word) : quand une page raccourcit
 * (lignes effacees), le haut de sa page de suite (`continues`) remonte
 * combler la place. Orchestration : PageView.autoPull.
 */

/** Tout ce qui remonte d'une page de suite : son encre, ses zones, reperes, photos et blocs. */
export function pullSelection(next: Page): FlowSelection {
  const main = next.blocks.find(isMainInk);
  const placed = next.blocks.filter((b) => b.type !== "text" && "rect" in b && b.rect);
  return {
    strokeIds: main ? main.strokes.map((s) => s.id) : [],
    zoneIds: placed.filter((b) => b.type !== "flag").map((b) => b.id),
    flagIds: placed.filter((b) => b.type === "flag").map((b) => b.id),
    blockIds: next.blocks.filter((b) => b.type !== "text" && b.type !== "ink" && !("rect" in b && b.rect)).map((b) => b.id),
  };
}

/**
 * La page de suite peut-elle remonter d'elle-meme ? Seulement si tout ce
 * qu'elle contient sait suivre le texte : un texte encadre (ancien format),
 * une page de PDF ou un bloc inconnu restent ou ils sont.
 */
export function canAutoPull(next: Page): boolean {
  const known = new Set(["text", "ink", "math", "flag", "image", "calc", "graph", "schema"]);
  // Un seul fond d'encre (pullSelection ne prend que le premier) et un seul texte tape.
  if (next.blocks.filter(isMainInk).length > 1) return false;
  if (next.blocks.filter((b) => b.type === "text").length > 1) return false;
  return next.blocks.every((b) => known.has(b.type) && !(b.type === "text" && "rect" in b && b.rect));
}

/**
 * Lignes libres en bas d'une page (sous son texte, lignes vides comprises,
 * et sous son encre). `textBottom` : bas de la derniere rangee de texte
 * (unites de page), 0 sans texte.
 */
export function freeRows(textBottom: number, inkBottom: number): { used: number; textRows: number; free: number } {
  const rows = (y: number) => (y > TEXT_TOP + 0.5 ? rowAt(y - 0.5) + 1 : 0);
  const textRows = rows(textBottom);
  const used = Math.max(textRows, rows(inkBottom));
  return { used, textRows, free: TEXT_ROWS - used };
}

/** Texte sans blancs ni ancres invisibles (ce qu'on compare). */
function squashText(s: string): string {
  return s.replace(/[\s​]/g, "");
}

/**
 * Apres la mesure de la page avec la suite ajoutee : quelque chose de la
 * suite remonte-t-il vraiment ? `tail` = texte qui repartirait sur la
 * suite, `theirs` = son texte d'avant ; `back` = traits/zones/reperes/blocs
 * qui y repartiraient, `all` = tous les siens.
 */
export function pullGains(theirs: string, tail: string, back: number, all: number): boolean {
  return squashText(tail) !== squashText(theirs) || back < all;
}

/** Nombre de morceaux (traits du fond, zones, reperes, blocs) d'une selection. */
export function selectionSize(s: FlowSelection): number {
  return s.strokeIds.length + s.zoneIds.length + s.flagIds.length + s.blockIds.length;
}
