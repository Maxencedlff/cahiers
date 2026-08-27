import "./style.css";
import "katex/dist/katex.min.css";
import { App } from "./ui/app";
import { detectPlatform } from "./platform";
import { el, toast } from "./ui/dom";

/**
 * Point d'entree. L'application s'ouvre directement sur le menu,
 * pas d'ecran de demarrage (section 5).
 */
async function main() {
  const mount = document.getElementById("app");
  if (!mount) return;

  try {
    const platform = await detectPlatform();
    const app = new App(platform.fs, platform.rootLabel, platform.presence, platform.ocr);
    mount.replaceChildren(app.element);
    await app.start();

    if (!platform.isTauri) {
      toast("Mode navigateur : les donnees restent dans ce navigateur.", "warn", 5000);
    }
  } catch (e) {
    mount.replaceChildren(el("div", { class: "screen" },
      el("div", { class: "screen-inner" },
        el("h1", {}, "Demarrage impossible"),
        el("p", { class: "muted" }, e instanceof Error ? e.message : String(e)),
      ),
    ));
  }
}

void main();
