/**
 * Historique des versions d'une page et purge de la corbeille. Logique pure :
 * noms de fichiers, rythme des instantanes, plan de retention. Le disque est
 * dans storage/repo.ts.
 *
 * Avant d'ecraser une page, Repo garde l'ancienne version dans
 *   <matiere>/.versions/<id de page>/<horodatage>.json
 * au plus une toutes les 10 minutes par page. Le point cache le dossier du
 * menu et des intercalaires ; le nom par id suit la page a travers les
 * renumerotations et les deplacements.
 */

export const VERSIONS_DIR = ".versions";
/** Au plus un instantane par page toutes les 10 minutes. */
export const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
/** Au-dela, une version ou une suppression part (jamais avant). */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Dernieres 24 h : toutes les versions sont gardees. */
export const KEEP_ALL_MS = 24 * 60 * 60 * 1000;

const p2 = (n: number, w = 2) => String(n).padStart(w, "0");

/** Horodatage lisible et triable (heure locale) : 2026-10-13_14-03-22-123. */
export function stampOf(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_`
    + `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}-${p2(d.getMilliseconds(), 3)}`;
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})(?:-\d+)?$/;

/** Date (ms) d'un horodatage stampOf (suffixe « -2 » accepte), ou null. */
export function parseStamp(name: string): number | null {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s, ms);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return null;
  return t.getTime();
}

/** Nom du fichier d'une version. */
export function versionFileName(d: Date): string {
  return `${stampOf(d)}.json`;
}

/** Date (ms) d'un fichier de version, ou null si ce n'en est pas un. */
export function parseVersionName(file: string): number | null {
  if (!file.endsWith(".json")) return null;
  return parseStamp(file.slice(0, -5));
}

/** Faut-il un nouvel instantane (le dernier date de plus de 10 min) ? */
export function shouldSnapshot(last: number | null, now: number): boolean {
  return last == null || now - last >= SNAPSHOT_EVERY_MS || now < last;
}

/** Jour local (AAAA-MM-JJ) d'une date. */
function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * Versions a retirer, parmi les dates `times` (ms) :
 *  - dernieres 24 h : toutes gardees ;
 *  - de 1 a 30 jours : la plus recente de chaque jour gardee (au moins une
 *    par jour), les autres retirees ;
 *  - plus de 30 jours : retirees ;
 *  - la plus recente de toutes est toujours gardee, quel que soit son age.
 * Une date dans le futur (horloge de l'autre PC en avance) est gardee.
 */
export function planVersionPurge(times: readonly number[], now: number): number[] {
  if (!times.length) return [];
  const newest = Math.max(...times);
  const bestOfDay = new Map<string, number>();
  for (const t of times) {
    const age = now - t;
    if (age <= KEEP_ALL_MS || age > KEEP_MS) continue;
    const k = dayKey(t);
    if ((bestOfDay.get(k) ?? -Infinity) < t) bestOfDay.set(k, t);
  }
  const drop: number[] = [];
  for (const t of times) {
    if (t === newest) continue;
    const age = now - t;
    if (age <= KEEP_ALL_MS) continue;
    if (age > KEEP_MS) { drop.push(t); continue; }
    if (bestOfDay.get(dayKey(t)) !== t) drop.push(t);
  }
  return drop;
}

/**
 * Dossiers de corbeille (`ESEO/.corbeille/<horodatage>`) a purger : plus
 * de 30 jours, jamais un nom qu'on ne sait pas dater, jamais avant.
 */
export function trashToPurge(names: readonly string[], now: number): string[] {
  return names.filter((n) => {
    const t = parseStamp(n);
    return t != null && now - t > KEEP_MS;
  });
}

/** « 13 oct. 2026 à 14:03 » : libelle d'une version dans la liste. */
export function versionLabel(t: number, now: number): string {
  const d = new Date(t);
  const months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const today = dayKey(now) === dayKey(t);
  const yesterday = dayKey(now - 86_400_000) === dayKey(t);
  if (today) return `Aujourd'hui à ${time}`;
  if (yesterday) return `Hier à ${time}`;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} à ${time}`;
}
