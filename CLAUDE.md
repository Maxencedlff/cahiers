# Projet « Cahiers »

Application de bureau de prise de notes pour études d'ingénieur (maths, électronique, info) : texte tapé avec formules automatiques, encre au stylet, schémas électriques et schémas-blocs, calculatrice, export Word/PDF. Windows, macOS (dont Mac App Store), Linux.

À lire avant toute modification. Le détail fonction par fonction de chaque lot (version longue de ce fichier, 130 Ko) est archivé dans `obsolete/CLAUDE-2026-10-22.md` : y chercher (`grep`) avant de toucher à un module mal connu, sans le recopier ici. Feuille de route : `docs/FEUILLE_DE_ROUTE.md`. Publication : `docs/PUBLIER.md`. Audits : `docs/audits/`.

## 1. Contraintes non négociables

Tranchées par Maxence. Ne pas les remettre en question sans lui demander.

- **Application de bureau native** (Tauri 2 + TypeScript vanilla, pas Electron : batterie et mémoire). Jamais de navigateur ouvert ni d'URL visible, sauf la politique de confidentialité ouverte depuis les Réglages.
- **Une seule instance** (single-instance). Le verrou est local à la machine, jamais dans le dossier synchronisé.
- **Un fichier JSON par page**, jamais de fichier global ni SQLite (dossier synchronisé OneDrive/iCloud : un conflit doit coûter une page, pas un semestre).
- **L'appli lit l'arborescence du disque, elle ne la possède pas.** Pas d'index qui fasse autorité ; un dossier créé dans l'explorateur apparaît.
- **Formats ouverts et lisibles.** JSON en clair, texte en markdown étendu.
- **Ne jamais perdre une ligne.** L'encre brute n'est jamais jetée (un bloc `math` garde ses `strokes` à côté du `latex`) ; suppression = corbeille ; écriture conditionnelle ; conflit = copie, jamais écrasement.
- **Ne jamais bloquer l'écriture sans réseau.** La reconnaissance (MyScript, cloud) passe par une file hors ligne.
- **Emplacement (décision du 16/10/2026)** : par défaut, cahiers dans l'espace privé de l'appli (`app_data_dir/Cahiers`) ; dossier synchronisé possible dans les Réglages. Installation existante avec `root.txt` (cas de Maxence, dossier ESEO sur OneDrive) gardée telle quelle.
- **Batterie** : portable ~3-4 h d'autonomie, viser < 1 W au-dessus du repos. Dirty-rect sur le canvas, aucune animation en boucle, écritures groupées, défilement virtualisé.
- **Cibles tactiles 44 px**, tout utilisable au doigt.

## 2. Données

```
<racine>/                      espace privé, ou dossier choisi (root.txt)
├── Maths/                     matière = cahier
│   ├── cahier.json            titre, couleur, ordre des intercalaires, modes, fonds (+ cahier.json.bak)
│   ├── Cours/                 intercalaire = dossier, jusqu'à 3 niveaux (« S1/Chapitre 1 »)
│   │   ├── 0001.page.json     numérotation par intercalaire, renumérotée à l'insertion
│   │   └── assets/            photos (<id>.png|jpg + <id>.original.jpg), PDF (<nom>-<12 hex>.pdf)
│   ├── .versions/<id page>/   versions horodatées (10 min, purge 24 h / 30 j)
│   └── .presence-<PC>.json    présence par machine (périmée à 15 min)
├── Vrac/                      toujours présent
└── .corbeille/<horodatage>/   purgée après 30 jours
```

- Page = `{version, id, created, modified, blocks[], height?, continues?}`. Types de blocs : `text` (markdown étendu, porte formules `$…$`, photos et blocs vivants en jetons `![](img:<id>)`), `ink`, `math`, `image`, `pdf`, `calc`, `graph`, `schema`, `link`, `flag`. Champs inconnus toujours conservés.
- **Format v2 des traits** (`SCHEMA_VERSION` 2) : tableaux plats `pts` / `p` / `t` / `tilt`, `points: []` laissé vide pour qu'une appli v1 lise sans planter. En mémoire `{x, y, p, t}` ; conversion seulement dans `encodeStroke`/`decodeStroke` (`src/core/ink/stroke.ts`). Une page v1 n'est réécrite en v2 qu'à sa première modification. Page de version future = lecture seule.
- Toute référence se fait **par id** (page, bloc, trait), jamais par numéro : liens `cahiers:<pageId>`, clés de reconnaissance, annulation, positions. Un trait déplacé garde son id (fusion OneDrive par id).
- Blocs `calc`/`graph`/`schema` **vivants** : ils stockent l'expression ou le modèle, jamais une image.
- Stockage local de la machine (jamais dans le dossier) : positions (`cahiers.positions.v1`), réglages, file de reconnaissance (`cahiers.reco.pending.v1`), clés MyScript (gardées par la machine).

## 3. Architecture du code

Règle : **logique pure dans `src/core/` (sans DOM, testée), DOM dans `src/ui/`**, Rust dans `src-tauri/src/`. Ajouter une fonction = logique dans core + test, puis branchement UI.

| Domaine | Logique pure (`src/core/`) | Interface (`src/ui/`) |
|---|---|---|
| Texte tapé, formules auto | `text/automath.ts` (une seule grammaire `findFormulas`/`Parser`), `text/doc.ts` (jetons, sérialisation, `texToPlain`), `text/hint.ts`, `text/table.ts`, `text/codehl.ts`, `text/find.ts` | `textdoc.ts` (le gros morceau), `doctable.ts`, `doccode.ts`, `tex.ts` |
| Suggestions grisées | `suggest.ts`, `factor.ts`, `calc/nextstep.ts` (ordre : factor, nextstep, suggest) | `suggestions.ts` |
| Page, mise en page | `paginate.ts`, `textlayout.ts`, `docsel.ts`, `paper.ts`, `virtual.ts`, `zoom.ts`, `print.ts`, `printwait.ts` | `pageview.ts` (vue, sauvegarde, débordement), `pagebreak.ts`, `linesnap.ts` |
| Encre | `ink/` (`stroke`, `pointer`, `gestures`, `selection`, `bands`, `recognizer`, `recokey`, `confusions`), `kinetic.ts`, `history.ts` | `canvas.ts` (`InkSurface`), `mathdialog.ts` |
| Stockage | `storage/` (repo, search, location), `writeguard.ts`, `textmerge.ts`, `flowguard.ts`, `sync.ts`, `versions.ts`, `dividers.ts` | `location.ts`, `versions.ts` |
| Calculatrice | `calc/` (`engine`, `screen`, `solve`, `derive`, `integrate`, `plot`, `live`, `texinput`/`texparse`/`texprint`) | `calculator/`, `plotdraw.ts` |
| Schémas | `schema/` (`symbols`, `model`, `render`, `templates`, `label`, `ltspice`) | `schema-view.ts` |
| Formules (ruban Σ) | `mathcatalog.ts` (~160 touches), `templates.ts`, `symbols.ts` | `mathbar.ts` |
| Navigation, chrome | `nav.ts`, `chrome.ts`, `shortcuts.ts` (table unique `SHORTCUTS`), `theme.ts`, `status.ts`, `settings.ts`, `position.ts` | `app.ts` (orchestration), `sidebar.ts`, `menu.ts`, `spotlight.ts`, `help.ts`, `dom.ts` |
| Export | `export/` (`docx.ts`, `omml.ts`, `plan.ts`, `zip.ts` : Word sans dépendance npm) | `docx-export.ts` |
| Photos, PDF | `image/` (`dewarp`, `photo`, `cache`), `pdf/pdf.ts` | `image-import.ts`, `pdf.ts`, `pdflayer.ts`, `pdf-import.ts` |
| Divers | `review.ts`, `links.ts`, `liveblock.ts`, `update.ts`, `release.ts`, `distribution.ts`, `privacy.ts` | `review.ts`, `linkpicker.ts`, `updater.ts` |

- `src/platform.ts` : seul pont vers Tauri (`TauriFs`) ou le navigateur (`BrowserFs` sur localStorage `cahiers.fs.v1`, sert aux tests Playwright et à la démo ; `?vierge` = premier lancement).
- Rust (`src-tauri/src/`) : `lib.rs` (commandes, `write_durable` = verrou par chemin + temporaire unique + `sync_all` + renommage, `write_text_if`, `rename_no_replace`), `location.rs` (choix de la racine, copie vérifiée), `sandbox.rs` (bookmarks Mac App Store), `shell.rs` (seul endroit « quel outil selon le système »).
- Styles : jetons CSS sur `:root` dans `src/style.css` (thème clair/sombre, feuille `auto`); icônes Lucide (`src/ui/icons.ts`).

## 4. Commandes

Développer **depuis Windows** (le dépôt est sur `C:\Users\maxde\cahiers`, `/mnt/c/...` sous WSL). npm, vitest et cargo se lancent par PowerShell :

```
powershell.exe -NoProfile -Command "cd C:\Users\maxde\cahiers; npx vitest run"
powershell.exe -NoProfile -Command "cd C:\Users\maxde\cahiers; npx tsc --noEmit"
powershell.exe -NoProfile -Command "cd C:\Users\maxde\cahiers\src-tauri; cargo test"
```

- **Rebuild de l'exe de Maxence** : `npx tauri build --no-bundle` (pas besoin de la clé de signature de l'updater). Avant : fermer Cahiers proprement (`CloseMainWindow` + `Wait-Process`). Après : `Start-Process C:\Users\maxde\cahiers\src-tauri\target\release\cahiers.exe` (son raccourci AHK Ctrl+Alt+Gauche lance cet exe). **Demander avant** : fermer l'appli pendant un cours lui coûte ses notes en direct.
- `tauri build` complet exige `TAURI_SIGNING_PRIVATE_KEY`, sinon ajouter `-c '{"bundle":{"createUpdaterArtifacts":false}}'`.
- Bancs Playwright (WSL, Python) dans `scripts/banc-*.py` : sur `vite build` + `vite preview` (port via `CAHIERS_URL`), **jamais le serveur de dev** ; page de test en localStorage. Tuer l'ancien `vite preview` avant d'en relancer un (un orphelin verrouille esbuild : `npm ci` en EPERM).
- Publication : changer la version dans `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ locks), push, `git tag vX.Y.Z && git push --tags`. CI `.github/workflows/build.yml` (jobs version, test via `ci.yml`, build, release, mas). Tags de pré-version refusés. Détail : `docs/PUBLIER.md`.
- `scripts/release.ts` exige Node 22+ (`--experimental-strip-types`) : utiliser le Node Windows 24, pas celui de WSL (20).

## 5. Conventions

- **Tests dès qu'on ajoute de la logique** : `src/tests/<domaine>.test.ts` (vitest), un fichier par domaine (automath, calc*, solve-detail, paginate, fiabilite, sync, schema-*, mathcatalog, chrome, location, release…). `cargo test` côté Rust. CI : `npm audit`, `tsc`, `vitest`, `cargo test` Windows + macOS (+ `--features app-store`).
- Interface entièrement en français, **tutoiement**, aucune mention d'ESEO dans les textes (test `textes.test.ts`). Pas de tirets cadratins dans les messages.
- Toute nouvelle commande clavier passe par `SHORTCUTS` (`src/core/shortcuts.ts`) : elle alimente l'aide F1, les infobulles et les libellés Mac (⌘ ⌥). Raccourcis Alt lus par `altKeyName` (même touche AZERTY/QWERTY/Option).
- Nouveaux champs de fichier : **optionnels et rétrocompatibles** ; ne jamais retirer un champ inconnu à l'écriture (`normalizeMeta`).
- Commentaires courts en français ; pas de dépendance npm lourde sans raison (`docx` et `mathml2omml` écartés, licence).
- Avant de dire « fini » sur de l'UI : capture réelle (Playwright) en clair ET en sombre, aux tailles 1536×780 (écran de Maxence, 125 %), 1280×720, 1920×1040.
- Grosse modification : relecture par l'agent `auditeur-senior` ; avant publication, workflow `audit-senior` (rapport dans `docs/audits/`).

## 6. Pièges connus

- **Saisie** : `pen` écrit, `touch` navigue (rejet de paume gratuit), `mouse` selon l'outil ; appui court = jamais d'encre (curseur). Option « Écrire au doigt » = `settings.touchWrites`.
- **Formules du texte** : une seule grammaire (`findFormulas`), jamais MathLive pendant la frappe ; « jamais de maths fausses en silence » (ce qui ne se lit pas en entier reste du texte ; dates, URL, code, sigles masqués). Toute nouvelle règle = cas dans `automath.test.ts` + banc `banc-frappe.py`/`banc-fractions.py`.
- **Sauvegarde** (`pageview.ts`) : file indexée par id de page, écritures et renumérotations en série ; aucune renumérotation tant qu'une page reste non écrite ; fermeture = `flushAll`. Pagination/remontée : la page d'arrivée est écrite **avant** que celle d'avant perde quoi que ce soit (perte réelle le 13/10 quand l'ordre était faux).
- **Écriture conditionnelle** (`writeguard.ts`) : page changée ailleurs = fusion de l'encre par id, fusion à trois du texte si le disque n'a fait qu'ajouter, sinon copie de conflit `NNNN.page-<PC>.json`. Copies OneDrive (`- Copie`, `(1)`) jamais prises pour une page.
- **Mac App Store** : feature Cargo `app-store` (pas d'updater), config `src-tauri/tauri.appstore.conf.json` + `src-tauri/appstore/` (entitlements : sandbox, `files.user-selected.read-write`, `files.bookmarks.app-scope`, `network.client`, print). Sous sandbox : pas de fichier frère `.tmp-write` pour l'export (écrire directement), dossier choisi rouvert par bookmark. Essayé sur Mac par `.github/workflows/mac-impression.yml` (macOS 26 et 27, appli directe et sandboxée, parcours Partager › Exporter rejoué, captures en artefact).
- **WebKit macOS 13.3** : pdf.js en build `legacy/`, Vite cible `safari16.4` (et `chrome110` pour WebView2).
- **Impression** : `window.print` passe par `printAndWait` (fin = `afterprint` ou retour du focus) ; permission `core:webview:allow-print`. Sur Mac, `window.print` = commande `print_page` (`src-tauri/src/print.rs`) : celle de Tauri/wry ne donne pas de cadre à la vue imprimée (erreur « NSPrintOperation view's frame was not initialized » sous macOS 27, refus App Review 2.1(a) du 29/10/2026 : « Export button unresponsive »).
- **Canvas sous WebView2 opaque** : un fond CSS ne se voit pas, le fond de page est peint par `InkSurface` sous l'encre.
- **KaTeX gras/italique** plus hauts : `.text-doc b, .text-doc i { line-height: 1 }`, sinon le texte sort des lignes.
- **F5 / Ctrl+Maj+R** ne doivent jamais recharger le WebView2 (`isReloadKey`).
- **MathLive** : raccourcis-mots retirés (`WORD_SHORTCUTS_OFF`, sinon « Force » devient F∨ce) et raccourcis Alt retirés (`appAltKey`).
- **Calculatrice** : armée = focus ET sélection dans un récepteur invisible `.calc-sink` (sinon AltGr/IME partent dans la page) ; une formule collée est lue par `texToCalc`, jamais affichée en LaTeX ; elle ne défile jamais (le pavé cède).
- **Ruban des formules** : jamais de défilement à la souris (une ou deux rangées, `ribbonColumns`) ; vérifié par `banc-ruban.py`.

## 7. Secrets et données réelles

- Ne jamais lire, afficher ni copier `~/.config/apple/*` (certificats, p12, clé ASC) ni `~/.config/cahiers-updater/*` (clé de signature de l'updater et son mot de passe). Les secrets de CI sont dans GitHub (`MAS_CERTIFICATE*`, `MAS_INSTALLER_CERTIFICATE*`, `TAURI_SIGNING_PRIVATE_KEY*`, clé App Store Connect).
- Ne jamais écrire dans les vrais cahiers de Maxence (dossier ESEO sur OneDrive, désigné par `%LOCALAPPDATA%\Cahiers\root.txt`). Tests et bancs sur dossier ou localStorage de test.
- Disque C: : garder 15 Go libres (WSL dessus) ; `src-tauri/target/debug` se supprime sans risque.

## 8. Distribution

- Releases publiques : `Maxencedlff/cahiers-releases` (installateurs + `latest.json` pour l'updater). Site, confidentialité, assistance, liens de téléchargement : `cahiers.vercel.app` (dépôt `Maxencedlff/cahiers-site`), liens versionnés à mettre à jour à chaque release.
- Mac App Store : appli « Cahiers » (id 6824238306, bundle `fr.mdlf.cahiers`). Numéro de build MAS = `masBuildNumber` (0.2.1, run 7 → 201.7.1).
- Quota GitHub Actions du dépôt privé limité (minutes Mac ×10) : si le job release ne part pas, publier à la main (`gh run download`, `release.ts plan`, `gh release create`).

## 9. Fonctionnalités : repères

- Priorité 1 (fait) : pages, texte + encre + math, reconnaissance, recherche plein texte, navigation. Priorité 2 (fait) : calculatrice, split, « Pas compris », photos avec redressement et OCR Windows. Priorité 3 : PDF annotés (fait), liens entre pages (fait), puis pont mail → cahier, fiche de formules, analyse dimensionnelle.
- Écarté : enregistrement audio synchronisé.
- Palette fermée à 5 couleurs sémantiques (définition, théorème, exemple, attention, remarque) : jamais de palette libre (filtrable dans Réviser). Matières : 8 teintes sourdes en carré arrondi.
- Question ouverte : primitives par table à la main seule, ou Nerdamer (parties, substitution) quand le besoin se confirme.
