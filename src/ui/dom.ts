/** Micro-utilitaires DOM. Pas de framework : l'empreinte memoire compte. */

import { toastPlacement, toastsToDrop } from "../core/chrome";
import { icon, type IconName } from "./icons";

type Attrs = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "html") node.innerHTML = String(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Appui long (stylet, doigt ou souris) ou clic droit : le menu d'un
 * element sans passer par le clic droit, introuvable au stylet. Le clic du
 * relachement est avale, sinon l'appui long ouvrait aussi l'element.
 * `run` recoit le point de l'appui : le menu s'ouvre sous le doigt.
 */
export function onLongPress(node: HTMLElement, run: (at: { x: number; y: number }) => void, ms = 500): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; start = null; };
  node.addEventListener("pointerdown", (e) => {
    fired = false;
    if (e.button !== 0) return;
    const at = { x: e.clientX, y: e.clientY };
    start = at;
    timer = setTimeout(() => { timer = null; fired = true; run(at); }, ms);
  });
  node.addEventListener("pointermove", (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) node.addEventListener(t, cancel);
  node.addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  // Le doigt maintenu declenche aussi contextmenu sous Windows : un seul menu.
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (fired) return;
    cancel();
    fired = true;
    run({ x: e.clientX, y: e.clientY });
  });
}

/* ---------------- menus contextuels ---------------- */

/** Une ligne de menu : libelle, icone, touches, action ou sous-menu. */
export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Raccourci montre a droite (« Ctrl+N »). */
  keys?: string;
  run?: () => void;
  /** Action destructive : en rouge, a part. */
  danger?: boolean;
  /** Choix actif d'un groupe (coche). */
  checked?: boolean;
  disabled?: boolean;
  sub?: MenuEntry[];
  /** Carre de couleur (matiere) a la place de l'icone. */
  swatch?: string;
  /** Rendu montre a la place du libelle (formule) ; `label` reste le nom lu. */
  content?: Node;
}
/** Ligne, separateur ou titre de section. */
export type MenuEntry = MenuItem | "sep" | { title: string };

let openMenus: { node: HTMLElement; close: () => void }[] = [];

/** Ferme tous les menus contextuels ouverts. */
export function closeMenus(): void {
  for (const m of [...openMenus].reverse()) m.close();
}

/**
 * Vrai menu contextuel, compact (32 px par ligne a la souris, 44 au doigt
 * via `pointer: coarse`) : icone, libelle, raccourci, coche, sous-menu.
 * Un appui a cote, Echap, ou un choix le ferme ; pas de bouton « Annuler ».
 * Clavier : fleches, Entree, → ouvre un sous-menu, ← le referme. Le focus
 * reste ou il etait (le curseur du texte n'est pas perdu).
 * `at` : point (clic droit, appui long) ou bouton d'ancrage (menu ⋯).
 */
export function contextMenu(
  at: { x: number; y: number } | HTMLElement, entries: MenuEntry[],
  o: { align?: "start" | "end"; label?: string; onClose?: () => void; parent?: HTMLElement } = {},
): () => void {
  if (!o.parent) closeMenus();
  const node = el("div", { class: "ctx-menu", role: "menu", "aria-label": o.label ?? "Menu" });
  const items: { btn: HTMLButtonElement; item: MenuItem }[] = [];
  let sel = -1;
  let child: (() => void) | null = null;
  let childOf: HTMLButtonElement | null = null;

  const highlight = (i: number) => {
    sel = i;
    items.forEach((x, k) => x.btn.classList.toggle("kb", k === i));
  };
  const openSub = (btn: HTMLButtonElement, item: MenuItem) => {
    if (childOf === btn) return;
    child?.();
    childOf = btn;
    const r = btn.getBoundingClientRect();
    child = contextMenu({ x: r.right - 2, y: r.top - 5 }, item.sub!, {
      parent: btn, label: item.label, onClose: () => { if (childOf === btn) { childOf = null; child = null; } },
    });
  };

  for (const e of entries) {
    if (e === "sep") { node.append(el("div", { class: "ctx-sep", role: "separator" })); continue; }
    if ("title" in e) { node.append(el("div", { class: "ctx-title" }, e.title)); continue; }
    const btn = el("button", {
      class: `ctx-item${e.danger ? " danger" : ""}${e.sub ? " has-sub" : ""}`,
      role: e.checked != null ? "menuitemradio" : "menuitem",
      ...(e.checked != null ? { "aria-checked": String(e.checked) } : {}),
      ...(e.sub ? { "aria-haspopup": "menu" } : {}),
      disabled: e.disabled ? true : null,
      ...(e.content ? { "aria-label": e.label } : {}),
      tabindex: "-1",
    },
    el("span", { class: "ctx-icon" }, e.checked ? icon("check", 16) : e.icon ? icon(e.icon, 17)
      : e.swatch ? el("i", { class: "nb-sq", style: { background: e.swatch } }) : null),
    el("span", { class: "ctx-label" }, e.content ?? e.label),
    e.keys ? el("kbd", { class: "ctx-keys" }, e.keys) : null,
    e.sub ? el("span", { class: "ctx-chev" }, icon("chevronRight", 15)) : null);
    // Le focus reste dans la page : on continue de taper apres un choix.
    btn.addEventListener("pointerdown", (ev) => { if (ev.pointerType === "mouse") ev.preventDefault(); });
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    const idx = items.length;
    btn.addEventListener("pointerenter", () => {
      highlight(idx);
      if (e.sub) openSub(btn, e);
      else if (child) { child(); }
    });
    btn.addEventListener("click", () => {
      if (e.disabled) return;
      if (e.sub) { openSub(btn, e); return; }
      closeMenus();
      e.run?.();
    });
    items.push({ btn, item: e });
    node.append(btn);
  }

  const onDown = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (openMenus.some((m) => m.node.contains(t))) return;
    closeMenus();
    // L'appui sur le bouton d'ancrage referme seulement (pas de reouverture).
    if (at instanceof HTMLElement && at.contains(t)) {
      ev.stopPropagation(); ev.preventDefault();
      const eat = (c: Event) => { c.stopImmediatePropagation(); c.preventDefault(); };
      at.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => at.removeEventListener("click", eat, { capture: true }), 600);
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    // Seul le menu le plus profond repond au clavier.
    if (openMenus[openMenus.length - 1]?.node !== node) return;
    const enabled = items.map((x, k) => (x.item.disabled ? -1 : k)).filter((k) => k >= 0);
    if (ev.key === "Escape" || (ev.key === "ArrowLeft" && o.parent)) {
      ev.preventDefault(); ev.stopPropagation();
      close();
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault(); ev.stopPropagation();
      if (!enabled.length) return;
      const at2 = enabled.indexOf(sel);
      const next = ev.key === "ArrowDown"
        ? enabled[(at2 + 1) % enabled.length]
        : enabled[(at2 - 1 + enabled.length) % enabled.length];
      highlight(next);
      return;
    }
    if ((ev.key === "ArrowRight" || ev.key === "Enter" || ev.key === " ") && sel >= 0) {
      ev.preventDefault(); ev.stopPropagation();
      const x = items[sel];
      if (x.item.sub) { openSub(x.btn, x.item); return; }
      if (ev.key !== "ArrowRight") x.btn.click();
      return;
    }
    if (ev.key === "Tab") { ev.preventDefault(); closeMenus(); }
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    child?.();
    node.remove();
    openMenus = openMenus.filter((m) => m.node !== node);
    if (!openMenus.length) {
      document.removeEventListener("pointerdown", onDown, true);
    }
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", closeAll);
    if (at instanceof HTMLElement && !o.parent) at.classList.remove("open");
    o.onClose?.();
  };
  const closeAll = () => closeMenus();
  document.body.append(node);
  openMenus.push({ node, close });
  if (openMenus.length === 1) document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", closeAll);

  // Place : sous le bouton (aligne a droite pour un ⋯ en bout de barre),
  // ou au point de l'appui, toujours entier a l'ecran.
  const w = node.offsetWidth, h = node.offsetHeight;
  const W = window.innerWidth, H = window.innerHeight;
  let x: number, y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    at.classList.add("open");
    x = o.align === "end" ? r.right - w : r.left;
    y = r.bottom + 4;
    if (y + h > H - 8 && r.top - h - 4 >= 8) y = r.top - h - 4;
  } else {
    x = at.x; y = at.y;
    // Sous-menu sans place a droite : a gauche de son parent.
    if (o.parent && x + w > W - 8) x = o.parent.getBoundingClientRect().left - w + 2;
  }
  x = Math.max(8, Math.min(x, W - w - 8));
  y = Math.max(8, Math.min(y, H - h - 8));
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
  return close;
}

/* ---------------- messages ephemeres ---------------- */

let toastHost: HTMLElement | null = null;

/** Bouton d'un message ephemere, par exemple « Annuler » apres une suppression. */
export interface ToastAction {
  label: string;
  run: () => void;
}

/**
 * Place de la pile de messages : en haut a droite sous la barre du haut,
 * jamais sur la zone d'ecriture centrale ; en bas a droite si une
 * calculatrice detachee occupe le coin (core/chrome.ts, toastPlacement).
 */
function placeToasts(host: HTMLElement): void {
  const bar = document.querySelector(".topbar")?.getBoundingClientRect();
  const avoid = [...document.querySelectorAll<HTMLElement>(".calc:not(.docked)")]
    .map((c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })
    // Fermee (display: none) : un rectangle vide, rien a eviter.
    .filter((r) => r.w > 0 && r.h > 0);
  const p = toastPlacement({
    width: window.innerWidth, height: window.innerHeight,
    top: bar ? Math.round(bar.bottom) : 0,
    // Indicateur de page en bas a droite de chaque panneau.
    bottom: 64,
    avoid,
  });
  host.classList.toggle("bottom", p.corner === "bottom-right");
  host.style.right = `${p.right}px`;
  host.style.top = p.corner === "top-right" ? `${p.offset}px` : "";
  host.style.bottom = p.corner === "bottom-right" ? `${p.offset}px` : "";
}

/**
 * Message ephemere. `key` : un message de meme cle remplace le precedent
 * au lieu de s'empiler (trois Ctrl+F = un seul message). Trois au plus, le
 * plus recent en haut ; chacun se ferme d'un appui sur sa croix.
 */
export function toast(
  message: string, kind: "info" | "warn" | "err" = "info", ms = 3200, action?: ToastAction, key?: string,
): void {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  placeToasts(toastHost);
  if (key) {
    for (const old of [...toastHost.children] as HTMLElement[]) if (old.dataset.key === key) old.remove();
  }
  const node = el("div", { class: `toast${kind === "info" ? "" : ` ${kind}`}` },
    el("span", { class: "toast-text" }, message));
  if (key) node.dataset.key = key;
  if (action) {
    node.classList.add("with-action");
    // Un seul appui : le message part aussitot, l'action ne se rejoue pas.
    const btn = el("button", {
      class: "toast-action",
      onclick: () => { node.remove(); action.run(); },
    }, action.label);
    // Le curseur reste dans le texte : on annule et on continue de taper.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    node.append(btn);
  }
  const close = el("button", {
    class: "toast-close", "aria-label": "Fermer le message", onclick: () => node.remove(),
  }, icon("close", 16));
  close.addEventListener("mousedown", (e) => e.preventDefault());
  node.append(close);
  // Trois messages au plus. Le plus ancien part, sauf s'il porte une action
  // (« Annuler ») et qu'un message sans action peut partir a sa place.
  // Pile affichee du plus recent (en haut) au plus ancien : l'ordre du DOM
  // est inverse par CSS (column-reverse), on travaille donc du plus ancien.
  const shown = [...toastHost.children] as HTMLElement[];
  for (const i of toastsToDrop(shown.map((t) => ({ action: t.classList.contains("with-action") }))).reverse()) {
    shown[i].remove();
  }
  toastHost.append(node);
  setTimeout(() => node.remove(), ms);
}

/** Retire le message pose avec cette cle, s'il est encore affiche. */
export function dismissToast(key: string): void {
  for (const t of [...(toastHost?.children ?? [])] as HTMLElement[]) if (t.dataset.key === key) t.remove();
}

/**
 * Ajoute une ligne discrete au message pose avec cette cle (rappel d'un
 * raccourci, par exemple). Rien si le message est deja parti.
 */
export function appendToToast(key: string, text: string): void {
  for (const t of [...(toastHost?.children ?? [])] as HTMLElement[]) {
    if (t.dataset.key !== key || t.querySelector(".toast-note")) continue;
    const note = el("span", { class: "toast-note" }, text);
    (t.querySelector(".toast-text") ?? t).append(note);
  }
}

/**
 * Prefixe de cle d'un message qui ne depend d'aucune page (matiere ou
 * intercalaire mis a la corbeille) : il survit au retour au menu.
 */
export const APP_TOAST = "app:";

/**
 * On quitte la page (menu, recherche, autre intercalaire) : ses messages a
 * bouton (« Annuler » d'un repere, d'une photo retiree) partent avec elle,
 * leur action n'aurait plus de sens a l'ecran suivant.
 */
export function dismissPageToasts(): void {
  for (const t of [...(toastHost?.children ?? [])] as HTMLElement[]) {
    if (t.classList.contains("with-action") && !(t.dataset.key ?? "").startsWith(APP_TOAST)) t.remove();
  }
}

/* ---------------- dialogues ---------------- */

/**
 * Fenetre de reglages ou de choix (Reglages, Partager) : titre, croix de
 * fermeture, contenu ; Echap ou un appui a cote la ferme. Pas de bouton
 * « Annuler » : chaque choix s'applique tout de suite, ou le bouton
 * principal du pied l'execute.
 */
export function sheetDialog(
  title: string, body: HTMLElement, o: { cls?: string; footer?: HTMLElement[]; onClose?: () => void } = {},
): { close: () => void; root: HTMLElement } {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".ctx-menu")) {
      // Un dialogue ouvert par-dessus (cles MyScript) prend son Echap.
      const top = [...document.querySelectorAll(".backdrop")].pop();
      if (top !== backdrop) return;
      e.preventDefault(); e.stopPropagation(); close();
    }
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    o.onClose?.();
  };
  const modal = el("div", { class: `modal sheet-dialog ${o.cls ?? ""}`.trim(), role: "dialog", "aria-label": title },
    el("header", { class: "sheet-head" }, el("span", {}, title),
      el("button", { class: "icon-btn sheet-x", "aria-label": "Fermer", onclick: () => close() }, icon("close", 18))),
    el("div", { class: "content" }, body),
    o.footer?.length ? el("footer", {}, ...o.footer) : null,
  );
  const backdrop = el("div", { class: "backdrop" }, modal);
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  return { close, root: modal };
}

export interface DialogField {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
}

/**
 * Verification avant de fermer le dialogue (cles essayees aupres du
 * service, par exemple). null = valide. Sinon le message s'affiche dans le
 * dialogue, qui reste ouvert ; `force` renomme le bouton et laisse valider
 * les memes valeurs au second appui (« Enregistrer sans tester »).
 */
export type FieldsCheck = (values: Record<string, string>) =>
  Promise<{ message: string; force?: string } | null>;

/**
 * Dialogue de saisie. Remplace window.prompt, qui n'existe pas dans une
 * WebView Tauri et qui ne serait de toute facon pas utilisable au doigt.
 * `intro` : phrase au-dessus des champs (ce que deviennent les valeurs).
 */
export function askFields(
  title: string, fields: DialogField[], okLabel = "Valider", check?: FieldsCheck, intro?: string,
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
    const content = el("div", { class: "content" });
    if (intro) content.append(el("p", { class: "small muted" }, intro));

    for (const f of fields) {
      const input = f.multiline
        ? el("textarea", { rows: "3", placeholder: f.placeholder ?? "" })
        : el("input", { type: "text", placeholder: f.placeholder ?? "" });
      input.value = f.value ?? "";
      inputs[f.name] = input;
      content.append(el("label", { class: "small muted" }, f.label), input);
    }

    const note = el("p", { class: "form-note", role: "status" });
    note.hidden = true;
    content.append(note);
    const ok = el("button", { class: "primary" }, okLabel);
    let closed = false;
    let busy = false;
    /** Valeurs deja refusees avec `force` : le second appui les garde. */
    let forced: string | null = null;

    const close = (result: Record<string, string> | null) => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const submit = async () => {
      if (busy) return;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(inputs)) out[k] = v.value.trim();
      const sig = JSON.stringify(out);
      if (!check || forced === sig) { close(out); return; }
      busy = true;
      ok.disabled = true;
      ok.textContent = "Vérification…";
      note.hidden = true;
      let verdict: { message: string; force?: string } | null;
      try { verdict = await check(out); } catch (e) {
        verdict = { message: e instanceof Error ? e.message : String(e), force: okLabel };
      }
      busy = false;
      ok.disabled = false;
      if (closed) return;
      if (!verdict) { close(out); return; }
      note.textContent = verdict.message;
      note.hidden = false;
      forced = verdict.force ? sig : null;
      ok.textContent = verdict.force ?? okLabel;
    };
    ok.addEventListener("click", () => void submit());
    // Valeurs modifiees apres un refus : on reverifie avant d'enregistrer.
    content.addEventListener("input", () => {
      if (forced) { forced = null; ok.textContent = okLabel; }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter" && !e.shiftKey && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault(); void submit();
      }
    };

    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal" },
        el("header", {}, title),
        content,
        el("footer", {},
          el("button", { onclick: () => close(null) }, "Annuler"),
          ok,
        ),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    setTimeout(() => Object.values(inputs)[0]?.focus(), 30);
  });
}

export async function askText(
  title: string, label: string, value = "",
): Promise<string | null> {
  const r = await askFields(title, [{ name: "v", label, value }]);
  return r ? r.v : null;
}

export function confirmDialog(title: string, message: string, okLabel = "Confirmer"): Promise<boolean> {
  return new Promise((resolve) => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(false); } };
    const close = (v: boolean) => {
      backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(v);
    };
    document.addEventListener("keydown", onKey);
    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal" },
        el("header", {}, title),
        el("div", { class: "content" }, el("p", { class: "muted" }, message)),
        el("footer", {},
          el("button", { onclick: () => close(false) }, "Annuler"),
          el("button", { class: "primary", onclick: () => close(true) }, okLabel),
        ),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(false); });
    document.body.append(backdrop);
  });
}

/**
 * Question a plusieurs reponses, chacune un bouton du pied (44 px). Echap
 * ou un appui a cote rend null : a l'appelant de choisir la reponse sure.
 */
export function chooseDialog(
  title: string, message: string, choices: { value: string; label: string; primary?: boolean }[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(null); } };
    const close = (v: string | null) => {
      backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(v);
    };
    document.addEventListener("keydown", onKey);
    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal" },
        el("header", {}, title),
        el("div", { class: "content" }, el("p", { class: "muted" }, message)),
        el("footer", {},
          ...choices.map((c) => el("button", {
            class: c.primary ? "primary" : "", onclick: () => close(c.value),
          }, c.label)),
        ),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.body.append(backdrop);
  });
}

/**
 * Choix dans une liste, au doigt. Le libelle peut etre un rendu (formule) ;
 * `name` le dit alors en mots. Avec `at` (point de l'appui ou element) :
 * petit menu pose la, sans voile ni bouton « Annuler » (un appui a cote ou
 * Echap le ferme) ; sinon fenetre.
 */
export function pick(
  title: string, options: { value: string; label: string | Node; name?: string }[],
  at?: { x: number; y: number } | HTMLElement,
): Promise<string | null> {
  if (at) {
    return new Promise((resolve) => {
      let done = false;
      const settle = (v: string | null) => { if (!done) { done = true; resolve(v); } };
      contextMenu(at, [
        { title },
        ...options.map((o): MenuItem => typeof o.label === "string"
          ? { label: o.label, run: () => settle(o.value) }
          : { label: o.name ?? o.value, content: o.label, run: () => settle(o.value) }),
      ], {
        label: title,
        // Un choix ferme le menu juste avant de courir : on attend sa reponse.
        onClose: () => queueMicrotask(() => settle(null)),
      });
    });
  }
  return new Promise((resolve) => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(null); } };
    const close = (v: string | null) => {
      backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(v);
    };
    document.addEventListener("keydown", onKey);
    const list = el("div", { class: "hits" },
      ...options.map((o) =>
        el("button", { class: "hit", onclick: () => close(o.value) }, o.label)),
    );
    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal" },
        el("header", {}, title),
        el("div", { class: "content" }, list),
        el("footer", {}, el("button", { onclick: () => close(null) }, "Annuler")),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.body.append(backdrop);
  });
}
