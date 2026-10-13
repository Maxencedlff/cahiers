/**
 * Indicateur d'etat compact (logique pure). Un point vert quand tout va
 * bien ; orange ou rouge avec un texte court seulement s'il y a un
 * probleme. Le detail complet (reseau, conversion, enregistrement, stylet,
 * quota, dossier) va dans le volet ouvert au survol ou a l'appui.
 */

export type StatusLevel = "ok" | "warn" | "err";

export interface StatusInput {
  online: boolean;
  /** Reconnaissance configuree (cles MyScript). */
  backendReady: boolean;
  /** Conversions en attente dans la file. */
  pending: number;
  /** File arretee : cles refusees (401/403). */
  keysBlocked: boolean;
  /** Derniere erreur de la reconnaissance, si elle en a une. */
  lastError: string | null;
  /** Une ecriture attend le disque. */
  saving: boolean;
  /** Ecriture refusee par le disque (message), sinon null. */
  saveError: string | null;
  /** Le cahier vise est ouvert en lecture seule (autre PC). */
  readOnly: boolean;
  /** Envois a MyScript ce mois-ci et quota mensuel. */
  usage: number;
  quota: number;
  /** Option « Écrire au doigt (sans stylet) ». */
  touchWrites: boolean;
}

export interface StatusLine {
  level: StatusLevel;
  label: string;
  text: string;
}

export interface StatusSummary {
  level: StatusLevel;
  /** Texte court a cote du point ; vide quand tout va bien. */
  short: string;
  /** Phrase pour l'infobulle et le lecteur d'ecran. */
  title: string;
  lines: StatusLine[];
}

/** Part du quota a partir de laquelle on previent (reco-3 : alerte 80 %). */
export const QUOTA_WARN = 0.8;

export function statusSummary(s: StatusInput): StatusSummary {
  const lines: StatusLine[] = [];
  const problems: { level: StatusLevel; short: string }[] = [];

  // Enregistrement d'abord : c'est le seul probleme qui fait perdre des notes.
  if (s.saveError) {
    lines.push({ level: "err", label: "Enregistrement", text: `Non enregistré : ${s.saveError}` });
    problems.push({ level: "err", short: "Non enregistré" });
  } else {
    lines.push({ level: "ok", label: "Enregistrement", text: s.saving ? "Enregistrement en cours…" : "Tout est enregistré" });
  }

  if (s.readOnly) {
    lines.push({ level: "warn", label: "Cahier", text: "Lecture seule : ouvert sur l'autre PC" });
    problems.push({ level: "warn", short: "Lecture seule" });
  }

  lines.push(s.online
    ? { level: "ok", label: "Réseau", text: "En ligne" }
    : { level: "warn", label: "Réseau", text: "Hors ligne : l'écriture continue, la conversion attendra le réseau" });
  if (!s.online) problems.push({ level: "warn", short: "Hors ligne" });

  if (s.keysBlocked) {
    lines.push({ level: "err", label: "Conversion", text: s.lastError ?? "Clés MyScript refusées : la file est arrêtée" });
    problems.push({ level: "err", short: "Clés refusées" });
  } else if (!s.backendReady) {
    lines.push({
      level: "ok", label: "Conversion",
      text: s.pending ? `${s.pending} en attente, reconnaissance non configurée` : "Reconnaissance non configurée",
    });
  } else {
    lines.push({
      level: "ok", label: "Conversion",
      text: s.pending ? `${s.pending} conversion${s.pending > 1 ? "s" : ""} en attente` : "Aucune conversion en attente",
    });
    if (s.lastError) lines.push({ level: "warn", label: "Dernière erreur", text: s.lastError });
  }

  if (s.backendReady && s.quota > 0 && s.usage > 0) {
    const high = s.usage >= s.quota * QUOTA_WARN;
    lines.push({ level: high ? "warn" : "ok", label: "Quota", text: `${s.usage} / ${s.quota} envois ce mois-ci` });
    if (high) problems.push({ level: "warn", short: s.usage >= s.quota ? "Quota épuisé" : "Quota bientôt atteint" });
  }

  lines.push({
    level: "ok", label: "Saisie",
    text: s.touchWrites ? "Le doigt écrit (sans stylet)" : "Le stylet écrit, le doigt navigue",
  });

  const worst = problems.find((p) => p.level === "err") ?? problems[0];
  if (!worst) return { level: "ok", short: "", title: "Tout va bien : enregistré", lines };
  const extra = problems.length > 1 ? ` (+${problems.length - 1})` : "";
  return {
    level: worst.level,
    short: worst.short + extra,
    title: problems.map((p) => p.short).join(", "),
    lines,
  };
}
