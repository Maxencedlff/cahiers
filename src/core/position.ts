/**
 * Derniere position, par cahier et par intercalaire (D8). Gardee sur la
 * machine (stockage local), JAMAIS dans cahier.json : un defilement
 * reecrivait le dossier synchronise toutes les 250 ms et les deux PC se
 * disputaient le fichier. Chaque PC reprend la ou il etait.
 *
 * Logique pure ; `Positions` ne fait qu'y ajouter la lecture et l'ecriture
 * du stockage, chacune protegee (stockage absent ou plein : on continue).
 */

export interface NotebookSpot {
  /** Dernier intercalaire consulte. */
  divider: string;
  /** Derniere page consultee, par intercalaire. */
  pages: Record<string, number>;
  /** Date de la derniere visite (ISO), pour « Reprendre ». */
  at: string;
}

export type PositionMap = Record<string, NotebookSpot>;

/** Ancienne position, lue dans cahier.json (jamais plus ecrite). */
export interface LegacyPosition {
  divider: string;
  page: number;
}

export interface Spot {
  notebook: string;
  divider: string;
  page: number;
}

export const POSITIONS_KEY = "cahiers.positions.v1";

/** Retient la page vue. Rend une nouvelle table, l'ancienne n'est pas touchee. */
export function recordPosition(
  map: PositionMap, notebook: string, divider: string, page: number, now: string,
): PositionMap {
  if (!notebook || !divider || !Number.isInteger(page) || page < 1) return map;
  const old = map[notebook];
  return {
    ...map,
    [notebook]: { divider, pages: { ...(old?.pages ?? {}), [divider]: page }, at: now },
  };
}

/**
 * Page ou rouvrir un intercalaire : celle qu'on y avait laissee. L'ancienne
 * position de cahier.json ne vaut que pour SON intercalaire (avant, elle
 * renvoyait Exos p.4 sur Cours p.4).
 */
export function startPage(
  map: PositionMap, notebook: string, divider: string, legacy?: LegacyPosition,
): number | undefined {
  const known = map[notebook]?.pages[divider];
  if (known) return known;
  if (legacy?.divider === divider && legacy.page >= 1) return legacy.page;
  return undefined;
}

/** Intercalaire ou rouvrir le cahier, s'il existe encore. */
export function lastDivider(
  map: PositionMap, notebook: string, existing: readonly string[], legacy?: LegacyPosition,
): string | undefined {
  const d = map[notebook]?.divider ?? legacy?.divider;
  return d && existing.includes(d) ? d : undefined;
}

export function renameDividerIn(map: PositionMap, notebook: string, from: string, to: string): PositionMap {
  const spot = map[notebook];
  if (!spot || from === to) return map;
  const pages = { ...spot.pages };
  if (from in pages) { pages[to] = pages[from]; delete pages[from]; }
  return { ...map, [notebook]: { ...spot, pages, divider: spot.divider === from ? to : spot.divider } };
}

export function dropDividerIn(map: PositionMap, notebook: string, divider: string): PositionMap {
  const spot = map[notebook];
  if (!spot) return map;
  const pages = { ...spot.pages };
  delete pages[divider];
  const next = { ...map };
  if (spot.divider === divider) {
    // Plus d'intercalaire a reprendre : on garde les pages des autres.
    const other = Object.keys(pages)[0];
    if (other) next[notebook] = { ...spot, pages, divider: other };
    else delete next[notebook];
  } else {
    next[notebook] = { ...spot, pages };
  }
  return next;
}

export function renameNotebookIn(map: PositionMap, from: string, to: string): PositionMap {
  if (!(from in map) || from === to) return map;
  const next = { ...map, [to]: map[from] };
  delete next[from];
  return next;
}

export function dropNotebookIn(map: PositionMap, notebook: string): PositionMap {
  if (!(notebook in map)) return map;
  const next = { ...map };
  delete next[notebook];
  return next;
}

/** Bloc « Reprendre » : la visite la plus recente parmi les cahiers qui existent. */
export function latestSpot(map: PositionMap, notebooks: readonly string[]): Spot | null {
  let best: Spot | null = null;
  let bestAt = "";
  for (const nb of notebooks) {
    const s = map[nb];
    if (!s) continue;
    const page = s.pages[s.divider];
    if (!page || s.at <= bestAt) continue;
    bestAt = s.at;
    best = { notebook: nb, divider: s.divider, page };
  }
  return best;
}

/** Ce cahier est la visite la plus recente (aucun autre n'a une date plus tardive). */
export function isLatest(map: PositionMap, notebook: string): boolean {
  const at = map[notebook]?.at ?? "";
  return Object.entries(map).every(([nb, s]) => nb === notebook || s.at <= at);
}

/** Table relue du stockage : tout ce qui n'a pas la bonne forme est ignore. */
export function parsePositions(raw: string | null): PositionMap {
  if (!raw) return {};
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: PositionMap = {};
  for (const [nb, v] of Object.entries(data as Record<string, unknown>)) {
    const s = v as Partial<NotebookSpot> | null;
    if (!s || typeof s.divider !== "string" || !s.pages || typeof s.pages !== "object") continue;
    const pages: Record<string, number> = {};
    for (const [d, n] of Object.entries(s.pages)) if (Number.isInteger(n) && (n as number) >= 1) pages[d] = n as number;
    out[nb] = { divider: s.divider, pages, at: typeof s.at === "string" ? s.at : "" };
  }
  return out;
}

/** Ce qu'il faut du stockage local ; null quand il est indisponible. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Positions de cette machine, lues une fois et reecrites a chaque changement. */
export class Positions {
  private map: PositionMap;

  constructor(private storage: StorageLike | null, private now: () => string = () => new Date().toISOString()) {
    let raw: string | null = null;
    try { raw = storage?.getItem(POSITIONS_KEY) ?? null; } catch { raw = null; }
    this.map = parsePositions(raw);
  }

  private set(next: PositionMap): void {
    if (next === this.map) return;
    this.map = next;
    try { this.storage?.setItem(POSITIONS_KEY, JSON.stringify(next)); } catch { /* stockage plein ou absent */ }
  }

  record(notebook: string, divider: string, page: number): void {
    const spot = this.map[notebook];
    // Meme endroit, deja la visite la plus recente : rien a reecrire (le
    // defilement rappelle souvent). Revenu d'une autre matiere sur la meme
    // page, la date avance, sinon « Reprendre » montrait l'autre matiere.
    if (spot?.divider === divider && spot.pages[divider] === page && isLatest(this.map, notebook)) return;
    this.set(recordPosition(this.map, notebook, divider, page, this.now()));
  }

  pageFor(notebook: string, divider: string, legacy?: LegacyPosition): number | undefined {
    return startPage(this.map, notebook, divider, legacy);
  }

  dividerFor(notebook: string, existing: readonly string[], legacy?: LegacyPosition): string | undefined {
    return lastDivider(this.map, notebook, existing, legacy);
  }

  latest(notebooks: readonly string[]): Spot | null { return latestSpot(this.map, notebooks); }

  renameDivider(notebook: string, from: string, to: string): void {
    this.set(renameDividerIn(this.map, notebook, from, to));
  }

  dropDivider(notebook: string, divider: string): void { this.set(dropDividerIn(this.map, notebook, divider)); }
  renameNotebook(from: string, to: string): void { this.set(renameNotebookIn(this.map, from, to)); }
  dropNotebook(notebook: string): void { this.set(dropNotebookIn(this.map, notebook)); }
}
