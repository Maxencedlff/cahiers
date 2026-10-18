/**
 * Publication d'une version (GitHub Actions, scripts/release.ts) : logique
 * pure, sans acces disque. A partir des fichiers produits par `tauri build`
 * sur les trois machines, choisit les installateurs, renomme ce qui doit
 * l'etre et ecrit le latest.json lu par le bouton « Mettre a jour ».
 *
 * Artefacts du updater Tauri v2 (bundle.createUpdaterArtifacts = true) :
 * - Windows : l'installateur NSIS lui-meme (`Cahiers_X_x64-setup.exe`) + `.sig` ;
 * - Mac : `Cahiers.app.tar.gz` + `.sig` (appli universelle : puces Apple et Intel) ;
 * - Linux : l'AppImage + `.sig`.
 */

export interface ReleaseFile {
  /** Chemin du fichier tel que telecharge (artefacts des jobs). */
  path: string;
  /** Nom de l'asset dans la release. */
  name: string;
}

export interface PlatformEntry {
  signature: string;
  url: string;
}

export interface LatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, PlatformEntry>;
}

export interface ReleasePlan {
  /** Fichiers a joindre a la release (installateurs, archives, signatures). */
  assets: ReleaseFile[];
  latest: LatestJson;
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** « v0.2.0 » → « 0.2.0 » ; null si ce n'est pas un numero de version X.Y.Z. */
export function versionOfTag(tag: string): string | null {
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return m ? m[1] : null;
}

/**
 * Les trois versions (package.json, tauri.conf.json, Cargo.toml) et le tag
 * doivent dire la meme chose : sinon l'appli installee se croirait toujours
 * en retard (ou jamais), et la release serait fausse.
 */
export function versionMismatch(tag: string, versions: Record<string, string>): string | null {
  const v = versionOfTag(tag);
  if (!v) return `Tag « ${tag} » : attendu vX.Y.Z (ex. v0.2.1)`;
  const bad = Object.entries(versions).filter(([, x]) => x !== v);
  if (!bad.length) return null;
  return `Le tag dit ${v}, mais ${bad.map(([f, x]) => `${f} dit ${x}`).join(", ")}`;
}

/**
 * CFBundleVersion d'un envoi Mac App Store (job « mas ») : App Store Connect
 * refuse un numero deja envoye et veut des numeros croissants. Apple :
 * trois entiers au plus sur macOS. Donc la version codee (0.2.1 → 201,
 * 1.4.0 → 10400 : croissante d'une version a l'autre), puis le numero du
 * run GitHub (croissant a chaque lancement) et la tentative (relance du
 * meme run). Ex. 0.2.0, run 57 → « 200.57.1 ».
 */
export function masBuildNumber(version: string, run: number, attempt = 1): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new Error(`Version « ${version} » : attendu X.Y.Z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`Version « ${version} » : mineure et correctif limités à 99`);
  if (!Number.isInteger(run) || run < 1 || !Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Run ${run}, tentative ${attempt} : entiers positifs attendus`);
  }
  return `${major * 10000 + minor * 100 + patch}.${run}.${attempt}`;
}

/**
 * Prepare la release. `files` : tous les fichiers telecharges ; `readSig`
 * lit une signature (.sig) ; `baseUrl` : adresse de telechargement des
 * assets de cette release (…/releases/download/vX.Y.Z). Une plateforme
 * manquante est une erreur : une release a moitie ne part jamais.
 */
export function planRelease(
  files: readonly string[], version: string, baseUrl: string,
  readSig: (path: string) => string, now: Date = new Date(), notes = "",
): ReleasePlan {
  const find = (test: (name: string) => boolean, what: string): string => {
    const hit = files.filter((f) => test(base(f)));
    if (hit.length !== 1) {
      throw new Error(hit.length ? `${what} : plusieurs fichiers (${hit.map(base).join(", ")})` : `${what} : introuvable`);
    }
    return hit[0];
  };
  const sigOf = (path: string, what: string): string => {
    const sig = files.find((f) => f === `${path}.sig`);
    if (!sig) throw new Error(`${what} : signature .sig introuvable (TAURI_SIGNING_PRIVATE_KEY absente ?)`);
    return readSig(sig).trim();
  };

  const exe = find((n) => /_x64-setup\.exe$/i.test(n), "Installateur Windows");
  const mac = find((n) => /\.app\.tar\.gz$/i.test(n), "Archive Mac (.app.tar.gz)");
  const dmg = find((n) => /\.dmg$/i.test(n), "Image disque Mac (.dmg)");
  const appImage = find((n) => /\.AppImage$/.test(n), "AppImage Linux");
  const deb = files.find((f) => /\.deb$/.test(base(f)));

  // L'archive Mac s'appelle « Cahiers.app.tar.gz », sans version : on la
  // nomme comme les autres pour qu'une release n'ecrase rien.
  const macName = `Cahiers_${version}_universal.app.tar.gz`;
  const url = (name: string) => `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(name)}`;

  const assets: ReleaseFile[] = [
    { path: exe, name: base(exe) }, { path: `${exe}.sig`, name: `${base(exe)}.sig` },
    { path: dmg, name: base(dmg) },
    { path: mac, name: macName }, { path: `${mac}.sig`, name: `${macName}.sig` },
    { path: appImage, name: base(appImage) }, { path: `${appImage}.sig`, name: `${base(appImage)}.sig` },
    ...(deb ? [{ path: deb, name: base(deb) }] : []),
  ];

  const win: PlatformEntry = { signature: sigOf(exe, "Installateur Windows"), url: url(base(exe)) };
  const darwin: PlatformEntry = { signature: sigOf(mac, "Archive Mac"), url: url(macName) };
  const linux: PlatformEntry = { signature: sigOf(appImage, "AppImage Linux"), url: url(base(appImage)) };
  // Paquet .deb signe (selon la version de Tauri) : sa propre entree.
  const debSig = deb && files.includes(`${deb}.sig`) ? deb : null;
  if (debSig) assets.push({ path: `${debSig}.sig`, name: `${base(debSig)}.sig` });
  return {
    assets,
    latest: {
      version,
      notes,
      pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      platforms: {
        "windows-x86_64": win,
        "windows-x86_64-nsis": win,
        // Une seule appli universelle pour les deux processeurs.
        "darwin-aarch64": darwin,
        "darwin-x86_64": darwin,
        "darwin-aarch64-app": darwin,
        "darwin-x86_64-app": darwin,
        "linux-x86_64": linux,
        "linux-x86_64-appimage": linux,
        ...(debSig ? { "linux-x86_64-deb": { signature: readSig(`${debSig}.sig`).trim(), url: url(base(debSig)) } } : {}),
      },
    },
  };
}
