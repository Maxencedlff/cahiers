/**
 * Attente de la fin d'une impression (export PDF des pages, fiche de
 * revision). Sans DOM : la fenetre et `print` sont passes en parametre, ce
 * qui la rend testable.
 *
 * Pendant l'impression la vue est deplacee hors ecran (body.printing) ; elle
 * doit revenir dans TOUS les cas, sinon l'appli reste vide jusqu'au
 * rechargement. Or :
 *  - sur Mac, Tauri remplace window.print par une commande (impression
 *    native) qui rend une promesse : refusee (permission absente), elle
 *    doit sortir en erreur, pas laisser attendre pour toujours ;
 *  - rien ne garantit que WebKit emette `afterprint` pour une impression
 *    lancee par le natif.
 * D'ou la premiere de ces fins : `afterprint` ; retour du focus apres l'avoir
 * perdu pour la boite d'impression ; delai maximal. WebView2 (Windows)
 * emet `afterprint` a la fermeture de son apercu, comme avant.
 */

/** Ce qu'il faut de la fenetre : ses evenements. */
export interface PrintEvents {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Au-dela, la vue revient meme sans aucun signal. Assez long pour regler la
 * boite d'impression et choisir ou enregistrer le PDF.
 */
export const PRINT_WAIT_MAX_MS = 120_000;

/**
 * Lance `print` et attend la fin de l'impression. Rejette si `print` echoue
 * (exception ou promesse refusee) ; les ecouteurs et le delai sont toujours
 * retires.
 */
export async function printAndWait(
  win: PrintEvents, print: () => unknown, maxWaitMs = PRINT_WAIT_MAX_MS,
): Promise<void> {
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  // Le focus revient aussi a l'ouverture de certaines boites : il ne compte
  // qu'apres avoir ete perdu une fois depuis le debut de l'impression.
  let blurred = false;
  const onBlur = () => { blurred = true; };
  const onFocus = () => { if (blurred) finish(); };
  win.addEventListener("afterprint", finish);
  win.addEventListener("blur", onBlur);
  win.addEventListener("focus", onFocus);
  const timer = setTimeout(finish, maxWaitMs);
  try {
    // Promesse refusee (commande d'impression interdite) : sort aussitot.
    // Tenue (Mac : rendue des l'ouverture de la boite) : on attend la fin.
    await Promise.all([ended, Promise.resolve(print())]);
  } finally {
    clearTimeout(timer);
    win.removeEventListener("afterprint", finish);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("focus", onFocus);
  }
}
