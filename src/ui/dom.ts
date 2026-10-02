/** Micro-utilitaires DOM. Pas de framework : l'empreinte memoire compte. */

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
 */
export function onLongPress(node: HTMLElement, run: () => void, ms = 500): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; start = null; };
  node.addEventListener("pointerdown", (e) => {
    fired = false;
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { timer = null; fired = true; run(); }, ms);
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
    run();
  });
}

/* ---------------- messages ephemeres ---------------- */

let toastHost: HTMLElement | null = null;

/** Bouton d'un message ephemere, par exemple « Annuler » apres une suppression. */
export interface ToastAction {
  label: string;
  run: () => void;
}

/**
 * Message en bas de l'ecran. `key` : un message de meme cle remplace le
 * precedent au lieu de s'empiler (trois Ctrl+F = un seul message).
 */
export function toast(
  message: string, kind: "info" | "warn" | "err" = "info", ms = 3200, action?: ToastAction, key?: string,
): void {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host" });
    document.body.append(toastHost);
  }
  if (key) {
    for (const old of [...toastHost.children] as HTMLElement[]) if (old.dataset.key === key) old.remove();
  }
  const node = el("div", { class: `toast ${kind === "info" ? "" : kind}` }, message);
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
  // Deux messages au plus : une pile masquait la page et la barre d'etat.
  // Le plus ancien part, sauf s'il porte une action (« Annuler ») et qu'un
  // message sans action peut partir a sa place.
  const shown = [...toastHost.children] as HTMLElement[];
  while (shown.length >= MAX_TOASTS) {
    const plain = shown.find((t) => !t.classList.contains("with-action"));
    const victim = plain ?? shown[0];
    victim.remove();
    shown.splice(shown.indexOf(victim), 1);
  }
  toastHost.append(node);
  setTimeout(() => node.remove(), ms);
}

const MAX_TOASTS = 2;

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
    const btn = t.querySelector(".toast-action");
    if (btn) t.insertBefore(note, btn); else t.append(note);
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
 */
export function askFields(
  title: string, fields: DialogField[], okLabel = "Valider", check?: FieldsCheck,
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
    const content = el("div", { class: "content" });

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

/** Choix dans une liste, au doigt. Le libelle peut etre un rendu (formule). */
export function pick(title: string, options: { value: string; label: string | Node }[]): Promise<string | null> {
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
