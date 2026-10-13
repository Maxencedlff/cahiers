import { confirmDialog, pick, toast } from "./dom";
import { versionLabel } from "../core/versions";
import type { PageVersion } from "../core/storage/repo";

/**
 * « Versions de la page… » : les instantanes gardes par Repo avant chaque
 * ecrasement (au plus un toutes les 10 minutes, `.versions/<id de page>/`).
 * Restaurer : la version actuelle passe d'abord en version, rien n'est perdu.
 *
 * A brancher par App (menu « ⋯ » ou raccourci) sur la vue du panneau vise :
 *   void openVersions(view)
 */
export interface VersionsHost {
  listVersions(): Promise<{ page: number; versions: PageVersion[] } | null>;
  restoreVersion(file: string): Promise<boolean>;
}

export async function openVersions(view: VersionsHost): Promise<void> {
  let info: Awaited<ReturnType<VersionsHost["listVersions"]>>;
  try {
    info = await view.listVersions();
  } catch (e) {
    toast(`Versions illisibles : ${e instanceof Error ? e.message : String(e)}`, "err", 6000);
    return;
  }
  if (!info) { toast("Aucune page ouverte", "warn", 4000); return; }
  if (!info.versions.length) {
    toast(`Page ${info.page} : aucune version gardée pour l'instant. Une version est gardée `
      + "au plus toutes les 10 minutes pendant que tu écris.", "info", 7000);
    return;
  }
  const now = Date.now();
  const file = await pick(`Versions de la page ${info.page}`, info.versions.map((v) => ({
    value: v.file, label: versionLabel(v.at, now),
  })));
  if (!file) return;
  const chosen = info.versions.find((v) => v.file === file);
  const when = chosen ? versionLabel(chosen.at, now) : file;
  const ok = await confirmDialog(
    "Restaurer cette version",
    `La page ${info.page} reprend la version « ${when} ». `
      + "Sa version actuelle est d'abord gardée dans les versions : rien n'est perdu.",
    "Restaurer",
  );
  if (ok) await view.restoreVersion(file);
}
