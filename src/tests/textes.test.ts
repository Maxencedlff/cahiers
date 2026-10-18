import { describe, expect, it } from "vitest";
import { PRIVACY_URL } from "../core/privacy";

/*
 * Textes affiches a l'utilisateur. Lus sur le disque comme dans
 * chrome.test.ts (pas de types Node dans le projet).
 */
const nodeFs = "node:fs";
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync(p: URL, enc: string): string;
  readdirSync(p: URL, opts: { recursive: boolean }): string[];
};

/** Sources de l'interface : src/ui (sous-dossiers compris), platform.ts, main.ts. */
function uiSources(): { name: string; text: string }[] {
  const ui = new URL("../ui/", import.meta.url);
  const files = readdirSync(ui, { recursive: true })
    .map((f) => String(f).replace(/\\/g, "/"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: `ui/${f}`, url: new URL(f, ui) }));
  files.push(
    { name: "platform.ts", url: new URL("../platform.ts", import.meta.url) },
    { name: "main.ts", url: new URL("../main.ts", import.meta.url) },
  );
  return files.map(({ name, url }) => ({ name, text: readFileSync(url, "utf8") }));
}

describe("textes de l'interface", () => {
  it("ne citent jamais ESEO : l'espace prive de l'appli n'a pas ce nom chez un autre utilisateur", () => {
    const found = uiSources()
      .flatMap(({ name, text }) => text.split("\n")
        .map((line, i) => ({ where: `${name}:${i + 1}`, line }))
        .filter(({ line }) => /ESEO/.test(line)))
      .map(({ where }) => where);
    expect(found).toEqual([]);
  });

  it("la politique de confidentialite a la meme adresse cote Rust", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/shell.rs", import.meta.url), "utf8");
    expect(rust).toContain(`pub const PRIVACY_URL: &str = "${PRIVACY_URL}";`);
    expect(PRIVACY_URL).toMatch(/^https:\/\//);
  });
});
