import type { ColorKey, InkColor, ToolKind } from "./types";
import { isSheetTone, isThemePref, type SheetTone, type ThemePref } from "./theme";

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
  /** Gomme au trait entier ou precise (encre-14 : coupe le trait). */
  eraserMode: "stroke" | "precise";
  /** Convertir l'ecriture au fil de la plume plutot qu'a la demande. */
  autoConvert: boolean;
  /** Couleur du texte tape, null = noir. Toujours alignee sur l'encre. */
  textColor: ColorKey | null;
  /**
   * Un stylet a deja ete vu sur cette machine : le doigt navigue des le
   * lancement, sans attendre que le stylet touche l'ecran.
   */
  penSeen: boolean;
  /** Calculatrice ouverte (colonne de droite, ou flottante sur un petit ecran). */
  calcOpen: boolean;
  /**
   * Ruban Maths epingle : il reste ouvert (colonne a cote du rail sur un
   * ecran d'au moins 1600 px, sinon volet flottant). Non epingle, il
   * s'ouvre en volet d'un appui et se referme seul.
   */
  mathPinned: boolean;
  /** Theme du chrome : clair, sombre ou celui de Windows. */
  theme: ThemePref;
  /** Teinte de la feuille, independante du theme (claire par defaut). */
  sheet: SheetTone;
  /**
   * Version de la disposition. Passee a 2 quand la calculatrice est devenue
   * fermee par defaut (D6) : l'ancien defaut « ouverte » est remis a fermee
   * une fois, puis le choix de l'utilisateur est respecte.
   */
  layout: number;
  /** Formules tapees au clavier mises en forme a chaque retour a la ligne. */
  autoMath: boolean;
  /** Correcteur orthographique du navigateur sur le texte tape (coupe par defaut). */
  spellcheck: boolean;
  myscript: { applicationKey: string; hmacKey: string };
}

const KEY = "cahiers.settings.v1";
const LAYOUT = 2;

const DEFAULTS: Settings = {
  tool: "pen",
  color: "normal",
  width: 2.2,
  eraserMode: "stroke",
  autoConvert: false,
  calcOpen: false,
  mathPinned: false,
  theme: "system",
  sheet: "light",
  layout: LAYOUT,
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
    if (!isThemePref(out.theme)) out.theme = DEFAULTS.theme;
    if (!isSheetTone(out.sheet)) out.sheet = DEFAULTS.sheet;
    out.mathPinned = out.mathPinned === true;
    // Ancien ruban « deplie dans la colonne » : remplace par le volet epinglable.
    delete (out as Partial<Settings> & { mathOpen?: unknown }).mathOpen;
    // Calculatrice ouverte par l'ancien defaut : la feuille perdait 340 px
    // sur le portable. Fermee une fois ; Ctrl+L la rouvre et c'est retenu.
    if ((parsed.layout ?? 1) < LAYOUT) {
      out.calcOpen = false;
      out.layout = LAYOUT;
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}
