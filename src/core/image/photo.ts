/**
 * Import de photos (lot 10) : logique pure, sans DOM, testable sous Node.
 *
 * L'interface est dans src/ui/image-import.ts. Ici : mise en page du
 * dialogue de redressement, touches, noms de fichiers, messages d'erreur,
 * dernier choix noir et blanc (D9).
 */

import type { Quad } from "./dewarp";

/**
 * Plus grand cote de la photo d'origine gardee (D9). Une photo de telephone
 * fait 4000 px : au-dela de 2560 rien ne se lit mieux, et le JPEG passerait
 * de 1 Mo a 3 ou 4 Mo synchronises par OneDrive pour chaque photo.
 */
export const ORIGINAL_MAX = 2560;
/** Plus grand cote de l'image redressee enregistree. */
export const FINAL_MAX = 1600;
/** Plus grand cote de l'apercu redresse. */
export const PREVIEW_MAX = 520;
/** Qualite JPEG : photo couleur et original. Un PNG de photo pese 10 fois plus. */
export const JPEG_QUALITY = 0.85;

/**
 * Rayon du seuil adaptatif, proportionnel a la taille : le meme rayon a
 * 520 px et a 1600 px donnait un apercu qui ne ressemblait pas au resultat.
 * 1600 px donnent 12, comme avant ; l'apercu a 520 px en prend 4.
 */
export function binarizeRadius(width: number, height: number): number {
  return Math.max(3, Math.round(Math.max(width, height) / 130));
}

/** Facteur qui ramene (w, h) sous `max` sur le plus grand cote, jamais agrandi. */
export function fitRatio(width: number, height: number, max: number): number {
  return Math.min(1, max / Math.max(1, width, height));
}

export function scaleQuad(quad: Quad, k: number): Quad {
  return quad.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad;
}

/** Coins arrondis au dixieme de pixel : le JSON de la page reste lisible. */
export function roundQuad(quad: Quad): Quad {
  const r = (v: number) => Math.round(v * 10) / 10;
  return quad.map((p) => ({ x: r(p.x), y: r(p.y) })) as Quad;
}

/**
 * Quad lu dans un bloc : quatre points finis, sinon null (fichier abime ou
 * edite a la main). « Redresser a nouveau » repart alors des coins par defaut.
 */
export function readQuad(value: unknown): Quad | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  for (const p of value) {
    if (!p || typeof p !== "object") return null;
    const { x, y } = p as { x: unknown; y: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) return null;
  }
  return (value as Quad).map((p) => ({ x: p.x, y: p.y })) as Quad;
}

/* ------------------------------------------------------------------ */
/* Mise en page du dialogue                                            */
/* ------------------------------------------------------------------ */

export interface CropLayout {
  /** Echelle photo (pixels de travail) vers vue (pixels CSS). */
  scale: number;
  viewW: number;
  viewH: number;
  /** Apercu a droite de la photo ; sinon en dessous, en bandeau bas. */
  side: boolean;
  /** Largeur maximale de l'apercu, en pixels CSS. */
  previewW: number;
  /** Hauteur maximale de l'apercu, en pixels CSS. */
  previewH: number;
}

/**
 * Hauteur prise par tout ce qui n'est pas la photo : marges du fond,
 * titre, ligne d'etat, pied de dialogue (boutons de 44 px), espacements.
 */
const CHROME_H = 176;
/** Marges horizontales : fond (2 x 20) et contenu (2 x 18). */
const CHROME_W = 76;
const GAP = 16;
/** En dessous, l'apercu passe sous la photo en bandeau. */
const SIDE_MIN_W = 700;
const STRIP_H = 120;
/** Fenetre etroite : les cinq boutons du pied passent sur deux lignes. */
const FOOTER_WRAP_H = 56;

/**
 * Taille de la vue de recadrage : la photo ENTIERE doit tenir a l'ecran,
 * en largeur comme en hauteur. Une photo de telephone est en portrait
 * (3000 x 4000) : calculee sur la seule largeur, la vue faisait 960 px de
 * haut et les deux coins du bas etaient hors champ.
 *
 * `maxH` : hauteur maximale du dialogue (84 % de la fenetre, comme .modal).
 */
export function cropLayout(imgW: number, imgH: number, winW: number, winH: number): CropLayout {
  const side = winW >= SIDE_MIN_W;
  const maxH = Math.floor(winH * 0.84);
  const previewW = side ? Math.max(160, Math.min(300, Math.round(winW * 0.22))) : Math.max(120, winW - CHROME_W);
  let availW = winW - CHROME_W - (side ? previewW + GAP : 0);
  let availH = maxH - CHROME_H - (side ? 0 : STRIP_H + GAP + FOOTER_WRAP_H);
  availW = Math.max(120, availW);
  availH = Math.max(120, availH);
  const scale = Math.min(1, availW / Math.max(1, imgW), availH / Math.max(1, imgH));
  const viewW = Math.max(1, Math.round(imgW * scale));
  const viewH = Math.max(1, Math.round(imgH * scale));
  return { scale, viewW, viewH, side, previewW, previewH: side ? availH : STRIP_H };
}

/* ------------------------------------------------------------------ */
/* Clavier                                                             */
/* ------------------------------------------------------------------ */

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

export type CropKey = "cancel" | "insert" | "bw" | "reset" | "skip";

/**
 * Touches du dialogue de redressement : Echap annule, Entree insere,
 * N bascule le noir et blanc, R remet les coins, S passe a la suivante
 * (import de plusieurs photos). Lettres par `code` : la meme touche en
 * AZERTY et en QWERTY, majuscule ou non.
 */
export function cropKey(e: KeyLike): CropKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === "Escape") return "cancel";
  if (e.key === "Enter") return e.repeat ? null : "insert";
  if (e.repeat) return null;
  if (e.code === "KeyN" || e.key.toLowerCase() === "n") return "bw";
  if (e.code === "KeyR" || e.key.toLowerCase() === "r") return "reset";
  if (e.code === "KeyS" || e.key.toLowerCase() === "s") return "skip";
  return null;
}

/**
 * Raccourci d'import : Alt+Maj+P. Alt+P seul est deja pris par le modele
 * « Puissance » du ruban Maths (core/templates.ts). Par `code` : en AZERTY
 * Maj change la lettre affichee mais pas la touche.
 */
export const PHOTO_IMPORT_KEYS = "Alt+Maj+P";
export function isPhotoImportKey(e: KeyLike): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyP";
}

/* ------------------------------------------------------------------ */
/* Fichiers                                                            */
/* ------------------------------------------------------------------ */

/** Noms des deux fichiers d'une photo dans assets/. */
export function photoFileNames(id: string, bw: boolean): { final: string; original: string } {
  return { final: `${id}.${bw ? "png" : "jpg"}`, original: `${id}.original.jpg` };
}

/** Noir et blanc : PNG (deux couleurs, quelques dizaines de Ko). Couleur : JPEG. */
export function finalMime(bw: boolean): "image/png" | "image/jpeg" {
  return bw ? "image/png" : "image/jpeg";
}

export function isHeic(name: string, type = ""): boolean {
  return /\.(heic|heif)$/i.test(name) || /image\/hei[cf]/i.test(type);
}

/**
 * Message quand une photo ne se decode pas. Le HEIC de l'iPhone est le cas
 * courant : WebView2 ne le lit pas, et l'import echouait sans un mot.
 */
export function unreadableMessage(name: string, type = ""): string {
  if (isHeic(name, type)) {
    return `« ${name} » est au format HEIC de l'iPhone, illisible ici. `
      + "Sur l'iPhone : Réglages, Appareil photo, Formats, « Le plus compatible » ; "
      + "ou envoie la photo en JPG.";
  }
  return `« ${name} » n'est pas une image lisible (JPG, PNG ou WebP).`;
}

/* ------------------------------------------------------------------ */
/* Dernier choix noir et blanc (D9)                                    */
/* ------------------------------------------------------------------ */

const PREFS_KEY = "cahiers.photo.v1";

/**
 * Noir et blanc ou couleur : le dernier choix est retenu, sur cette machine
 * seulement (comme les reglages). Couleur au premier import : un schema
 * d'electronique au feutre de couleur perdait ses couleurs.
 */
export function loadBwChoice(): boolean {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return false;
    return (JSON.parse(raw) as { bw?: unknown }).bw === true;
  } catch {
    return false;
  }
}

export function saveBwChoice(bw: boolean): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ bw }));
  } catch { /* stockage plein ou interdit : le choix n'est pas retenu */ }
}
