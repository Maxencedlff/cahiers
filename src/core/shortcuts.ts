import { PALETTE, NEUTRAL_INK } from "./palette";
import { MATH_TEMPLATES } from "./templates";
import { PHOTO_IMPORT_KEYS } from "./image/photo";

/**
 * Table UNIQUE des raccourcis clavier. Elle sert a la fois :
 * - a reconnaitre les raccourcis Ctrl (ctrlCommand, appele par App.onKey) ;
 * - a la fiche d'aide (F1 ou Ctrl+/) ;
 * - aux infobulles des boutons (titleOf).
 * Un raccourci ajoute ici apparait donc partout ; le README la recopie.
 */

export type Command =
  | "menu" | "search" | "calc" | "undo" | "redo" | "flag" | "convert"
  | "newPage" | "insertPage" | "goto" | "nextPage" | "prevPage" | "nextDivider" | "prevDivider"
  | "closeTab" | "nextTab" | "prevTab" | "split" | "swap" | "closeSplit"
  | "exportPage" | "exportAll" | "help" | "zoomIn" | "zoomOut" | "zoomReset"
  | "copy" | "cut" | "paste" | "sendCalc" | "newDivider" | "review" | "exportWord" | "exportWordAll" | "importPdf" | "viewMode"
  | "maths" | "theme" | "solveCalc" | "settings" | "sidebar";

export type Group = "Pendant le cours" | "Pages et intercalaires" | "Outils et couleurs" | "Formules" | "Fenêtres";

export const GROUPS: readonly Group[] = [
  "Pendant le cours", "Pages et intercalaires", "Outils et couleurs", "Formules", "Fenêtres",
];

export interface Shortcut {
  /** Touches telles qu'affichees : « Ctrl+Maj+N ». */
  keys: string;
  label: string;
  group: Group;
  /** Raccourci Ctrl reconnu par ctrlCommand : e.key en minuscules, et Maj. */
  ctrl?: { key: string; shift: boolean; command: Command };
  /** Un des raccourcis essentiels : la fiche F1 les montre d'abord. */
  essential?: boolean;
}

/** Champ minimal d'un KeyboardEvent : testable sans navigateur. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const KEY_LABELS: Record<string, string> = {
  pagedown: "Pg↓", pageup: "Pg↑", tab: "Tab", "\\": "\\", "/": "/", ",": ",",
};

function keyName(key: string): string {
  return KEY_LABELS[key] ?? key.toUpperCase();
}

function ctrl(key: string, shift: boolean, command: Command, label: string, group: Group, essential = false): Shortcut {
  return {
    keys: `Ctrl+${shift ? "Maj+" : ""}${keyName(key)}`,
    label, group, ctrl: { key, shift, command }, ...(essential ? { essential } : {}),
  };
}

/* ---------------- libelles selon la plateforme ---------------- */

/**
 * Le Mac ecrit ses raccourcis avec des symboles (⌘ ⇧ ⌥ ⌃), sans « + » ;
 * Windows et Linux en toutes lettres (« Ctrl+Maj+F »). La table garde la
 * forme Windows ; l'affichage passe par `keyLabel`.
 */
export function keyLabel(keys: string, mac: boolean = macKeys): string {
  if (!mac) return keys;
  return keys.replace(/(?<![\w])(Ctrl|Maj|Alt)\+/g, (_m, k: string) => (k === "Ctrl" ? "⌘" : k === "Maj" ? "⇧" : "⌥"));
}

/** Plateforme Apple (macOS, iPadOS) : Cmd a la place de Ctrl. */
export function isApplePlatform(ua: string, platform = ""): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform) || /Macintosh|iPhone|iPad|iPod/i.test(ua);
}

let macKeys = typeof navigator !== "undefined"
  && isApplePlatform(navigator.userAgent ?? "", (navigator as { platform?: string }).platform ?? "");

/** Force l'affichage Mac ou PC (tests, reglage). */
export function setMacKeys(mac: boolean): void { macKeys = mac; }
export function usesMacKeys(): boolean { return macKeys; }

export const SHORTCUTS: readonly Shortcut[] = [
  ctrl("f", true, "flag", "Pas compris : repère sur la page (« Annuler » dans le message)", "Pendant le cours", true),
  ctrl("z", false, "undo", "Annuler", "Pendant le cours", true),
  ctrl("y", false, "redo", "Rétablir", "Pendant le cours"),
  ctrl("z", true, "redo", "Rétablir", "Pendant le cours"),
  ctrl("l", false, "calc", "Calculatrice", "Pendant le cours", true),
  ctrl("l", true, "sendCalc", "Envoyer le dernier résultat de la calculatrice dans la page (au curseur du texte, sinon en bas)", "Pendant le cours"),
  ctrl("f", false, "search", "Rechercher dans tous les cahiers (aussi Ctrl+K)", "Pendant le cours", true),
  ctrl("k", false, "search", "Rechercher (comme Ctrl+F)", "Pendant le cours"),
  ctrl("k", true, "review", "Réviser : tous les théorèmes, définitions… d'une matière, par couleur ; export PDF", "Pendant le cours"),
  { keys: PHOTO_IMPORT_KEYS, label: "Photos du tableau : redressées, lues, posées dans le texte", group: "Pendant le cours" },
  { keys: "C", label: "Photo sélectionnée : la mettre à côté (la photo ou le texte qui suit passe à droite)", group: "Pendant le cours" },
  { keys: "← →", label: "Photo sélectionnée : la décaler (Maj : pas fin) ; bouton ⇤ : gauche, centre, droite", group: "Pendant le cours" },
  { keys: "→", label: "Formule déjà écrite proposée en grisé : Flèche droite la pose (Échap ou toute autre touche l'ignore, Ctrl+Z la retire)", group: "Pendant le cours" },
  { keys: "Suppr / Retour arrière", label: "À la fin d'une page / au début de sa suite : la suite remonte dans le blanc", group: "Pendant le cours" },
  { keys: "Ctrl+X, Ctrl+V", label: "Photo sélectionnée : la couper puis la coller sur une autre page (Ctrl+C : la copier)", group: "Pendant le cours" },
  ctrl("j", false, "solveCalc", "Résoudre la formule (ou la ligne du curseur) dans la calculatrice, avec le détail", "Pendant le cours"),
  ctrl("r", false, "convert", "Conversion de l'écriture : au fil de la plume ou sur zone", "Pendant le cours"),
  {
    keys: "Échap",
    label: "Ferme ce qui est ouvert (volet, sélection du lasso), rend le clavier de la calculatrice à la page, "
      + "quitte le texte ; un second Échap de suite : retour à l'accueil",
    group: "Pendant le cours", essential: true,
  },
  {
    keys: "# puis Espace",
    label: "En début de ligne : titre (## sous-titre, ### niveau 3) ; - puce ; 1. liste numérotée ; Tab / Maj+Tab : retrait ; Ctrl+Z rend le texte tapé",
    group: "Pendant le cours", essential: true,
  },

  ctrl("pagedown", false, "nextPage", "Page suivante (Pg↓ seul hors du texte)", "Pages et intercalaires", true),
  ctrl("pageup", false, "prevPage", "Page précédente (Pg↑ seul hors du texte)", "Pages et intercalaires"),
  ctrl("pagedown", true, "nextDivider", "Intercalaire suivant", "Pages et intercalaires"),
  ctrl("pageup", true, "prevDivider", "Intercalaire précédent", "Pages et intercalaires"),
  ctrl("n", false, "newPage", "Nouvelle page à la fin", "Pages et intercalaires", true),
  ctrl("n", true, "insertPage", "Insérer une page après la page courante", "Pages et intercalaires"),
  ctrl("t", false, "newDivider", "Nouvel intercalaire dans le cahier en vue", "Pages et intercalaires"),
  ctrl("g", false, "goto", "Liste des pages dans la barre latérale ; taper un numéro y va", "Pages et intercalaires", true),
  { keys: "Alt+←", label: "Revenir d'où l'on vient après un saut (recherche, repère, lien, liste) ; aussi le bouton retour de la souris", group: "Pages et intercalaires" },
  { keys: "Appui long", label: "Sur un intercalaire ou une page de la barre latérale (ou clic droit) : son menu ; glisser un intercalaire le déplace", group: "Pages et intercalaires" },
  ctrl("=", false, "zoomIn", "Zoom avant, jusqu'à 300 % (aussi Ctrl+molette, pinch à deux doigts)", "Pages et intercalaires"),
  ctrl("-", false, "zoomOut", "Zoom arrière, jusqu'à 50 %", "Pages et intercalaires"),
  ctrl("0", false, "zoomReset", "Zoom à 100 % (aussi un appui sur « 150 % » en bas du panneau)", "Pages et intercalaires"),
  ctrl("p", false, "exportPage", "Exporter la page en PDF (aussi : Partager)", "Pages et intercalaires"),
  ctrl("p", true, "exportAll", "Exporter tout l'intercalaire en PDF", "Pages et intercalaires"),
  ctrl("e", false, "exportWord", "Exporter la page en Word (.docx) : titres, listes, équations Word éditables, encre en images", "Pages et intercalaires"),
  ctrl("e", true, "exportWordAll", "Exporter tout l'intercalaire en Word (un saut de page entre deux pages)", "Pages et intercalaires"),
  ctrl("o", false, "importPdf", "Importer un PDF (sujet de TD, poly, datasheet) après la page courante, pour l'annoter ; aussi : déposer un .pdf sur la page", "Pages et intercalaires"),
  ctrl("d", true, "viewMode", "Affichage : une page à la fois ou toutes à la suite (défilement)", "Pages et intercalaires"),

  { keys: "Alt+E", label: "Stylo ; appui long sur le stylo de la palette : épaisseur", group: "Outils et couleurs", essential: true },
  { keys: "Alt+H", label: "Surligneur", group: "Outils et couleurs" },
  { keys: "Alt+G", label: "Gomme (le bout gomme du stylet gomme aussi) ; deux fois : trait entier ou précise", group: "Outils et couleurs" },
  { keys: "Alt+A", label: "Lasso : entourer, glisser pour déplacer, poignée d'angle pour retailler ; deux fois : insérer de l'espace", group: "Outils et couleurs" },
  { keys: "Suppr", label: "Supprimer la sélection du lasso", group: "Outils et couleurs" },
  ctrl("c", false, "copy", "Copier la sélection du lasso (hors du texte)", "Outils et couleurs"),
  ctrl("x", false, "cut", "Couper la sélection du lasso", "Outils et couleurs"),
  ctrl("v", false, "paste", "Coller l'encre copiée sur la page en vue, même dans un autre cahier", "Outils et couleurs"),
  { keys: "Alt+Z", label: "Zone math : une zone, puis retour au stylo ; deux fois = verrou", group: "Outils et couleurs" },
  { keys: "Alt+T", label: "Zone texte : une zone, puis retour au stylo ; deux fois = verrou", group: "Outils et couleurs" },
  { keys: `Alt+${NEUTRAL_INK.shortcut}`, label: `${NEUTRAL_INK.label}, en noir`, group: "Outils et couleurs" },
  ...PALETTE.map((p): Shortcut => ({
    keys: `Alt+${p.shortcut}`, label: `${p.label} (recolore la sélection du lasso)`, group: "Outils et couleurs",
    ...(p.shortcut === "1" ? { essential: true } : {}),
  })),

  { keys: "Alt+=", label: "Nouvelle formule", group: "Formules", essential: true },
  ctrl("m", true, "maths", "Formules : ouvrir ou fermer le volet des symboles (Σ)", "Formules"),
  ...MATH_TEMPLATES.filter((t) => t.key).map((t): Shortcut => ({
    keys: `Alt+${t.key!.toUpperCase()}`, label: t.title, group: "Formules",
  })),

  ctrl("m", false, "menu", "Accueil, puis retour au même endroit", "Fenêtres"),
  ctrl("s", true, "sidebar", "Barre latérale : afficher ou masquer", "Fenêtres"),
  ctrl(",", false, "settings", "Réglages", "Fenêtres"),
  { keys: "Entrée", label: "À l'accueil : reprendre ; taper filtre les matières, flèches pour choisir", group: "Fenêtres" },
  ctrl("tab", false, "nextTab", "Onglet suivant", "Fenêtres"),
  ctrl("tab", true, "prevTab", "Onglet précédent", "Fenêtres"),
  ctrl("w", false, "closeTab", "Fermer l'onglet", "Fenêtres"),
  ctrl("\\", false, "split", "Split gauche/droite (AZERTY : Ctrl+*)", "Fenêtres"),
  ctrl("x", true, "swap", "Permuter les panneaux", "Fenêtres"),
  ctrl("w", true, "closeSplit", "Fermer le panneau droit", "Fenêtres"),
  ctrl("t", true, "theme", "Thème : clair, sombre, celui du système (la feuille suit, sauf réglage)", "Fenêtres"),
  { keys: "F1", label: "Cette fiche (aussi Ctrl+/)", group: "Fenêtres", essential: true },
];

/**
 * Commande Ctrl d'une touche, ou null. AltGr arrive comme Ctrl+Alt sous
 * Windows : ces touches tapent des caracteres (\ @ [ en AZERTY), elles ne
 * declenchent jamais de commande.
 */
export function ctrlCommand(e: KeyLike): Command | null {
  if (e.key === "F1" && !e.ctrlKey && !e.altKey && !e.metaKey) return "help";
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  // « / » demande Maj en AZERTY (touche « : ») ; pave numerique aussi.
  if (k === "/") return "help";
  // Ctrl+\ est introuvable en AZERTY sans AltGr : la touche du meme
  // emplacement (« * ») fait l'affaire.
  if (!e.shiftKey && e.code === "Backslash") return "split";
  // Zoom, par emplacement autant que par caractere. AZERTY : « = » est sa
  // propre touche (Maj donne « + ») ; « - » est sur le 6 ; Ctrl+0 donne
  // e.key « à ». Pave numerique compris.
  if (k === "+" || e.code === "NumpadAdd" || (e.code === "Equal" && k !== "-")) return "zoomIn";
  if (!e.shiftKey && (k === "-" || e.code === "NumpadSubtract")) return "zoomOut";
  if (!e.shiftKey && (e.code === "Digit0" || e.code === "Numpad0" || k === "0")) return "zoomReset";
  for (const s of SHORTCUTS) {
    if (s.ctrl && s.ctrl.key === k && s.ctrl.shift === e.shiftKey) return s.ctrl.command;
  }
  return null;
}

/**
 * F5, Ctrl+R et Ctrl+Maj+R rechargent le WebView2 : l'appli repartirait de
 * zero et les dernieres frappes, pas encore ecrites, seraient perdues.
 * Ctrl+R seul est deja une commande (conversion) ; ces touches ne doivent
 * jamais arriver au WebView2, meme sous un dialogue.
 */
export function isReloadKey(e: KeyLike): boolean {
  if (e.key === "F5") return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "r";
}

/** Touches d'une commande, pour une infobulle : « Ctrl+F » (« ⌘F » sur Mac). */
export function keysOf(command: Command): string {
  return keyLabel(SHORTCUTS.find((s) => s.ctrl?.command === command)?.keys ?? "");
}

/** Infobulle complete : « Pas compris (Ctrl+Maj+F) ». */
export function titleOf(label: string, command: Command): string {
  const keys = keysOf(command);
  return keys ? `${label} (${keys})` : label;
}

/** Libelle de l'indicateur de page : « p. 4 / 12 ». */
export function pageLabel(n: number, total: number): string {
  // Intercalaire sans page (dossier range en sous-dossiers).
  if (n < 1) return "p. –";
  return total > 0 ? `p. ${n} / ${total}` : `p. ${n}`;
}

/**
 * Saisie de Ctrl+G : un numero de page existant, ou un message. Accepte
 * « 12 », « p12 », « p. 12 ».
 */
export function parsePageInput(input: string, nums: readonly number[]): { page: number } | { error: string } {
  const m = /^\s*(?:p\.?\s*)?(\d{1,5})\s*$/i.exec(input);
  if (!m) return { error: "Tape un numéro de page" };
  const n = Number(m[1]);
  if (!nums.includes(n)) {
    const last = nums.length ? nums[nums.length - 1] : 0;
    return { error: last ? `Pas de page ${n} : cet intercalaire va de 1 à ${last}` : `Pas de page ${n}` };
  }
  return { page: n };
}

/* ---------------- Echap ---------------- */

/** Ce qui est ouvert ou a le clavier au moment d'un Echap, sur l'ecran cahier. */
export interface EscapeState {
  /** L'Echap precedent etait la touche d'avant (rien entre les deux, ni touche ni appui). */
  again: boolean;
  /** Touche deja prise plus bas (formule MathLive figee, photo deselectionnee) ou composition IME. */
  handled: boolean;
  /** Fenetre de dialogue ouverte : elle prend son Echap. */
  dialog: boolean;
  /** Ruban Maths ouvert en volet par-dessus la page. */
  popover: boolean;
  /** Le clavier est dans la calculatrice (bouton, champ, recepteur arme). */
  calc: boolean;
  /** Champ de saisie hors de la page (INPUT, TEXTAREA). */
  field: boolean;
  /** Selection du lasso. */
  selection: boolean;
  /** Le clavier est dans le texte de la page. */
  inText: boolean;
}

export type EscapeAction =
  | "ignore" | "close-popover" | "release-calc" | "leave-field" | "clear-selection" | "menu" | "leave-text" | "to-text";

/**
 * Un Echap, sur l'ecran cahier. Il ferme d'abord ce qui est ouvert, rend le
 * clavier de la calculatrice a la page, sinon quitte le texte (ou y revient
 * depuis un bouton). Le menu seulement au second Echap de suite, et jamais
 * celui qui termine une saisie (formule, champ, composition).
 */
export function escapeAction(s: EscapeState): EscapeAction {
  if (s.handled || s.dialog) return "ignore";
  if (s.popover) return "close-popover";
  if (s.calc) return "release-calc";
  if (s.field) return "leave-field";
  if (s.selection) return "clear-selection";
  if (s.again) return "menu";
  return s.inText ? "leave-text" : "to-text";
}
