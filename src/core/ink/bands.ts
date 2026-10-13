import type { InkBlock, InkWord, Stroke } from "../types";
import type { Bounds } from "./stroke";
import { cachedBounds } from "./stroke";
import { carryEdits, dropStrokes, joinWords } from "./words";
import { DOT_NEAR } from "./pointer";

/**
 * Conversion incrementale par bande de lignes (reco-3, fond).
 *
 * En mode Auto, toute l'encre de la page partait chez MyScript a chaque
 * pause : le quota mensuel fondait, la latence montait avec la page, et des
 * mots deja convertis changeaient sous les yeux. Ici, logique pure :
 *  - `groupBands` decoupe l'encre en bandes de lignes (une ligne ecrite,
 *    avec ses indices, exposants, fractions hautes, points et accents) ;
 *  - `planIncremental` choisit ce qui part : les traits pas encore lus des
 *    bandes touchees, plus les mots voisins qu'un ajout prolonge (contexte) ;
 *  - `mergeIncremental` range le resultat : les mots hors envoi ne bougent
 *    pas, ceux de l'envoi sont remplaces (corrections reportees).
 *
 * Etat garde dans le bloc (champs optionnels, ignores par les anciennes
 * versions, reecrits tels quels) :
 *  - `InkWord.stale` : mot a relire (gomme partielle, morceau coupe,
 *    deplacement au lasso). Il reste affiche jusqu'a sa relecture ;
 *  - `InkBlock.recoSkip` : traits deja envoyes que le moteur n'a rattaches a
 *    aucun mot (schema, fleche, gribouillis). Sans cette liste, ils
 *    repartaient a chaque conversion.
 */

/** Mot reconnu, avec la marque « a relire ». */
export type RecoWord = InkWord & { stale?: boolean };
/** Fond de page, avec les traits lus sans mot. */
export type RecoInk = Omit<InkBlock, "words"> & { recoSkip?: string[]; words?: RecoWord[] };

export interface Band {
  top: number;
  bottom: number;
  /** Ids des traits de la bande, dans l'ordre d'ecriture. */
  ids: string[];
}

/**
 * Seuils, en hauteurs medianes de trait (`L`, environ une lettre) :
 * - deux traits dont les centres sont a moins de JUMP·L sont sur la meme
 *   ligne (indice, exposant, numerateur / barre / denominateur) ;
 * - ou si leurs hauteurs se recouvrent de plus de OVERLAP de la plus petite ;
 * - un grand trait (plus de BIG·L : integrale, accolade d'un systeme, grande
 *   parenthese) relie toutes les lignes dont le centre tombe dans sa
 *   hauteur : ses bornes, ses deux lignes ;
 * - un trait plus petit que SAT·L en hauteur ET en largeur (point du i,
 *   accent, virgule) ne relie pas deux lignes : il va a la ligne du trait le
 *   plus proche. Sinon le point d'un i, pose dans le jambage de la ligne du
 *   dessus, collait les deux lignes ;
 * - un trait plus haut que TALL·L (fleche, trait de schema) ne relie rien :
 *   il va a la ligne la plus proche de son centre.
 */
const JUMP = 1.0;
const OVERLAP = 0.5;
const SAT = 0.45;
const BIG = 2.2;
const TALL = 4.5;
/** Un ajout a moins de PULL hauteurs de mot d'un mot converti le prolonge. */
const PULL = 0.35;

interface Item { s: Stroke; b: Bounds; cy: number }
interface Group { top: number; bottom: number; maxCy: number; items: Item[] }

/** Decoupe des traits en bandes de lignes, de haut en bas. */
export function groupBands(strokes: readonly Stroke[]): Band[] {
  const items: Item[] = [];
  for (const s of strokes) {
    if (!s.points.length) continue;
    const b = cachedBounds(s);
    items.push({ s, b, cy: b.y + b.h / 2 });
  }
  if (!items.length) return [];
  const L = Math.max(8, median(items.map((i) => i.b.h).filter((h) => h > 3)) || 20);
  const isSat = (i: Item) => i.b.h < SAT * L && i.b.w < SAT * L * 1.5;
  const isTall = (i: Item) => i.b.h > TALL * L;
  const isBig = (i: Item) => !isTall(i) && i.b.h > BIG * L;

  // 1. Lignes formees par les traits ordinaires, chainees par leur centre.
  let groups: Group[] = [];
  const core = items.filter((i) => !isSat(i) && !isTall(i) && !isBig(i)).sort((a, b) => a.cy - b.cy);
  for (const it of core) {
    const g = groups[groups.length - 1];
    if (g) {
      const near = it.cy - g.maxCy <= JUMP * L;
      const ov = Math.min(g.bottom, it.b.y + it.b.h) - Math.max(g.top, it.b.y);
      if (near || ov > OVERLAP * Math.min(it.b.h, g.bottom - g.top)) { add(g, it); continue; }
    }
    groups.push(newGroup(it));
  }

  // 2. Grands traits : ils relient les lignes qu'ils couvrent.
  for (const it of items.filter(isBig)) {
    const lo = it.b.y - 0.5 * L, hi = it.b.y + it.b.h + 0.5 * L;
    const covered = groups.filter((g) => { const c = coreOf(g); return c >= lo && c <= hi; });
    if (!covered.length) { groups.push(newGroup(it)); continue; }
    const merged = covered.reduce((acc, g) => {
      if (acc !== g) { for (const x of g.items) add(acc, x); }
      return acc;
    });
    add(merged, it);
    groups = groups.filter((g) => g === merged || !covered.includes(g));
  }

  // 3. Points, accents : ligne du trait le plus proche. Fleches : ligne la
  // plus proche de leur centre, sans l'etirer. Loin de tout : bande a part.
  const cores = new Map(groups.map((g) => [g, coreOf(g)]));
  for (const it of items.filter((i) => isSat(i) || isTall(i))) {
    let best: Group | null = null, dist = Infinity;
    for (const g of groups) {
      const d = isTall(it) ? Math.abs(it.cy - (cores.get(g) ?? coreOf(g))) : nearestStroke(it.b, g);
      if (d < dist) { dist = d; best = g; }
    }
    if (best && (isTall(it) || dist <= 2 * L)) {
      best.items.push(it);
      if (!isTall(it)) {
        best.top = Math.min(best.top, it.b.y);
        best.bottom = Math.max(best.bottom, it.b.y + it.b.h);
      }
    } else {
      groups.push(newGroup(it));
    }
  }

  const order = new Map(strokes.map((s, i) => [s.id, i]));
  return groups
    .map((g) => ({
      top: g.top, bottom: g.bottom,
      ids: g.items.map((i) => i.s.id).sort((a, b) => order.get(a)! - order.get(b)!),
    }))
    .sort((a, b) => a.top - b.top);
}

function newGroup(it: Item): Group {
  return { top: it.b.y, bottom: it.b.y + it.b.h, maxCy: it.cy, items: [it] };
}

function add(g: Group, it: Item): void {
  g.items.push(it);
  g.top = Math.min(g.top, it.b.y);
  g.bottom = Math.max(g.bottom, it.b.y + it.b.h);
  g.maxCy = Math.max(g.maxCy, it.cy);
}

/** Centre median d'une ligne : son axe, insensible aux hampes et jambages. */
function coreOf(g: Group): number {
  return median(g.items.map((i) => i.cy));
}

/** Ecart entre une boite et le trait le plus proche de la ligne. */
function nearestStroke(b: Bounds, g: Group): number {
  let best = Infinity;
  for (const it of g.items) {
    const o = it.b;
    const dx = Math.max(o.x - (b.x + b.w), 0, b.x - (o.x + o.w));
    const dy = Math.max(o.y - (b.y + b.h), 0, b.y - (o.y + o.h));
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

/** Traits du fond de page deja lus : dans un mot a jour, ou lus sans mot. */
export function doneStrokeIds(block: RecoInk): Set<string> {
  const out = new Set<string>(block.recoSkip ?? []);
  for (const w of block.words ?? []) {
    if (w.box && w.label.trim() && !w.stale) for (const id of w.strokeIds) out.add(id);
  }
  return out;
}

/** Traits d'ecriture pas encore lus (ou a relire). */
export function dirtyStrokes(block: RecoInk): Stroke[] {
  const done = doneStrokeIds(block);
  return recoStrokes(block.strokes).filter((s) => !done.has(s.id));
}

/**
 * Traits d'ecriture a envoyer a la reconnaissance. Un trait d'1 ou 2
 * points isole (appui, aucun trait d'ecriture a moins de DOT_NEAR) n'y
 * part jamais : il etait lu « . » (audit du lot stylet). Un point pose
 * contre un autre trait (point du i, accent, virgule decimale) part.
 */
export function recoStrokes(strokes: readonly Stroke[]): Stroke[] {
  const pens = strokes.filter((s) => s.tool === "pen");
  return pens.filter((s) => {
    if (s.points.length > 2) return true;
    const b = cachedBounds(s);
    return pens.some((o) => o !== s && o.points.length > 2 && near(cachedBounds(o), b, DOT_NEAR));
  });
}

export interface IncrementalPlan {
  /** A envoyer tout de suite : bandes touchees, hors ligne en cours d'ecriture. */
  now: Stroke[];
  /** Tout ce qui reste a lire, ligne en cours comprise (pause longue). */
  all: Stroke[];
  bands: Band[];
}

/**
 * Ce qui part a la reconnaissance. `current` = boite du dernier trait ecrit :
 * sa ligne est gardee tant qu'on y ecrit (une seule requete par ligne au
 * lieu d'une par pause), elle part avec `all` a la pause longue ou des
 * qu'on passe a une autre ligne. `full` = toute la page (reconversion
 * demandee).
 */
export function planIncremental(
  block: RecoInk, opts: { current?: Bounds; full?: boolean } = {},
): IncrementalPlan {
  const pens = recoStrokes(block.strokes);
  const bands = groupBands(pens);
  if (opts.full) return { now: pens, all: pens, bands };
  const done = doneStrokeIds(block);
  const byId = new Map(pens.map((s) => [s.id, s]));
  const words = (block.words ?? []).filter((w) => w.box && w.label.trim() && !w.stale);

  let currentBand = -1;
  if (opts.current) {
    const c = opts.current;
    const cy = c.y + c.h / 2;
    currentBand = bands.findIndex((b) => cy >= b.top && cy <= b.bottom);
  }

  const now = new Set<string>();
  const all = new Set<string>();
  bands.forEach((band, k) => {
    const dirty = band.ids.filter((id) => !done.has(id));
    if (!dirty.length) return;
    const send = new Set(dirty);
    // Contexte : un mot converti que l'ajout touche ou prolonge (« tension »
    // puis un « s », l'accent pose apres coup) repart avec lui, sinon le
    // moteur lirait l'ajout seul.
    const inBand = new Set(band.ids);
    const boxes = dirty.map((id) => cachedBounds(byId.get(id)!));
    for (const w of words) {
      if (!w.strokeIds.some((id) => inBand.has(id))) continue;
      const m = PULL * w.box!.h;
      if (boxes.some((b) => near(b, w.box!, m))) {
        for (const id of w.strokeIds) if (byId.has(id)) send.add(id);
      }
    }
    for (const id of send) {
      all.add(id);
      if (k !== currentBand) now.add(id);
    }
  });
  const pick = (set: Set<string>) => pens.filter((s) => set.has(s.id));
  return { now: pick(now), all: pick(all), bands };
}

function near(a: Bounds, b: Bounds, m: number): boolean {
  return a.x <= b.x + b.w + m && b.x <= a.x + a.w + m && a.y <= b.y + b.h + m && b.y <= a.y + a.h + m;
}

/** Empreinte d'un envoi : le meme envoi n'est pas repose deux fois. */
export function sendSignature(strokes: readonly Stroke[]): string {
  return strokes.map((s) => s.id).sort().join(",");
}

/** Nombre de points envoyes (taille d'une requete). */
export function pointCount(strokes: readonly Stroke[]): number {
  let n = 0;
  for (const s of strokes) n += s.points.length;
  return n;
}

/**
 * Un trait du fond de page a ete gomme en partie, coupe ou deplace : les
 * mots qui le portent sont a relire (ils restent affiches d'ici la), et un
 * trait lu sans mot redevient a lire. Vrai si quelque chose a change.
 */
export function invalidateStrokes(block: RecoInk, ids: Iterable<string>): boolean {
  const set = new Set(ids);
  if (!set.size) return false;
  let changed = false;
  if (block.words) {
    block.words = block.words.map((w) => {
      if (w.stale || !w.box || !w.strokeIds.some((id) => set.has(id))) return w;
      changed = true;
      return { ...w, stale: true };
    });
  }
  if (block.recoSkip?.some((id) => set.has(id))) {
    block.recoSkip = block.recoSkip.filter((id) => !set.has(id));
    if (!block.recoSkip.length) delete block.recoSkip;
    changed = true;
  }
  return changed;
}

/**
 * Range le resultat d'un envoi partiel (`scope` = traits envoyes).
 * - un mot ancien sans trait envoye est garde tel quel (jamais relu ni
 *   modifie) ;
 * - un mot ancien dont des traits sont partis est remplace par la nouvelle
 *   lecture, ses corrections reportees (carryEdits) ;
 * - un trait envoye que le moteur ne rattache a aucun mot passe dans
 *   `recoSkip` : il ne repartira plus ;
 * - un trait gomme pendant l'aller-retour ne ressuscite pas.
 * Les separateurs sont refaits dans l'ordre de lecture (lignes, puis x).
 */
export function mergeIncremental(
  block: RecoInk, next: InkWord[] | undefined, scope: readonly string[],
): void {
  const alive = new Set(block.strokes.map((s) => s.id));
  const sent = new Set(scope);
  const prev = (block.words ?? []).filter((w) => w.box && w.label.trim());
  const fresh = (next ?? []).filter((w) => w.box && w.label.trim() && w.strokeIds.length);

  let kept: RecoWord[];
  let words: RecoWord[];
  if (fresh.length === 0) {
    // Rien de lu (gribouillis, schema) : les mots en place restent, les
    // traits envoyes ne repartent plus.
    kept = prev.map((w) => (w.stale && !w.strokeIds.some((id) => !sent.has(id))
      ? withoutStale(w) : w));
    words = kept;
  } else {
    const replaced = prev.filter((w) => w.strokeIds.some((id) => sent.has(id)));
    kept = prev.filter((w) => !w.strokeIds.some((id) => sent.has(id)));
    // Un trait pris par un nouveau mot quitte un ancien mot garde (rare :
    // mot ancien a moitie envoye).
    const taken = new Set(fresh.flatMap((w) => w.strokeIds));
    kept = kept.map((w) => (w.strokeIds.some((id) => taken.has(id))
      ? { ...w, strokeIds: w.strokeIds.filter((id) => !taken.has(id)) } : w))
      .filter((w) => w.strokeIds.length);
    words = [...kept, ...carryEdits(replaced, fresh).map(withoutStale)];
  }

  // Mots sans traits vivants retires, traits morts oublies.
  const dead = new Set<string>();
  for (const w of words) for (const id of w.strokeIds) if (!alive.has(id)) dead.add(id);
  const live = dropStrokes(words, dead).filter((w) => w.box);

  const attached = new Set(live.flatMap((w) => w.strokeIds));
  const skip = new Set((block.recoSkip ?? []).filter((id) => alive.has(id) && !attached.has(id)));
  for (const id of sent) if (alive.has(id) && !attached.has(id)) skip.add(id);

  block.words = orderWords(live);
  block.recognized = joinWords(block.words) || null;
  block.candidates = undefined;
  if (skip.size) block.recoSkip = [...skip];
  else delete block.recoSkip;
}

function withoutStale(w: RecoWord): RecoWord {
  if (!w.stale) return w;
  const { stale: _s, ...rest } = w;
  void _s;
  return rest;
}

/**
 * Mots dans l'ordre de lecture, avec leurs separateurs : " " entre deux mots
 * d'une ligne, "\n" entre deux lignes. Deux mots sont sur la meme ligne si
 * leurs boites se recouvrent sur plus de la moitie de la plus petite.
 */
export function orderWords(words: readonly InkWord[]): InkWord[] {
  const boxed = words.filter((w) => w.box && w.label.trim());
  const sorted = [...boxed].sort((a, b) => (a.box!.y + a.box!.h / 2) - (b.box!.y + b.box!.h / 2));
  const lines: { top: number; bottom: number; words: InkWord[] }[] = [];
  for (const w of sorted) {
    const b = w.box!;
    const line = lines.find((l) => {
      const ov = Math.min(l.bottom, b.y + b.h) - Math.max(l.top, b.y);
      return ov > 0.5 * Math.min(b.h, l.bottom - l.top);
    });
    if (line) {
      line.words.push(w);
      line.top = Math.min(line.top, b.y);
      line.bottom = Math.max(line.bottom, b.y + b.h);
    } else {
      lines.push({ top: b.y, bottom: b.y + b.h, words: [w] });
    }
  }
  lines.sort((a, b) => a.top - b.top);
  const out: InkWord[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ label: "\n", strokeIds: [] });
    l.words.sort((a, b) => a.box!.x - b.box!.x).forEach((w, j) => {
      if (j > 0) out.push({ label: " ", strokeIds: [] });
      out.push(w);
    });
  });
  return out;
}

/** Reste-t-il de l'ecriture a lire dans ce bloc ? */
export function hasDirty(block: RecoInk): boolean {
  return dirtyStrokes(block).length > 0;
}

/**
 * Delai de la pause longue (ms, depuis le dernier trait) au bout duquel la
 * ligne en cours part aussi. Plus court, chaque hesitation au milieu d'une
 * ligne coutait une requete ; plus long, la ligne reste a l'encre.
 */
export const AUTO_IDLE_MS = 4000;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
