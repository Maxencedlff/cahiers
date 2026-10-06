import { colorOf } from "./palette";
import type { InkColor } from "./types";

/**
 * Apparence (logique pure). Le chrome (barres, rail, menus) suit le theme
 * choisi ; la feuille a son propre reglage, claire par defaut meme en
 * sombre. Rien de tout cela ne touche aux donnees : l'encre « Normal »
 * rendue claire sur une feuille sombre l'est a l'affichage seulement,
 * jamais dans les fichiers ni a l'export PDF/Word.
 */

export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";
export type SheetTone = "light" | "sepia" | "dark";

export const THEME_PREFS: readonly { pref: ThemePref; label: string }[] = [
  { pref: "light", label: "Clair" },
  { pref: "dark", label: "Sombre" },
  { pref: "system", label: "Système" },
];

export const SHEET_TONES: readonly { tone: SheetTone; label: string; title: string }[] = [
  { tone: "light", label: "Claire", title: "Feuille blanche, comme imprimée" },
  { tone: "sepia", label: "Sépia", title: "Feuille crème, plus douce le soir ; l'encre ne change pas" },
  { tone: "dark", label: "Sombre", title: "Feuille sombre : l'encre noire est montrée claire (affichage seulement, jamais à l'export)" },
];

/** Theme reellement applique : « Systeme » suit Windows. */
export function effectiveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** Raccourci : Clair → Sombre → Systeme → Clair. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === "light" ? "dark" : pref === "dark" ? "system" : "light";
}

export function isThemePref(v: unknown): v is ThemePref {
  return v === "light" || v === "dark" || v === "system";
}

export function isSheetTone(v: unknown): v is SheetTone {
  return v === "light" || v === "sepia" || v === "dark";
}

/**
 * Encre a l'affichage sur une feuille sombre. Le noir « Normal » devient
 * clair ; les couleurs semantiques gardent leur teinte, eclaircie pour
 * rester lisibles (contraste suffisant sur le fond sombre). La couleur
 * stockee ne change jamais.
 */
const DARK_SHEET_INK: Record<string, { ink: string; wash: string }> = {
  normal: { ink: "#e4e6eb", wash: "#6b7280" },
  definition: { ink: "#6ea8ff", wash: "#1e4fa8" },
  theoreme: { ink: "#ff7b7b", wash: "#9b2c2c" },
  exemple: { ink: "#3ddc97", wash: "#11684a" },
  attention: { ink: "#fbbf24", wash: "#8a5a06" },
  perso: { ink: "#b69cff", wash: "#5b3aa8" },
};

/** Couleur d'un trait a l'ecran, selon la feuille. */
export function inkDisplayColor(key: InkColor, tool: "pen" | "highlighter", tone: SheetTone): string {
  if (tone !== "dark") return colorOf(key, tool);
  const e = DARK_SHEET_INK[key] ?? DARK_SHEET_INK.normal;
  return tool === "highlighter" ? e.wash : e.ink;
}

/**
 * Couleur CSS d'un texte ou d'un mot converti : une variable que la feuille
 * sombre redefinit (style.css, `.app[data-sheet="dark"]`), avec la couleur
 * stockee en repli. Hors de l'appli (export PDF), seul le repli existe.
 */
export function inkCssColor(key: InkColor): string {
  const k = DARK_SHEET_INK[key] ? key : "normal";
  return `var(--ink-${k}, ${colorOf(k)})`;
}

/** Valeurs de la feuille sombre, pour verifier que style.css les reprend. */
export const DARK_SHEET_INKS: Readonly<Record<string, { ink: string; wash: string }>> = DARK_SHEET_INK;

/* ---------------- contraste (WCAG) ---------------- */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminance relative d'une couleur « #rrggbb ». */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`couleur illisible : ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => channel(parseInt(h, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rapport de contraste WCAG entre deux couleurs (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
