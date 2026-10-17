# Publier une nouvelle version de Cahiers

## En bref

1. Changer le numéro de version aux **trois** endroits (le même partout) :
   - `package.json` : `"version": "0.2.1"`
   - `src-tauri/tauri.conf.json` : `"version": "0.2.1"`
   - `src-tauri/Cargo.toml` : `version = "0.2.1"` (section `[package]`)
2. Commit et push, puis le tag :

   ```
   git tag v0.2.1 && git push --tags
   ```

3. GitHub fait le reste (environ 20 à 30 min) : builds Windows, Mac (signé, notarisé, universel) et Linux, signés pour les mises à jour, puis release publique.

Si les trois numéros ne sont pas ceux du tag, le workflow s'arrête tout de suite (job « version ») et rien n'est publié. Il s'arrête aussi si un des trois builds échoue : jamais de release à moitié.

## Où voir

- Le build : dépôt privé `Maxencedlff/cahiers`, onglet **Actions**, workflow « Installateurs ».
- La release : https://github.com/Maxencedlff/cahiers-releases/releases (publique). On y trouve `Cahiers_X_x64-setup.exe` (Windows), `Cahiers_X_universal.dmg` (Mac), `.AppImage` et `.deb` (Linux), les archives signées et `latest.json`.
- Lien à donner pour une première installation : https://github.com/Maxencedlff/cahiers-releases/releases/latest

## Comment l'ami reçoit la mise à jour

Rien à faire de son côté. Environ 5 secondes après le lancement, l'appli lit `latest.json` de la dernière release. Si la version est plus récente, un message « Cahiers X.Y disponible » avec « Mettre à jour » apparaît (jamais pendant qu'il tape). Un clic télécharge, enregistre toutes les pages, installe et relance. Il peut aussi passer par le menu ⋯ ou les Réglages, « Rechercher des mises à jour ». Hors ligne : rien ne s'affiche.

Seules les versions installées depuis la release (ou un build du workflow) se mettent à jour. La première installation se fait à la main.

## Lancer un build sans publier

Onglet Actions, « Installateurs », **Run workflow** : les installateurs arrivent en artefacts du workflow, aucune release n'est créée. Un build Mac compte 10 fois sur le quota de minutes du dépôt privé.

## Clé de signature des mises à jour

- Sur le PC (WSL) : `~/.config/cahiers-updater/` (`updater.key` = clé privée, `pass` = son mot de passe, `updater.key.pub` = clé publique, recopiée dans `tauri.conf.json` › `plugins.updater.pubkey`).
- **Ne jamais la perdre ni la publier.** Sans elle, les appareils déjà installés ne pourront plus jamais recevoir de mise à jour (il faudrait tout réinstaller à la main). En garder une copie hors du PC (clé USB, gestionnaire de mots de passe).
- Un build local (`npx tauri build`) demande maintenant la clé : variables `TAURI_SIGNING_PRIVATE_KEY` (contenu ou chemin de `updater.key`) et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, ou bien sans artefacts de mise à jour : `npx tauri build -c '{"bundle":{"createUpdaterArtifacts":false}}'`.

## Secrets du dépôt `cahiers` (Settings › Secrets and variables › Actions)

- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : signature des mises à jour.
- `RELEASES_TOKEN` : jeton GitHub qui publie dans `cahiers-releases`. S'il expire, la publication échoue (dernière étape) : en recréer un (droits `repo`) et remplacer le secret.
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `KEYCHAIN_PASSWORD` : signature Developer ID du Mac.
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` : notarisation Apple.

Le détail technique est dans `.github/workflows/build.yml` et `scripts/release.ts`.
