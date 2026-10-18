import { describe, it, expect } from "vitest";

/**
 * Commandes Rust exposees au frontend (generate_handler! de lib.rs) contre
 * celles que src/ invoque vraiment. Une commande enregistree mais plus
 * appelee reste ouverte a tout script de la webview : c'est ainsi que
 * `set_root` (n'importe quel dossier comme racine) a survecu a son dernier
 * appelant (C-4). Une commande invoquee mais non enregistree casse en vrai.
 */

// Lecture des sources comme chrome.test.ts : node:fs charge a l'execution.
const nodeFs = "node:fs";
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync(p: URL, enc: string): string;
  readdirSync(p: URL, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};

function registered(): string[] {
  const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const list = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? "";
  return list.split(",").map((s) => s.trim()).filter(Boolean).sort();
}

/** Noms passes a invoke(...) dans src/, tests exclus. */
function invoked(dir = new URL("../", import.meta.url), out = new Set<string>()): Set<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== "tests") invoked(new URL(`${e.name}/`, dir), out);
    } else if (e.name.endsWith(".ts")) {
      const src = readFileSync(new URL(e.name, dir), "utf8");
      for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)) out.add(m[1]);
    }
  }
  return out;
}

describe("commandes Tauri", () => {
  it("chaque commande enregistree est appelee par le frontend, et inversement", () => {
    const reg = registered();
    expect(reg.length).toBeGreaterThan(10);
    expect(reg).not.toContain("set_root");
    expect([...invoked()].sort()).toEqual(reg);
  });
});
