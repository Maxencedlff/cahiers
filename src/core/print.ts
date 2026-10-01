/**
 * Export PDF : decoupage d'une page du cahier en feuilles A4. Logique pure,
 * le DOM (mesures, clones, tranches d'encre) est dans PageView.exportPdf.
 *
 * Une page qui tient sur une A4 part telle quelle. Un peu plus haute
 * (jusqu'a PRINT_ZOOM_MAX), elle est legerement reduite. Au-dela, jamais de
 * reduction : elle est coupee en plusieurs feuilles, entre deux lignes de
 * texte, jamais au milieu d'une photo ou d'une formule, et si possible pas
 * au travers d'un trait d'encre.
 */

/** Intervalle vertical occupe (ligne de texte, photo, formule, trait), en px. */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * Hauteur utile d'une feuille A4 a 96 dpi (1123 px), en px CSS : feuille
 * plus numero de page, moins la marge du haut (10 mm) et une marge de
 * securite en bas.
 */
export const PRINT_FIT = 1060;
/** Au-dela de cette hauteur, une page est coupee au lieu d'etre reduite. */
export const PRINT_ZOOM_MAX = 1150;
/** Une feuille coupee fait au moins cette part d'une feuille pleine. */
const MIN_FILL = 0.55;
/** Marge sous le bord haut du premier intervalle quand rien n'est au-dessus. */
const PAD = 2;

export interface PrintPlan {
  /** Reduction de la page entiere (1 = taille reelle). */
  zoom: number;
  /** Bords des tranches, de 0 a la hauteur de la feuille. */
  cuts: number[];
}

/**
 * Plan d'impression d'une feuille de `sheetH` px, avec un numero de page de
 * `numH` px sous chaque tranche. `hard` : a ne jamais couper si possible
 * (lignes de texte, photos, formules) ; `soft` : a eviter (encre).
 */
export function planPrint(sheetH: number, numH: number, hard: Span[], soft: Span[] = []): PrintPlan {
  const total = sheetH + numH;
  if (total <= PRINT_FIT) return { zoom: 1, cuts: [0, sheetH] };
  if (total <= PRINT_ZOOM_MAX) return { zoom: PRINT_FIT / total, cuts: [0, sheetH] };
  const max = PRINT_FIT - numH;
  const both = merge([...hard, ...soft]);
  const strict = merge(hard);
  const cuts = [0];
  let at = 0;
  while (sheetH - at > max) {
    const lo = at + max * MIN_FILL;
    const hi = at + max;
    const cut = findCut(lo, hi, both) ?? findCut(lo, hi, strict) ?? hi;
    cuts.push(cut);
    at = cut;
  }
  cuts.push(sheetH);
  return { zoom: 1, cuts };
}

/**
 * Coupe la plus basse dans [lo, hi] qui ne traverse aucun intervalle
 * (fusionnes et tries), ou null. La coupe passe au milieu de l'espace libre
 * (l'interligne entre deux lignes ne fait que quelques pixels).
 */
export function findCut(lo: number, hi: number, spans: Span[]): number | null {
  // Espaces libres, du bas vers le haut : sous le dernier intervalle, puis
  // entre deux intervalles, puis au-dessus du premier.
  for (let i = spans.length; i >= 0; i--) {
    const a = i > 0 ? spans[i - 1].bottom : -Infinity;
    const b = i < spans.length ? spans[i].top : Infinity;
    const from = Math.max(a, lo), to = Math.min(b, hi);
    if (from > to) {
      if (b < lo) break;
      continue;
    }
    const mid = isFinite(a) && isFinite(b) ? (a + b) / 2 : isFinite(b) ? b - PAD : hi;
    return Math.floor(Math.max(from, Math.min(to, mid)));
  }
  return null;
}

/** Intervalles tries et fusionnes (ceux qui se touchent n'en font qu'un). */
export function merge(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.bottom > s.top).sort((a, b) => a.top - b.top);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.top <= last.bottom + 1) last.bottom = Math.max(last.bottom, s.bottom);
    else out.push({ top: s.top, bottom: s.bottom });
  }
  return out;
}
