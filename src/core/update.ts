/**
 * Mises a jour de l'appli : logique pure (le DOM et le plugin Tauri sont
 * dans ui/updater.ts). Le plugin compare deja les versions et verifie la
 * signature ; ici, ce qu'on affiche et quand on a le droit de le montrer.
 */

/** Premiere verification, apres le lancement : jamais pendant le demarrage. */
export const CHECK_DELAY_MS = 5000;

/** Le bandeau attend ce silence du clavier : il n'arrive jamais en pleine frappe. */
export const TYPING_QUIET_MS = 4000;

/** Le bandeau reste longtemps : on finit sa phrase, on clique quand on veut. */
export const OFFER_MS = 30 * 60 * 1000;

/** « 0.2.0 » → [0, 2, 0] ; suffixe (-beta) ignore, morceau illisible = 0. */
function parts(v: string): number[] {
  return v.trim().replace(/^v/i, "").split(/[-+]/)[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
}

/** Vrai si `remote` est plus recente que `current` (0.10.0 > 0.9.3). */
export function isNewer(remote: string, current: string): boolean {
  const a = parts(remote);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** Version telle qu'on la lit : « 0.3.0 » → « 0.3 », « 0.2.1 » reste. */
export function shortVersion(v: string): string {
  const p = v.trim().replace(/^v/i, "").split(/[-+]/)[0].split(".");
  while (p.length > 2 && p[p.length - 1] === "0") p.pop();
  return p.join(".");
}

/** Texte du bandeau : « Cahiers 0.3 disponible ». */
export function offerText(version: string): string {
  return `Cahiers ${shortVersion(version)} disponible`;
}

/** Taille lisible : « 850 Ko », « 12,4 Mo ». */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

/**
 * Progression du telechargement : pourcentage si la taille est connue,
 * sinon ce qui est deja arrive.
 */
export function progressText(version: string, done: number, total?: number): string {
  const head = `Téléchargement de Cahiers ${shortVersion(version)}…`;
  if (total && total > 0) return `${head} ${Math.min(100, Math.floor((done / total) * 100))} %`;
  return done > 0 ? `${head} ${sizeText(done)}` : head;
}

/** Palier de 5 % : le message n'est redessine qu'a chaque palier. */
export function progressStep(done: number, total?: number): number {
  if (!total || total <= 0) return Math.floor(done / (1024 * 1024));
  return Math.floor(Math.min(1, done / total) * 20);
}

/** On peut montrer le bandeau : aucune touche depuis TYPING_QUIET_MS. */
export function quietEnough(lastKeyAt: number, now: number): boolean {
  return now - lastKeyAt >= TYPING_QUIET_MS;
}
