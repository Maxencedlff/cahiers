/**
 * Import d'un PDF dans l'intercalaire (priorite 3) : choix du fichier (menu
 * « ⋯ », Ctrl+O, ou depot d'un .pdf sur la page), choix des pages, copie
 * unique dans assets/ (dedoublonnage par empreinte), puis une page de
 * l'appli par page du PDF, inseree apres la page courante.
 */
import { askFields, el, toast } from "./dom";
import type { Repo } from "../core/storage/repo";
import type { Page } from "../core/types";
import { uuid, nowIso } from "../core/id";
import {
  findPdfAsset, hashBytes, isPdfFile, makePdfPage, parsePageRange, pdfAssetName, rangeLabel,
} from "../core/pdf/pdf";
import { adoptPdfDoc, openPdf, pageSize, pageText } from "./pdf";

/** Ce que l'import demande a la vue de l'intercalaire (PageView). */
export interface PdfImportTarget {
  notebook: string;
  divider: string;
  /** Insere les pages apres la page courante ; rend le numero de la premiere, ou null (refus). */
  insertPages(pages: Page[]): Promise<number | null>;
  /** Vue en lecture seule (autre PC) : rien n'est importe. */
  readonly readOnly: boolean;
}

/** Selecteur de fichier limite aux PDF. null : ferme sans choix. */
export function pickPdf(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept: "application/pdf,.pdf", style: { display: "none" } });
    let done = false;
    const finish = (f: File | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** Premier PDF d'un depot ou d'un presse-papiers, s'il y en a un. */
export function pdfFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []).filter((f) => isPdfFile(f));
}

/** Le depot en cours contient-il un PDF ? (pendant dragover, seuls les types sont lisibles.) */
export function dragHasPdf(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.items ?? []).some((i) => i.kind === "file" && i.type === "application/pdf");
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("lecture impossible"));
    r.readAsDataURL(file);
  });
}

/** Message lisible pour une erreur de pdf.js. */
function pdfError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "PasswordException") return "PDF protégé par un mot de passe : ouvre-le et enregistre-le sans protection d'abord";
  if (name === "InvalidPDFException") return "ce fichier n'est pas un PDF valide (ou il est abîmé)";
  return e instanceof Error ? e.message : String(e);
}

/**
 * Importe `file` (deja choisi, ou demande ici) dans la vue. Rend le nombre
 * de pages importees (0 : annule ou refuse).
 */
export async function importPdf(repo: Repo, target: PdfImportTarget, file?: File | null): Promise<number> {
  if (target.readOnly) { toast("Cahier en lecture seule : import impossible", "warn"); return 0; }
  const f = file ?? (await pickPdf());
  if (!f) return 0;
  if (!isPdfFile(f)) { toast(`« ${f.name} » n'est pas un PDF`, "warn"); return 0; }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await f.arrayBuffer());
  } catch (e) {
    toast(`Lecture de « ${f.name} » impossible : ${pdfError(e)}`, "err", 6000);
    return 0;
  }
  let doc;
  try {
    doc = await openPdf(bytes);
  } catch (e) {
    toast(`« ${f.name} » : ${pdfError(e)}`, "err", 7000);
    return 0;
  }
  const total = doc.numPages;
  const answer = await askFields(
    `Importer « ${f.name} »`,
    [{
      name: "pages",
      label: `Pages à importer (${total} au total) : « toutes », ou par exemple 1-3, 5. Elles arrivent après la page courante.`,
      value: "toutes",
      placeholder: "toutes",
    }],
    "Importer",
    async (v) => {
      const r = parsePageRange(v.pages ?? "", total);
      return "error" in r ? { message: r.error } : null;
    },
  );
  if (!answer) { void doc.loadingTask.destroy(); return 0; }
  const range = parsePageRange(answer.pages ?? "", total);
  if ("error" in range) { void doc.loadingTask.destroy(); return 0; }
  const pages = range.pages;
  if (pages.length > 4) toast(`Import de ${pages.length} pages…`, "info", 2500, undefined, "pdf-import");

  try {
    // Le PDF entier, une seule fois dans assets/ : un second import du
    // meme fichier (meme empreinte) reutilise la copie deja la.
    const hash = hashBytes(bytes);
    const existing = findPdfAsset(await repo.listAssets(target.notebook, target.divider), hash);
    const src = existing
      ? `assets/${existing}`
      : await repo.writeAsset(target.notebook, target.divider, pdfAssetName(f.name, hash), await readAsDataUrl(f));
    adoptPdfDoc(`${target.notebook}/${target.divider}/${src}`, doc);

    const now = nowIso();
    const made: Page[] = [];
    for (const n of pages) {
      const page = await doc.getPage(n);
      made.push(makePdfPage({ page: uuid(), block: uuid() }, now, {
        src, page: n, size: pageSize(page), text: await pageText(page), name: f.name,
      }));
      page.cleanup();
    }
    const first = await target.insertPages(made);
    if (first === null) return 0;
    const what = pages.length === total
      ? `${total} page${total > 1 ? "s" : ""}`
      : `pages ${rangeLabel(pages)}`;
    toast(`« ${f.name} » importé (${what}) à partir de la p. ${first}`
      + (existing ? " ; PDF déjà présent dans le dossier, pas recopié" : ""), "info", 4500, undefined, "pdf-import");
    return made.length;
  } catch (e) {
    toast(`Import de « ${f.name} » impossible : ${pdfError(e)}`, "err", 7000, undefined, "pdf-import");
    return 0;
  }
}
