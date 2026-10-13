/**
 * Fonds de page (D12), choisis par intercalaire. Logique pure : quelles
 * lignes et quels points tombent dans une zone de la feuille, en unites de
 * page. La surface d'encre les peint sous les traits, zone sale par zone
 * sale (le canvas est opaque sous WebView2, voir InkSurface.paperColor :
 * un fond CSS pose dessous ne se verrait pas).
 *
 * Les espacements sont en millimetres d'une A4 : la feuille fait PAGE_W
 * unites pour 210 mm, les carreaux gardent donc la meme taille relative a
 * la feuille a toute echelle (fitSheet, zoom).
 */
import type { PaperKind } from "./types";
import { PAGE_W } from "./ink/sheet";

export type { PaperKind };

/** Unites de page par millimetre (feuille de 210 mm de large). */
export const MM = PAGE_W / 210;

export interface PaperInfo {
  kind: PaperKind;
  /** Libelle court du bouton. */
  label: string;
  title: string;
}

/** Ordre du menu « ⋯ ». « uni » d'abord : c'est le defaut. */
export const PAPERS: readonly PaperInfo[] = [
  { kind: "uni", label: "Uni", title: "Feuille blanche" },
  { kind: "ligne", label: "Ligné", title: "Lignes tous les 8 mm" },
  { kind: "seyes", label: "Seyès", title: "Grands carreaux (Seyès) : interligne 2 mm, carreau 8 mm, marge" },
  { kind: "quadrille", label: "5×5", title: "Quadrillé 5×5 mm, pour les schémas" },
  { kind: "millimetre", label: "Millimétré", title: "Petits carreaux : millimétré léger, renforcé tous les 5 et 10 mm (chronogrammes, courbes)" },
  { kind: "points", label: "Points", title: "Points tous les 5 mm" },
];

export function isPaperKind(v: unknown): v is PaperKind {
  return typeof v === "string" && PAPERS.some((p) => p.kind === v);
}

/** Fond memorise pour un intercalaire ; « uni » si absent ou inconnu. */
export function paperOf(map: unknown, divider: string): PaperKind {
  if (!map || typeof map !== "object" || Array.isArray(map)) return "uni";
  const v = (map as Record<string, unknown>)[divider];
  return isPaperKind(v) ? v : "uni";
}

/** Force d'un trait du fond, du plus discret au plus marque. */
export type PaperWeight = "fine" | "main" | "strong" | "margin";

export interface PaperLines {
  weight: PaperWeight;
  /** Abscisses des lignes verticales (unites de page). */
  vertical: number[];
  /** Ordonnees des lignes horizontales. */
  horizontal: number[];
}

export interface Zone { x: number; y: number; w: number; h: number }

/**
 * Ecart minimal a l'ecran, en pixels CSS, pour qu'un niveau de lignes soit
 * peint : en dessous (feuille reduite, zoom 50 %), les millimetres ou
 * l'interligne Seyes ne font plus qu'un gris uniforme. Le niveau superieur
 * reste.
 */
export const MIN_GAP_PX = 3.5;

/** Marge Seyes : verticale, a 4 grands carreaux du bord gauche. */
export const SEYES_MARGIN = 4 * 8 * MM;

/** Positions multiples de `step` dans [from, to], sauf celles de `skip`. */
function ticks(step: number, from: number, to: number, skip = 0): number[] {
  const out: number[] = [];
  const a = Math.max(1, Math.ceil(from / step - 1e-9));
  const b = Math.floor(to / step + 1e-9);
  for (let i = a; i <= b; i++) {
    if (skip > 1 && i % skip === 0) continue;
    out.push(i * step);
  }
  return out;
}

/**
 * Lignes du fond qui coupent la zone, par force. `k` = pixels CSS par
 * unite de page (largeur affichee / PAGE_W) : un niveau trop serre a cette
 * echelle est omis. Les lignes au bord meme de la feuille (0, PAGE_W) ne
 * sont pas tracees.
 */
export function paperLines(kind: PaperKind, zone: Zone, k = 1): PaperLines[] {
  const x0 = zone.x, x1 = zone.x + zone.w, y0 = zone.y, y1 = zone.y + zone.h;
  const shows = (stepMm: number) => stepMm * MM * k >= MIN_GAP_PX;
  const out: PaperLines[] = [];
  const add = (weight: PaperWeight, vertical: number[], horizontal: number[]) => {
    // Le bord droit de la feuille n'est pas une ligne du fond.
    vertical = vertical.filter((x) => x < PAGE_W - 0.01);
    if (vertical.length || horizontal.length) out.push({ weight, vertical, horizontal });
  };
  switch (kind) {
    case "ligne": {
      add("main", [], ticks(8 * MM, y0, y1));
      break;
    }
    case "seyes": {
      // Interligne de 2 mm (sauf la ou passe la ligne de 8 mm), carreau
      // de 8 mm, une marge.
      if (shows(2)) add("fine", [], ticks(2 * MM, y0, y1, 4));
      const marginIn = SEYES_MARGIN >= x0 && SEYES_MARGIN <= x1;
      // Verticales du carreau en trait fin : pas d'effet damier, la ligne
      // d'ecriture reste le seul repere fort.
      add("main", [], ticks(8 * MM, y0, y1));
      add("fine", ticks(8 * MM, x0, x1).filter((x) => Math.abs(x - SEYES_MARGIN) > 0.01), []);
      if (marginIn) add("margin", [SEYES_MARGIN], []);
      break;
    }
    case "quadrille": {
      add("main", ticks(5 * MM, x0, x1), ticks(5 * MM, y0, y1));
      break;
    }
    case "millimetre": {
      if (shows(1)) add("fine", ticks(MM, x0, x1, 5), ticks(MM, y0, y1, 5));
      add("main", ticks(5 * MM, x0, x1, 2), ticks(5 * MM, y0, y1, 2));
      add("strong", ticks(10 * MM, x0, x1), ticks(10 * MM, y0, y1));
      break;
    }
    default:
      break;
  }
  return out;
}

/** Points du fond « points » dans la zone : un tous les 5 mm. */
export function paperDots(kind: PaperKind, zone: Zone): { x: number; y: number }[] {
  if (kind !== "points") return [];
  const xs = ticks(5 * MM, zone.x, zone.x + zone.w);
  const ys = ticks(5 * MM, zone.y, zone.y + zone.h);
  const out: { x: number; y: number }[] = [];
  for (const y of ys) for (const x of xs) out.push({ x, y });
  return out;
}

/**
 * Trait du fond : couleur et epaisseur en pixels CSS. Gris clair, pour ne
 * gener ni la lecture ni la reconnaissance ; la marge Seyes en rose pale.
 * A l'impression (export PDF), le meme fond, donc tres clair aussi.
 */
export const PAPER_STYLE: Record<PaperWeight, { color: string; width: number }> = {
  fine: { color: "rgba(110, 125, 150, 0.16)", width: 0.6 },
  main: { color: "rgba(110, 125, 150, 0.30)", width: 0.8 },
  strong: { color: "rgba(110, 125, 150, 0.42)", width: 0.9 },
  margin: { color: "rgba(214, 92, 120, 0.45)", width: 1 },
};

export const DOT_STYLE = { color: "rgba(100, 115, 140, 0.55)", size: 1.8 };
