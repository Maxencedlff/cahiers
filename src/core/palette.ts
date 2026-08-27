import type { ColorKey } from "./types";

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
  { key: "definition", label: "Definition", ink: "#2563eb", wash: "#93c5fd", shortcut: "1" },
  { key: "theoreme",   label: "Theoreme",   ink: "#dc2626", wash: "#fca5a5", shortcut: "2" },
  { key: "exemple",    label: "Exemple",    ink: "#059669", wash: "#6ee7b7", shortcut: "3" },
  { key: "attention",  label: "Attention",  ink: "#d97706", wash: "#fcd34d", shortcut: "4" },
  { key: "perso",      label: "Remarque",   ink: "#7c3aed", wash: "#c4b5fd", shortcut: "5" },
] as const;

const BY_KEY = new Map(PALETTE.map((p) => [p.key, p]));

export function colorOf(key: ColorKey, tool: "pen" | "highlighter" = "pen"): string {
  const e = BY_KEY.get(key) ?? PALETTE[0];
  return tool === "highlighter" ? e.wash : e.ink;
}

export function labelOf(key: ColorKey): string {
  return (BY_KEY.get(key) ?? PALETTE[0]).label;
}

/** Couleurs de cahier proposees au moment de creer une matiere. */
export const NOTEBOOK_COLORS = [
  "#2563eb", "#dc2626", "#059669", "#d97706",
  "#7c3aed", "#0891b2", "#db2777", "#65a30d",
] as const;
