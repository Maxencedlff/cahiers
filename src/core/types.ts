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
  color: ColorKey;
  width: number;
  tool: Exclude<ToolKind, "eraser">;
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
}

export interface ImageBlock extends BlockBase {
  type: "image";
  src: string;
  ocr: string | null;
}

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
  lastPosition?: { divider: string; page: number };
  /** Mode de lecture memorise par intercalaire (section 5). */
  viewMode?: Record<string, "pages" | "scroll">;
}

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

export function emptyPage(id: string, now: string): Page {
  return { version: SCHEMA_VERSION, id, created: now, modified: now, blocks: [] };
}
