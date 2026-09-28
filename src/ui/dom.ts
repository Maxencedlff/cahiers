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

/* ---------------- messages ephemeres ---------------- */

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "warn" | "err" = "info", ms = 3200): void {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host" });
    document.body.append(toastHost);
  }
  const node = el("div", { class: `toast ${kind === "info" ? "" : kind}` }, message);
  toastHost.append(node);
  setTimeout(() => node.remove(), ms);
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
 * Dialogue de saisie. Remplace window.prompt, qui n'existe pas dans une
 * WebView Tauri et qui ne serait de toute facon pas utilisable au doigt.
 */
export function askFields(
  title: string, fields: DialogField[], okLabel = "Valider",
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

    const close = (result: Record<string, string> | null) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const submit = () => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(inputs)) out[k] = v.value.trim();
      close(out);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter" && !e.shiftKey && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault(); submit();
      }
    };

    const backdrop = el("div", { class: "backdrop" },
      el("div", { class: "modal" },
        el("header", {}, title),
        content,
        el("footer", {},
          el("button", { onclick: () => close(null) }, "Annuler"),
          el("button", { class: "primary", onclick: submit }, okLabel),
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

/** Choix dans une liste, au doigt. */
export function pick(title: string, options: { value: string; label: string }[]): Promise<string | null> {
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
