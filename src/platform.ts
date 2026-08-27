import { BrowserFs, TauriFs, joinPath, splitDataUrl, type FsAdapter } from "./core/storage/fs";

/**
 * Couche plateforme. L'application tourne dans deux contextes :
 *  - Tauri : l'application installee, qui lit le vrai dossier ESEO ;
 *  - navigateur : `npm run dev`, pour developper et verifier l'interface.
 *
 * Le reste du code ne sait pas dans lequel il se trouve.
 */

export interface Presence {
  /** Nom de l'autre machine si le cahier semble ouvert ailleurs. */
  check: (notebook: string) => Promise<string | null>;
  claim: (notebook: string) => Promise<void>;
  release: (notebook: string) => Promise<void>;
}

export interface Platform {
  fs: FsAdapter;
  rootLabel: string;
  presence: Presence | null;
  isTauri: boolean;
  /** OCR local fourni par Windows. Absent en mode navigateur. */
  ocr: ((dataUrl: string) => Promise<string>) | null;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function detectPlatform(): Promise<Platform> {
  if (!inTauri()) {
    const fs = new BrowserFs();
    await seedDemo(fs);
    return {
      fs,
      rootLabel: "Mode navigateur, donnees de developpement",
      presence: null,
      isTauri: false,
      ocr: null,
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const fs = new TauriFs(invoke as never);
  const rootLabel = await fs.rootLabel();
  const machine = await invoke<string>("machine_name");

  return {
    fs,
    rootLabel,
    isTauri: true,
    presence: buildPresence(fs, machine),
    ocr: async (dataUrl: string) => {
      const { base64 } = splitDataUrl(dataUrl);
      return invoke<string>("ocr_image", { base64 });
    },
  };
}

/**
 * Fichier de presence dans le dossier partage (section 11). Le verrou
 * d'instance est local a la machine et ne peut pas voir l'autre PC :
 * seul un fichier dans OneDrive le peut. L'avertissement reste non bloquant.
 */
const PRESENCE_FILE = ".presence.json";
const PRESENCE_TTL_MS = 15 * 60 * 1000;

function buildPresence(fs: FsAdapter, machine: string): Presence {
  const path = (nb: string) => joinPath(nb, PRESENCE_FILE);

  return {
    async check(nb) {
      try {
        if (!(await fs.exists(path(nb)))) return null;
        const raw = JSON.parse(await fs.readText(path(nb))) as { machine: string; at: string };
        if (raw.machine === machine) return null;
        const age = Date.now() - new Date(raw.at).getTime();
        return age < PRESENCE_TTL_MS ? raw.machine : null;
      } catch {
        return null;
      }
    },
    async claim(nb) {
      try {
        await fs.writeText(path(nb), JSON.stringify({ machine, at: new Date().toISOString() }));
      } catch { /* dossier en lecture seule, on continue */ }
    },
    async release(nb) {
      try { await fs.remove(path(nb)); } catch { /* deja parti */ }
    },
  };
}

/**
 * Jeu de donnees minimal pour le mode navigateur, cree une seule fois.
 * Rien de tout ceci n'existe dans l'application installee.
 */
async function seedDemo(fs: BrowserFs): Promise<void> {
  if (await fs.exists("Maths")) return;
  const now = new Date().toISOString();
  for (const [nb, color, dividers] of [
    ["Maths", "#2563eb", ["Cours", "Exos", "TD"]],
    ["Elec", "#dc2626", ["Cours", "TP"]],
    ["Info", "#059669", ["Cours", "Projets"]],
  ] as [string, string, string[]][]) {
    await fs.writeText(`${nb}/cahier.json`, JSON.stringify({
      version: 1, title: nb, color, dividers, viewMode: {},
    }, null, 2));
    for (const d of dividers) {
      await fs.mkdir(`${nb}/${d}`);
      await fs.writeText(`${nb}/${d}/0001.page.json`, JSON.stringify({
        version: 1, id: `${nb}-${d}-1`, created: now, modified: now, blocks: [],
      }, null, 2));
    }
  }
}
