import type { ColorKey, InkColor, ToolKind } from "./types";
import { isSheetPref, isThemePref, type SheetPref, type ThemePref } from "./theme";

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
   * Option « Écrire au doigt (sans stylet) ». Par defaut le doigt navigue
   * et le stylet ecrit (section 3) ; l'ancien `penSeen` n'est plus lu.
   */
  touchWrites: boolean;
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
  /** Teinte de la feuille ; « auto » (defaut) = sombre en theme sombre. */
  sheet: SheetPref;
  /** Barre laterale ouverte (grand ecran ; en surimpression elle se referme seule). */
  sidebar: boolean;
  /** Calculatrice detachee : fenetre flottante au lieu du panneau de droite. */
  calcDetached: boolean;
  /**
   * Version de la disposition. Passee a 2 quand la calculatrice est devenue
   * fermee par defaut (D6) : l'ancien defaut « ouverte » est remis a fermee
   * une fois, puis le choix de l'utilisateur est respecte. 3 : feuille
   * « claire » (ancien defaut) passee en « auto ».
   */
  layout: number;
  /** Formules tapees au clavier mises en forme a chaque retour a la ligne. */
  autoMath: boolean;
  /** Correcteur orthographique du navigateur sur le texte tape (coupe par defaut). */
  spellcheck: boolean;
  /** Bulle d'aide aux raccourcis (« ome » → ω, Tab l'accepte) ; activee par defaut. */
  shortcutHints: boolean;
  myscript: { applicationKey: string; hmacKey: string };
}

const KEY = "cahiers.settings.v1";
const LAYOUT = 3;

const DEFAULTS: Settings = {
  tool: "pen",
  color: "normal",
  width: 2.2,
  eraserMode: "stroke",
  autoConvert: false,
  calcOpen: false,
  mathPinned: false,
  theme: "system",
  sheet: "auto",
  sidebar: true,
  calcDetached: false,
  layout: LAYOUT,
  autoMath: true,
  spellcheck: false,
  shortcutHints: true,
  textColor: null,
  touchWrites: false,
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
    if (!isSheetPref(out.sheet)) out.sheet = DEFAULTS.sheet;
    out.sidebar = out.sidebar !== false;
    out.calcDetached = out.calcDetached === true;
    out.mathPinned = out.mathPinned === true;
    out.touchWrites = out.touchWrites === true;
    out.shortcutHints = out.shortcutHints !== false;
    // Ancienne detection du stylet (Ctrl+D l'oubliait) : retiree.
    delete (out as Partial<Settings> & { penSeen?: unknown }).penSeen;
    // Ancien ruban « deplie dans la colonne » : remplace par le volet epinglable.
    delete (out as Partial<Settings> & { mathOpen?: unknown }).mathOpen;
    // Calculatrice ouverte par l'ancien defaut : la feuille perdait 340 px
    // sur le portable. Fermee une fois ; Ctrl+L la rouvre et c'est retenu.
    if ((parsed.layout ?? 1) < 2) out.calcOpen = false;
    // Disposition 3 (refonte de l'interface) : la feuille « claire » etait
    // l'ancien defaut, pas un choix ; elle passe en Auto (sombre en theme sombre).
    if ((parsed.layout ?? 1) < 3 && out.sheet === "light") out.sheet = "auto";
    out.layout = LAYOUT;
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}
