import type { ColorKey, ToolKind } from "./types";

/**
 * Reglages locaux a la machine. Ils ne vont JAMAIS dans le dossier
 * synchronise : un choix d'outil n'a aucune raison de traverser OneDrive
 * et de provoquer des conflits.
 */
export interface Settings {
  tool: ToolKind | "region" | "textregion";
  color: ColorKey;
  width: number;
  /** Convertir l'ecriture au fil de la plume plutot qu'a la demande. */
  autoConvert: boolean;
  /** Couleur du texte tape, null = noir. L'encre garde toujours une couleur. */
  textColor: ColorKey | null;
  /** Calculatrice ouverte dans la colonne de droite. */
  calcOpen: boolean;
  /** Formules tapees au clavier mises en forme a chaque retour a la ligne. */
  autoMath: boolean;
  myscript: { applicationKey: string; hmacKey: string };
}

const KEY = "cahiers.settings.v1";

const DEFAULTS: Settings = {
  tool: "pen",
  color: "definition",
  width: 2.2,
  autoConvert: false,
  calcOpen: true,
  autoMath: true,
  textColor: null,
  myscript: { applicationKey: "", hmacKey: "" },
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULTS,
      ...parsed,
      myscript: { ...DEFAULTS.myscript, ...(parsed.myscript ?? {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}
