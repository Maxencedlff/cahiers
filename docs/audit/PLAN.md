# Cahiers : plan d'amélioration

Ce plan regroupe 150 constats vérifiés, venant de 10 audits. Une fois les doublons fusionnés, il en reste environ 105, répartis en 11 lots. Les lots sont à faire dans l'ordre. Chacun touche un groupe de fichiers proches, ce qui évite les conflits. Deux exceptions : `app.ts` et `pageview.ts` reviennent dans plusieurs lots, donc ces lots se font l'un après l'autre et jamais en parallèle.

## D'abord : pourquoi « Vz et I1 » ne se mettent plus en forme proprement

Ce n'est pas un bug unique. Cinq causes s'additionnent, et toutes sont traitées dans le lot 1.

1. **Entrée après une formule avale la ligne suivante** (`ergo-1`, critique). « Vs = Vz - Vbe », puis Entrée, puis « Le courant » donne `V_{beLe}`. Les boucles de `convertLine` et `slashToFraction` (`textdoc.ts` ~623 et ~672) sautent le `\n` inséré par Entrée, car `\s` le reconnaît comme un blanc.
2. **Régression du commit 1b20ec1** (`automath-1`). Une variable seule est maintenant convertie dès l'espace. « iD = (Vz - Vbe)/… » est donc découpé en 3 ou 4 morceaux, alors qu'avant c'était une seule formule propre.
3. **Une pause au milieu d'un mot le coupe** (`automath-5`). « Qu », une pause, puis « and » donne `Q_u and`.
4. **Des mots ordinaires deviennent des variables** (`automath-4`, `rech-8`, `manque-automath-faux-positifs`). Voici, Vu, Loi, Ohm, Hz, kV, dB deviennent des variables indicées, et la recherche ne les retrouve plus.
5. **Petits défauts d'affichage** : le correcteur orthographique souligne Vz (`ergo-10`), et chaque formule laisse un blanc avant la ponctuation à cause de `padding: 0 2px` (`automath-12`).

---

## Lot 1 : Frappe et formules auto propres

**Pourquoi.** C'est la plainte directe, et le lot contient deux défauts critiques : du texte avalé, et des formules perdues au couper-coller.
**Fichiers.** `src/ui/textdoc.ts`, `src/core/text/automath.ts`, `src/core/text/doc.ts`, `src/style.css`, `src/ui/mathbar.ts`, plus les tests.
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| ergo-1 | Entrée après une formule fusionne la ligne suivante | Arrêter les deux boucles de remontée sur un nœud qui contient `\n` ou un `<br>`. Marquer `eq.dataset.closed` quand on sort de la formule par Espace ou Entrée. Test jsdom : « Vs = Vz - Vbe\nLe courant » doit donner 1 formule et 2 lignes. | S |
| automath-1 | Les formules qui commencent par une variable sont découpées | Dans `convertLine`, reconstruire la source de toute la ligne (texte plus `dataset.src` des `.eq`) jusqu'au `<br>`, puis relancer `findFormulas` et remplacer toute la plage. Solution de repli : ne pas convertir une variable seule si le mot suivant est un opérateur. Dans `commit()`, garder `data-src` si le LaTeX n'a pas changé. | M |
| automath-5 | Pause au milieu d'un mot | À la pause (`finished=false`), ne pas convertir les variables seules. Ne rien faire si le caractère après le curseur est une lettre ou un chiffre. | S |
| automath-4, rech-8, manque-automath-faux-positifs | Faux positifs (Voici, Loi, Ohm, Hz, dB, If…) | `loneVariable` : exclure les mots de `UNITS` (ajouter dB, Mo, Ohm), supprimer le motif générique `/^[A-Z][a-z]{1,2}$/`, garder seulement les initiales V/I/U/R/C/L/P/Z suivies d'un indice connu, et compléter `STOP`. Ajouter des tests négatifs. | S |
| automath-2 | Après un « / », toute la phrase part au dénominateur | Marquer le champ ouvert par la fraction auto. Sur Espace, si le dénominateur est rempli et ses parenthèses équilibrées : valider la fraction, insérer l'espace et poser `data-src`. Restreindre les `inlineShortcuts` pour que « or » ne devienne plus ∨. | M |
| automath-3 | Le « / » ouvre une fraction pour m/s, dB/dec, E/S, TCP/IP | Pas de fraction quand on a nombre + unité, ni pour un sigle en majuscules. Retour arrière juste après l'ouverture rend « num/ » en texte. | S |
| automath-6 | On ne peut pas annuler une conversion automatique | Symboles : passer par une Range puis `execCommand('insertText')` pour que le Ctrl+Z natif fonctionne. Formules : mémoriser `lastAuto` ; Ctrl+Z ou Retour arrière juste après remet le texte source, marqué pour ne pas être reconverti. | M |
| automath-7 | **Critique.** Ctrl+X puis Ctrl+V supprime les formules | Ajouter des gestionnaires copy et cut qui mettent le type `application/x-cahiers-doc` (sérialisé) et un text/plain avec les formules en `$…$`. Au collage, lire le type interne ; sinon utiliser `insertLineBreak`, pour ne plus créer de `<div>`. Test d'aller-retour. | M |
| automath-10 | Un symbole du ruban laisse la formule ouverte, et Entrée ne passe pas à la ligne | Si le modèle n'a pas de case à remplir (`#?`), insérer directement la `.eq`. Entrée dans une formule : valider puis `insertLineBreak`. | S |
| ergo-10 | Soulignés rouges sous Vz, Vbe | `spellcheck="false"` sur `.text-doc`, avec un réglage pour le réactiver. | S |
| automath-12 | R1 non indicé dans les fractions, blanc avant la ponctuation | Dans `subscriptVars`, ajouter la règle `([A-Z])(\d{1,2})`. Passer les unités en `\mathrm`. `.eq { padding: 0 }`. | S |
| automath-8 | Notes de code réécrites (p->next, Pi, lambda) | Retirer Pi et lambda de `GREEK_WORDS`. Ne pas remplacer `->`, `<<`, `>=` quand ils sont collés à un identifiant. | S |
| automath-9 | Trous du parseur (2a, ax, ωt, Re(Z), f(x)) | Correctifs ciblés dans `atom` et `identTex`, un test par cas. | M |
| automath-11, rech-1, manque-recherche (en partie) | Voir lot 5 | La conversion LaTeX vers texte (`texToPlain`) peut vivre dans `doc.ts`, qui est touché ici. | |

**Risques.** `textdoc.ts` est fragile, car c'est du contenteditable. Il faut un test DOM (happy-dom ou jsdom) qui tape les chaînes réelles mot à mot : « iD = (Vz - Vbe)/(beta.Ru) », « Id = Vz/R1 donc… », « Vs = Vz - Vbe », Entrée, « Le courant », « 10 m/s », « Voici ». Il faut aussi vérifier à la main dans l'appli.

---

## Lot 2 : Sécurité des pages (sauvegarde, annulation, suppression)

**Pourquoi.** Ce lot contient 5 pertes de données réelles, reproduites, qui peuvent survenir en plein cours.
**Fichiers.** `src/ui/pageview.ts` (partie sauvegarde et annulation), `src/core/storage/repo.ts`, `src/ui/app.ts` (renommer, supprimer, fermer), `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `src/main.ts`.
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| nav-1, donnees-1 | **Critique.** Supprimer une page pendant une sauvegarde en attente écrase la page suivante | Tout de suite : `await this.flush()` en tête de `deleteCurrentPage` et de `newPage(insertHere)`, et abandon avec un toast si `hasUnsaved`. Solution durable : indexer `pendingSave` par `page.id` et retrouver le numéro au moment d'écrire. | S puis M |
| donnees-2 | **Critique.** L'annulation est indexée par numéro, donc Ctrl+Z restaure une autre page ou consomme un pas en silence | Une pile par page : `Map<pageId,{undo,redo}>`. Regarder la pile avant de dépiler (jamais de pop si la page n'est pas chargée), afficher « Rien à annuler sur cette page », et supprimer la pile d'une page supprimée. | M |
| photo-undo-perte | **Critique.** Ctrl+Z supprime le bloc image | Dans `step()`, conserver comme le corps de texte les images en ligne (`image` sans `rect`). Test vitest : trait, photo, annulation. | S |
| nav-2 | **Critique.** Renommer l'intercalaire ouvert recrée l'ancien dossier, et la frappe part dedans | Faire un flush avant `renameDivider`, puis `tab.divider = applied` et `mountView`. Avertir si le nom est déjà pris (comparaison sans casse). Pour la suppression : ajouter `PageView.discard()`, qui vide la file sans écrire. | S |
| donnees-4 | Fermer la fenêtre fait perdre la dernière seconde | `onCloseRequested` attend `flushAll()`, demande confirmation si des modifications restent non enregistrées, puis `destroy()` (ajouter la permission). Flush aussi sur `visibilitychange=hidden`. Rendre `closeTab` awaitable. | S |
| donnees-5 | Page illisible = écran gris muet | Afficher à la place une feuille « Page illisible » avec le message d'erreur, et des boutons Réessayer, Ouvrir le dossier, Page suivante. Aucune écriture pour ce numéro. | S |
| donnees-6 | Écriture non durable et verrou OneDrive | Côté Rust : `sync_all` avant le rename, puis 5 essais sur les erreurs os 32/5, et nettoyage du `.tmp`. Côté TS : relancer un timer de 3 s après un échec, et pastille « Non enregistré » dans la barre d'état. | M |
| nav-12, manque-corbeille | Suppression définitive | `repo.trash()` : renommer vers `.corbeille/<horodatage>_…`. Toast « Annuler » de 8 s. Bouton rouge, éloigné de « Insérer ici ». | M |
| donnees-9 | Fuite mémoire à chaque changement de page (45 canvases gardés) | Ajouter `TextDoc.dispose()` (qui retire l'écouteur `selectionchange`), déconnecter le ResizeObserver, faire `surface.dispose()` avec `canvas.width = 0`, et n'ajouter l'écouteur de défilement qu'une seule fois. `textdoc.ts` est aussi touché au lot 1, donc faire ce point après. **Fait** (vérifié : 1 canvas et 1 écouteur `selectionchange` après 50 changements de page). | S |

**Risques.** Le passage aux identifiants de page touche la file de reconnaissance (lot 6), qui utilise la même clé. Il faut concevoir la clé par `page.id` dès maintenant. Il faut aussi tester sur Tauri, pas seulement dans le navigateur, pour la fermeture et le fsync.

---

## Lot 3 : Encre et stylet

**Pourquoi.** Le geste le plus fréquent en cours (retourner le stylet pour gommer) écrit au lieu de gommer. L'encre sous la hauteur A4 est écrasée, et le surligneur est inutilisable.
**Fichiers.** `src/ui/canvas.ts`, `src/ui/pageview.ts` (callbacks d'encre), `src/ui/app.ts` (outils), `src/core/settings.ts`, `src/core/palette.ts`, `src/core/types.ts`.
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| encre-3, donnees-3 | **Critique.** L'encre sous la hauteur A4 est aplatie sur y=1240 | `InkSurface.layout(cssWidth, logicalH)`, avec une hauteur logique égale au maximum entre la page, le texte et le dernier trait. Ne plus borner y en bas. Ajouter un `Page.height` optionnel. Test vitest. | M |
| encre-2 | Le bout gomme et le bouton latéral écrivent | Dans `onDown` : pour un stylet avec `buttons & 32`, `button === 5` ou `buttons & 2`, prendre la gomme. Figer l'outil pour tout le geste (`this.gestureTool`). | S |
| encre-6, donnees-11 (partie S) | Un geste de gomme crée N entrées d'annulation | Ajouter `onEraseStart`, qui fait un seul `pushUndo` par geste. | S |
| encre-4 | Surligneur fin, trop foncé, peint par-dessus l'encre | Largeur multipliée par environ 7, un seul chemin par trait avec `lineCap: 'butt'`, surligneurs peints avant les traits de stylo, repeindre après `simplify`. | S |
| encre-5, ergo-6 | Pas d'encre neutre, et deux pastilles actives en même temps | Ajouter la couleur `'normal'` (noir), qui devient la valeur par défaut. Alt+0 s'applique à l'encre. Une seule pastille active, avec une légende « Définition · Alt+1 ». *Nécessite une décision, voir D2.* | M |
| reco-6 | La zone math reste active, et le trait suivant est perdu | Outils de zone ponctuels : `prevTool` est restauré après `onRegion`. Appuyer deux fois sur Alt+Z verrouille l'outil. | S |
| encre-12, reco-5 (partie pageview) | Les surlignages partent à la reconnaissance et sont masqués | Envoyer seulement les traits de stylo (`tool === 'pen'`). Dans `visibleStrokes`, toujours afficher les surligneurs. | S |
| encre-1 | La paume fait défiler pendant l'écriture | Ignorer un appui tactile qui veut déplacer la page tant qu'un stylet est actif, ou moins de 400 ms après le dernier lever du stylet. | S |
| encre-10 | À chaque lancement, le doigt écrit | Persister `penSeen` dans Settings. | S |
| encre-9 | Traînée de cercles de gomme | Repeindre l'ancien cercle. Aperçu au survol du stylet. | S |
| encre-8 | La zone math repeint toute la page à chaque mouvement | Repeindre seulement le rectangle modifié (dirty-rect), et mettre en cache les bornes des traits (`WeakMap`). | S |
| donnees-10 (partie S) | 189 octets par point | Arrondir dans `addPoint` (x et y à 0,1 près, p à 0,01, t entier) et écrire le JSON sans indentation. | S |
| encre-7, donnees-11 (partie M) | Toute la page est sérialisée à chaque trait | Annulation par commandes légères (`add` ou `erase` de traits par id). À faire avec la pile par page du lot 2. | M |

**Risques.** Changer la hauteur du canvas impose de revoir `fitSheet` et l'export PDF. L'ajout de `'normal'` à `Stroke.color` doit rester rétrocompatible : les anciens fichiers restent lisibles.

---

## Lot 4 : Ergonomie en cours (clavier, colonne d'outils, finition)

**Pourquoi.** Tout ce qui fait perdre des secondes en direct : « Pas compris » inaccessible, PageDown sans effet pendant la frappe, boutons hors de l'écran.
**Fichiers.** `src/ui/app.ts` (onKey, buildToolbar), `src/style.css`, `src/ui/mathbar.ts`, `src/ui/dom.ts`, `src/core/settings.ts`, `README.md`, plus des chaînes dans `menu.ts`, `calculator/index.ts` et `palette.ts`.
**Effort total.** M (environ 1 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| nav-5, rech-4, manque-flag-1 | Ctrl+F et PageDown ne marchent pas pendant la frappe | Ctrl+F toujours intercepté (`preventDefault` puis `addFlag`, en gardant le focus). Ctrl+PageDown et PageUp changent de page, avec Maj pour changer d'intercalaire. Ctrl+Maj+N insère une page. Ctrl+G va à une page. Ajouter Ctrl+Maj+Tab. | S |
| ergo-2, manque-flag-1 | Colonne d'outils haute de 1522 px, avec « Pas compris » et ◀▶ hors écran | En haut : outils, couleurs, épaisseur, annuler, pages et « Pas compris ». Ruban Maths repliable (état mémorisé). Actions rares (Photo, Export, Supprimer, Mode) dans un menu « ⋯ ». Mathbar en `grid auto-fill 44px`. | M |
| nav-6 | « p. N » jamais mis à jour | Callback `onPageChange(n, total)` qui affiche « p. 4 / 12 » ; un clic dessus équivaut à Ctrl+G. | S |
| ergo-3 | Calculatrice ouverte par défaut (feuille de 668 px) | `calcOpen: false`, et onglets de la calculatrice en `nowrap`. *Décision D6.* | S |
| ergo-9, reco-15 (partie) | ✕ d'onglet de 26 px, toasts qui masquent la barre d'état | Cible de 44 px, `.toast-host { bottom: 48px }`, 2 toasts au maximum, `toast()` avec une action « Annuler ». | S |
| ergo-8 | Cahier et intercalaire affichés 3 fois (189 px de chrome) | Afficher `.pane-head` seulement en split, et réduire le padding de `.dividers`. | S |
| ergo-5 | Bascules ambiguës | Contrôles segmentés : Affichage [Pages\|Défilement], Encre [Brute\|Propre], Conversion [Auto\|Sur zone], Formules [Auto\|Off]. | S |
| ergo-7, manque-raccourcis-doc | Raccourcis introuvables, README faux | Table `SHORTCUTS` unique, fiche d'aide sur F1 ou Ctrl+/, et `title` complets (lisibles, pas de LaTeX brut). Corriger le README. | M |
| ergo-4 | Plus de 50 libellés sans accents | Passe sur les chaînes affichées seulement, sans toucher aux clés internes. | S |
| export-ctrlp-portee | Ctrl+P imprime l'interface | Ctrl+P exporte la page courante, Ctrl+Maj+P tout l'intercalaire. Garde-fou `@media print`. | S |

**Risques.** Faible. `onKey` est aussi modifié aux lots 5 et 7 : faire ce lot en premier.

---

## Lot 5 : Retrouver (recherche et repères « pas compris »)

**Pourquoi.** La recherche ne trouve pas « Vbe », n'amène pas au bon endroit et ne se pilote pas au clavier. Les repères s'empilent en haut de la page, tous avec « À revoir ».
**Fichiers.** `src/core/storage/search.ts`, `src/ui/menu.ts`, `src/ui/pageview.ts` (`addFlag`, `focusBlock`), `src/ui/textdoc.ts` (`revealText`), `src/core/types.ts`, `src/core/storage/repo.ts` (summary et cache).
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| rech-1, automath-11, manque-recherche, rech-8 | La recherche lit le markdown brut, donc « Vbe », « Loi d'Ohm » et les mots en gras sont introuvables | `searchableText` = `docPlainText` puis `texToPlain` (retirer `_ ^ { } \left`, `\frac{a}{b}` devient a/b, grec vers son nom, des deux côtés). Des extraits propres en découlent. Tests. | S |
| rech-3, ergo-11 | Écran de recherche sans clavier | ↑/↓ pour choisir, Entrée pour ouvrir, Échap pour revenir **à la page en cours** (mémoriser l'écran précédent). Garder la dernière requête. Traduire le type de bloc. | S |
| rech-2 | Le résultat ouvre le haut de la page | `openAt(…, blockId, query)` puis `focusBlock`. `TextDoc.revealText(query)` : Range, `scrollIntoView` et surlignage temporaire (`CSS.highlights`). | M |
| rech-5, ergo-14, manque-flag-2 | Le repère n'est pas à l'endroit exact et sa note est générique | Hauteur du repère = hauteur du curseur, sinon celle du dernier trait. `FlagBlock.context` (environ 80 caractères de la ligne) et `created`. La vue affiche le contexte, triée par date. Un seul toast. | M |
| rech-12 | On ne peut pas marquer « compris » depuis la liste | Bouton « Compris » avec annulation, badge de matière cliquable vers une vue filtrée, ouverture via `focusBlock`. | S |
| rech-9 | Phrase exacte seulement, 200 résultats coupés sans le dire | Mots en ET, guillemets pour une phrase exacte, tri par date, « 200 premiers sur N », `<mark>`, filtre `@maths`. | M |
| image-suppression-orphelin | Le texte OCR d'une photo supprimée remonte encore | Ne pas indexer une image en ligne dont le marqueur a disparu du texte. | S |
| rech-7, nav-9, rech-6, donnees-13 | Ctrl+M et chaque frappe relisent toutes les pages | `summary()` renvoie aussi les repères (un seul parcours). Cache de session `chemin → {mtime, texte, repères}`, invalidé par `writePage`. Recherche annulable (`isStale`). Plus d'écriture de `cahier.json` pendant une lecture (voir lot 7). | M |

**Risques.** Le cache ne doit jamais faire foi : toujours revérifier le `mtime` pour les changements venus d'OneDrive. `textdoc.ts` est touché : faire ce lot après le lot 1.

---

## Lot 6 : Reconnaissance manuscrite fiable

**Pourquoi.** Des conversions sont perdues en silence (file mémoire, collision entre deux réponses, mauvais intercalaire), avec en plus une écriture disque concurrente qui peut perdre des traits.
**Fichiers.** `src/core/ink/recognizer.ts`, `src/core/ink/words.ts`, `src/ui/pageview.ts` (applyRecognition, onRegion, onErase), `src/ui/app.ts` (onRecognized, editKeys).
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| reco-1 | Une réponse ancienne efface le job le plus récent | `if (jobs.get(key) === job) jobs.delete(key)`, puis `continue`. Remettre `pending=false` seulement si la file est vide pour cette clé. Test. | S |
| nav-11, reco-14, donnees-7 | Résultat appliqué au mauvais intercalaire, écriture disque concurrente | Utiliser la vue seulement si le cahier, l'intercalaire et le bloc correspondent. Sinon, faire **une seule** écriture disque depuis App (`applyRecognitionToDisk`), en cherchant le `blockId` dans tout l'intercalaire. Clé = `page.id` (voir lot 2). | S |
| reco-2, donnees-7 | La file hors ligne est perdue au redémarrage | Au chargement de la page, remettre en file les blocs `pending`. `setBackend()` pour prendre en compte les clés sans relancer l'appli. | M |
| reco-4 | Pas de timeout, reprise lente, 401/429 réessayés à l'infini | `AbortSignal.timeout(15000)`. Sur `online`, `focus` et `visibilitychange`, remettre `nextTry = 0`. Attente plafonnée à 30 s. Erreurs typées : 401/403 donnent « Clés refusées », 429 donne « Quota atteint ». | S |
| reco-12 | Un job en échec bloque les autres | `continue` au lieu de `break`, et erreur conservée sur le job concerné (tag « non reconnu » sur le bloc). | S |
| reco-5 (partie words) | Schémas et surlignages rattachés au mot le plus proche | Seuil de distance et de hauteur, surligneurs exclus, couleur prise sur un trait de stylo. | S |
| reco-7 | Mots parasites laissés après une Zone math | Dans `onRegion`, appeler `dropStrokes` sur `ink.words` et recalculer `recognized`. | S |
| reco-10 | Gommer une partie d'un mot ne relance pas la conversion | `scheduleAutoConvert` dans `onErase` si un mot a été amputé. | S |
| reco-9 | Une correction de mot est réimposée à tort | Stocker `misread`, et ne reporter la correction que si les traits sont identiques. | S |
| reco-11, reco-15 | Clés : relance obligatoire, pas de test, messages trompeurs | Envoi de test dans le dialogue, pas de clé HMAC dans `localStorage`, Ctrl+R sans clé ouvre la saisie des clés. | S |
| reco-3 (partie S) | La page entière est renvoyée toutes les 500 ms | Délai de 1,5 s en mode Auto, compteur mensuel avec alerte à 80 %. *Envoi par bande de lignes : voir le lot 11.* | S |
| reco-13 | Horodatage des traits remis à zéro | `Stroke.startedAt`, et envoi de temps absolus. | S |
| reco-8 | Corriger une formule oblige à éditer du LaTeX brut | Dialogue MathLive plutôt que `askText`, et table de confusions (dx/dz, a/α…). | M |

**Risques.** À valider sur le vrai service MyScript (quota, 401). Ce lot dépend du lot 2 pour la clé par `page.id`.

---

## Lot 7 : Navigation et organisation des cahiers

**Pourquoi.** On revient sur la mauvaise page, les dossiers réels de Maxence sont pollués, et le split tel que la spec le décrit n'existe pas.
**Fichiers.** `src/ui/app.ts` (onglets, split, menu), `src/core/storage/repo.ts`, `src/ui/menu.ts`, `src/ui/pageview.ts` (load, défilement), `src/core/types.ts`.
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| nav-3, ergo-12 | Dernière position par cahier, et « Reprendre » absent | `lastPage: Record<intercalaire, n>`, `setLastPosition` à l'ouverture. `.resume` aligné à gauche, Split masqué dans le menu, « Sonde stylet » déplacée dans les réglages. | S |
| nav-10, donnees-14 | `cahier.json` écrit dans tous les dossiers et à chaque défilement | Ne plus écrire dans `listDividers`. Un dossier est une matière s'il contient `cahier.json` ou `*.page.json`, sinon il va dans « Autres dossiers ». Ignorer les dossiers `.git`. Écritures de meta mises en file. `normalizeMeta` garde les champs inconnus. Page d'une version future ouverte en lecture seule. *Décision D8 pour la position.* | S |
| nav-4 (palier 1) | L'appli crée `0001` dans les dossiers qui ont des sous-dossiers | Ne pas créer la page, et afficher les sous-dossiers ou un bouton « Nouvelle page ici ». | S |
| nav-8 | Ctrl+M aller-retour remet la page en haut | `savedScroll`, restauré au rattachement de la vue. | S |
| nav-7, ergo-13, manque-split-meme-cahier | Split impossible dans un même cahier, et les outils agissent toujours à gauche | Onglets identifiés par cahier et intercalaire, « Ouvrir à droite » sur un intercalaire, `focusedTab()` pour toutes les actions. Replier la calculatrice en split. | M |
| nav-13, manque-gestion-cahiers | Pas de renommage, de couleur ni de réordonnancement, et un doublon réinitialise le cahier | `createNotebook` ne réécrit pas un cahier existant. Carte de matière avec un menu ⋯ (Renommer, Couleur, Supprimer vers la corbeille). Intercalaires : appui long, « Déplacer à gauche/droite ». | M |
| manque-nav-pages | 30 pages = 30 clics | Panneau des pages (numéro, date, première ligne) au clic sur « p. N », date dans l'en-tête de page. | M |
| nav-14 | Menu sans clavier, Vrac perdu dans la grille | Entrée pour reprendre, frappe pour filtrer, flèches. Vrac épinglé en dernier. | S |
| rech-11 | Aucun retour arrière après un saut | Pile `navHistory`, Alt+← et le bouton retour de la souris. | S |

**Risques.** Passer à plusieurs onglets par cahier oblige à revoir le routage de `onRecognized` (lot 6). Faire ce lot après le lot 6.

---

## Lot 8 : Synchronisation OneDrive entre deux PC

**Pourquoi.** C'est une exigence de la section 11 de la spec, et elle n'est pas branchée. Une version d'un cours peut disparaître de l'appli sans avertissement.
**Fichiers.** `src/ui/app.ts` (ouverture et fermeture), `src/platform.ts`, `src/core/storage/repo.ts`, `src/core/types.ts`, `src/ui/pageview.ts` (lecture seule).
**Effort total.** M.

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| donnees-8, manque-presence-onedrive | `checkPresence`, `claim` et `release` ne sont jamais appelés | Appel à l'ouverture d'un cahier, `claim` toutes les 5 min, `release` à la fermeture (onglet et `onCloseRequested`). « Lecture seule » devient un vrai drapeau qui bloque `queueSave` et `flush`, avec un bandeau. | S |
| donnees-8 | Copies de conflit `0003.page-PC.json` invisibles | `listConflicts`, bandeau sur la page (Voir, Fusionner l'encre par id de trait, Supprimer la copie), pastille sur l'intercalaire. Ne jamais supprimer une copie automatiquement. | M |

---

## Lot 9 : Calculatrice juste et rapide

**Pourquoi.** Elle donne des résultats faux sans aucun message (virgule, intégrale « exacte » fausse, asymptotes prises pour des racines), et le clavier AZERTY est inutilisable.
**Fichiers.** `src/core/calc/{engine,derive,integrate,solve,matrix,plot}.ts`, `src/ui/calculator/index.ts`, `src/ui/pageview.ts` (blocs calc et courbe).
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| calc-virgule | `nthRoot(8,3)` donne 2,88 et `max(1,2)` donne 1,2 | Ne remplacer « chiffre,chiffre » par un point qu'hors des parenthèses et crochets. Tests. | S |
| calc-derive-moins | La dérivée de `exp(-x)` ou `-x^2` plante | Condition `args.length === 2`, et `explain` dans un try/catch. | S |
| calc-integrale-fausse | ∫₋₁¹ 1/x = 0 affiché comme « exacte » | Échantillonner f sur [a,b] : si une valeur est non finie, c'est une intégrale impropre. Comparer à `simpson`. | S |
| calc-racines | Pôles comptés comme racines, variable forcée à x, x=x | Rejeter une racine si \|f(r)\| est grand. Traiter le degré 0. Déduire l'inconnue des symboles. Afficher au plus 10 racines puis « … ». | M |
| calc-clavier-vole | Ctrl+L et Ctrl+Z tapés dans la calculatrice | Ignorer Ctrl, Alt et Méta. Flèches, Suppr, Échap, Début/Fin, ↑/↓ pour l'historique, caractères `! = [ ] ;`. `show()` arme la calculatrice. | S |
| calc-azerty | `^` (touche morte) et `²` ignorés | Touche morte `Dead` + code `BracketLeft` = `^`. Accepter `²` et `³`. | S |
| calc-onglets-etat | Changer d'onglet efface la saisie, exemples préremplis, Entrée inopérante | État conservé par onglet, exemples en placeholder, Entrée (ou Ctrl+Entrée dans les zones de texte) lance l'action, focus sur le premier champ. | M |
| calc-ln-log-messages | `ln` inconnu, `log` = ln, messages en anglais | `ln` devient `log`, `log` à un argument devient `log10`. Messages traduits. Garder les fonctions `f(x)=` définies par l'utilisateur. | S |
| calc-residus-flottants | sin(π) = 1,22e-16 | Afficher 0 si \|v\| < 1e-13, en traitant séparément partie réelle et imaginaire. | S |
| calc-fenetre-courbe | Bornes ±60, fenêtre inversée, pas de graduations | Fenêtre calée sur les quantiles 2 % et 98 %, axes gradués. Ensuite : ymin/ymax dans `GraphBlock.range`, lecture au toucher, rendu partagé avec `drawMini`. | S puis M |
| calc-ecran-ti | Curseur invisible, pas de `ans`, pas d'historique | Afficher le curseur, préfixer `ans` si la saisie commence par un opérateur, ↑ ou un clic sur l'historique pour réinsérer, effacer l'erreur à la frappe. *Décision D10.* | S |
| calc-blocs-morts, manque-blocs-vivants | Blocs courbe et calcul figés, posés sur le texte, et un toast qui ment | Idéal : les mettre dans le flux du texte, comme les images. Sinon, `nextFreeY` compte le texte et un bouton ✕. Un clic ouvre la calculatrice préremplie avec « Mettre à jour ». Rendu avec `toLatex`, mode `angle` stocké. Corriger le toast tout de suite. | M |
| calc-litteral-preview-envoi | Pas de « Lu par le moteur », pas d'envoi dans la page, matrices « 0,5 » cassées | Matrices : séparateurs espace et `;`, cellules évaluées. Aperçu de lecture et bouton « Envoyer dans la page » sur chaque résultat. | M |
| calc-exact | Résultats seulement en décimal | √2 pour le second degré, `ln 2` dans les dérivées. Le reste plus tard. | M |

---

## Lot 10 : Photos et export PDF

**Pourquoi.** Il est impossible de coller une capture Win+Maj+S, le dialogue photo déborde en portrait, et un PDF d'une page longue sort illisible.
**Fichiers.** `src/ui/image-import.ts`, `src/ui/textdoc.ts` (collage, poignée), `src/ui/pageview.ts` (`exportPdf`, `routePointers`), `src/style.css`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src/core/types.ts`.
**Effort total.** M+ (environ 1,5 jour).

| id | Quoi | Correctif | Effort |
|---|---|---|---|
| coller-deposer-image | Coller une capture ou déposer une image : rien ne se passe | Coller un `image/*` l'insère directement, sans recadrage, avec l'OCR en fond. Dépôt de fichier : `dragDropEnabled: false` avec `dataTransfer.files`, ou l'API de glisser-déposer de Tauri. | M |
| crop-portrait-deborde | Photo en portrait : coins et aperçu hors écran | Échelle calculée aussi sur la hauteur, aperçu à côté de la photo, boutons dans le bas du dialogue. | S |
| crop-clavier | Ni Échap ni Entrée dans le dialogue, pas de raccourci d'import | Échap, Entrée, N (noir et blanc), R (réinitialiser). Alt+P pour importer. | S |
| image-stylet-doigt | Photo impossible à retailler ou déplacer au stylet | `routePointers` ignore `.doc-img`. Poignée de 44 px pour tous les pointeurs, sélection au toucher avec mini-barre (monter, descendre, supprimer), déplacement par pointer events. | M |
| export-zoom-illisible | Une page longue est réduite à environ 50 % | Pas de réduction au-delà de 1150 px de haut, découpage sur plusieurs feuilles (`break-inside` seulement sur les images et formules). À terme, une tranche de canvas d'encre par feuille A4. | M |
| export-robustesse | Pas de try/finally, double clic possible, photos Tauri blanches | Drapeau `exporting` et `try/finally`. `TextDoc.imagesReady` attendue avant la mesure. | S |
| heic-silence | Une photo HEIC échoue en silence | Toast d'erreur avec le nom du fichier et le conseil de réglage iPhone. | S |
| ocr-thread-principal | La fenêtre gèle pendant l'OCR | `#[tauri::command(async)]` pour `ocr_image`, `read_binary` et `write_binary`. Cache des data URL. | S |
| noir-blanc-defaut-original | Noir et blanc forcé, original jeté | Dernier choix mémorisé. Garder l'original en JPEG avec son `quad`, pour « Redresser à nouveau ». Rayon de binarisation proportionnel à la taille. *Décision D9.* | M |
| png-photo-poids | Photos couleur en PNG de 3 à 5 Mo | JPEG q85 en couleur, extension transmise au bloc. | S |
| photo-telephone-flux | Une seule photo par import | Attribut `multiple` et enchaînement de dialogues « Suivante ». | S |
| export-encre-raster | Encre pixelisée dans le PDF | Rendu en densité 3 pendant l'export. | S |

**Risques.** `dragDropEnabled: false` change le comportement de Tauri : vérifier le glisser-déposer interne des photos. `textdoc.ts` est touché : faire ce lot après le lot 1.

---

## Lot 11 : Gros chantiers (plus tard, un par un)

| id | Quoi | Effort |
|---|---|---|
| encre-13, manque-lasso | Sélection au lasso : déplacer, recolorer, supprimer, puis insérer de l'espace | L |
| encre-11 | Zoom : pinch à deux doigts, Ctrl+molette, Ctrl+/- | M-L |
| donnees-12 | Mode défilement virtualisé (100 pages = 2,9 s). Prérequis : `donnees-9`. **Fait** : ouverture 100 pages 2,1 s → 0,17 s, 100 → 2-3 canvases (`src/core/virtual.ts`) | L |
| nav-4 (palier 2) | Arborescence à 3 niveaux (E3A/S1/Chapitre 1) | L |
| reco-3 (fond) | Conversion incrémentale par bande de lignes | L |
| rech-10, manque-liens | Création de liens, cibles par `page.id` | L |
| pdf-absent | Import et annotation de PDF (priorité 3 de la spec) | L |
| encre-14 | Gomme précise qui coupe les traits | M |
| donnees-10 (v2) | Format de points en tableau plat, via `migratePage` | M |
| manque-filtre-couleur | Vue « tous les théorèmes de Maths » | M |

---

## Décisions à prendre (choix produit)

| # | Question | Recommandation |
|---|---|---|
| D1 | **Variables seules** : les convertir à l'espace (comportement actuel), ou attendre le mot suivant ? | **Attendre le mot suivant** et utiliser une liste blanche stricte (V/I/U/R/C/L/P/Z + indice connu). C'est ce qui rétablit le « avant ils se mettaient auto propres ». |
| D2 | **Encre neutre noire par défaut** : ajouter une 6e valeur `'normal'` hors palette sémantique ? | **Oui.** Sinon tout le cours est marqué « Définition » et le filtrage par couleur ne sert à rien. Ce n'est pas une couleur libre, donc la palette fermée est respectée. |
| D3 | **Ctrl+F** : garder « Pas compris » (spec), ou lui donner la recherche comme dans Windows ? | **Garder Ctrl+F = Pas compris**, toujours intercepté, avec un toast « Annuler ». La recherche reste sur Ctrl+K. Mentionner les deux dans l'aide F1. |
| D4 | **Arborescence à 3 niveaux** (E3A/S1/Chapitre) alors que la spec en décrit 2 | Tout de suite le palier 1 (ne plus polluer les dossiers). Palier 2 seulement si Maxence veut garder ce rangement ; sinon, aplatir en intercalaires « S1 · Chapitre 1 ». |
| D5 | **Quels dossiers sont des matières ?** | Ceux qui ont `cahier.json` ou des pages. Les autres vont dans « Autres dossiers » avec un bouton « En faire une matière ». Proposer (sans l'imposer) le nettoyage des `cahier.json` déjà créés. |
| D6 | **Calculatrice ouverte par défaut ?** | **Fermée** (Ctrl+L). Flottante sous 1400 px de large. |
| D7 | **Corbeille** : `ESEO/.corbeille` ou corbeille Windows ? | **`.corbeille` dans ESEO** : synchronisée entre les deux PC, restaurable depuis l'appli, sans dépendance. Vidage manuel. |
| D8 | **Dernière position** : dans `cahier.json` (synchronisé) ou en local par PC ? | **En local** (localStorage) : moins d'écritures OneDrive et moins de conflits. Chaque PC reprend là où il était. |
| D9 | **Photo : noir et blanc par défaut, et conservation de l'original ?** | Retenir le dernier choix, et **toujours garder l'original** en JPEG, dans l'esprit de « l'encre brute n'est jamais jetée ». |
| D10 | **Calculatrice façon TI** : « +1 » après un résultat utilise `ans` ? | Oui pour `+ * / ^ ² !`. Pour `-`, garder le moins unaire. |
| D11 | **Titres et listes** dans le texte tapé (`#`, `##`, `-`) | **Oui**, déclenchés à l'Espace en début de ligne. Cela étend le markdown restreint de façon compatible et sert au futur panneau des pages. |
| D12 | **Fonds de page** (quadrillé 5×5, Seyès, points) par intercalaire | **Oui**, effort S, en fond CSS sous le canvas. Très utile pour les schémas d'électronique et les chronogrammes. |
| D13 | **Segments de code** dans les notes d'info (`` `…` `` sans formules auto) | Plus tard. En attendant, les correctifs de `automath-8` et l'interrupteur « Formules auto » par page suffisent. |
| D14 | **Quota MyScript** : délai de 1,5 s et compteur, ou conversion seulement sur zone par défaut ? | Délai de 1,5 s avec compteur visible. Remettre en question si le quota est atteint en moins de 2 semaines. |

**Ordre conseillé.** Lot 1, puis 2, 3, 4, 5, 6, 7, 8, 9, 10, 11. Les lots 1 et 2 corrigent la plainte sur Vz/I1 et toutes les pertes de données critiques. Environ 3 jours de travail.