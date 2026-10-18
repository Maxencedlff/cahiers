/**
 * Canal de distribution de l'appli : logique pure (la commande Rust
 * `distribution` le donne, platform.ts le lit une fois au demarrage).
 *
 * - « direct » : installateurs de cahiers-releases (Windows, .dmg Developer
 *   ID, Linux) ; l'appli se met a jour elle-meme (ui/updater.ts) ;
 * - « app-store » : build Mac App Store (feature Cargo `app-store`) ; c'est
 *   l'App Store qui met a jour, l'appli ne doit RIEN montrer des mises a
 *   jour (regle d'Apple : pas d'installation de code hors de l'App Store) ;
 * - « browser » : `npm run dev`, pas d'appli installee.
 */
export type Distribution = "direct" | "app-store" | "browser";

/**
 * Reponse de la commande Rust. Inconnue ou absente : « direct », le cas de
 * tous les installateurs publies jusqu'ici.
 */
export function parseDistribution(raw: unknown): Distribution {
  return raw === "app-store" ? "app-store" : "direct";
}

/** L'appli verifie et installe ses propres mises a jour (bandeau, menu ⋯, Reglages). */
export function selfUpdates(d: Distribution): boolean {
  return d === "direct";
}
