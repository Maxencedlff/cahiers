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

3. GitHub fait le reste (environ 20 à 30 min) : builds Windows, Mac (signé, notarisé, universel) et Linux, signés pour les mises à jour, puis release publique. En parallèle, la version Mac App Store part sur App Store Connect (voir plus bas).

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

## Mac App Store

Job `mas` du même workflow, à côté du `.dmg` Developer ID (qui ne change pas). Il part à chaque tag `v*`, ou à la main : Actions, « Installateurs », **Run workflow**, cible `mas` (Mac App Store seul, sans les autres installateurs) ou `tout`.

Ce qu'il fait :

1. Build universelle (puces Apple et Intel) avec `src-tauri/tauri.appstore.conf.json` fusionnée et la feature Cargo `app-store` : appli sandboxée, sans updater (c'est l'App Store qui met à jour ; le bandeau, le menu ⋯ et les Réglages ne parlent plus de mises à jour), catégorie Éducation, `ITSAppUsesNonExemptEncryption` = false, profil de provisioning embarqué.
2. Signature « Apple Distribution », puis `.pkg` signé « 3rd Party Mac Developer Installer ».
3. Vérifications : `codesign --verify`, entitlements (sandbox, bookmarks, identifiant), profil, numéro de build, `pkgutil --check-signature`. Le `.pkg` est gardé en artefact `cahiers-mas`.
4. Envoi sur App Store Connect (`xcrun altool --upload-package`, clé d'API de la notarisation). Le build apparaît ensuite dans App Store Connect › Cahiers › TestFlight (traitement par Apple : 10 à 30 min), puis on le choisit dans la version à soumettre.

Numéro de build (`CFBundleVersion`) : unique et croissant à chaque envoi, sans rien changer à la main : version codée, numéro du run, tentative (0.2.0, run 57 → `200.57.1`, `src/core/release.ts`). La version affichée (`CFBundleShortVersionString`) reste celle des trois fichiers ; la version préparée dans App Store Connect doit porter le même numéro (0.2.0, puis 0.2.1…).

Fichiers : `src-tauri/tauri.appstore.conf.json`, `src-tauri/appstore/Entitlements.plist` (sandbox, `files.user-selected.read-write`, `files.bookmarks.app-scope`, `network.client` pour la reconnaissance MyScript), `src-tauri/appstore/Info.plist`. Le dossier synchronisé choisi sous sandbox est retrouvé d'un lancement à l'autre par un « security-scoped bookmark » (`src-tauri/src/sandbox.rs`) ; s'il ne se résout plus, l'appli s'ouvre dans son espace privé avec l'avertissement « Dossier introuvable » des Réglages, rien n'est perdu.

Certificats et profil sur le PC (WSL) : `~/.config/apple/` (`dist.p12`, `mas_installer.p12`, `cahiers_mas.provisionprofile`, expirent en octobre 2027 : les refaire avant, puis remplacer les secrets).

## Clé de signature des mises à jour

- Sur le PC (WSL) : `~/.config/cahiers-updater/` (`updater.key` = clé privée, `pass` = son mot de passe, `updater.key.pub` = clé publique, recopiée dans `tauri.conf.json` › `plugins.updater.pubkey`).
- **Ne jamais la perdre ni la publier.** Sans elle, les appareils déjà installés ne pourront plus jamais recevoir de mise à jour (il faudrait tout réinstaller à la main). En garder une copie hors du PC (clé USB, gestionnaire de mots de passe).
- Un build local (`npx tauri build`) demande maintenant la clé : variables `TAURI_SIGNING_PRIVATE_KEY` (contenu ou chemin de `updater.key`) et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, ou bien sans artefacts de mise à jour : `npx tauri build -c '{"bundle":{"createUpdaterArtifacts":false}}'`.

## Secrets du dépôt `cahiers` (Settings › Secrets and variables › Actions)

- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : signature des mises à jour.
- `RELEASES_TOKEN` : jeton GitHub qui publie dans `cahiers-releases`. S'il expire, la publication échoue (dernière étape) : en recréer un (droits `repo`) et remplacer le secret.
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `KEYCHAIN_PASSWORD` : signature Developer ID du Mac.
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` : notarisation Apple, et envoi sur App Store Connect.
- `MAS_CERTIFICATE`, `MAS_CERTIFICATE_PASSWORD` : certificat « Apple Distribution » (`.p12` en base64) ; `MAS_INSTALLER_CERTIFICATE`, `MAS_INSTALLER_CERTIFICATE_PASSWORD` : certificat « 3rd Party Mac Developer Installer » ; `MAS_PROVISION_PROFILE` : profil Mac App Store de `fr.mdlf.cahiers` (base64). `KEYCHAIN_PASSWORD` sert aussi au trousseau temporaire du job `mas`.

Le détail technique est dans `.github/workflows/build.yml` et `scripts/release.ts`.
