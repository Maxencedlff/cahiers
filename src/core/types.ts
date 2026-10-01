/**
 * Schema des donnees. Tous les types de blocs sont declares des la v1
 * (section 2 de CLAUDE.md) meme si tous ne sont pas encore rendus :
 * ajouter un type apres coup obligerait a migrer tous les fichiers du disque.
 */

export const SCHEMA_VERSION = 1 as const;

/** Les 5 couleurs a semantique fixe. Palette fermee, voir section 8. */
export type ColorKey =
  | "definition"
  | "theoreme"
  | "exemple"
  | "attention"
  | "perso";

/**
 * Couleur d'un trait : une des 5 couleurs semantiques, ou "normal", l'encre
 * neutre noire de 95 % des notes. Ce n'est pas une couleur libre : sans elle,
 * tout le cours serait marque « Definition » et le filtrage par couleur ne
 * voudrait plus rien dire. Les anciens fichiers (5 valeurs) restent valides.
 */
export type InkColor = ColorKey | "normal";

export type ToolKind = "pen" | "highlighter" | "eraser";

/** Un point de trait. `p` = pression 0..1, `t` = ms depuis le debut du trait. */
export interface InkPoint {
  x: number;
  y: number;
  p: number;
  t: number;
  tiltX?: number;
  tiltY?: number;
}

export interface Stroke {
  id: string;
  points: InkPoint[];
  color: InkColor;
  width: number;
  tool: Exclude<ToolKind, "eraser">;
  /**
   * Heure du debut du trait (ms depuis 1970). Les `t` des points restent
   * relatifs a ce debut ; MyScript recoit des temps absolus, d'ou il tire
   * l'ordre des traits differes (point du i, barre du t, accents).
   * Optionnel : les anciens traits n'en ont pas.
   */
  startedAt?: number;
}

export type BlockType =
  | "text"
  | "ink"
  | "math"
  | "image"
  | "pdf"
  | "calc"
  | "graph"
  | "link"
  | "flag";

interface BlockBase {
  id: string;
  type: BlockType;
  /** Position et taille dans la page, en unites de page (voir PAGE_W/PAGE_H). */
  rect?: { x: number; y: number; w: number; h: number };
}

export interface TextBlock extends BlockBase {
  type: "text";
  content: string;
  color?: ColorKey;
}

export interface InkBlock extends BlockBase {
  type: "ink";
  strokes: Stroke[];
  /** Texte reconnu quand la zone a ete passee au moteur Text. */
  recognized: string | null;
  mode: "raw";
  /** true tant que la reconnaissance n'est pas revenue (file hors ligne). */
  pending?: boolean;
  candidates?: string[];
  /**
   * L'utilisateur a repris le texte au clavier : la conversion automatique
   * ne doit plus l'ecraser, sinon elle efface une correction a chaque trait.
   */
  editedByHand?: boolean;
  /**
   * Mots reconnus, chacun a sa place sur la page et avec ses traits.
   * En rendu propre, ils remplacent l'encre mot a mot (facon Scribble).
   */
  words?: InkWord[];
  /**
   * La reconnaissance a refuse ce bloc (reponse 4xx, hors cles et quota) :
   * le motif, affiche avec « non reconnu, réessayer ». Absent sinon.
   */
  recoError?: string;
}

/** Un mot reconnu (ou un separateur " " / "\n", sans boite ni traits). */
export interface InkWord {
  label: string;
  /** Position du mot manuscrit, en unites de page. */
  box?: { x: number; y: number; w: number; h: number };
  /** Traits qui composent le mot : ceux que le mot tape remplace. */
  strokeIds: string[];
  /** Autres lectures du moteur, pour la correction en un geste. */
  candidates?: string[];
  /** Corrige a la main : une reconversion ne doit pas l'ecraser. */
  edited?: boolean;
  /**
   * Lecture du moteur au moment de la correction. La correction n'est
   * reportee sur une nouvelle lecture que si l'encre est la meme, ou si le
   * moteur relit la meme erreur : un mot qui grandit (« tension » →
   * « tensions ») garde sa nouvelle lecture.
   */
  misread?: string;
}

export interface MathBlock extends BlockBase {
  type: "math";
  /** REGLE ABSOLUE : jamais vide, jamais efface apres reconnaissance. */
  strokes: Stroke[];
  latex: string | null;
  mode: "math";
  /** true tant que la reconnaissance n'est pas revenue (file hors ligne). */
  pending?: boolean;
  /** Autres lectures proposees par le moteur, pour la correction en un geste. */
  candidates?: string[];
  /** Motif d'un refus de la reconnaissance (voir InkBlock.recoError). */
  recoError?: string;
}

export interface ImageBlock extends BlockBase {
  type: "image";
  src: string;
  ocr: string | null;
  /**
   * Largeur en unites de page quand la photo est posee dans le texte
   * (sans rect) : elle suit alors le texte, comme une image dans Word.
   */
  width?: number;
  /**
   * Photo d'origine, avant redressement (D9) : JPEG dans assets/. Jamais
   * jetee, dans l'esprit de « l'encre brute n'est jamais jetee » : des coins
   * mal places ou un noir et blanc qui bouche tout se refont depuis elle.
   * Optionnel : les photos importees avant le lot 10 n'en ont pas.
   */
  original?: string;
  /**
   * Coins du redressement dans `original`, en pixels de ce fichier :
   * haut-gauche, haut-droit, bas-droit, bas-gauche.
   */
  quad?: [ImagePoint, ImagePoint, ImagePoint, ImagePoint];
  /** Noir et blanc applique au redressement. Absent = inconnu (ancien bloc). */
  bw?: boolean;
}

/** Point d'une photo, en pixels. */
export interface ImagePoint { x: number; y: number }

export interface PdfBlock extends BlockBase {
  type: "pdf";
  src: string;
  page: number;
  annotations: Stroke[];
}

export interface CalcBlock extends BlockBase {
  type: "calc";
  expr: string;
  result: string | number | null;
}

export interface GraphBlock extends BlockBase {
  type: "graph";
  fn: string;
  domain: [number, number];
  range?: [number, number];
}

export interface LinkBlock extends BlockBase {
  type: "link";
  /** "Maths/Cours/0012#<blockId>" */
  target: string;
  label: string;
}

export interface FlagBlock extends BlockBase {
  type: "flag";
  note: string;
  resolved?: boolean;
  /**
   * La ligne ou le repere a ete pose (environ 80 caracteres), pour savoir
   * le soir ce qui n'etait pas compris. Optionnel : les anciens reperes
   * restent valides.
   */
  context?: string;
  /** Date de pose (ISO), pour trier la vue « Pas compris ». */
  created?: string;
}

export type Block =
  | TextBlock
  | InkBlock
  | MathBlock
  | ImageBlock
  | PdfBlock
  | CalcBlock
  | GraphBlock
  | LinkBlock
  | FlagBlock;

export interface Page {
  version: typeof SCHEMA_VERSION;
  id: string;
  created: string;
  modified: string;
  /**
   * Hauteur de la feuille en unites de page, quand l'encre descend sous la
   * hauteur A4 (PAGE_H). Absente sur une page normale. Optionnelle : les
   * anciens fichiers restent lisibles.
   */
  height?: number;
  blocks: Block[];
}

/** cahier.json : metadonnees d'une matiere. */
export interface NotebookMeta {
  version: typeof SCHEMA_VERSION;
  title: string;
  color: string;
  /** Ordre des intercalaires. Le disque fait autorite sur l'existence,
   *  ce tableau n'ordonne que ce qui existe reellement. */
  dividers: string[];
  /**
   * Ancienne derniere position. Plus jamais ecrite (D8 : elle vit dans le
   * stockage local de chaque PC, voir core/position.ts) ; seulement relue
   * tant que la machine n'a pas la sienne.
   */
  lastPosition?: { divider: string; page: number };
  /** Mode de lecture memorise par intercalaire (section 5). */
  viewMode?: Record<string, "pages" | "scroll">;
  /**
   * Fond de page par intercalaire (D12). Absent = « uni ». Une valeur
   * inconnue (version plus recente) est lue comme « uni » et gardee.
   */
  paper?: Record<string, PaperKind>;
}

/** Fonds de page (D12), voir core/paper.ts. */
export type PaperKind = "uni" | "ligne" | "seyes" | "quadrille" | "millimetre" | "points";

/** Reference d'une page dans l'arborescence. */
export interface PageRef {
  notebook: string;
  divider: string;
  /** Numero par intercalaire, 1-based. */
  number: number;
}

export function pageFileName(n: number): string {
  return `${String(n).padStart(4, "0")}.page.json`;
}

export function parsePageNumber(fileName: string): number | null {
  const m = /^(\d{4})\.page\.json$/.exec(fileName);
  return m ? Number(m[1]) : null;
}

export function refToString(r: PageRef): string {
  return `${r.notebook}/${r.divider}/${String(r.number).padStart(4, "0")}`;
}

/**
 * Page ecrite par une version plus recente de l'application (sur l'autre
 * PC, mis a jour avant celui-ci). Elle s'ouvre en lecture seule : la
 * reenregistrer ici perdrait ce que cette version ne connait pas.
 */
export function isFutureVersion(p: { version?: unknown }): boolean {
  return typeof p.version === "number" && p.version > SCHEMA_VERSION;
}

export function emptyPage(id: string, now: string): Page {
  return { version: SCHEMA_VERSION, id, created: now, modified: now, blocks: [] };
}
