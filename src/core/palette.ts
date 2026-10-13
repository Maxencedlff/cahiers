import type { ColorKey, InkColor } from "./types";

/**
 * Palette FERMEE a 5 entrees, semantique fixe (section 8).
 * Pas de couleur libre : sur trois ans une palette libre devient du bruit
 * et casse le filtrage ("montre-moi tous les theoremes d'analyse").
 */
export interface PaletteEntry {
  key: ColorKey;
  label: string;
  ink: string;
  /** Version claire pour le surligneur. */
  wash: string;
  shortcut: string;
}

export const PALETTE: readonly PaletteEntry[] = [
  { key: "definition", label: "Définition", ink: "#2563eb", wash: "#93c5fd", shortcut: "1" },
  { key: "theoreme",   label: "Théorème",   ink: "#dc2626", wash: "#fca5a5", shortcut: "2" },
  { key: "exemple",    label: "Exemple",    ink: "#059669", wash: "#6ee7b7", shortcut: "3" },
  { key: "attention",  label: "Attention",  ink: "#d97706", wash: "#fcd34d", shortcut: "4" },
  { key: "perso",      label: "Remarque",   ink: "#7c3aed", wash: "#c4b5fd", shortcut: "5" },
] as const;

/**
 * Encre neutre, hors palette semantique : le texte courant. Noire au stylo,
 * grise au surligneur. Les filtres par couleur l'ignorent.
 */
export const NEUTRAL_INK = {
  key: "normal", label: "Normal", ink: "#16181d", wash: "#9ca3af", shortcut: "0",
} as const;

const BY_KEY = new Map<string, { label: string; ink: string; wash: string; shortcut: string }>(
  [...PALETTE.map((p) => [p.key, p] as const), [NEUTRAL_INK.key, NEUTRAL_INK] as const],
);

/** Couleur reelle d'un trait. Une cle inconnue retombe sur l'encre neutre. */
export function colorOf(key: InkColor, tool: "pen" | "highlighter" = "pen"): string {
  const e = BY_KEY.get(key) ?? NEUTRAL_INK;
  return tool === "highlighter" ? e.wash : e.ink;
}

export function labelOf(key: InkColor): string {
  return (BY_KEY.get(key) ?? NEUTRAL_INK).label;
}

/** Raccourci Alt+chiffre d'une couleur (0 pour l'encre neutre). */
export function shortcutOf(key: InkColor): string {
  return (BY_KEY.get(key) ?? NEUTRAL_INK).shortcut;
}

/**
 * Couleurs de matiere proposees a la creation : huit teintes sourdes, toutes
 * distinctes des cinq couleurs semantiques (bleu, rouge, vert, ambre,
 * violet de la palette) pour qu'une matiere ne se lise jamais comme un
 * « théorème ». Affichees en carre arrondi ; les pastilles semantiques sont
 * rondes. Les cahiers existants gardent leur couleur tant qu'on n'y touche pas.
 */
export const NOTEBOOK_COLORS = [
  "#4338ca", "#0f766e", "#b45309", "#86198f",
  "#4d7c0f", "#475569", "#0e7490", "#9f1239",
] as const;

export const NOTEBOOK_COLOR_NAMES: Readonly<Record<string, string>> = {
  "#4338ca": "Indigo", "#0f766e": "Sarcelle", "#b45309": "Rouille", "#86198f": "Prune",
  "#4d7c0f": "Olive", "#475569": "Ardoise", "#0e7490": "Océan", "#9f1239": "Grenat",
  // Anciennes couleurs, encore portees par des cahiers existants.
  "#2563eb": "Bleu", "#dc2626": "Rouge", "#059669": "Vert", "#d97706": "Orange",
  "#7c3aed": "Violet", "#0891b2": "Cyan", "#db2777": "Rose", "#65a30d": "Vert clair",
};

/** La couleur d'une matiere est aussi une couleur semantique (ancien cahier). */
export function isSemanticColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  return PALETTE.some((p) => p.ink === c);
}
