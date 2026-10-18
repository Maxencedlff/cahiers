import type { Update } from "@tauri-apps/plugin-updater";
import {
  CHECK_DELAY_MS, OFFER_MS, isNewer, offerText, progressStep, progressText, quietEnough, shortVersion,
} from "../core/update";
import { APP_TOAST, confirmDialog, dismissToast, toast } from "./dom";

/**
 * Bouton « Mettre a jour » (Tauri updater). Seulement dans l'appli
 * installee : main.ts ne le cree pas en mode navigateur.
 *
 * - au lancement, apres CHECK_DELAY_MS, une verification silencieuse (hors
 *   ligne ou erreur : rien ne s'affiche) ;
 * - version plus recente : un message a bouton, pose seulement quand le
 *   clavier est au repos, jamais au milieu d'une frappe ; il ne prend pas
 *   le focus ;
 * - clic : telechargement avec progression, toutes les pages ecrites
 *   (comme a la fermeture), installation, relance.
 */

/**
 * Ce que l'updater demande a l'appli (App.quiesce / App.resumePresence) : tout
 * ecrire et liberer la presence avant d'installer, la reprendre si
 * l'installation echoue.
 */
export interface UpdateHost {
  /** false = une page reste refusee, rien n'est libere ; `force` libere quand meme. */
  quiesce(force?: boolean): Promise<boolean>;
  resumePresence(): Promise<void>;
  readonly unsavedError: string | null;
}

const OFFER_KEY = `${APP_TOAST}update`;
const PROGRESS_KEY = `${APP_TOAST}update-progress`;

export class Updater {
  private lastKeyAt = 0;
  private pending: Update | null = null;
  private busy = false;
  private checking = false;
  private current = "";

  constructor(private host: UpdateHost) {
    // Seulement l'heure de la derniere touche : jamais la touche elle-meme.
    window.addEventListener("keydown", () => { this.lastKeyAt = Date.now(); }, { capture: true, passive: true });
  }

  /** Version installee (« 0.2.0 »), lue une fois. */
  async version(): Promise<string> {
    if (!this.current) {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        this.current = await getVersion();
      } catch { /* version inconnue : rien a afficher */ }
    }
    return this.current;
  }

  /** Verification silencieuse quelques secondes apres le lancement. */
  checkSoon(): void {
    setTimeout(() => void this.check(false), CHECK_DELAY_MS);
  }

  /**
   * Cherche une version plus recente. `manual` (menu, Reglages) : le
   * resultat s'affiche toujours, « a jour » ou l'erreur ; sinon silence.
   */
  async check(manual: boolean): Promise<void> {
    if (this.busy || this.checking) return;
    this.checking = true;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const found = await check({ timeout: 20000 });
      // Le plugin ne rend qu'une version plus recente ; on le reverifie quand meme.
      if (found && !isNewer(found.version, found.currentVersion)) { void found.close().catch(() => undefined); return; }
      if (!found) {
        if (manual) toast(`Cahiers est à jour (version ${shortVersion(await this.version())}).`, "info", 4000, undefined, OFFER_KEY);
        return;
      }
      if (this.pending && this.pending !== found) void this.pending.close().catch(() => undefined);
      this.pending = found;
      if (manual) this.offer();
      else this.offerWhenQuiet();
    } catch (e) {
      if (manual) {
        toast("Impossible de vérifier les mises à jour (pas de connexion ?). Réessaie plus tard.", "warn", 5000, undefined, OFFER_KEY);
        console.warn("updater", e);
      }
    } finally {
      this.checking = false;
    }
  }

  /** Attend que le clavier se taise avant de poser le message. */
  private offerWhenQuiet(): void {
    const tick = () => {
      if (!this.pending || this.busy) return;
      if (quietEnough(this.lastKeyAt, Date.now())) this.offer();
      else setTimeout(tick, 1000);
    };
    tick();
  }

  private offer(): void {
    const u = this.pending;
    if (!u || this.busy) return;
    toast(offerText(u.version), "info", OFFER_MS, { label: "Mettre à jour", run: () => void this.install() }, OFFER_KEY);
  }

  /** Telecharge, ecrit toutes les pages, installe, relance. */
  async install(): Promise<void> {
    const u = this.pending;
    if (!u || this.busy) return;
    this.busy = true;
    dismissToast(OFFER_KEY);
    let total: number | undefined;
    let done = 0;
    let step = -1;
    const paint = () => {
      const s = progressStep(done, total);
      if (s === step) return;
      step = s;
      toast(progressText(u.version, done, total), "info", OFFER_MS, undefined, PROGRESS_KEY);
    };
    try {
      paint();
      await u.download((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength;
        else if (ev.event === "Progress") done += ev.data.chunkLength;
        paint();
      });
      // Comme a la fermeture : tout ce qui attend part sur le disque avant
      // que l'installateur ferme l'appli, puis la presence est liberee.
      if (!(await this.host.quiesce())) {
        const go = await confirmDialog(
          "Modifications non enregistrées",
          `Une page n'a pas pu être écrite (${this.host.unsavedError ?? "erreur inconnue"}). `
            + "Installer maintenant la ferait perdre.",
          "Installer quand même",
        );
        if (!go) {
          dismissToast(PROGRESS_KEY);
          this.busy = false;
          this.offer();
          return;
        }
        await this.host.quiesce(true);
      }
      toast(`Installation de Cahiers ${shortVersion(u.version)}…`, "info", OFFER_MS, undefined, PROGRESS_KEY);
      // Windows : l'installateur (mode passif) ferme l'appli lui-meme.
      await u.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      // L'appli reste ouverte : l'autre PC doit de nouveau voir ses cahiers pris.
      await this.host.resumePresence().catch(() => undefined);
      dismissToast(PROGRESS_KEY);
      this.busy = false;
      toast("La mise à jour n'a pas pu se faire. Les notes sont intactes ; réessaie plus tard.", "warn", 6000);
      console.warn("updater", e);
    }
  }
}
