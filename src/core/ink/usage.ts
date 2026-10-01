/**
 * Compteur mensuel des envois a MyScript (reco-3). Le compte developpeur a
 * un quota par mois : sans compteur, il se decouvrait epuise en plein cours,
 * par des erreurs. Logique pure ; l'appli garde l'etat dans le stockage
 * local de la machine (jamais dans le dossier synchronise).
 *
 * Le compte est par machine : le PC fixe consomme le meme quota sans que le
 * portable le voie. L'alerte a 80 % laisse cette marge.
 */

/** Quota mensuel du compte gratuit, a ajuster si le compte change. */
export const MONTHLY_QUOTA = 2000;
/** Part du quota a partir de laquelle on previent, une fois par mois. */
export const WARN_RATIO = 0.8;

export interface Usage {
  /** Mois compte, « 2026-10 ». */
  month: string;
  count: number;
  /** L'alerte des 80 % a deja ete montree ce mois-ci. */
  warned?: boolean;
}

export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Usage du mois en cours : un nouveau mois repart de zero. */
export function currentUsage(u: Usage | null | undefined, now: Date): Usage {
  const month = monthOf(now);
  return u && u.month === month && Number.isFinite(u.count) ? u : { month, count: 0 };
}

/** Un envoi de plus. */
export function bumpUsage(u: Usage | null | undefined, now: Date): Usage {
  const cur = currentUsage(u, now);
  return { ...cur, count: cur.count + 1 };
}

/** Faut-il prevenir maintenant ? Vrai une seule fois par mois. */
export function shouldWarn(u: Usage, quota = MONTHLY_QUOTA): boolean {
  return !u.warned && u.count >= Math.ceil(quota * WARN_RATIO);
}

/** Libelle court pour la barre d'etat : « 312 / 2 000 ce mois ». */
export function usageLabel(u: Usage, quota = MONTHLY_QUOTA): string {
  const fmt = (n: number) => n.toLocaleString("fr-FR").replace(/ | /g, " ");
  return `${fmt(u.count)} / ${fmt(quota)} ce mois`;
}
