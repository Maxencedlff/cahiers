import { el, toast, confirmDialog, chooseDialog, busyVeil, type BusyVeil } from "./dom";
import { icon, type IconName } from "./icons";
import {
  formatBytes, modeLabel, pagesLabel, switchFlow,
  type LocationApi, type StorageInfo, type SwitchAsk, type Target,
} from "../core/storage/location";

/**
 * Reglages, « Emplacement des cahiers » : mode (dans l'appli / dossier
 * synchronise), chemin, bascules et « Ouvrir l'emplacement ». La logique
 * (copie verifiee, choix selon le contenu du dossier) est dans
 * core/storage/location.ts ; ici seulement les questions et les messages.
 */
export interface LocationHost {
  api: LocationApi;
  /** Appli installee : les bascules sont possibles (pas en mode navigateur). */
  canSwitch: boolean;
  /**
   * Avant de copier ou de basculer (App.quiesce) : tout ecrire, liberer les
   * fichiers de presence. false = une page reste refusee, on n'y touche pas.
   */
  quiesce: () => Promise<boolean>;
  /** Bascule annulee ou ratee (App.resumePresence) : la presence est reprise. */
  resumePresence: () => Promise<void>;
}

export async function locationSection(host: LocationHost): Promise<HTMLElement> {
  const box = el("div", { class: "location" });
  let info: StorageInfo;
  try {
    info = await host.api.info();
  } catch (e) {
    box.append(el("p", { class: "small muted" }, `Emplacement illisible : ${(e as Error).message}`));
    return box;
  }
  const hintOff = host.canSwitch ? "" : "Dans l'appli installée seulement";
  const button = (label: string, run: () => void, primary = false, ic?: IconName) => el("button", {
    class: primary ? "primary" : "", disabled: !host.canSwitch, title: hintOff, onclick: run,
  }, ic ? icon(ic, 18) : null, label);

  const run = (target: Target) => { void runSwitch(host, target); };
  box.append(
    el("div", { class: "set-row" },
      el("div", { class: "set-label" },
        el("span", {}, modeLabel(info.mode)),
        el("span", { class: "set-hint" }, info.mode === "app"
          ? "Les cahiers sont rangés dans l'espace privé de l'appli, sur cet ordinateur"
          : "Les cahiers sont dans un dossier que tu as choisi (OneDrive, iCloud Drive…)")),
      el("div", { class: "set-control" },
        el("button", {
          disabled: !host.canSwitch, title: hintOff,
          onclick: () => { void host.api.open().catch((e) => toast(`Ouverture impossible : ${(e as Error).message}`, "err")); },
        }, icon("folder", 18), "Ouvrir l'emplacement"))),
    el("div", { class: "location-path", title: info.path }, info.path),
  );
  if (info.missing) {
    const waiting = "Les cahiers s'ouvrent dans l'appli en attendant : "
      + "ce qui est écrit maintenant reste ici, rien n'a été copié ni supprimé.";
    // Sandbox Mac App Store : le dossier peut tres bien etre la, c'est l'acces
    // qui manque (bookmark illisible). « Rouvrir » viserait un chemin sans
    // droit et ne pourrait pas reussir : il faut le choisir de nouveau dans
    // la boite, qui rend l'acces (C-10).
    box.append(info.lostAccess
      ? el("div", { class: "location-warn" },
        el("div", {},
          el("strong", {}, "Accès au dossier perdu"),
          el("div", { class: "small" },
            `macOS ne donne plus accès à « ${info.missing} » (dossier déplacé, renommé ou accès retiré). `
              + `Choisis-le de nouveau pour y retrouver tes cahiers. ${waiting}`)),
        button("Choisir le dossier…", () => run("picked")))
      : el("div", { class: "location-warn" },
        el("div", {},
          el("strong", {}, "Dossier introuvable"),
          el("div", { class: "small" }, `« ${info.missing} » n'était pas là au lancement. ${waiting}`)),
        button("Rouvrir ce dossier", () => run("missing"))));
  }
  box.append(el("div", { class: "location-actions" },
    ...(info.mode === "app"
      ? [button("Passer à un dossier synchronisé…", () => run("picked"), true)]
      : [
        button("Ramener dans l'appli…", () => run("internal")),
        button("Changer de dossier…", () => run("picked")),
      ]),
  ));
  box.append(el("p", { class: "set-hint" },
    "Les cahiers sont copiés, jamais déplacés : l'ancien emplacement reste tel quel. Mêmes fichiers JSON lisibles dans les deux cas."));
  return box;
}

function notebooksLabel(n: number): string {
  return `${n} matière${n > 1 ? "s" : ""}`;
}

/**
 * Questions de la bascule, en dialogues. `ready` pose le voile modal avant
 * d'ecrire et de liberer la presence : plus rien ne s'edite jusqu'au
 * rechargement (ou jusqu'a l'echec, ou runSwitch le retire).
 */
function asker(host: LocationHost, info: StorageInfo, veil: { current: BusyVeil | null }): SwitchAsk {
  return {
    confirmCopy: (src, path) => confirmDialog(
      "Copier les cahiers",
      `${pagesLabel(src.pages)} (${src.files} fichiers, ${formatBytes(src.bytes)}) seront copiées vers « ${path} ». `
        + `Rien n'est écrasé ; « ${info.path} » reste tel quel. L'appli bascule une fois la copie vérifiée.`,
      "Copier",
    ),
    confirmOpen: (r) => confirmDialog(
      "Ce dossier contient déjà des cahiers",
      `« ${r.path} » : ${notebooksLabel(r.notebooks)}, ${pagesLabel(r.pages)}. `
        + `L'ouvrir tel quel ? Les cahiers actuels restent dans « ${info.path} », ils ne sont pas copiés.`,
      "Ouvrir ce dossier",
    ),
    confirmSubfolder: (r) => confirmDialog(
      "Dossier déjà utilisé",
      `« ${r.path} » contient d'autres fichiers. Les cahiers seront copiés dans un sous-dossier « Cahiers » ; rien d'autre n'est touché.`,
      "Copier dans « Cahiers »",
    ),
    chooseInternal: (r, current) => chooseDialog(
      "L'appli a déjà une ancienne copie",
      `L'espace de l'appli contient une ancienne copie (${notebooksLabel(r.notebooks)}, ${pagesLabel(r.pages)}). `
        + `Ramener les notes actuelles (${pagesLabel(current.pages)}, ${formatBytes(current.bytes)}) ? `
        + `L'ancienne copie est mise de côté (renommée, jamais effacée) ; « ${info.path} » reste tel quel.`,
      [
        { value: "open", label: "Rouvrir l'ancienne copie" },
        { value: "copy", label: "Ramener les notes actuelles", primary: true },
      ],
    ).then((v) => (v === "copy" || v === "open" ? v : null)),
    ready: async () => {
      veil.current = busyVeil("Enregistrement des pages…");
      if (await host.quiesce()) return true;
      veil.current.close();
      veil.current = null;
      return false;
    },
    progress: (m) => veil.current?.update(`${m} Ne ferme pas l'appli.`),
  };
}

/**
 * Bascule complete : switchFlow (choisir, confirmer, puis seulement tout
 * ecrire et liberer la presence sous le voile, copier, verifier), puis
 * rechargement de l'appli sur la nouvelle racine. Rien ne change si un pas
 * echoue : le voile tombe et la presence est reprise (C-18).
 */
export async function runSwitch(host: LocationHost, target: Target): Promise<void> {
  if (!host.canSwitch) { toast("Disponible dans l'appli installée seulement.", "info"); return; }
  let info: StorageInfo;
  try { info = await host.api.info(); } catch (e) { toast(`Emplacement illisible : ${(e as Error).message}`, "err"); return; }
  const veil: { current: BusyVeil | null } = { current: null };
  const out = await switchFlow(host.api, target, asker(host, info, veil));
  if (out.kind !== "switched") {
    veil.current?.close();
    await host.resumePresence();
  }
  switch (out.kind) {
    case "cancelled": return;
    case "unchanged": toast(out.message, "info", 6000); return;
    case "failed": toast(`Rien n'a changé : ${out.message}`, "err", 9000); return;
    case "switched": {
      const what = out.copied
        ? `${pagesLabel(out.copied.dest.pages)} copiées et vérifiées. `
          + (out.copied.aside ? `Ancienne copie gardée dans « ${out.copied.aside} ». ` : "")
        : "";
      // Le voile reste jusqu'au rechargement : l'appli repart sur la
      // nouvelle racine (menu, recherche, presence).
      const done = `${what}Cahiers : ${modeLabel(out.info.mode).toLowerCase()}.`;
      if (veil.current) veil.current.update(`${done} Rechargement…`);
      else toast(done, "info", 4000);
      // Le temps de lire ou est gardee l'ancienne copie, s'il y en a une.
      setTimeout(() => window.location.reload(), out.copied?.aside ? 3000 : 600);
    }
  }
}
