/**
 * Grille des lignes du texte tape (DOM). Les calculs sont dans
 * src/core/textlayout.ts : ici on mesure et on pose les marges.
 *
 *  - Formule (.eq) : marges haute et basse en em, posees une fois par
 *    formule (data-snap) : invariantes au zoom. Une fraction occupe deux ou
 *    trois lignes entieres, une formule basse reste sur une ligne.
 *  - Photo, calcul, courbe (.doc-img, blocs) : marges en px, revues a
 *    chaque mise a l'echelle (fitSheet) et quand la photo finit de charger.
 */
import { blockMargins, LINE, snapInline, TEXT_FONT } from "../core/textlayout";

/** Bande de texte minimale a cote d'une photo calee, en unites de page (~5 cm). */
const MIN_TEXT = 200;

/** Formules dans un titre : le titre a sa propre grille, on ne touche a rien. */
const HEADING = ".dl-h1, .dl-h2, .dl-h3";

/**
 * Cale les formules et les blocs du texte sur la grille. `all` : remesure
 * aussi les formules deja calees (polices KaTeX arrivees apres coup).
 * Rend vrai si une marge a change.
 */
export function snapLines(root: HTMLElement, all = false): boolean {
  if (!root.isConnected) return false;
  const fontPx = parseFloat(getComputedStyle(root).fontSize);
  if (!fontPx) return false;
  let changed = false;
  for (const eq of root.querySelectorAll<HTMLElement>(".eq")) {
    if (eq.dataset.snap && !all) continue;
    if (eq.closest(HEADING)) { eq.dataset.snap = "1"; continue; }
    const m = measureEq(eq);
    if (!m) continue;
    const s = snapInline(m.boxAsc / fontPx, m.boxDesc / fontPx, m.inkAsc / fontPx, m.inkDesc / fontPx);
    const top = `${s.top}em`, bottom = `${s.bottom}em`;
    if (eq.style.marginTop !== top || eq.style.marginBottom !== bottom) {
      eq.style.marginTop = top;
      eq.style.marginBottom = bottom;
      changed = true;
    }
    eq.dataset.snap = "1";
  }
  const line = LINE * (fontPx / TEXT_FONT);
  // h : hauteur reelle (offsetHeight est arrondi, l'ecart d'un demi-pixel
  // suffisait a laisser une ligne a cote de la plus haute des deux).
  const want = new Map<HTMLElement, { top: number; bottom: number; h: number }>();
  for (const fig of root.querySelectorAll<HTMLElement>(":scope > .doc-img, .dl > .doc-img")) {
    const h = fig.offsetHeight;
    if (h) want.set(fig, { ...blockMargins(h, line), h: fig.getBoundingClientRect().height });
  }
  // Photo calee a gauche et sa voisine (style.css) : bas alignes sur la
  // plus haute, sinon le texte qui suit se glissait dans l'ecart de
  // quelques pixels sous la plus courte. Hauts deja alignes (meme ligne).
  for (const [a, ma] of want) {
    if (!a.classList.contains("side")) continue;
    const b = a.nextElementSibling;
    const mb = b instanceof HTMLElement && b.matches(".doc-img:not(.side)") ? want.get(b) : undefined;
    if (!mb) continue;
    const ea = ma.top + ma.h + ma.bottom, eb = mb.top + mb.h + mb.bottom;
    // Arrondi par exces : le bas le plus court ne doit jamais rester au-dessus.
    if (ea < eb) ma.bottom += eb - ea + 0.01; else mb.bottom += ea - eb + 0.01;
  }
  // Bande laissee a droite de la derniere photo calee : trop etroite, le
  // texte s'y ecrivait une lettre par ligne. Elle est alors bouchee (marge
  // droite) et le texte passe dessous.
  const cs = getComputedStyle(root);
  const contentRight = root.getBoundingClientRect().right - (parseFloat(cs.paddingRight) || 0);
  const minText = MIN_TEXT * (fontPx / TEXT_FONT);
  for (const a of root.querySelectorAll<HTMLElement>(".doc-img.side")) {
    const b = a.nextElementSibling;
    const last = b instanceof HTMLElement && b.matches(".doc-img:not(.side)") ? b : a;
    const before = last.style.marginRight;
    last.style.marginRight = "";
    const gap = parseFloat(getComputedStyle(last).marginRight) || 0;
    const left = contentRight - last.getBoundingClientRect().right - gap;
    const mr = left < minText ? `${Math.max(0, gap + left - 1).toFixed(2)}px` : "";
    last.style.marginRight = mr;
    if (mr !== before) changed = true;
    if (last !== a && a.style.marginRight) { a.style.marginRight = ""; changed = true; }
  }
  for (const [fig, m] of want) {
    const top = `${m.top.toFixed(2)}px`, bottom = `${m.bottom.toFixed(2)}px`;
    if (fig.style.marginTop !== top || fig.style.marginBottom !== bottom) {
      fig.style.marginTop = top;
      fig.style.marginBottom = bottom;
      changed = true;
    }
  }
  return changed;
}

/**
 * Boite d'une formule et ce qu'elle dessine, en px, autour de sa ligne de
 * base. Les « struts » KaTeX donnent la hauteur et la profondeur exactes de
 * chaque morceau (inline-block de hauteur h, abaisse de sa profondeur) ;
 * la ligne de base est celle du dernier (une formule trop longue passe a
 * la ligne a l'interieur de sa boite). null si la formule n'est pas
 * affichee (page cachee) ou n'est pas du KaTeX (erreur de rendu).
 */
function measureEq(eq: HTMLElement): { boxAsc: number; boxDesc: number; inkAsc: number; inkDesc: number } | null {
  const box = eq.getBoundingClientRect();
  if (!box.height) return null;
  const struts = eq.querySelectorAll<HTMLElement>(".katex-html .strut");
  if (!struts.length) return null;
  const katexEl = eq.querySelector<HTMLElement>(".katex");
  const fs = katexEl ? parseFloat(getComputedStyle(katexEl).fontSize) : 0;
  if (!fs) return null;
  let top = Infinity, bottom = -Infinity, baseline = NaN;
  for (const s of struts) {
    const r = s.getBoundingClientRect();
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
    const depth = -(parseFloat(s.style.verticalAlign) || 0) * fs;
    baseline = r.bottom - depth;
  }
  if (!Number.isFinite(baseline)) return null;
  return {
    boxAsc: baseline - box.top,
    boxDesc: box.bottom - baseline,
    inkAsc: Math.max(0, baseline - top),
    inkDesc: Math.max(0, bottom - baseline),
  };
}
