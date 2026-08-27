import { el, toast } from "./dom";
import { dewarp, binarize, defaultQuad, targetSize, type Quad } from "../core/image/dewarp";

/**
 * Import d'une photo, redressement de perspective et OCR (section 6, P2).
 *
 * Sans OCR, une photo est un trou noir dans la recherche : c'est la raison
 * d'etre du champ `ocr` du bloc image.
 */

export interface ImportResult {
  /** PNG redresse, en data URL. */
  dataUrl: string;
  width: number;
  height: number;
  ocr: string | null;
}

export interface ImportOptions {
  /** OCR fourni par la plateforme. Absent en mode navigateur. */
  ocr?: (dataUrl: string) => Promise<string>;
}

/** Ouvre le selecteur de fichier et rend l'image chargee. */
export function pickImage(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = String(reader.result);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    document.body.append(input);
    input.click();
  });
}

/**
 * Dialogue de recadrage. Quatre coins deplacables au doigt, apercu en direct
 * du resultat redresse. Rien n'est devine automatiquement : sur une photo de
 * tableau, une detection ratee coute plus cher que quatre appuis.
 */
export function cropDialog(img: HTMLImageElement, opts: ImportOptions = {}): Promise<ImportResult | null> {
  return new Promise((resolve) => {
    const maxW = Math.min(720, window.innerWidth - 120);
    const scale = Math.min(1, maxW / img.width);
    const viewW = Math.round(img.width * scale);
    const viewH = Math.round(img.height * scale);

    const source = el("canvas", { width: String(img.width), height: String(img.height) });
    const sctx = source.getContext("2d")!;
    sctx.drawImage(img, 0, 0);
    const imageData = sctx.getImageData(0, 0, img.width, img.height);

    const view = el("canvas", {
      width: String(viewW), height: String(viewH),
      style: { width: `${viewW}px`, height: `${viewH}px`, touchAction: "none", borderRadius: "6px" },
    });
    const vctx = view.getContext("2d")!;
    const preview = el("canvas", { style: { maxWidth: "100%", borderRadius: "6px", border: "1px solid var(--line)" } });

    let quad: Quad = defaultQuad(img.width, img.height);
    let noir = true;
    let dragging = -1;

    const toView = (p: { x: number; y: number }) => ({ x: p.x * scale, y: p.y * scale });

    const paint = () => {
      vctx.clearRect(0, 0, viewW, viewH);
      vctx.drawImage(img, 0, 0, viewW, viewH);
      vctx.strokeStyle = "#2563eb";
      vctx.lineWidth = 2;
      vctx.beginPath();
      quad.forEach((p, i) => {
        const v = toView(p);
        i === 0 ? vctx.moveTo(v.x, v.y) : vctx.lineTo(v.x, v.y);
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

    const refreshPreview = () => {
      const size = targetSize(quad);
      const ratio = Math.min(1, 520 / size.width);
      const out = dewarp(imageData, quad, {
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
      });
      if (!out) return;
      const final = noir ? binarize(out) : out;
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
      const r = view.getBoundingClientRect();
      dragging = nearest(e.clientX - r.left, e.clientY - r.top);
      if (dragging >= 0) view.setPointerCapture(e.pointerId);
    });
    view.addEventListener("pointermove", (e) => {
      if (dragging < 0) return;
      const r = view.getBoundingClientRect();
      quad[dragging] = {
        x: Math.max(0, Math.min(img.width, (e.clientX - r.left) / scale)),
        y: Math.max(0, Math.min(img.height, (e.clientY - r.top) / scale)),
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

    const status = el("div", { class: "small muted" }, "Deplace les quatre coins sur ceux du tableau.");

    const close = (r: ImportResult | null) => { backdrop.remove(); resolve(r); };

    const valider = async () => {
      const size = targetSize(quad);
      // Plein format pour le fichier enregistre, borne pour ne pas exploser.
      const ratio = Math.min(1, 1600 / Math.max(size.width, size.height));
      const out = dewarp(imageData, quad, {
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
      });
      if (!out) { toast("Coins invalides", "err"); return; }
      const final = noir ? binarize(out) : out;
      const canvas = el("canvas", { width: String(final.width), height: String(final.height) });
      canvas.getContext("2d")!.putImageData(final, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");

      let ocr: string | null = null;
      if (opts.ocr) {
        status.textContent = "Lecture du texte...";
        try {
          ocr = (await opts.ocr(dataUrl)).trim() || null;
        } catch (e) {
          ocr = null;
          toast(`OCR indisponible : ${(e as Error).message}`, "warn", 5000);
        }
      }
      close({ dataUrl, width: final.width, height: final.height, ocr });
    };

    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal", style: { width: "min(880px, 100%)" } },
        el("header", {}, "Redresser la photo"),
        el("div", { class: "content" },
          view,
          status,
          el("div", { class: "row" },
            el("button", {
              class: noir ? "on" : "",
              onclick: (e: Event) => {
                noir = !noir;
                (e.currentTarget as HTMLElement).classList.toggle("on", noir);
                refreshPreview();
              },
            }, "Noir et blanc"),
            el("button", {
              onclick: () => { quad = defaultQuad(img.width, img.height); paint(); refreshPreview(); },
            }, "Reinitialiser les coins"),
          ),
          el("span", { class: "lbl small muted" }, "Apercu redresse"),
          preview,
        ),
        el("footer", {},
          el("button", { onclick: () => close(null) }, "Annuler"),
          el("button", { class: "primary", onclick: () => void valider() }, "Inserer dans la page"),
        ),
      ),
    );
    document.body.append(backdrop);
    paint();
    refreshPreview();
  });
}
