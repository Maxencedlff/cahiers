/**
 * Liens entre pages (rech-10, manque-liens) : logique pure, sans DOM.
 *
 * Un lien vise une page par son id (uuid stable de `Page.id`), jamais par
 * son numero : « Maths/Cours/0012 » change des qu'on insere une page ou que
 * la pagination automatique en cree une. Le chemin reste ecrit a cote, pour
 * un humain qui lit le JSON, et sert de repli (ancien bloc `link` sans id).
 *
 * Dans le texte tape (core/text/doc.ts), un lien s'ecrit :
 *   [libellé](cahiers:<pageId>)                    la page
 *   [libellé](cahiers:<pageId>#<blockId>)          un bloc (formule, zone, photo)
 *   [libellé](cahiers:<pageId>#titre:<titre>)      un titre # de la page
 * suivi en option du chemin lisible entre guillemets :
 *   [théorème](cahiers:3f2a…#titre:Théorème%20de%20Thévenin "Elec/Cours/0003")
 *
 * Les retroliens (« Mentionné dans… ») se calculent a la volee depuis les
 * resumes des pages (PageIndex.links), ils ne sont jamais ecrits.
 */

import { fold, normalize } from "./text/find";

export const LINK_SCHEME = "cahiers:";
const HEADING_PREFIX = "titre:";

/** Cible d'un lien : la page (id), et en option un bloc ou un titre, plus le chemin lu. */
export interface LinkRef {
  pageId: string;
  /** Bloc vise (formule, zone, photo). */
  blockId?: string;
  /** Titre # vise dans le texte de la page (son texte). */
  heading?: string;
  /** Chemin lisible « Maths/Cours/0012 » au moment de la pose : repli seulement. */
  path?: string;
}

/** Ou se trouve une page sur le disque. */
export interface PageSpot { notebook: string; divider: string; number: number }

/* ---------------- format ---------------- */

/** Caracteres qui casseraient la syntaxe [..](..) : encodes en %XX, le reste lisible. */
const FRAGMENT_UNSAFE = /[%\s()"#[\]\\<>]/g;

function encodeFragment(s: string): string {
  return s.replace(FRAGMENT_UNSAFE, (c) => (c.charCodeAt(0) < 128
    ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : encodeURIComponent(c)));
}

function decodeFragment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Adresse d'un lien : « cahiers:<pageId>#<blockId> » ou « #titre:<titre> ». */
export function linkUrl(ref: LinkRef): string {
  let url = LINK_SCHEME + encodeFragment(ref.pageId);
  if (ref.blockId) url += "#" + encodeFragment(ref.blockId);
  else if (ref.heading) url += "#" + HEADING_PREFIX + encodeFragment(ref.heading);
  return url;
}

/** Relit une adresse « cahiers:… » ; `path` = chemin lisible ecrit a cote. null si ce n'en est pas une. */
export function parseLinkUrl(url: string, path?: string): LinkRef | null {
  if (!url.startsWith(LINK_SCHEME)) return null;
  const rest = url.slice(LINK_SCHEME.length);
  const hash = rest.indexOf("#");
  const pageId = decodeFragment(hash < 0 ? rest : rest.slice(0, hash));
  if (!pageId) return null;
  const ref: LinkRef = { pageId };
  if (hash >= 0) {
    const frag = rest.slice(hash + 1);
    if (frag.startsWith(HEADING_PREFIX)) {
      const h = decodeFragment(frag.slice(HEADING_PREFIX.length));
      if (h) ref.heading = h;
    } else if (frag) ref.blockId = decodeFragment(frag);
  }
  const p = path?.trim();
  if (p) ref.path = p;
  return ref;
}

/** Chemin lisible d'une page : « Elec/Cours/0003 » (numero sur 4 chiffres, comme le fichier). */
export function pagePathOf(spot: PageSpot): string {
  return `${spot.notebook}/${spot.divider}/${String(spot.number).padStart(4, "0")}`;
}

/** Chemin relu : matiere = 1er segment, numero = dernier, intercalaire entre les deux (D4). */
export function parsePath(path: string): PageSpot | null {
  const s = path.split("/").map((x) => x.trim()).filter(Boolean);
  if (s.length < 3) return null;
  const number = Number(s[s.length - 1]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { notebook: s[0], divider: s.slice(1, -1).join("/"), number };
}

/** Le chemin ecrit entre guillemets : jamais de guillemet dedans. */
export function cleanHint(path: string): string {
  return path.replace(/["\n\r]/g, "").trim();
}

/** Lien complet en markdown, tel qu'il est ecrit dans le texte (et copie par « Copier le lien »). */
export function linkMarkdown(label: string, ref: LinkRef): string {
  const body = label.replace(/[\\$*[\]]/g, (c) => `\\${c}`);
  const hint = ref.path ? ` "${cleanHint(ref.path)}"` : "";
  return `[${body}](${linkUrl(ref)}${hint})`;
}

/**
 * Lien markdown seul, sans rien autour (presse-papiers) : son libelle et sa
 * cible. null pour tout autre texte.
 */
export function parseLinkMarkdown(text: string): { label: string; ref: LinkRef } | null {
  const m = /^\s*\[((?:\\.|[^\\\]])*)\]\((cahiers:[^\s)"]+)(?:\s+"([^"]*)")?\)\s*$/.exec(text);
  if (!m) return null;
  const ref = parseLinkUrl(m[2], m[3]);
  if (!ref) return null;
  return { label: m[1].replace(/\\(.)/g, "$1"), ref };
}

/** Ancien bloc `link` : `target` = « Maths/Cours/0012#<blockId> », `pageId` en plus depuis rech-10. */
export interface LinkBlockLike { target: string; label: string; pageId?: string }

/** Cible d'un bloc `link` (format de la section 2), avec ou sans pageId. */
export function blockLinkRef(b: LinkBlockLike): LinkRef & { path: string } {
  const hash = b.target.indexOf("#");
  const path = hash < 0 ? b.target : b.target.slice(0, hash);
  const frag = hash < 0 ? "" : b.target.slice(hash + 1);
  const ref: LinkRef & { path: string } = { pageId: b.pageId ?? "", path };
  if (frag.startsWith(HEADING_PREFIX)) ref.heading = decodeFragment(frag.slice(HEADING_PREFIX.length));
  else if (frag) ref.blockId = frag;
  return ref;
}

/** Champs d'un bloc `link` pour cette cible : chemin lisible ET id (retrocompatible). */
export function linkBlockFields(ref: LinkRef, spot: PageSpot, label: string): { target: string; pageId: string; label: string } {
  const frag = ref.blockId ? `#${ref.blockId}` : ref.heading ? `#${HEADING_PREFIX}${encodeFragment(ref.heading)}` : "";
  return { target: pagePathOf(spot) + frag, pageId: ref.pageId, label };
}

/**
 * Texte d'un lien pour un export (PDF, Word) : son libelle, sinon le titre
 * vise, sinon « lien ». Point d'extension de l'export Word (core/export).
 */
export function linkLabel(link: { label?: string; heading?: string }): string {
  const l = (link.label ?? "").replace(/\s+/g, " ").trim();
  if (l) return l;
  const h = (link.heading ?? "").trim();
  return h || "lien";
}

/* ---------------- resolution ---------------- */

/** Une page vue au scan, avec ce que les liens en lisent (PageIndex). */
export interface LinkPage extends PageSpot {
  id: string;
  notebookTitle?: string;
  title?: string;
  firstLine?: string;
  modified?: string;
  /** Titres # de la page, dans l'ordre. */
  headings?: string[];
  /** Liens poses dans la page. */
  links?: IndexedLink[];
  /** Blocs que l'on peut viser (formules, zones reconnues). */
  anchors?: LinkAnchor[];
}

/** Lien lu dans une page (texte tape ou bloc `link`). */
export interface IndexedLink { pageId: string; blockId?: string; heading?: string; label: string }

/** Bloc qu'un lien peut viser : formule, zone manuscrite reconnue. */
export interface LinkAnchor { blockId: string; kind: "math" | "zone"; text: string }

/** Index id de page → endroit, construit a chaque scan (jamais ecrit). */
export function indexById(pages: readonly LinkPage[]): Map<string, LinkPage> {
  const map = new Map<string, LinkPage>();
  for (const p of pages) if (p.id && !map.has(p.id)) map.set(p.id, p);
  return map;
}

export type LinkResolution =
  | { kind: "page"; page: PageSpot; via: "id" | "path" }
  | { kind: "trash" }
  | { kind: "missing" };

/**
 * Ou mene un lien. Par l'id d'abord (survit aux renumerotations et aux
 * renommages) ; une page a la corbeille (`trashed`) n'est jamais remplacee
 * par celle qui a pris son numero ; le chemin ne sert qu'en dernier recours
 * (lien sans id, ou page dont l'id a disparu partout).
 */
export function resolveLink(
  ref: LinkRef, byId: ReadonlyMap<string, PageSpot>, opts: { trashed?: boolean; pathExists?: (spot: PageSpot) => boolean } = {},
): LinkResolution {
  const hit = ref.pageId ? byId.get(ref.pageId) : undefined;
  if (hit) return { kind: "page", page: { notebook: hit.notebook, divider: hit.divider, number: hit.number }, via: "id" };
  if (opts.trashed) return { kind: "trash" };
  const spot = ref.path ? parsePath(ref.path) : null;
  if (spot && (opts.pathExists?.(spot) ?? false)) return { kind: "page", page: spot, via: "path" };
  return { kind: "missing" };
}

/** La page existe-t-elle a cet endroit, d'apres le scan ? */
export function spotExists(pages: readonly PageSpot[], spot: PageSpot): boolean {
  return pages.some((p) => p.notebook === spot.notebook && p.divider === spot.divider && p.number === spot.number);
}

/* ---------------- retroliens ---------------- */

export interface Backlink extends PageSpot {
  pageId: string;
  notebookTitle?: string;
  /** Titre (ou premiere ligne) de la page qui cite. */
  title: string;
  /** Libelles des liens de cette page vers la cible, sans doublon. */
  labels: string[];
}

/**
 * Pages qui citent `pageId` (« Mentionné dans… »), une entrée par page, dans
 * l'ordre matiere › intercalaire › page. La page elle-meme n'est pas citee.
 */
export function backlinksTo(pageId: string, pages: readonly LinkPage[]): Backlink[] {
  const out: Backlink[] = [];
  for (const p of pages) {
    if (p.id === pageId || !p.links?.length) continue;
    const labels: string[] = [];
    for (const l of p.links) {
      if (l.pageId !== pageId) continue;
      const label = linkLabel(l);
      if (!labels.includes(label)) labels.push(label);
    }
    if (!labels.length) continue;
    out.push({
      notebook: p.notebook, divider: p.divider, number: p.number, pageId: p.id,
      ...(p.notebookTitle ? { notebookTitle: p.notebookTitle } : {}),
      title: p.title || p.firstLine || "", labels,
    });
  }
  return out.sort((a, b) => a.notebook.localeCompare(b.notebook) || a.divider.localeCompare(b.divider) || a.number - b.number);
}

/* ---------------- recherche floue ---------------- */

/**
 * Score d'un mot plie dans un texte plie : sous-chaine (mieux en debut de
 * mot, mieux tot), sinon lettres dans l'ordre (« thvn » trouve
 * « thevenin »), sinon null.
 */
function wordScore(w: string, t: string): number | null {
  const i = t.indexOf(w);
  if (i >= 0) {
    const atWord = i === 0 || !/[a-z0-9]/.test(t[i - 1]);
    return 100 + w.length * 4 + (atWord ? 40 : 0) + (i === 0 ? 20 : 0) - Math.min(i, 30) / 3;
  }
  // Lettres dans l'ordre : moins on saute, mieux c'est.
  let at = -1, gaps = 0, first = -1;
  for (const c of w) {
    const j = t.indexOf(c, at + 1);
    if (j < 0) return null;
    if (first < 0) first = j;
    else gaps += j - at - 1;
    at = j;
  }
  if (gaps > w.length * 3) return null;
  return Math.max(1, 40 + w.length * 2 - gaps * 3 - Math.min(first, 30) / 3);
}

/**
 * Score flou d'une requete dans un texte (plus grand = meilleur), null si
 * un mot de la requete n'y est pas. Casse, accents et grec plies comme la
 * recherche (core/text/find.ts).
 */
export function fuzzyScore(query: string, text: string): number | null {
  const words = normalize(query).split(" ").filter(Boolean);
  const t = fold(text).text;
  let total = 0;
  for (const w of words) {
    const s = wordScore(w, t);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** Choix proposes par le selecteur `[[` : une page, un titre, une formule, une zone. */
export interface LinkCandidate {
  kind: "page" | "heading" | "math" | "zone";
  /** Texte montre, et libelle du lien pose. */
  label: string;
  ref: LinkRef;
  spot: PageSpot;
  notebookTitle: string;
  modified?: string;
  /** Page sans titre # : son libelle est sa premiere ligne, elle passe apres les pages titrees. */
  untitled?: boolean;
}

const KIND_RANK: Record<LinkCandidate["kind"], number> = { page: 0, heading: 1, math: 2, zone: 3 };
/** Libelle d'un choix : coupe sur un mot. */
const LABEL_MAX = 80;

function shortLabel(s: string): string {
  const l = s.replace(/\s+/g, " ").trim();
  if (l.length <= LABEL_MAX) return l;
  const cut = l.slice(0, LABEL_MAX);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > LABEL_MAX * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * Tous les choix d'un scan : chaque page (son titre ou sa premiere ligne),
 * ses titres # (hors celui qui sert deja de titre), ses formules et zones.
 */
export function linkCandidates(pages: readonly LinkPage[]): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  for (const p of pages) {
    if (!p.id) continue;
    const spot: PageSpot = { notebook: p.notebook, divider: p.divider, number: p.number };
    const path = pagePathOf(spot);
    const base = { spot, notebookTitle: p.notebookTitle ?? p.notebook, ...(p.modified ? { modified: p.modified } : {}) };
    const title = shortLabel(p.title || p.firstLine || "");
    out.push({
      kind: "page", label: title || `${p.divider.split("/").pop()} p. ${p.number}`, ref: { pageId: p.id, path }, ...base,
      ...(p.title ? {} : { untitled: true }),
    });
    const seen = new Set<string>([normalize(p.title ?? "")]);
    for (const h of p.headings ?? []) {
      const key = normalize(h);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "heading", label: shortLabel(h), ref: { pageId: p.id, heading: h, path }, ...base });
    }
    for (const a of p.anchors ?? []) {
      if (!a.text.trim()) continue;
      out.push({ kind: a.kind, label: shortLabel(a.text), ref: { pageId: p.id, blockId: a.blockId, path }, ...base });
    }
  }
  return out;
}

/** Ou se trouve un choix, en clair : « Élec › Cours p. 3 ». */
export function candidateWhere(c: LinkCandidate): string {
  return `${c.notebookTitle} › ${c.spot.divider.split("/").join(" › ")} p. ${c.spot.number}`;
}

/**
 * Choix classes pour une requete. Chaque mot doit se trouver dans le
 * libelle ou dans la matiere/l'intercalaire (qui compte moins : « elec
 * thev » trouve le theoreme de Thevenin du cahier d'Elec). Requete vide : les
 * pages les plus recentes. A score egal : page avant titre avant formule,
 * puis libelle le plus court.
 */
export function rankCandidates(query: string, all: readonly LinkCandidate[], limit = 30): LinkCandidate[] {
  const words = normalize(query).split(" ").filter(Boolean);
  if (!words.length) {
    return all.filter((c) => c.kind === "page")
      .slice().sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
      .slice(0, limit);
  }
  const scored: { c: LinkCandidate; s: number }[] = [];
  for (const c of all) {
    const label = fold(c.label).text;
    const where = fold(`${c.notebookTitle} ${c.spot.notebook} ${c.spot.divider}`).text;
    let total = 0, inLabel = 0;
    let ok = true;
    for (const w of words) {
      const a = wordScore(w, label);
      const b = wordScore(w, where);
      if (a === null && b === null) { ok = false; break; }
      if (a !== null && a >= (b ?? 0) * 0.6) { total += a; inLabel++; } else total += (b ?? 0) * 0.6;
    }
    // Au moins un mot dans le libelle : sinon toutes les pages d'Elec sortiraient pour « elec ».
    if (!ok || (!inLabel && words.length > 0 && c.kind !== "page")) continue;
    scored.push({ c, s: total - KIND_RANK[c.kind] * 2 - (c.untitled ? 20 : 0) });
  }
  scored.sort((x, y) => y.s - x.s || KIND_RANK[x.c.kind] - KIND_RANK[y.c.kind] || x.c.label.length - y.c.label.length);
  return scored.slice(0, limit).map((x) => x.c);
}
