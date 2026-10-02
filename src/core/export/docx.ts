/**
 * Ecriture d'un document Word (.docx, WordprocessingML) depuis un modele
 * simple : paragraphes (titres 1-3, listes a puces ou numerotees avec
 * niveaux), morceaux de texte (gras, italique, couleur), equations OMML,
 * images PNG/JPEG en ligne. Logique pure, sans DOM ni dependance : le XML
 * est ecrit a la main et empaquete par zip.ts.
 *
 * Page A4, marges normales (2,5 cm), Calibri 11 pt, equations en Cambria
 * Math, langue fr-FR declaree (correction orthographique de Word). Les
 * titres utilisent les styles integres « heading 1-3 » : Word les affiche
 * « Titre 1-3 » et les montre dans le volet de navigation.
 */

import { zipStore, type ZipEntry } from "./zip";
import { escapeXml, latexToOmml } from "./omml";

/** Image prete a poser : octets, type, taille affichee en EMU (914 400 par pouce). */
export interface DxImage {
  data: Uint8Array;
  type: "png" | "jpeg";
  /** Largeur et hauteur affichees, en EMU. */
  cx: number;
  cy: number;
  /** Texte de remplacement (accessibilite, « encre manuscrite »). */
  descr?: string;
}

export type DxRun =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean; color?: string; size?: number; highlight?: string; underline?: boolean }
  | { kind: "math"; latex: string; color?: string }
  | { kind: "image"; image: DxImage }
  | { kind: "br" };

export interface DxPara {
  /** Titre 1 a 3 (styles Word integres). */
  heading?: 1 | 2 | 3;
  /** Liste : puce ou numero, niveau 0..4 ; `num` = numero affiche (depart d'une liste). */
  list?: { ordered: boolean; level: number; num?: number };
  runs: DxRun[];
  align?: "left" | "center";
  /** Retrait gauche en twips (1/1440 de pouce). */
  indent?: number;
  /** Saut de page Word avant ce paragraphe (nouvelle page de l'appli). */
  pageBreakBefore?: boolean;
  /** Fond du paragraphe (surligneur sur une ligne de texte), hex sans #. */
  shade?: string;
  /** Petit texte gris (legende). */
  caption?: boolean;
}

export interface DxDoc {
  title: string;
  paras: DxPara[];
}

/**
 * Repli d'une formule qui ne passe pas en OMML : une image (PNG rendu par
 * l'interface) ; null = le texte simple de la formule.
 */
export type MathFallback = (latex: string) => DxImage | null;

/** EMU par twip, par point. */
export const EMU_PER_TWIP = 635;
export const EMU_PER_MM = 36000;
/** A4 en twips, marges normales de Word en France (2,5 cm). */
export const PAGE_W_TW = 11906;
export const PAGE_H_TW = 16838;
export const MARGIN_TW = 1417;
/** Largeur utile (16 cm), en EMU. */
export const TEXT_W_EMU = (PAGE_W_TW - 2 * MARGIN_TW) * EMU_PER_TWIP;

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
};

const XML_HEAD = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/** Numerotation : une liste a puces partagee, une instance par liste numerotee (depart propre). */
class Numbering {
  /** numId 1 = puces. */
  private nums: { id: number; abs: number; level: number; start: number }[] = [{ id: 1, abs: 0, level: 0, start: 1 }];
  /** Liste numerotee en cours par niveau : numId et dernier numero. */
  private open: ({ id: number; last: number } | undefined)[] = [];

  /** numId d'un element de liste. */
  idFor(list: NonNullable<DxPara["list"]>): number {
    const lvl = list.level;
    if (!list.ordered) { this.open.length = Math.min(this.open.length, lvl); return 1; }
    const n = list.num ?? 1;
    const cur = this.open[lvl];
    if (cur && n === cur.last + 1) { cur.last = n; this.open.length = lvl + 1; return cur.id; }
    const id = this.nums.length + 1;
    this.nums.push({ id, abs: 1, level: lvl, start: n });
    this.open[lvl] = { id, last: n };
    this.open.length = lvl + 1;
    return id;
  }

  /** Paragraphe hors liste : les listes numerotees suivantes repartent. */
  reset(): void { this.open = []; }

  xml(): string {
    const bullets = ["•", "◦", "▪", "•", "◦"];
    const lvl = (i: number, ordered: boolean) => {
      const ind = 360 + i * 360;
      const fmt = ordered
        ? `<w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/>`
        : `<w:numFmt w:val="bullet"/><w:lvlText w:val="${bullets[i]}"/>`;
      const font = ordered ? "" : "<w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/></w:rPr>";
      return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>${fmt}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind + 360}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
    };
    const abs = (id: number, ordered: boolean) =>
      `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2, 3, 4].map((i) => lvl(i, ordered)).join("")}</w:abstractNum>`;
    const nums = this.nums.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.abs}"/>`
      + (n.abs === 1 ? `<w:lvlOverride w:ilvl="${n.level}"><w:startOverride w:val="${n.start}"/></w:lvlOverride>` : "")
      + "</w:num>").join("");
    return `${XML_HEAD}<w:numbering xmlns:w="${NS.w}">${abs(0, false)}${abs(1, true)}${nums}</w:numbering>`;
  }
}

class Builder {
  readonly media: { name: string; image: DxImage; rid: string }[] = [];
  private nextDocPr = 1;
  readonly numbering = new Numbering();
  constructor(private fallback: MathFallback | null, private plainOf: (latex: string) => string) {}

  private image(img: DxImage): string {
    const n = this.media.length + 1;
    const name = `image${n}.${img.type === "png" ? "png" : "jpeg"}`;
    const rid = `rIdImg${n}`;
    this.media.push({ name, image: img, rid });
    const id = this.nextDocPr++;
    const cx = Math.max(1, Math.round(img.cx)), cy = Math.max(1, Math.round(img.cy));
    const descr = escapeXml(img.descr ?? "");
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
      + `<wp:docPr id="${id}" name="Image ${id}" descr="${descr}"/>`
      + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + `<a:graphic xmlns:a="${NS.a}"><a:graphicData uri="${NS.pic}"><pic:pic xmlns:pic="${NS.pic}">`
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  private text(r: Extract<DxRun, { kind: "text" }>, para: DxPara): string {
    const pr = (r.bold ? "<w:b/><w:bCs/>" : "") + (r.italic ? "<w:i/><w:iCs/>" : "")
      + (r.color ? `<w:color w:val="${r.color}"/>` : para.caption ? "<w:color w:val=\"6B7280\"/>" : "")
      + (r.size ? `<w:sz w:val="${r.size}"/><w:szCs w:val="${r.size}"/>` : para.caption ? "<w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/>" : "")
      + (r.underline ? "<w:u w:val=\"single\"/>" : "")
      + (r.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${r.highlight}"/>` : "");
    // Tabulations et retours : un run par morceau.
    return r.text.split("\n").map((part, i) =>
      (i ? "<w:r><w:br/></w:r>" : "") + (part
        ? `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`
        : "")).join("");
  }

  /** Equation en ligne ; repli image, sinon texte simple (jamais le LaTeX brut). */
  math(latex: string, color?: string): string {
    const omml = latexToOmml(latex, { color });
    if (omml) return omml;
    const img = this.fallback?.(latex) ?? null;
    if (img) return this.image(img);
    return this.text({ kind: "text", text: this.plainOf(latex), italic: true, color }, { runs: [] });
  }

  para(p: DxPara): string {
    const pPr: string[] = [];
    if (p.heading) pPr.push(`<w:pStyle w:val="Heading${p.heading}"/>`);
    else if (p.list) pPr.push("<w:pStyle w:val=\"ListParagraph\"/>");
    else if (p.caption) pPr.push("<w:pStyle w:val=\"Caption\"/>");
    if (p.pageBreakBefore) pPr.push("<w:pageBreakBefore/>");
    if (p.list) {
      pPr.push(`<w:numPr><w:ilvl w:val="${Math.max(0, Math.min(4, p.list.level))}"/><w:numId w:val="${this.numbering.idFor(p.list)}"/></w:numPr>`);
    } else {
      this.numbering.reset();
    }
    if (p.shade) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.shade}"/>`);
    if (p.indent) pPr.push(`<w:ind w:left="${Math.round(p.indent)}"/>`);
    if (p.align === "center") pPr.push("<w:jc w:val=\"center\"/>");
    // Equation seule sur sa ligne : bloc d'equation centre (m:oMathPara).
    const lone = p.runs.length === 1 && p.runs[0].kind === "math" && !p.list && !p.heading;
    let body = "";
    if (lone) {
      const r = p.runs[0] as Extract<DxRun, { kind: "math" }>;
      const m = this.math(r.latex, r.color);
      body = m.startsWith("<m:oMath>") ? `<m:oMathPara>${m}</m:oMathPara>` : m;
    } else {
      for (const r of p.runs) {
        if (r.kind === "text") body += this.text(r, p);
        else if (r.kind === "math") body += this.math(r.latex, r.color);
        else if (r.kind === "image") body += this.image(r.image);
        else body += "<w:r><w:br/></w:r>";
      }
    }
    return `<w:p>${pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${body}</w:p>`;
  }
}

function stylesXml(): string {
  const heading = (n: number, size: number, color: string, before: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`
    + `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>`
    + `<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return `${XML_HEAD}<w:styles xmlns:w="${NS.w}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>`
    + `<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="fr-FR" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + `<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + heading(1, 32, "2F5496", 240) + heading(2, 26, "2F5496", 200) + heading(3, 24, "1F3763", 160)
    + `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>`
    + `</w:styles>`;
}

function settingsXml(): string {
  return `${XML_HEAD}<w:settings xmlns:w="${NS.w}" xmlns:m="${NS.m}">`
    + `<w:defaultTabStop w:val="708"/><w:hyphenationZone w:val="425"/><w:characterSpacingControl w:val="doNotCompress"/>`
    + `<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:brkBinSub m:val="--"/><m:smallFrac m:val="0"/><m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/><m:wrapIndent m:val="1440"/><m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>`
    + `<w:themeFontLang w:val="fr-FR"/><w:decimalSymbol w:val=","/><w:listSeparator w:val=";"/>`
    + `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>`
    + `</w:settings>`;
}

function coreXml(title: string, now: string): string {
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${escapeXml(title)}</dc:title><dc:creator>Cahiers</dc:creator><dc:language>fr-FR</dc:language>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + `</cp:coreProperties>`;
}

/** Fichiers du paquet .docx (pour les tests), dans l'ordre de l'archive. */
export function docxParts(doc: DxDoc, opts: { fallback?: MathFallback; plain?: (latex: string) => string; now?: string } = {}): ZipEntry[] {
  const b = new Builder(opts.fallback ?? null, opts.plain ?? ((l) => l.replace(/\\[a-zA-Z]+|[{}\\_^$]/g, " ").replace(/\s+/g, " ").trim()));
  const paras = doc.paras.length ? doc.paras : [{ runs: [] }];
  const body = paras.map((p) => b.para(p)).join("");
  const sect = `<w:sectPr><w:pgSz w:w="${PAGE_W_TW}" w:h="${PAGE_H_TW}"/>`
    + `<w:pgMar w:top="${MARGIN_TW}" w:right="${MARGIN_TW}" w:bottom="${MARGIN_TW}" w:left="${MARGIN_TW}" w:header="708" w:footer="708" w:gutter="0"/>`
    + `<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`;
  const document = `${XML_HEAD}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:m="${NS.m}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}">`
    + `<w:body>${body}${sect}</w:body></w:document>`;
  const hasPng = b.media.some((m) => m.image.type === "png");
  const hasJpeg = b.media.some((m) => m.image.type === "jpeg");
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + (hasPng ? `<Default Extension="png" ContentType="image/png"/>` : "")
    + (hasJpeg ? `<Default Extension="jpeg" ContentType="image/jpeg"/>` : "")
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
    + `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`
    + `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>`
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
    + `</Types>`;
  const rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`
    + `</Relationships>`;
  const docRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`
    + `<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`
    + b.media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join("")
    + `</Relationships>`;
  const now = opts.now ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return [
    { name: "[Content_Types].xml", data: types },
    { name: "_rels/.rels", data: rels },
    { name: "docProps/core.xml", data: coreXml(doc.title, now) },
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: docRels },
    { name: "word/styles.xml", data: stylesXml() },
    { name: "word/numbering.xml", data: b.numbering.xml() },
    { name: "word/settings.xml", data: settingsXml() },
    ...b.media.map((m) => ({ name: `word/media/${m.name}`, data: m.image.data })),
  ];
}

/** Le .docx complet, en octets. */
export function buildDocx(doc: DxDoc, opts: { fallback?: MathFallback; plain?: (latex: string) => string; now?: string } = {}): Uint8Array {
  return zipStore(docxParts(doc, opts));
}
