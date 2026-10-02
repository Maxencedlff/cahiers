/**
 * Arborescence des intercalaires (D4, palier 2). Logique pure, sans disque
 * ni DOM.
 *
 * Un intercalaire est designe par son chemin relatif a la matiere, avec des
 * « / » : « Cours », « E3A/S1/Chapitre 1 ». Les cahiers a 2 niveaux gardent
 * donc exactement les memes noms qu'avant (un seul segment).
 *
 * Un « groupe » est un dossier qui contient d'autres dossiers
 * d'intercalaires (E3A, S1). S'il a aussi des pages, il reste un
 * intercalaire a part entiere : ses pages s'ouvrent comme les autres.
 * Au plus MAX_DEPTH niveaux sous la matiere ; plus bas, les dossiers sont
 * laisses tels quels (projets, sources), jamais lus comme des intercalaires.
 */

/** Niveaux de dossiers lus sous la matiere (E3A / S1 / Chapitre 1). */
export const MAX_DEPTH = 3;

/** Separateur affiche entre les niveaux (« S1 › Chapitre 1 »). */
export const LEVEL_SEP = " › ";

/** Un dossier d'intercalaire tel que lu sur le disque. */
export interface RawDir {
  name: string;
  /** Sous-dossiers d'intercalaires (deja filtres : ni caches, ni assets). */
  children?: RawDir[];
  /** Le dossier a des pages (seulement su pour les groupes). */
  pages?: boolean;
}

export interface DividerNode {
  /** Chemin relatif a la matiere : l'identite de l'intercalaire. */
  path: string;
  /** Nom du dossier (dernier segment). */
  name: string;
  /** 1 sous la matiere, 2, 3. */
  depth: number;
  /** Intercalaires imbriques, dans l'ordre de cahier.json puis du disque. */
  children: DividerNode[];
  /** Le dossier a ses propres pages (toujours vrai pour une feuille). */
  pages: boolean;
}

/* ---------------- chemins ---------------- */

export function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/** Dernier segment : le nom du dossier. */
export function leafName(path: string): string {
  const s = segments(path);
  return s[s.length - 1] ?? "";
}

/** Chemin du groupe parent ; "" pour un intercalaire de premier niveau. */
export function parentPath(path: string): string {
  const s = segments(path);
  return s.slice(0, -1).join("/");
}

export function depthOf(path: string): number {
  return segments(path).length;
}

export function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** `path` est `ancestor` ou se trouve dessous. */
export function isUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor + "/");
}

/**
 * Chemin apres le renommage ou le deplacement de `from` en `to` : le
 * dossier lui-meme et tout ce qu'il contient suivent, le reste ne bouge pas.
 */
export function renamePrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return path;
}

/** Table indexee par chemin (modes, fonds, positions) apres un renommage. */
export function remapKeys<T>(rec: Record<string, T>, from: string, to: string): Record<string, T> {
  const out: Record<string, T> = {};
  // Les cles deplacees passent apres les autres : une cle deja presente
  // sous le nouveau nom (ancienne entree orpheline) est remplacee.
  for (const [k, v] of Object.entries(rec)) if (!isUnder(k, from)) out[k] = v;
  for (const [k, v] of Object.entries(rec)) if (isUnder(k, from)) out[renamePrefix(k, from, to)] = v;
  return out;
}

/** Nom affiche : « E3A › S1 › Chapitre 1 ». `last` garde les derniers niveaux. */
export function dividerLabel(path: string, last?: number): string {
  const s = segments(path);
  return (last && s.length > last ? s.slice(-last) : s).join(LEVEL_SEP);
}

/**
 * Chemin d'une page dans un lien ou une reference (« Elec/E3A/S1/0003 ») :
 * la matiere est le premier segment, le numero le dernier, l'intercalaire
 * tout ce qui est entre les deux (un ou plusieurs niveaux).
 */
export function parsePagePath(path: string): { notebook: string; divider: string; number: number } | null {
  const s = segments(path);
  if (s.length < 3) return null;
  const number = Number(s[s.length - 1]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { notebook: s[0], divider: s.slice(1, -1).join("/"), number };
}

/* ---------------- arbre ---------------- */

/**
 * Arbre ordonne : a chaque niveau, les dossiers nommes dans `order`
 * (cahier.json, chemins relatifs) dans cet ordre, puis les autres dans
 * l'ordre du disque. Un ancien cahier.json (noms de premier niveau
 * seulement) ordonne le premier niveau comme avant.
 */
export function buildTree(raw: readonly RawDir[], order: readonly string[], parent = ""): DividerNode[] {
  const rank = new Map<string, number>();
  order.forEach((p, i) => { if (!rank.has(p)) rank.set(p, i); });
  const depth = depthOf(parent) + 1;
  if (depth > MAX_DEPTH) return [];
  const nodes = raw.map((r, i) => {
    const path = childPath(parent, r.name);
    const children = buildTree(r.children ?? [], order, path);
    return {
      i,
      node: { path, name: r.name, depth, children, pages: children.length ? !!r.pages : true },
    };
  });
  nodes.sort((a, b) => {
    const ra = rank.get(a.node.path), rb = rank.get(b.node.path);
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1;
    if (rb != null) return 1;
    return a.i - b.i;
  });
  return nodes.map((n) => n.node);
}

/** Tous les chemins, groupe avant son contenu (ordre de lecture). */
export function flattenTree(nodes: readonly DividerNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly DividerNode[]) => {
    for (const n of list) { out.push(n.path); walk(n.children); }
  };
  walk(nodes);
  return out;
}

/**
 * Intercalaires qui ont des pages a montrer : les feuilles et les groupes
 * qui ont aussi leurs propres pages. Ordre de lecture (Ctrl+Maj+Pg↓).
 */
export function openableDividers(nodes: readonly DividerNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly DividerNode[]) => {
    for (const n of list) { if (n.pages) out.push(n.path); walk(n.children); }
  };
  walk(nodes);
  return out;
}

export function findNode(nodes: readonly DividerNode[], path: string): DividerNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (isUnder(path, n.path)) return findNode(n.children, path);
  }
  return null;
}

/** Les intercalaires du meme niveau (meme groupe), dans l'ordre. */
export function siblingsIn(nodes: readonly DividerNode[], path: string): DividerNode[] {
  const parent = parentPath(path);
  if (!parent) return [...nodes];
  return findNode(nodes, parent)?.children ?? [];
}

/** Niveaux occupes par le dossier et son contenu (1 pour une feuille). */
export function subtreeHeight(node: DividerNode): number {
  return 1 + Math.max(0, ...node.children.map(subtreeHeight));
}

/**
 * Groupe dont la sous-bande est ouverte quand on arrive sur `divider` :
 * le groupe lui-meme s'il en est un (ses intercalaires a portee de doigt),
 * sinon son parent ; null au premier niveau sans contenu.
 */
export function defaultExpanded(nodes: readonly DividerNode[], divider: string): string | null {
  const node = findNode(nodes, divider);
  if (node?.children.length) return node.path;
  const parent = parentPath(divider);
  return parent || null;
}

/**
 * Groupes de la sous-bande ouverte, du premier niveau au plus profond
 * (fil d'Ariane) : « E3A », « E3A/S1 ».
 */
export function expandedChain(expanded: string | null): string[] {
  if (!expanded) return [];
  const s = segments(expanded);
  return s.map((_, i) => s.slice(0, i + 1).join("/"));
}

/* ---------------- ordre ---------------- */

/**
 * Ordre a ecrire dans cahier.json apres avoir glisse `path` a la place
 * `index` parmi ses voisins (meme groupe). `flat` est l'ordre affiche,
 * groupes et contenus compris ; seuls les voisins changent de place.
 */
export function moveAmongSiblings(flat: readonly string[], path: string, index: number): string[] {
  const parent = parentPath(path);
  const sibs = flat.filter((p) => parentPath(p) === parent);
  const from = sibs.indexOf(path);
  if (from < 0) return [...flat];
  const rest = sibs.filter((p) => p !== path);
  rest.splice(Math.max(0, Math.min(rest.length, index)), 0, path);
  let k = 0;
  return flat.map((p) => (parentPath(p) === parent ? rest[k++] : p));
}

/**
 * Peut-on ranger `from` dans le groupe `toParent` ("" = premier niveau) ?
 * Rend le motif du refus, ou null. `height` = niveaux occupes par `from`
 * et son contenu (subtreeHeight).
 */
export function moveRefusal(from: string, toParent: string, height = 1): string | null {
  if (parentPath(from) === toParent) return "il y est déjà";
  if (toParent && isUnder(toParent, from)) return "un dossier ne peut pas aller dans lui-même";
  if (depthOf(toParent) + height > MAX_DEPTH) return `au plus ${MAX_DEPTH} niveaux sous la matière`;
  return null;
}
