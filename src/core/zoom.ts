/**
 * Zoom d'une vue de pages (lot 11, encre-11). Logique pure : bornes, paliers,
 * zoom centre sur un point, densite du canvas. Le zoom ne change jamais les
 * donnees : les traits restent en unites de page, seule la largeur affichee
 * de la feuille est multipliee.
 */

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

/** Paliers de Ctrl+= et Ctrl+- (comme un traitement de texte). */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/**
 * Pres de 100 %, un pinch retombe sur 100 % : sans cela on ne revient
 * jamais exactement a la taille normale au doigt.
 */
const SNAP_ONE = 0.04;

/** Zoom ramene dans les bornes, 100 % attrape de pres, arrondi au centieme. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  const c = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (Math.abs(c - 1) < SNAP_ONE) return 1;
  return Math.round(c * 100) / 100;
}

/** Palier suivant (+1) ou precedent (-1) depuis un zoom quelconque. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const eps = 0.005;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + eps) ?? ZOOM_MAX;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z - eps) return ZOOM_STEPS[i];
  return ZOOM_MIN;
}

/**
 * Facteur d'un cran de Ctrl+molette (ou du pinch d'un pave tactile, que
 * Windows envoie comme Ctrl+molette). `deltaMode` 1 = lignes, 2 = pages.
 * Un cran de souris (100 px) vaut environ 15 %.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
  const d = Math.max(-300, Math.min(300, px));
  return Math.exp(-d * 0.0014);
}

export interface Pt { x: number; y: number }

/** Pinch a deux doigts : facteur d'echelle et deplacement du milieu. */
export function pinchOf(start: [Pt, Pt], now: [Pt, Pt]): { scale: number; dx: number; dy: number } {
  const d0 = Math.hypot(start[0].x - start[1].x, start[0].y - start[1].y);
  const d1 = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y);
  const m0 = mid(start), m1 = mid(now);
  return { scale: d0 > 8 ? d1 / d0 : 1, dx: m1.x - m0.x, dy: m1.y - m0.y };
}

export function mid(p: [Pt, Pt]): Pt {
  return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
}

/**
 * Point vise, en unites de page, sous un point de l'ecran. `sheet` = coin
 * haut gauche de la feuille a l'ecran, `k` = pixels par unite de page.
 */
export function anchorAt(point: Pt, sheet: Pt, k: number): Pt {
  return { x: (point.x - sheet.x) / k, y: (point.y - sheet.y) / k };
}

/**
 * Defilement a ajouter pour que le point de page `anchor` revienne sous
 * `target` a l'ecran, la feuille etant maintenant en `sheet` a l'echelle `k`.
 * C'est ce qui rend le zoom « centre sur le point du pinch ou de la souris ».
 */
export function scrollToAnchor(anchor: Pt, sheet: Pt, k: number, target: Pt): { dx: number; dy: number } {
  return { dx: sheet.x + anchor.x * k - target.x, dy: sheet.y + anchor.y * k - target.y };
}

/**
 * Apercu pendant le geste : transformation CSS d'un element dont le coin
 * est en `box`, pour qu'un point de l'ecran sous `focus` grossisse de
 * `scale` autour de lui et suive le deplacement (dx, dy) des doigts.
 * Aucun re-rendu de l'encre pendant le geste (batterie) : seulement le
 * compositeur ; le rendu net vient au lacher.
 */
export function previewTransform(focus: Pt, box: Pt, scale: number, dx = 0, dy = 0): { transform: string; origin: string } {
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    transform: `translate(${r(dx)}px, ${r(dy)}px) scale(${Math.round(scale * 1000) / 1000})`,
    origin: `${r(focus.x - box.x)}px ${r(focus.y - box.y)}px`,
  };
}

/** Libelle de l'indicateur : « 150 % » (espace insecable). */
export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)} %`;
}

/**
 * Pixels au plus pour le canvas d'une page : 16 millions (64 Mo). Une page a
 * 300 % en densite 2 en demanderait plus de 40 millions ; la densite baisse
 * plutot que la memoire n'explose.
 */
export const MAX_CANVAS_PX = 16_000_000;

/**
 * Densite du canvas d'une page (pixels physiques par pixel CSS).
 * - `dpr` : densite de l'ecran, plafonnee a 2 comme avant le zoom ;
 * - `near` : page a l'ecran ou tout pres. Les autres (mode defilement)
 *   gardent le poids qu'elles avaient a 100 % : nettes une fois revenues
 *   a l'ecran, sans multiplier la memoire par le carre du zoom ;
 * - jamais plus de MAX_CANVAS_PX pixels.
 */
export function inkDensity(cssW: number, cssH: number, dpr: number, zoom = 1, near = true): number {
  let d = Math.min(Math.max(dpr || 1, 0.5), 2);
  if (!near && zoom > 1) d /= zoom;
  const area = Math.max(1, cssW * cssH);
  const cap = Math.sqrt(MAX_CANVAS_PX / area);
  d = Math.min(d, cap);
  // Au centieme : une petite variation de hauteur ne relance pas le rendu.
  return Math.max(0.25, Math.round(d * 100) / 100);
}
