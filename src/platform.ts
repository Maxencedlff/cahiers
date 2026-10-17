import { BrowserFs, TauriFs, joinPath, splitDataUrl, type FsAdapter } from "./core/storage/fs";
import {
  isPresenceFile, othersPresent, parsePresence, presenceFileName, type OtherPresence,
} from "./core/sync";
import type { LocationApi, StorageInfo, Target } from "./core/storage/location";

/**
 * Couche plateforme. L'application tourne dans deux contextes :
 *  - Tauri : l'application installee, qui lit le vrai dossier ESEO ;
 *  - navigateur : `npm run dev`, pour developper et verifier l'interface.
 *
 * Le reste du code ne sait pas dans lequel il se trouve.
 */

export interface Presence {
  /** Nom de cette machine, tel qu'il est ecrit dans son fichier de presence. */
  machine: string;
  /** L'autre machine qui a le cahier ouvert (la plus recente), ou null. */
  check: (notebook: string) => Promise<OtherPresence | null>;
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
  /** Cles MyScript retenues par la machine, si elles ont ete enregistrees. */
  keys: { applicationKey: string; hmacKey: string } | null;
  saveKeys: ((applicationKey: string, hmacKey: string) => Promise<void>) | null;
  /** Emplacement des cahiers (dans l'appli / dossier synchronise). */
  location: LocationApi;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function detectPlatform(): Promise<Platform> {
  if (!inTauri()) {
    const fs = new BrowserFs();
    // « ?vierge » : premier lancement tel qu'un nouvel utilisateur le voit.
    if (!new URLSearchParams(window.location.search).has("vierge")) await seedDemo(fs);
    return {
      fs,
      rootLabel: "Mode navigateur, données de développement",
      // Meme logique que l'appli installee, dans les donnees du navigateur :
      // sert a verifier les bandeaux (une presence d'un autre PC s'y simule).
      presence: buildPresence(fs, "NAVIGATEUR"),
      isTauri: false,
      ocr: null,
      keys: null,
      saveKeys: null,
      location: browserLocation(),
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const machine = await invoke<string>("machine_name");
  // Le nom de la machine signe aussi les copies de conflit ecrites par Repo.
  const fs = new TauriFs(invoke as never, machine);
  const rootLabel = await fs.rootLabel();

  let keys: { applicationKey: string; hmacKey: string } | null = null;
  try {
    const stored = await invoke<{ applicationKey?: string; hmacKey?: string }>("myscript_keys");
    if (stored?.applicationKey && stored?.hmacKey) {
      keys = { applicationKey: stored.applicationKey, hmacKey: stored.hmacKey };
    }
  } catch { /* pas de cles enregistrees */ }

  return {
    fs,
    rootLabel,
    isTauri: true,
    presence: buildPresence(fs, machine),
    ocr: async (dataUrl: string) => {
      const { base64 } = splitDataUrl(dataUrl);
      return invoke<string>("ocr_image", { base64 });
    },
    keys,
    saveKeys: (applicationKey: string, hmacKey: string) =>
      invoke<void>("set_myscript_keys", { applicationKey, hmacKey }),
    location: tauriLocation(invoke as never),
  };
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Emplacement des cahiers : commandes Rust (src-tauri/src/location.rs). */
function tauriLocation(invoke: Invoke): LocationApi {
  return {
    info: () => invoke<StorageInfo>("storage_info"),
    pickFolder: () => invoke<string | null>("pick_sync_folder"),
    inspect: (target, sub) => invoke("inspect_location", { target, sub: sub ?? null }),
    copy: (target: Target, sub?: string, aside?: boolean) =>
      invoke("copy_to_location", { target, sub: sub ?? null, aside: aside ?? false }),
    switchTo: (target, sub) => invoke<StorageInfo>("switch_location", { target, sub: sub ?? null }),
    open: () => invoke<void>("open_root"),
  };
}

/** Mode navigateur : les donnees sont « dans l'appli » (localStorage), sans bascule. */
function browserLocation(): LocationApi {
  const label = "Mode navigateur, données de développement";
  const no = () => Promise.reject(new Error("disponible dans l'appli installée seulement"));
  return {
    info: async () => ({ mode: "app", path: label, internal: label, missing: null }),
    pickFolder: no, inspect: no, copy: no, switchTo: no, open: no,
  };
}

/**
 * Fichier de presence dans le dossier partage (section 11), un par machine
 * (core/sync.ts). Le verrou d'instance est local a la machine et ne peut pas
 * voir l'autre PC : seul un fichier dans OneDrive le peut. L'avertissement
 * reste non bloquant. Toute erreur de disque est avalee : la presence ne
 * doit jamais empecher d'ouvrir un cahier.
 */
function buildPresence(fs: FsAdapter, machine: string): Presence {
  const mine = (nb: string) => joinPath(nb, presenceFileName(machine));

  return {
    machine,
    async check(nb) {
      try {
        const files = (await fs.listFiles(nb)).filter(isPresenceFile);
        const records = [];
        for (const f of files) {
          try { records.push(parsePresence(await fs.readText(joinPath(nb, f)))); } catch { /* fichier pas encore la */ }
        }
        return othersPresent(records, machine, Date.now())[0] ?? null;
      } catch {
        return null;
      }
    },
    async claim(nb) {
      try {
        await fs.writeText(mine(nb), JSON.stringify({ machine, at: new Date().toISOString() }));
      } catch { /* dossier en lecture seule, on continue */ }
    },
    async release(nb) {
      try { if (await fs.exists(mine(nb))) await fs.remove(mine(nb)); } catch { /* deja parti */ }
    },
  };
}

/**
 * Jeu de donnees minimal pour le mode navigateur, cree une seule fois.
 * Rien de tout ceci n'existe dans l'application installee.
 */
async function seedDemo(fs: BrowserFs): Promise<void> {
  // Seulement sur un stockage vide (bancs d'essai : localStorage.clear()).
  if ((await fs.listDirs("")).length || (await fs.listFiles("")).length) return;
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
