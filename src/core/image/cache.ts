/**
 * Cache des data URL d'images lues sur le disque (lot 10, ocr-thread-principal).
 *
 * Chaque rendu de page relisait chaque photo en base64 par IPC : une page
 * avec trois photos, c'etait trois fichiers relus a chaque changement de
 * page ou d'affichage. Le cache garde les dernieres lues, borne en taille
 * (une photo couleur fait 300 Ko a 1 Mo en base64).
 *
 * Cle = chemin relatif a la racine. Une ecriture remplace l'entree ; une
 * suppression ou un renommage oublie le chemin et tout ce qui est dessous.
 */
export class DataUrlCache {
  private map = new Map<string, string>();
  private size = 0;

  /** `budget` en caracteres (1 caractere de base64 = 1 octet en memoire JS latin-1). */
  constructor(private budget = 48 * 1024 * 1024) {}

  get(rel: string): string | undefined {
    const v = this.map.get(rel);
    if (v === undefined) return undefined;
    // Plus recent en fin de Map : l'ordre d'insertion sert de file LRU.
    this.map.delete(rel);
    this.map.set(rel, v);
    return v;
  }

  set(rel: string, dataUrl: string): void {
    this.delete(rel);
    // Une image plus grosse que tout le budget n'est pas gardee.
    if (dataUrl.length > this.budget) return;
    this.map.set(rel, dataUrl);
    this.size += dataUrl.length;
    for (const [k, v] of this.map) {
      if (this.size <= this.budget) break;
      this.map.delete(k);
      this.size -= v.length;
    }
  }

  delete(rel: string): void {
    const v = this.map.get(rel);
    if (v === undefined) return;
    this.map.delete(rel);
    this.size -= v.length;
  }

  /** Oublie `rel` et tout chemin sous `rel/` (dossier supprime ou renomme). */
  forget(rel: string): void {
    for (const k of [...this.map.keys()]) {
      if (k === rel || k.startsWith(rel + "/")) this.delete(k);
    }
  }

  get bytes(): number { return this.size; }
  get count(): number { return this.map.size; }
}
