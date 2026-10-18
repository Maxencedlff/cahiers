import "./style.css";
import "katex/dist/katex.min.css";
import { App } from "./ui/app";
import { detectPlatform } from "./platform";
import { el, toast, confirmDialog } from "./ui/dom";
import { Updater } from "./ui/updater";
import { selfUpdates } from "./core/distribution";

/**
 * Fermeture de la fenetre (croix, Alt+F4) : on ecrit ce qui attend AVANT de
 * fermer. Sans cela la derniere seconde de notes partait avec la fenetre.
 * Si une page reste refusee par le disque, on demande avant de la perdre.
 * Les fichiers de presence de ce PC partent avec la fenetre.
 */
async function guardClose(app: App): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  let asking = false;
  await getCurrentWindow().onCloseRequested(async (event) => {
    if (asking) { event.preventDefault(); return; }
    // L'autre PC ne doit plus croire les cahiers ouverts ici (section 11).
    if (await app.quiesce()) return; // la fenetre se ferme (destroy)
    asking = true;
    const close = await confirmDialog(
      "Modifications non enregistrées",
      `Une page n'a pas pu être écrite (${app.unsavedError ?? "erreur inconnue"}). `
        + "Fermer maintenant la ferait perdre.",
      "Fermer quand même",
    );
    asking = false;
    if (!close) event.preventDefault();
    else await app.quiesce(true);
  });
}

/**
 * Point d'entree. L'application s'ouvre directement sur le menu,
 * pas d'ecran de demarrage (section 5).
 */
async function main() {
  const mount = document.getElementById("app");
  if (!mount) return;

  try {
    const platform = await detectPlatform();
    const app = new App(
      platform.fs, platform.rootLabel, platform.presence,
      platform.ocr, platform.keys, platform.saveKeys,
      platform.location, platform.isTauri,
    );
    mount.replaceChildren(app.element);
    if (platform.isTauri) await guardClose(app);
    await app.start();

    // Mises a jour : seulement l'appli installee hors App Store (jamais en
    // mode navigateur ni dans la build Mac App Store : sans Updater, ni
    // bandeau, ni menu ⋯, ni section des Reglages), verification
    // automatique hors developpement (tauri dev).
    if (selfUpdates(platform.distribution)) {
      const updater = new Updater(app);
      app.setUpdater(updater);
      if (!import.meta.env.DEV) updater.checkSoon();
    }

    // Mode navigateur : rappel seulement en developpement (npm run dev) ;
    // le dossier reste lisible dans le detail de l'indicateur d'etat.
    if (!platform.isTauri && import.meta.env.DEV) {
      toast("Mode navigateur : les données restent dans ce navigateur.", "warn", 5000);
    }
  } catch (e) {
    mount.replaceChildren(el("div", { class: "screen" },
      el("div", { class: "screen-inner" },
        el("h1", {}, "Démarrage impossible"),
        el("p", { class: "muted" }, e instanceof Error ? e.message : String(e)),
      ),
    ));
  }
}

void main();
