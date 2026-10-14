/**
 * Fusion a trois du texte tape d'une page (deux PC, ou OneDrive) : la
 * version lue (base), la notre, celle du disque. Ligne par ligne, comme
 * git : chaque cote remplace des morceaux de la base. Des morceaux qui ne
 * se chevauchent pas se combinent ; deux ajouts au meme endroit sont gardes
 * tous les deux (le notre d'abord) ; deux modifications differentes des
 * memes lignes ne se fusionnent pas (null : copie de conflit, comme avant).
 * Logique pure, sans DOM.
 */

/** Morceau de la base [start, end) remplace par `lines` (start = end : ajout). */
export interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** Au-dela, pas de fusion (tableau n x m) : copie de conflit. */
const MAX_LINES = 3000;

/** Morceaux de `base` changes pour donner `next` (plus longue sous-suite commune). */
export function diffLines(base: readonly string[], next: readonly string[]): Hunk[] {
  const n = base.length, m = next.length;
  // Prefixe et suffixe communs : le gros des pages, sans tableau.
  let pre = 0;
  while (pre < n && pre < m && base[pre] === next[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && base[n - 1 - suf] === next[m - 1 - suf]) suf++;
  const a = base.slice(pre, n - suf), b = next.slice(pre, m - suf);
  const A = a.length, B = b.length;
  // lcs[i][j] = longueur commune de a[i..] et b[j..].
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= A; i++) lcs.push(new Uint32Array(B + 1));
  for (let i = A - 1; i >= 0; i--) {
    for (let j = B - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Hunk[] = [];
  let i = 0, j = 0;
  let cur: Hunk | null = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < A || j < B) {
    if (i < A && j < B && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { start: pre + i, end: pre + i, lines: [] };
    if (j < B && (i >= A || lcs[i][j + 1] >= lcs[i + 1][j])) { cur.lines.push(b[j]); j++; }
    else { i++; cur.end = pre + i; }
  }
  flush();
  return out;
}

const sameHunk = (x: Hunk, y: Hunk) =>
  x.start === y.start && x.end === y.end && x.lines.length === y.lines.length && x.lines.every((l, k) => l === y.lines[k]);

/**
 * Texte fusionne, ou null si les deux cotes ont change differemment les
 * memes lignes. Un cote inchange rend l'autre tel quel. `theirsAddOnly` :
 * leur cote ne peut qu'ajouter des lignes (ou retirer des lignes vides).
 */
export function merge3(base: string, ours: string, theirs: string, o: { theirsAddOnly?: boolean } = {}): string | null {
  if (ours === theirs || theirs === base) return ours;
  const b = base.split("\n"), t = theirs.split("\n");
  if (Math.max(b.length, t.length) > MAX_LINES) return null;
  const ht = diffLines(b, t);
  // Leur cote ne fait qu'ajouter : une ligne non vide qu'il retire ou
  // change (version plus ancienne remise par OneDrive ?) ne disparait
  // jamais sans trace, c'est une copie de conflit.
  if (o.theirsAddOnly && ht.some((h) => b.slice(h.start, h.end).some((l) => l.trim()))) return null;
  if (ours === base) return theirs;
  const ou = ours.split("\n");
  if (ou.length > MAX_LINES) return null;
  const ho = diffLines(b, ou);
  const all = [...ho.map((h) => ({ h, ours: true })), ...ht.map((h) => ({ h, ours: false }))];
  // Par debut, le notre d'abord a debut egal.
  all.sort((x, y) => x.h.start - y.h.start || (x.ours === y.ours ? 0 : x.ours ? -1 : 1));
  const keep: Hunk[] = [];
  next: for (const { h } of all) {
    for (let k = 0; k < keep.length; k++) {
      const prev = keep[k];
      if (sameHunk(prev, h)) continue next;
      if (prev.start === prev.end && h.start === h.end && prev.start === h.start) {
        // Deux ajouts au meme endroit : les deux, le notre d'abord.
        keep[k] = { ...prev, lines: [...prev.lines, ...h.lines] };
        continue next;
      }
      const overlap = Math.max(prev.start, h.start) < Math.min(prev.end, h.end);
      // Meme debut (un ajout juste avant une ligne que l'autre change) : ambigu.
      const sameStart = prev.start === h.start;
      // Ajout a l'interieur d'un morceau change de l'autre cote.
      const inside = (h.start === h.end && h.start > prev.start && h.start < prev.end)
        || (prev.start === prev.end && prev.start > h.start && prev.start < h.end);
      if (overlap || sameStart || inside) return null;
    }
    keep.push(h);
  }
  keep.sort((x, y) => x.start - y.start);
  const out: string[] = [];
  let at = 0;
  for (const h of keep) {
    out.push(...b.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...b.slice(at));
  return out.join("\n");
}
