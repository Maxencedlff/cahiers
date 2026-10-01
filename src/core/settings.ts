import type { ColorKey, InkColor, ToolKind } from "./types";

/**
 * Reglages locaux a la machine. Ils ne vont JAMAIS dans le dossier
 * synchronise : un choix d'outil n'a aucune raison de traverser OneDrive
 * et de provoquer des conflits.
 */
export interface Settings {
  tool: ToolKind | "region" | "textregion";
  /** Couleur de l'encre ; "normal" (noir) par defaut, comme le texte tape. */
  color: InkColor;
  width: number;
  /** Convertir l'ecriture au fil de la plume plutot qu'a la demande. */
  autoConvert: boolean;
  /** Couleur du texte tape, null = noir. Toujours alignee sur l'encre. */
  textColor: ColorKey | null;
  /**
   * Un stylet a deja ete vu sur cette machine : le doigt navigue des le
   * lancement, sans attendre que le stylet touche l'ecran.
   */
  penSeen: boolean;
  /** Calculatrice ouverte dans la colonne de droite. */
  calcOpen: boolean;
  /** Formules tapees au clavier mises en forme a chaque retour a la ligne. */
  autoMath: boolean;
  /** Correcteur orthographique du navigateur sur le texte tape (coupe par defaut). */
  spellcheck: boolean;
  myscript: { applicationKey: string; hmacKey: string };
}

const KEY = "cahiers.settings.v1";

const DEFAULTS: Settings = {
  tool: "pen",
  color: "normal",
  width: 2.2,
  autoConvert: false,
  calcOpen: true,
  autoMath: true,
  spellcheck: false,
  textColor: null,
  penSeen: false,
  myscript: { applicationKey: "", hmacKey: "" },
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const out: Settings = {
      ...DEFAULTS,
      ...parsed,
      myscript: { ...DEFAULTS.myscript, ...(parsed.myscript ?? {}) },
    };
    // Une seule couleur active, pour l'encre comme pour le texte. Les anciens
    // reglages gardaient l'encre en « Definition » sous un texte noir : deux
    // pastilles allumees. L'encre suit desormais le texte (noir = "normal").
    out.color = out.textColor ?? "normal";
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}
