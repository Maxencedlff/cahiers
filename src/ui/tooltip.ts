import { effectiveTheme, type SheetTone, type ThemePref } from "../core/theme";

/**
 * Infobulles du chrome : nom de l'outil et son raccourci, dans une bulle
 * nette posee a cote du bouton (le `title` natif arrive tard, en petit, et
 * se colle sous le curseur). Seulement a la souris : au doigt et au stylet,
 * une bulle qui reste affichee masquerait la page.
 *
 * Un bouton porte `data-tip` (nom) et, s'il en a un, `data-keys`
 * (« Alt+E »). `data-tip-side` = right (rail), bottom (barre du haut) ou top (indicateur de page).
 */

let bubble: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let current: HTMLElement | null = null;

function hide(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = null;
  bubble?.classList.remove("show");
}

function show(target: HTMLElement): void {
  if (!target.isConnected) return;
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "tip";
    bubble.setAttribute("role", "tooltip");
    document.body.append(bubble);
  }
  const label = target.dataset.tip ?? "";
  const keys = target.dataset.keys ?? "";
  bubble.replaceChildren(document.createTextNode(label));
  if (keys) {
    const k = document.createElement("kbd");
    k.textContent = keys;
    bubble.append(k);
  }
  bubble.classList.add("show");
  const r = target.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const side = target.dataset.tipSide ?? "right";
  let x: number, y: number;
  if (side === "bottom" || side === "top") {
    x = r.left + r.width / 2 - b.width / 2;
    y = side === "top" ? r.top - b.height - 6 : r.bottom + 6;
  } else {
    x = r.right + 8;
    y = r.top + r.height / 2 - b.height / 2;
  }
  x = Math.max(6, Math.min(x, window.innerWidth - b.width - 6));
  y = Math.max(6, Math.min(y, window.innerHeight - b.height - 6));
  bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** Pose les ecouteurs une fois pour toute l'appli. */
export function installTooltips(): void {
  document.addEventListener("pointerover", (e) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
    if (!t || e.pointerType !== "mouse") return;
    if (t === current) return;
    hide();
    current = t;
    // Deja une bulle a l'ecran il y a un instant : la suivante sans attendre.
    timer = setTimeout(() => show(t), 380);
  }, true);
  document.addEventListener("pointerout", (e) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]");
    const to = (e.relatedTarget as Element | null)?.closest?.("[data-tip]");
    if (t && t !== to) hide();
  }, true);
  for (const type of ["pointerdown", "keydown", "wheel", "blur"] as const) {
    window.addEventListener(type, hide, true);
  }
}

/* ---------------- apparence ---------------- */

const media = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/**
 * Applique le theme (sur <html> : chrome, dialogues, menus) et la teinte de
 * la feuille (sur la racine de l'appli seulement : l'export PDF, pose hors
 * de l'appli, garde toujours la feuille claire et l'encre noire).
 */
export function applyAppearance(appRoot: HTMLElement, pref: ThemePref, sheet: SheetTone): void {
  const theme = effectiveTheme(pref, !!media?.matches);
  document.documentElement.dataset.theme = theme;
  appRoot.dataset.sheet = sheet;
}

/** Windows change de theme : rappelle `run` si l'on suit le systeme. */
export function onSystemThemeChange(run: () => void): void {
  media?.addEventListener?.("change", run);
}
