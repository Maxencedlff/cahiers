import { el, toast } from "./dom";
import { dewarp, binarize, defaultQuad, targetSize, type Quad } from "../core/image/dewarp";
import {
  ORIGINAL_MAX, FINAL_MAX, PREVIEW_MAX, JPEG_QUALITY,
  binarizeRadius, fitRatio, scaleQuad, roundQuad, readQuad, cropLayout, cropKey,
  photoFileNames, finalMime, unreadableMessage, loadBwChoice, saveBwChoice,
  type CropLayout,
} from "../core/image/photo";
import type { ImageBlock } from "../core/types";

/**
 * Import d'une photo, redressement de perspective et OCR (section 6, P2).
 *
 * Sans OCR, une photo est un trou noir dans la recherche : c'est la raison
 * d'etre du champ `ocr` du bloc image. La photo d'origine est toujours
 * gardee (D9), avec ses coins, pour pouvoir « Redresser a nouveau ».
 * Logique pure (mise en page, touches, noms) : src/core/image/photo.ts.
 */

export interface ImportResult {
  /** Image redressee, en data URL : PNG en noir et blanc, JPEG en couleur. */
  dataUrl: string;
  /** Extension du fichier redresse, a transmettre au nom du fichier. */
  ext: "png" | "jpg";
  width: number;
  height: number;
  ocr: string | null;
  /** Noir et blanc applique. */
  bw: boolean;
  /**
   * Photo d'origine en JPEG (data URL), reduite a ORIGINAL_MAX. null quand
   * elle est deja sur le disque (« Redresser a nouveau »).
   */
  original: string | null;
  /** Coins du redressement, en pixels de `original`. */
  quad: Quad;
}

export interface ImportOptions {
  /** OCR fourni par la plateforme. Absent en mode navigateur. */
  ocr?: (dataUrl: string) => Promise<string>;
}

export interface CropOptions extends ImportOptions {
  /** Coins de depart, en pixels de l'image donnee (« Redresser a nouveau »). */
  quad?: Quad | null;
  /** Noir et blanc de depart ; sinon le dernier choix retenu (D9). */
  bw?: boolean;
  /** L'image donnee est l'original deja enregistre : ne pas le reecrire. */
  originalSaved?: boolean;
  /** Import de plusieurs photos : rang (0..) et nombre total. */
  index?: number;
  total?: number;
}

/* ------------------------------------------------------------------ */
/* Choix et decodage des fichiers                                      */
/* ------------------------------------------------------------------ */

/**
 * Ouvre le selecteur de fichiers. Plusieurs photos d'un coup : en fin de
 * cours, on en a pris quatre. Le HEIC est propose pour pouvoir dire
 * pourquoi il ne passe pas, au lieu de le cacher.
 */
export function pickFiles(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = el("input", {
      type: "file", accept: "image/*,.heic,.heif", multiple, style: { display: "none" },
    });
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    // Selecteur ferme sans choix : rien ne vient sur « change ».
    input.addEventListener("cancel", () => finish([]));
    document.body.append(input);
    input.click();
  });
}

/** Decode une image (fichier ou data URL). null si le navigateur ne sait pas la lire. */
export function loadImage(src: File | string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = typeof src === "string" ? src : URL.createObjectURL(src);
    const img = new Image();
    const done = (ok: boolean) => {
      if (typeof src !== "string") URL.revokeObjectURL(url);
      resolve(ok && img.naturalWidth > 0 ? img : null);
    };
    img.onload = () => {
      // decode() : l'image est prete a dessiner, sans saccade au premier trace.
      img.decode().then(() => done(true), () => done(true));
    };
    img.onerror = () => done(false);
    img.src = url;
  });
}

/** Decode un fichier ; illisible (HEIC de l'iPhone...) = toast qui dit pourquoi. */
async function loadOrWarn(file: File): Promise<HTMLImageElement | null> {
  const img = await loadImage(file);
  if (!img) toast(unreadableMessage(file.name, file.type), "err", 9000);
  return img;
}

/* ------------------------------------------------------------------ */
/* Flux complet : plusieurs photos, un dialogue par photo              */
/* ------------------------------------------------------------------ */

export interface ImportFlow extends ImportOptions {
  /**
   * Insere une photo validee (ecriture des fichiers + bloc). Appele avant
   * le dialogue suivant : chaque photo est posee des qu'elle est validee.
   * Rendre false arrete l'enchainement (ecriture refusee, page en lecture seule).
   */
  insert: (result: ImportResult) => Promise<boolean | void>;
}

/**
 * Import complet : selecteur multiple, puis un dialogue de redressement par
 * photo (« Insérer et suivante », « Passer »). Rend le nombre de photos
 * inserees. Echap arrete tout ; les photos deja inserees restent.
 */
export async function importPhotos(flow: ImportFlow): Promise<number> {
  const files = await pickFiles(true);
  let inserted = 0;
  for (let i = 0; i < files.length; i++) {
    const img = await loadOrWarn(files[i]);
    if (!img) continue;
    const r = await cropStep(img, { ocr: flow.ocr, index: i, total: files.length });
    if (r === "skip") continue;
    if (!r) break;
    if ((await flow.insert(r)) === false) break;
    inserted++;
  }
  return inserted;
}

/* ------------------------------------------------------------------ */
/* Enregistrement et « Redresser a nouveau »                           */
/* ------------------------------------------------------------------ */

/** Champs du bloc image issus d'un import. */
export type PhotoFields = Pick<ImageBlock, "src" | "ocr" | "bw" | "quad"> & { original?: string };

/**
 * Ecrit l'image redressee et l'original dans assets/ et rend les champs du
 * bloc. `write(name, dataUrl)` rend le chemin a stocker (Repo.writeAsset).
 * `existingOriginal` : chemin de l'original deja sur le disque.
 *
 * L'image redressee d'abord : c'est elle qui compte. Si l'original ne
 * s'ecrit pas, la photo est quand meme posee (sans « Redresser a nouveau »)
 * et on le dit.
 */
export async function savePhoto(
  result: ImportResult, id: string,
  write: (name: string, dataUrl: string) => Promise<string>,
  existingOriginal?: string,
): Promise<PhotoFields> {
  const names = photoFileNames(id, result.bw);
  const src = await write(names.final, result.dataUrl);
  const out: PhotoFields = { src, ocr: result.ocr, bw: result.bw };
  let original = existingOriginal;
  if (result.original) {
    try {
      original = await write(names.original, result.original);
    } catch (e) {
      original = undefined;
      toast(`Photo d'origine non gardée : ${(e as Error).message}`, "warn", 6000);
    }
  }
  if (original) {
    out.original = original;
    out.quad = roundQuad(result.quad);
  }
  return out;
}

/**
 * « Redresser a nouveau » : rouvre le dialogue sur l'original d'un bloc,
 * avec ses coins et son choix noir et blanc. `read(src)` rend la data URL
 * (Repo.readAsset). null si le bloc n'a pas d'original (photo d'avant le
 * lot 10), si le fichier manque, ou si l'utilisateur annule.
 */
export async function recropPhoto(
  block: ImageBlock, read: (src: string) => Promise<string>, opts: ImportOptions = {},
): Promise<ImportResult | null> {
  if (!block.original) {
    toast("Pas de photo d'origine pour cette image (importée avant cette version).", "warn", 6000);
    return null;
  }
  let img: HTMLImageElement | null = null;
  try {
    img = await loadImage(await read(block.original));
  } catch { img = null; }
  if (!img) { toast("Photo d'origine introuvable", "err", 6000); return null; }
  return cropDialog(img, {
    ...opts, quad: readQuad(block.quad), bw: block.bw, originalSaved: true,
  });
}

/* ------------------------------------------------------------------ */
/* Dialogue de redressement                                            */
/* ------------------------------------------------------------------ */

/**
 * Dialogue de recadrage. Quatre coins deplacables au doigt, apercu en direct
 * du resultat redresse. Rien n'est devine automatiquement : sur une photo de
 * tableau, une detection ratee coute plus cher que quatre appuis.
 */
export async function cropDialog(img: HTMLImageElement, opts: CropOptions = {}): Promise<ImportResult | null> {
  const r = await cropStep(img, { ...opts, total: 1, index: 0 });
  return r === "skip" ? null : r;
}

function cropStep(img: HTMLImageElement, opts: CropOptions): Promise<ImportResult | "skip" | null> {
  return new Promise((resolve) => {
    const total = Math.max(1, opts.total ?? 1);
    const index = opts.index ?? 0;
    const more = index < total - 1;

    // Image de travail = l'original garde, reduit a ORIGINAL_MAX. Les coins
    // sont dans ses pixels : ce sont eux qu'on enregistre dans le bloc.
    const k = fitRatio(img.naturalWidth, img.naturalHeight, ORIGINAL_MAX);
    const srcW = Math.max(1, Math.round(img.naturalWidth * k));
    const srcH = Math.max(1, Math.round(img.naturalHeight * k));
    const source = el("canvas", { width: String(srcW), height: String(srcH) });
    const sctx = source.getContext("2d")!;
    sctx.drawImage(img, 0, 0, srcW, srcH);
    const imageData = sctx.getImageData(0, 0, srcW, srcH);

    const initialQuad = (): Quad => defaultQuad(srcW, srcH);
    let quad: Quad = opts.quad ? clampQuad(scaleQuad(opts.quad, k), srcW, srcH) : initialQuad();
    let noir = opts.bw ?? loadBwChoice();
    let dragging = -1;
    let busy = false;
    let closed = false;

    const view = el("canvas", { class: "crop-view" });
    const vctx = view.getContext("2d")!;
    // Photo reduite a la taille de la vue, dessinee une fois par mise en
    // page : chaque mouvement de coin ne redessine pas 2560 px.
    const thumb = el("canvas");
    const preview = el("canvas", { class: "crop-preview" });
    let layout: CropLayout = cropLayout(srcW, srcH, window.innerWidth, window.innerHeight);

    const toView = (p: { x: number; y: number }) => ({ x: p.x * layout.scale, y: p.y * layout.scale });

    const paint = () => {
      const { viewW, viewH } = layout;
      vctx.clearRect(0, 0, viewW, viewH);
      vctx.drawImage(thumb, 0, 0);
      vctx.strokeStyle = "#2563eb";
      vctx.lineWidth = 2;
      vctx.beginPath();
      quad.forEach((p, i) => {
        const v = toView(p);
        if (i === 0) vctx.moveTo(v.x, v.y); else vctx.lineTo(v.x, v.y);
      });
      vctx.closePath();
      vctx.stroke();
      vctx.fillStyle = "rgba(37,99,235,.12)";
      vctx.fill();
      // Poignees larges : on doit pouvoir les attraper au doigt.
      for (const p of quad) {
        const v = toView(p);
        vctx.beginPath();
        vctx.arc(v.x, v.y, 11, 0, Math.PI * 2);
        vctx.fillStyle = "#fff";
        vctx.fill();
        vctx.strokeStyle = "#2563eb";
        vctx.stroke();
      }
    };

    const applyLayout = () => {
      layout = cropLayout(srcW, srcH, window.innerWidth, window.innerHeight);
      const { viewW, viewH } = layout;
      view.width = viewW;
      view.height = viewH;
      view.style.width = `${viewW}px`;
      view.style.height = `${viewH}px`;
      thumb.width = viewW;
      thumb.height = viewH;
      const tctx = thumb.getContext("2d")!;
      tctx.imageSmoothingQuality = "high";
      tctx.drawImage(source, 0, 0, viewW, viewH);
      body.classList.toggle("side", layout.side);
      side.style.width = layout.side ? `${layout.previewW}px` : "";
      preview.style.maxWidth = `${layout.previewW}px`;
      preview.style.maxHeight = `${layout.previewH}px`;
      paint();
    };

    /** Redresse a la taille voulue (plus grand cote <= max), noir et blanc compris. */
    const render = (max: number): ImageData | null => {
      const size = targetSize(quad);
      const ratio = fitRatio(size.width, size.height, max);
      const out = dewarp(imageData, quad, {
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
      });
      if (!out) return null;
      return noir ? binarize(out, binarizeRadius(out.width, out.height)) : out;
    };

    const refreshPreview = () => {
      const final = render(PREVIEW_MAX);
      if (!final) return;
      preview.width = final.width;
      preview.height = final.height;
      preview.getContext("2d")!.putImageData(final, 0, 0);
    };

    const nearest = (x: number, y: number): number => {
      let best = -1, dist = 26;
      quad.forEach((p, i) => {
        const v = toView(p);
        const d = Math.hypot(v.x - x, v.y - y);
        if (d < dist) { dist = d; best = i; }
      });
      return best;
    };

    view.addEventListener("pointerdown", (e) => {
      if (busy) return;
      const r = view.getBoundingClientRect();
      dragging = nearest(e.clientX - r.left, e.clientY - r.top);
      if (dragging >= 0) view.setPointerCapture(e.pointerId);
    });
    view.addEventListener("pointermove", (e) => {
      if (dragging < 0) return;
      const r = view.getBoundingClientRect();
      quad[dragging] = {
        x: Math.max(0, Math.min(srcW, (e.clientX - r.left) / layout.scale)),
        y: Math.max(0, Math.min(srcH, (e.clientY - r.top) / layout.scale)),
      };
      paint();
    });
    const stop = () => {
      if (dragging < 0) return;
      dragging = -1;
      refreshPreview();
    };
    view.addEventListener("pointerup", stop);
    view.addEventListener("pointercancel", stop);

    const status = el("div", { class: "small muted crop-status" },
      "Déplace les quatre coins sur ceux du tableau.");

    const bwBtn = el("button", {
      class: noir ? "on" : "", title: "Noir et blanc (N)", "aria-pressed": String(noir),
    }, "Noir et blanc");
    const setBw = (v: boolean) => {
      noir = v;
      bwBtn.classList.toggle("on", noir);
      bwBtn.setAttribute("aria-pressed", String(noir));
      refreshPreview();
    };
    bwBtn.addEventListener("click", () => { if (!busy) setBw(!noir); });

    const reset = () => {
      if (busy) return;
      quad = initialQuad();
      paint();
      refreshPreview();
    };
    const resetBtn = el("button", { title: "Réinitialiser les coins (R)", onclick: reset }, "Réinitialiser");

    const close = (r: ImportResult | "skip" | null) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      backdrop.remove();
      resolve(r);
    };

    const valider = async () => {
      if (busy) return;
      const final = render(FINAL_MAX);
      if (!final) { toast("Coins invalides", "err"); return; }
      busy = true;
      backdrop.classList.add("busy");
      for (const b of buttons) b.disabled = true;
      const canvas = el("canvas", { width: String(final.width), height: String(final.height) });
      canvas.getContext("2d")!.putImageData(final, 0, 0);
      // Couleur en JPEG : une photo de 1600 px pesait 3 a 5 Mo en PNG.
      const dataUrl = canvas.toDataURL(finalMime(noir), JPEG_QUALITY);
      const original = opts.originalSaved ? null : source.toDataURL("image/jpeg", JPEG_QUALITY);
      saveBwChoice(noir);

      let ocr: string | null = null;
      if (opts.ocr) {
        status.textContent = "Lecture du texte…";
        try {
          ocr = (await opts.ocr(dataUrl)).trim() || null;
        } catch (e) {
          ocr = null;
          toast(`OCR indisponible : ${(e as Error).message}`, "warn", 5000);
        }
      }
      close({
        dataUrl, ext: noir ? "png" : "jpg", width: final.width, height: final.height,
        ocr, bw: noir, original, quad: [...quad] as Quad,
      });
    };

    const onKey = (e: KeyboardEvent) => {
      // Un dialogue ouvert par-dessus (message, toast) garde la main.
      const open = document.querySelectorAll(".backdrop");
      if (open[open.length - 1] !== backdrop) return;
      const action = cropKey(e);
      if (!action) return;
      // Pris en capture : ni le texte de la page ni l'App ne voient la touche.
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      switch (action) {
        case "cancel": close(null); break;
        case "insert": void valider(); break;
        case "bw": setBw(!noir); break;
        case "reset": reset(); break;
        case "skip": if (total > 1) close("skip"); break;
      }
    };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeTimer = null; if (!closed) applyLayout(); }, 80);
    };

    const side = el("div", { class: "crop-side" },
      el("span", { class: "lbl small muted" }, "Aperçu redressé"),
      preview,
    );
    const body = el("div", { class: "content crop-body" },
      el("div", { class: "crop-stage" }, view, status),
      side,
    );
    const insertLabel = more ? "Insérer et suivante" : "Insérer dans la page";
    const buttons: HTMLButtonElement[] = [
      bwBtn,
      resetBtn,
      el("button", { title: more ? "Annuler les photos restantes (Échap)" : "Annuler (Échap)", onclick: () => close(null) }, "Annuler"),
      ...(total > 1 ? [el("button", { title: "Passer cette photo (S)", onclick: () => close("skip") }, "Passer")] : []),
      el("button", { class: "primary", title: `${insertLabel} (Entrée)`, onclick: () => void valider() }, insertLabel),
    ];
    const title = total > 1 ? `Redresser la photo ${index + 1} / ${total}` : "Redresser la photo";
    const backdrop = el("div", { class: "backdrop crop-backdrop" },
      el("div", { class: "modal crop-modal" },
        el("header", {}, title),
        body,
        el("footer", { class: "crop-footer" },
          el("div", { class: "crop-tools" }, buttons[0], buttons[1]),
          ...buttons.slice(2),
        ),
      ),
    );
    // Capture : le dialogue passe avant le texte de la page et App.onKey.
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    document.body.append(backdrop);
    // Le focus quitte le texte de la page : Entree ne doit pas y aller.
    (document.activeElement as HTMLElement | null)?.blur();
    applyLayout();
    refreshPreview();
  });
}

/** Coins ramenes dans l'image (quad d'un fichier edite a la main). */
function clampQuad(quad: Quad, w: number, h: number): Quad {
  return quad.map((p) => ({ x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) })) as Quad;
}
