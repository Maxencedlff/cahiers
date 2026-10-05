# Projet « Cahiers »

Application de prise de notes pour études d'ingénieur (ESEO). Remplace intégralement les cahiers papier : maths, électronique, informatique, IA.

Ce fichier est la référence du projet. À placer à la racine du dépôt. Le lire avant toute modification.

---

## 1. Contraintes non négociables

Ces points ont été tranchés. Ne pas les remettre en question sans me demander.

- **Application de bureau native**, pas un site web, pas une PWA. Un `.exe` installable, une icône, une fenêtre Windows normale. Aucun navigateur ne s'ouvre, aucune URL n'est jamais visible.
- **Stack : Tauri + TypeScript.** Pas Electron. Raison : autonomie batterie (le portable tient ~3 h) et empreinte mémoire. Tauri utilise le WebView2 déjà présent dans Windows.
- **Une seule instance à la fois.** Single-instance lock. Un second lancement remet au premier plan la fenêtre existante.
- **Le verrou d'instance est local à la machine**, jamais écrit dans le dossier synchronisé.
- **Un fichier par page**, jamais un fichier unique global, jamais SQLite. Raison : le dossier est synchronisé par OneDrive entre deux PC ; un conflit doit coûter une page, pas un semestre. SQLite se corrompt sur dossier synchronisé (fichiers `-wal` / `-shm`).
- **L'application lit l'arborescence du disque, elle ne la possède pas.** Un dossier créé dans l'explorateur Windows apparaît au lancement suivant. Un renommage dans l'app renomme le dossier réel. Aucune base cachée, aucun index qui fasse autorité sur le disque.
- **Formats ouverts et lisibles.** JSON en clair. L'utilisateur ne doit jamais être prisonnier de l'outil.

---

## 2. Structure des données

```
ESEO/                          <- racine, dans OneDrive
├── Maths/                     <- une matière = un cahier
│   ├── cahier.json            <- titre, couleur, ordre des intercalaires, mode et fond de page par intercalaire
│   ├── Cours/                 <- un intercalaire = un dossier
│   │   ├── 0001.page.json
│   │   ├── 0002.page.json
│   │   └── assets/            <- images, PDF importés
│   ├── Exos/
│   └── TD/
├── Élec/
├── Info/
└── Vrac/                      <- toujours présent, hors matières
```

- Les intercalaires sont libres : créés, renommés, réordonnés par l'utilisateur. Chaque matière a les siens.
- Numérotation des pages **par intercalaire**, pas globale. « Exos p.12 » a du sens, « cahier p.247 » n'en a pas.
- Insérer une page au milieu renumérote automatiquement.

### Format d'une page

Une page est une **pile de blocs typés**. Le schéma doit prévoir dès la v1 tous les types ci-dessous, même si seuls deux sont implémentés au départ. Ajouter un type après coup obligerait à migrer tous les fichiers.

```json
{
  "version": 1,
  "id": "uuid",
  "created": "ISO8601",
  "modified": "ISO8601",
  "blocks": [
    { "type": "text",  "content": "markdown" },
    { "type": "ink",   "strokes": [...], "recognized": null, "mode": "raw" },
    { "type": "math",  "strokes": [...], "latex": "\\int_0^{+\\infty}...", "mode": "math" },
    { "type": "image", "src": "assets/x.png", "ocr": "texte extrait" },
    { "type": "pdf",   "src": "assets/y.pdf", "page": 3, "annotations": [...] },
    { "type": "calc",  "expr": "cos(pi/4)*3", "result": 2.1213 },
    { "type": "graph", "fn": "sin(x)*x/2", "domain": [-8, 8] },
    { "type": "link",  "target": "Maths/Cours/0012#block-3", "label": "théorème", "pageId": "uuid" },
    { "type": "flag",  "note": "revoir le critère de Riemann" }
  ]
}
```

#### Points d'un trait : format v2 (schéma `"version": 2`)

Depuis la v2, les points d'un trait sont écrits en tableaux plats, un trait par ligne, au lieu d'un objet `{x, y, p, t}` par point (60 à 190 octets par point en v1) :

```json
{"id":"uuid","points":[],"color":"normal","width":1.4,"tool":"pen","startedAt":1759305600123,"pts":[611.2,113.6,611.8,113.6,612.5,115],"p":[0.31,0.42,0.45],"t":[0,8,9]}
```

- `pts` : `[x0, y0, x1, y1, ...]`, en unités de page, au dixième.
- `p` : pression de chaque point (0..1, au centième) ; un seul nombre si elle est constante ; absent si nulle (souris).
- `t` : `[t0, d1, d2, ...]` en ms entières, `t0` puis l'écart avec le point précédent ; absent si tous les temps sont nuls.
- `tilt` : `[tx0, ty0, ...]`, seulement si le stylet donne l'inclinaison.
- `points: []` reste vide : la version 1 de l'application lit alors la page sans planter (lecture seule, sans encre). Les vrais points sont dans `pts`.

En mémoire, les points restent des objets `{x, y, p, t}` ; la conversion se fait seulement à la lecture (`decodeStroke`, appelé par `migratePage`) et à l'écriture (`encodeStroke`, dans `serializePage`). Une page v1 se lit toujours et n'est réécrite en v2 que lorsqu'elle est modifiée. Sur un PC encore en v1, une page v2 s'ouvre en lecture seule (« version plus récente »).

Bloc `pdf` : une page de l'appli par page du PDF (PDF entier copié une fois dans `assets/`, `page` 1-based, `rect` = sa place sur l'A4). Champs optionnels : `text` (texte extrait, recherche Ctrl+K), `name` (nom du fichier importé), `size` (`{w, h}` en points). L'encre et le texte par-dessus sont ceux de la page ; `annotations` est lu mais plus écrit.

**Règle absolue : l'encre brute n'est jamais jetée.** Un bloc `math` conserve toujours ses `strokes` d'origine à côté du `latex`. Si la reconnaissance se trompe, le calcul manuscrit est toujours là. Perdre un cours est inacceptable.

**Les blocs `calc` et `graph` sont vivants.** Ils stockent l'expression, pas une image. Un clic rouvre l'éditeur, la modification recalcule et redessine sur place.

---

## 3. Saisie : stylet, doigt, clavier

Utiliser les **Pointer Events** et lire `pointerType`.

- `pen` → écrire uniquement
- `touch` → naviguer uniquement (défilement, pinch-zoom, boutons, intercalaires)
- `mouse` → les deux, selon l'outil actif

Cette séparation donne le rejet de paume gratuitement, sans code dédié.

**Matériel confirmé :** la machine expose un périphérique « Stylet HID » distinct de l'« Écran tactile HID ». Le digitizer actif est bien présent, protocole MPP. La séparation stylet/doigt fonctionnera nativement.

**Détection automatique au démarrage :** si l'app voit passer un `pointerType: pen`, elle active la séparation ci-dessus. Sinon, elle affiche un bouton de mode « écrire / naviguer » avec un raccourci clavier. Ce chemin de secours reste implémenté pour la robustesse, mais ce n'est pas le cas nominal.

Enregistrer la pression (`pressure`) et l'inclinaison quand disponibles.

**Cibles tactiles : 44 px minimum.** Toute l'interface doit être utilisable au doigt. Pas d'icônes de 16 px cliquables.

---

## 4. Reconnaissance manuscrite

Moteur : **MyScript iinkTS** (`npm i iink-ts`), compte développeur avec quota mensuel gratuit.

- Zone `math` → recognizer Math, sortie LaTeX. Gère 250 symboles, formules multi-lignes, systèmes, matrices.
- Zone `text` → recognizer Text, français. Le modèle unifié gère plusieurs langues latines simultanément (utile : français truffé de termes techniques anglais).
- Zone `ink` → aucune reconnaissance, trait brut (schémas, flèches, annotations).

**La reconnaissance se fait côté serveur.** Conséquence obligatoire : une **file d'attente hors ligne**. En amphi sans réseau, les traits sont capturés et stockés ; la conversion part dès le retour de la connexion. L'écriture ne doit jamais être bloquée par l'absence de réseau.

**N'envoyer qu'au lever du stylet + 500 ms de pause**, pas en flux continu. Divise les allers-retours réseau par dix, économise la batterie.

**Correction en un geste :** un appui sur un symbole mal reconnu propose les candidats alternatifs. Indispensable, la reconnaissance ne sera jamais parfaite (`dx`/`dz`, `a`/`α`, accents et apostrophes en français).

**Affichage double :** bascule instantanée entre l'encre brute et le rendu propre. Rendu des formules avec **KaTeX**.

---

## 5. Navigation

Trois niveaux :

1. **Menu** (écran d'accueil) → les matières
2. **Cahier** → les intercalaires
3. **Intercalaire** → les pages

L'application s'ouvre directement sur le menu. Pas d'écran de démarrage.

### Menu
- Bloc « Reprendre » en haut : dernière position, un clic.
- Grille des matières avec couleur et compteur de pages.
- Tri par dernière modification, pas alphabétique.
- Compteur de marqueurs « pas compris » en attente.
- Recherche globale accessible d'ici.

### Cahier
- Bande d'intercalaires visible en permanence, un clic pour changer.
- Ouverture à la dernière position consultée, pas à la page 1.
- Raccourci clavier vers le menu depuis n'importe où, et retour au même endroit.

### Onglets et split
- Onglets en haut, un par cahier ouvert (conséquence directe de l'instance unique).
- Split gauche/droite : glisser un onglet sur la moitié droite.
- Le split fonctionne aussi entre deux intercalaires du même cahier (Cours à gauche, Exos à droite).
- Raccourcis : permuter les panneaux, fermer le panneau droit.

### Pages ou défilement
- Bouton de bascule dans la barre d'outils, à tout moment.
- **La page reste l'unité de base dans les deux modes**, avec un séparateur discret en défilement. Sinon le retour au mode pages est impossible.
- Le mode est mémorisé **par intercalaire**.
- Les numéros de page restent affichés dans les deux modes.

---

## 6. Fonctionnalités

### Priorité 1 — la v1 doit avoir ça
- Pages, blocs texte + encre + math
- Reconnaissance maths et texte
- Recherche plein texte sur tous les cahiers
- Menu, intercalaires, navigation, numérotation

### Priorité 2
- Calculatrice flottante (section 7)
- Split côte à côte
- Marqueur « pas compris » : un bouton unique pose un repère à l'endroit exact ; une vue par matière liste tous les points marqués. En amphi on n'a pas le temps d'écrire une note, on a le temps d'appuyer sur un bouton.
- Import d'images depuis l'appareil photo du téléphone, avec redressement de perspective et **OCR** (l'OCR Windows suffit, pas de service externe). Sans OCR, une photo est un trou noir dans la recherche.

### Priorité 3
- Éditeur PDF intégré (existe déjà par ailleurs, à porter) : annoter les documents fournis par les profs. Fait : import (pages choisies, après la page courante) et annotation, voir section 10 « Import et annotation de PDF ».
- Pont mail → cahier : envoyer un cours reçu par mail directement dans un intercalaire.
- Liens cours ↔ exo : sélectionner une ligne d'exercice et l'attacher au théorème qui la justifie. Un clic y ramène.
- Formulaire auto-généré : marquer des formules et produire une fiche par matière à partir de ses propres notes.
- Analyse dimensionnelle : signaler les incohérences d'unités (mathjs gère les unités). Détecteur d'erreur numéro un en sciences de l'ingénieur.

### Écarté
- Enregistrement audio synchronisé à l'encre. Testé conceptuellement, pas retenu.

---

## 7. Calculatrice

Fenêtre flottante, déplaçable, ouverte au raccourci clavier, positionnable n'importe où sur la page. Utilisable au doigt : **touches de 46 px**.

Moteur : **mathjs**. Quatre onglets.

### Calcul
Pavé complet type Texas Instruments : `2nd`, `mode` (RAD/DEG), `del`, flèches, `x²`, `xʸ`, `log`, `ln`, `sin`, `cos`, `tan`, `x⁻¹`, parenthèses, chiffres, opérateurs, `π`, `e`, `i`, `ans`, `(−)`.

- La touche `2nd` **modifie l'affichage des touches concernées** (petit label au-dessus), elle ne laisse pas deviner.
- Historique de 3 lignes minimum, `ans` réutilise le dernier résultat.
- RAD par défaut.
- Nombres complexes.

### Couleurs — sémantiques, pas décoratives
Chaque famille a la sienne, pour trouver une touche sans lire son label :
- Fonctions → violet
- Opérateurs → bleu
- Constantes et `i` → vert
- Effacement → rouge
- `2nd` → ambre
- `=` → accent
- **Chiffres neutres**, ce sont les plus utilisés ; les colorer écraserait le reste.

### Courbes
Saisie `y = f(x)`, tracé qui se redessine pendant la frappe. Zoom, recherche de racines, tableau de valeurs. **Bouton « envoyer dans la page »** : insère un bloc `graph` vivant, réouvrable et modifiable.

### Matrices
Saisie de matrices, déterminant, inverse, transposée, rang. mathjs fait tout ça.

### Résoudre
Équations polynomiales, systèmes, résolution numérique. Afficher le discriminant et la nature des racines.

### Calcul littéral
`math.simplify`, `math.derivative`, substitution de variables. `2x + x` → `3x`.

**Bouton « afficher les détails ».** Pour la dérivation : parcourir l'arbre de l'expression, identifier la règle appliquée (produit, quotient, chaîne, puissance, linéarité), afficher `u`, `v`, `u′`, `v′`, puis le résultat. Dérivée seconde = dérivée de la dérivée.

**Limite connue : mathjs ne sait pas intégrer.** Pour les primitives, deux options, dans cet ordre :
1. Une table de formes usuelles écrite à la main (polynômes, `1/x`, `exp`, `sin`, `cos`, sommes, constante multiplicative). Couvre une bonne partie des exercices.
2. **Nerdamer** en complément, qui gère l'intégration par parties et par substitution. Recommandé quand le besoin se confirme.

**Réafficher en permanence l'expression telle qu'elle a été comprise**, en rendu KaTeX. `sin x^2` est ambigu ; l'utilisateur doit voir immédiatement ce que le moteur a lu.

---

## 8. Style et couleurs des cahiers

Palette **fermée à 5 couleurs à sémantique fixe** : définition, théorème, exemple, attention, remarque personnelle.

Ne pas offrir de palette libre. Sur trois ans, des couleurs libres deviennent du bruit et ne veulent plus rien dire. Une sémantique fixe rend les couleurs **filtrables** : « montre-moi tous les théorèmes d'analyse » ne fonctionne que si le rouge signifie toujours la même chose.

Polices et tailles : quelques choix, pas une liste infinie.

Outils : plusieurs stylos, surligneur, gomme, annulation (undo/redo profond).

---

## 9. Performance et batterie

Le portable tient environ 3 h. Chaque watt compte.

- **Dirty-rect obligatoire** sur le canvas : ne repeindre que la zone touchée, jamais la page entière à chaque mouvement de stylet. C'est le premier poste de consommation d'une app d'encre mal écrite.
- **Aucune animation en boucle en arrière-plan.** L'animation de tournage de page est jolie trois jours et coûte de la batterie tous les jours : la faire courte, ou pas du tout.
- Écriture disque groupée, pas à chaque trait.
- Réseau : voir la règle des 500 ms en section 4.

---

## 10. Architecture du code

- **Séparer strictement la logique du calcul de l'interface.** La calculatrice et le moteur symbolique dans leurs propres modules, sans dépendance à l'UI. Objectif : pouvoir ajouter un bouton sans risquer de casser la dérivation.
- Même séparation pour la couche de stockage : lecture/écriture des pages isolée du rendu.
- Formules automatiques du texte tapé : logique pure dans `src/core/text/automath.ts` (`findFormulas` avec un mode `final`/`space`/`pause`, `planLine` pour relire une ligne déjà en partie en forme), DOM dans `src/ui/textdoc.ts`. Variable seule (« Vz », « I1 ») : liste blanche, convertie au mot suivant ou à Entrée, jamais à la pause ; une unité (`isUnit`) n'en est jamais une. Noms usuels à initiale minuscule ou grecque en indice, pas en produit (`LOWER_SUB` fc, fe, f0, w0 → ω₀ ; `GREEK_SUB` ω0, τ1) ; `LONE_NAMES` (fc, Fe, Ts, Eth, Gv...) seuls dans la phrase ; `FORMULA_ONLY` (« Te », aussi mot outil) seulement dans une formule. j/pulsation : `IMAG` (jLw = j·L·ω, RCw, jω). Notations tapées : primes (f'(x), apostrophe du français jamais), `u_n`/`u_(n+1)` (base d'une lettre), `BIGOPS` lim/sum/prod/int collés à « _ » (int sans bornes seulement avec « dx »), matrice `(a b; c d)`, ∀ ∃ ∈ ℝ ∞. `mathWordsAtEnd` (Espace/Entrée, jamais à la pause) : forall, infty, « x in RR », « A sub B », RR après ∈/→/:, exists en contexte maths, inf derrière un signe ; « le CC », « logged in » restent du texte. Champ MathLive : `cleanMathLive` à la fermeture (\differentialD, cases vides, « in » entre espaces, parenthèses englobantes) ; `makeEq` ne montre jamais de LaTeX rouge (KaTeX en `throwOnError`, sinon version nettoyée, sinon texte simple `.eq-raw`) ; `FIELD_SHORTCUTS` (in jamais collé à une lettre, inf, lim à une case) ; bornes basse puis haute (`lowerBoundFirst`, `switchBound`, → et Tab) ; dénominateur d'une fraction tapée au « / » = un seul terme (`endOfSlashDen`, aussi pour la fraction ouverte depuis le texte) ; API interne `_mathfield.model` tolérée absente.
- Recherche : logique pure dans `src/core/text/find.ts` (`fold` = casse, accents, grec par son nom, ligatures, avec indices d'origine ; `parseQuery` : mots en ET, "phrase", `@matière`, `#couleur` ; `makeExcerpt`, `flagContext`). `storage/search.ts` et `TextDoc.revealText` plient le texte avec ce même module. `indexPage` (search.ts) : texte simple d'une page (markdown retiré, formules par `texToPlain` relues comme tapées : « -R2/R1 », « Ve · R2/(R1 + R2) », \frac12, `u_(n+1)`, `int_0^1` ; `fold` ignore les blancs autour des opérateurs (`OPS`, `skipBlank`, aussi dans `revealText`) et lit · et * comme « . », OCR d'une photo retirée du texte ignoré, bloc `pdf` cherché par son `text` extrait à l'import) et ses repères ; `Repo.scanDivider` le garde en cache de session par chemin, revérifié par date+taille (`listFilesStat`, commande Rust `list_files_meta`), oublié à chaque écriture ou renumérotation ; jamais écrit. `summary` porte les repères (un seul parcours pour le menu). Recherche annulable (`isStale`), triée par date ; Entrée avant la fin du délai annule la recherche différée et n'ouvre que les résultats de la requête tapée. Résultat ou repère → `App.openAt` → `focusBlock(page, id, query)` (2 images d'attente avant de mesurer). Repère : hauteur du curseur (`TextDoc.caretSpot`) ou du dernier trait selon le dernier geste, pastille centrée sur la ligne (44 px de haut), en défilement sur la page de ce geste si elle est à l'écran (`flagTarget`), `context` + `created` ; « Compris » depuis la liste passe par la vue qui a la page en mémoire (`PageView.setFlagResolved`), sinon par le disque. Recherche et repères : Échap/Retour reviennent à l'écran d'origine (`auxFrom`).
- Dernière position (D8) : `src/core/position.ts`, logique pure + classe `Positions`. Par cahier et par intercalaire, dans le stockage local de la machine (`cahiers.positions.v1`), jamais dans `cahier.json` (l'ancienne position y est lue seulement, valable pour son seul intercalaire) ; sert à « Reprendre » (`latestSpot`), suit renommages et suppressions ; `record` sur la même page n'écrit rien sauf si une autre matière est plus récente (`isLatest`, la date avance). Retenue à l'ouverture, au changement de page et au changement de panneau visé (`place`, `setFocused`). Tests : `src/tests/position.test.ts`.
- Navigation : logique pure dans `src/core/nav.ts`. `NavHistory` (pile bornée des endroits quittés par un saut : recherche, repère, lien, liste des pages ; Alt+← et bouton retour de la souris), `filterByTitle` + `gridStep` (menu au clavier), `moveItem` (ordre des intercalaires), `pickSplitDivider` (Exos/TD/TP à droite, sinon le suivant), `dayLabel` (« 3 oct. »). Onglet = cahier + intercalaire (jamais deux sur le même) ; `focusedTab()` pour toutes les actions en split, Ctrl+Tab change l'onglet du panneau visé sans refermer le split. `openNotebook` ignore la page demandée si l'intercalaire n'existe plus. Liste des pages : `src/ui/pagelist.ts` (`indexPage` donne `created` + `firstLine`). Tests : `src/tests/nav.test.ts`.
- Intercalaires imbriqués (D4, palier 2) : logique pure dans `src/core/dividers.ts`. Intercalaire = chemin relatif à la matière (« E3A/S1/Chapitre 1 »), au plus `MAX_DEPTH` = 3 niveaux (plus bas : ignoré) ; groupe = dossier de dossiers, ouvrable s'il a ses propres pages (`openableDividers`). `buildTree` (ordre de `cahier.json` en chemins relatifs par niveau, puis disque ; ancien cahier.json valable), `renamePrefix`/`remapKeys` (modes, fonds, positions, historique suivent un groupe renommé ou déplacé), `parsePagePath` (liens : matière = 1er segment, numéro = dernier), `dividerLabel` (« S1 › Chapitre 1 »), `defaultExpanded`/`expandedChain` (sous-bande), `moveAmongSiblings` (seul compte le rang relatif des voisins), `moveRefusal`. Repo : `listDividerTree` (un dossier contenant `.git` n'est pas lu), `listDividers` = tous les chemins à plat (recherche, repères, compteurs, copies de conflit), `createDivider(dir, nom, groupe)`, `renameDivider` (dernier niveau), `moveDivider(dir, chemin, groupe)` (dossier réel déplacé, `remapMeta`) ; clé de reconnaissance relue par `parseBlockKey` (matière = 1er segment). UI (app.ts) : bande à deux rangées au plus (`.divider-strip` : premier niveau, puis sous-bande du groupe ouvert `Tab.expanded` avec fil d'Ariane, « Pages de S1 » si le groupe a ses pages, « + » dans le groupe), groupe = ▸, flèches ←→↓↑ ; menu d'intercalaire : « Ranger dans un groupe… » (ou nouveau groupe), « Sortir de … » ; `retarget` fait suivre onglets, vues, positions et historique ; Ctrl+T crée à côté de l'intercalaire ouvert ; Ctrl+Maj+Pg↓/↑ et le split parcourent `openableDividers`. Groupe sans page ouvert : `folderSheet` avec ses intercalaires en boutons (`PageViewHost.openDivider`). Tests : `src/tests/dividers.test.ts`, `storage.test.ts` (« arborescence a 3 niveaux »).
- Racine (`Repo.classifyRoot`) : matière = `cahier.json` ou des pages (`hasPages`, borné, cache 1 min) ; sinon « Autres dossiers ». Dépôt git (`.git`) : jamais une matière, `createNotebook`/`adoptNotebook` refusent. `cahier.json` écrit seulement sur action (`updateMeta`, une à la fois par cahier), `normalizeMeta` garde les champs inconnus ; `lastPosition` n'est plus écrite. Intercalaire sans page mais avec sous-dossiers : aucune page créée (`folderSheet`, « Nouvelle page ici »). Page de version future (`isFutureVersion`) : lecture seule (`.sheet.readonly`, `queueSave`/`writePage` refusent). Défilement gardé quand la vue quitte l'écran (`savedScroll`, `attached()`).
- Mode de lecture : défilement par défaut (`PageView.load`, `meta.viewMode[intercalaire] ?? "scroll"`), « Pages » seulement si choisi ; Ctrl+Maj+D bascule (commande `viewMode`), aussi dans le menu « ⋯ ».
- Annulation : `src/core/history.ts`, logique pure. `PageHistory` garde des piles par id de page (jamais par numéro), `drop` à la suppression ; un trait ajouté = commande légère (`applyStrokeCommand`), le reste = instantané JSON (un seul par geste de gomme, `onEraseStart`) ; `restoreBlocks` ne restaure ni le texte tapé (il a son propre Ctrl+Z) ni les photos posées dedans. Tests : `src/tests/history.test.ts`.
- Sauvegarde (`pageview.ts`) : file indexée par id de page, numéro lu au moment d'écrire ; écritures et renumérotations passent l'une après l'autre (`serial`) ; échec = nouvel essai 3 s et pastille « Non enregistré ». Aucune renumérotation tant qu'une page reste non écrite. Vue quittée avec une écriture en échec : gardée dans `App.orphans` (barre d'état, fermeture), et `adopt(old)` avant `load()` quand on rouvre son intercalaire (une seule vue écrit la page). Fermeture de la fenêtre : `onCloseRequested` (main.ts) attend `flushAll`. Côté Rust : `sync_all` avant le renommage, 5 essais si le fichier est verrouillé.
- Suppression = corbeille, jamais effacement : `ESEO/.corbeille/<horodatage>/<chemin relatif>` (`repo.deletePage`/`deleteDivider` rendent un `TrashEntry`, `restorePage`/`restoreDivider` le remettent). Toast « Annuler » de 8 s (`toast(..., action)` dans dom.ts).
- Encre : logique pure dans `src/core/ink/` (`sheet.ts` : `PAGE_W`/`PAGE_H`, feuille plus haute que l'A4 via `Page.height` optionnel, le canvas suit `sheetHeight` ; `pointer.ts` : bout gomme et bouton latéral = gomme, outil figé pour le geste, paume ignorée 400 ms autour du stylet ; `stroke.ts` : points arrondis, bornes en cache, format disque v2 via `encodeStroke`/`decodeStroke` seuls (tableaux plats `pts`/`p`/`t`/`tilt`, lecture v1 `points` acceptée, `isMemoryStroke`)). Encre neutre `'normal'` (noire) par défaut, une seule couleur active pour l'encre et le texte. Surligneur ×7, peint sous l'encre, jamais envoyé à la reconnaissance. Zones math/texte ponctuelles (Alt+Z deux fois = verrou) ; `onRegion` repeint les traits APRÈS avoir ajouté le bloc (sinon l'encre de la zone disparaissait, visible surtout sans clés MyScript). `penSeen` mémorisé ; Ctrl+D l'oublie (stylet à plat : le doigt réécrit jusqu'au prochain contact du stylet). `Page.height` redescend à l'ouverture et à l'annulation du trait qui l'avait allongée (`shrinkToInk`), jamais pendant la gomme. `fitSheet` mesure le texte seul (`min-height` de la couche texte à 0 le temps de la lecture), sinon la feuille ne redescendait jamais. Pages écrites en JSON indenté, un trait par ligne (`serializePage`, format v2) ; `migratePage` (repo.ts) lit v1 et v2, ramène la page à `SCHEMA_VERSION` en mémoire sans rien écrire (une page v1 ouverte reste v1 sur le disque jusqu'à sa première modification) ; `cahier.json` garde `META_VERSION` 1. Tests : `src/tests/encre.test.ts`, `src/tests/format-v2.test.ts` (aller-retour v1 → v2, page mixte, trait d'un point, pression constante, page v3 en lecture seule, copies de conflit et corbeille).
- Lasso, transformation, insertion d'espace, gomme précise (encre-13/14) : logique pure dans `src/core/ink/selection.ts`. Trait déplacé/retaillé/recoloré garde son id (fusion OneDrive par id) ; trait collé (`pasteClip`) ou morceau coupé à la gomme (`splitStroke`, `replaceStrokes`) reçoit un id neuf. Lasso = > 50 % des points (`LASSO_RATIO`) ; zone math/texte reconnue indivisible ; `clampMove`/`resizeTransform` bornés à `PAGE_W` ; zone math vidée par la gomme perd son LaTeX et disparaît. Mot dont une partie seulement bouge lâche les traits partis ; espace : `strokesBelow` (centre du trait sous la ligne, zone entière), `clampSpace` (vers le haut, borné au blanc). UI : outil `lasso`/`space` (Alt+A, deux fois = espace ; jamais mémorisé), gomme `settings.eraserMode` (Alt+G deux fois). `InkSurface` : aperçu du geste peint transformé sans toucher au modèle (`preview`), poignée bas-droite 44 px, le doigt déplace une sélection même en navigation (hors paume) ; `PageView` applique à la fin (`transformBlocks`, un `pushUndo` au premier mouvement), barre `.lasso-bar` (couleurs, Copier, Supprimer), presse-papiers d'encre commun aux vues (`inkClip`), Ctrl+C/X/V seulement hors du texte. Tests : `src/tests/selection.test.ts`.
- Copier du texte tapé (`TextDoc.onCopy`) : type interne (morceau `serializeDoc`, formules comprises), texte simple avec formules relues comme tapées (`docClipboardText(tokens, texToPlain)` : « (3+5)/2 »), HTML avec formules en MathML KaTeX (`clipboardHtml` ; Word les colle en équations) + `data-cahiers` de secours. Formules `user-select: all` (sélectionnables en bloc), `.in-sel` quand la sélection les touche (`markSelectedEqs`).
- Reconnaissance : logique pure dans `src/core/ink/`. `recognizer.ts` : file (`RecognitionQueue`) un envoi à la fois, une version plus récente posée pendant l'envoi n'est jamais effacée (`has(key)` = résultat provisoire, le bloc reste en attente) ; erreurs typées (`RecoError` : network = nouvel essai plafonné à 30 s, keys 401/403 = file arrêtée jusqu'à `setBackend`, sauf si les clés ont changé pendant l'envoi, quota 429 = pause 10 min, refused = bloc seul marqué `recoError`, « non reconnu, réessayer ») ; un job en échec ne retient pas les autres ; `wake()` sur online/focus/visibilité ; fetch coupé à 15 s ; temps absolus des points (`Stroke.startedAt`, `strokeTimes`). `recokey.ts` : clé `cahier/intercalaire/<id de page>#<id de bloc>` (jamais le numéro), `applyToBlock`, `updateBlockOnDisk`. Un résultat va à la vue qui tient la page (`PageView.applyChange`, même cahier + intercalaire + bloc), sinon UNE écriture disque depuis App, dans la file d'E/S de la vue de cet intercalaire (`runIo`). Blocs `pending` remis en file à l'ouverture d'une page, au lancement, à la saisie des clés et au passage en Auto (`resumeAll` sur toutes les vues + `resumeSaved` ; clés en route dans le stockage local, `cahiers.reco.pending.v1`) ; le fond de page ne repart qu'en Auto. Pause 1,5 s en Auto (`AUTO_DEBOUNCE_MS`), 500 ms sur zone ; compteur mensuel `usage.ts` (alerte 80 %). Clés essayées avant enregistrement (`testKeys`), actives sans relance, jamais dans le stockage du navigateur si la machine les garde. `wordsFromJiix` : surligneur, trait loin (> 0,5 hauteur de mot) ou trop haut (> 2,5 hauteurs médianes) jamais rattachés ; `carryEdits` : correction reportée si mêmes traits ou même lecture fautive (`misread`). Formules : `confusions.ts` (dx/dz, z/x, a/alpha...) + `askLatex` (MathLive, `src/ui/mathdialog.ts`). Fond de page en Auto envoyé par bandes de lignes (reco-3, `bands.ts`) : `groupBands` (centres chaînés, grands traits ∫/accolades relient, points/accents au trait le plus proche, flèches sans relier), `planIncremental` (traits non lus + mot converti prolongé ; ligne en cours gardée jusqu'à changement de ligne ou pause longue `AUTO_IDLE_MS` 4 s, empreinte anti-doublon dans la vue ; `full` pour Reconvertir), `RecoJob.scope` → `RecoResult.scope` → `mergeIncremental` (mots hors envoi jamais touchés, séparateurs refaits par `orderWords`, traits lus sans mot dans `recoSkip`, bloc `pending` tant qu'il reste du non lu) ; gomme partielle, coupe, lasso, zone : `invalidateStrokes` (`stale`). Zones inchangées (envoi entier). Tests : `src/tests/reco.test.ts`, `words.test.ts`, `bands.test.ts` (mesure 30 lignes).
- Raccourcis clavier : table unique `SHORTCUTS` dans `src/core/shortcuts.ts` (logique pure). Elle sert à `ctrlCommand` (App.onKey ; Ctrl+Alt = AltGr, ignoré ; `code === "Backslash"` = split en AZERTY), à la fiche d'aide (F1 / Ctrl+/ : `showShortcuts`, `src/ui/help.ts`) et aux infobulles (`titleOf`). Le README la recopie. Aussi `pageLabel` et `parsePageInput` (Ctrl+G). Modèles du ruban Maths : `src/core/templates.ts`. Rail d'outils (voir « Chrome » ci-dessous) ; actions rares et réglages segmentés dans le menu « ⋯ » (deux colonnes, un choix le ferme et rend le clavier à la page ; Thème et Feuille en bas des réglages, « Clés MyScript… » dans les actions). Échap : `escapeAction` (pure) + `App.onNotebookEscape` : ferme ce qui est ouvert, rend le clavier de la calculatrice (`releaseKeys`, puis curseur gardé par le texte), quitte le texte ou y revient ; menu seulement au second Échap de suite (`lastEsc`, remis à zéro par toute touche ou appui), jamais celui qui finit une saisie. Intercalaires : glisser pour réordonner (`wireDividerDrag`, souris directe, doigt/stylet après appui long ; `dropIndex`/`moveTo` dans nav.ts), Ctrl+T = nouvel intercalaire. Toasts à bouton d'une page retirés en la quittant (`dismissPageToasts`, sauf clés `APP_TOAST`) ; Ctrl+F ajoute « Recherche : Ctrl+K » (`appendToToast`). Split empilé en portrait (CSS `orientation: portrait`). Calculatrice fermée par défaut (`settings.layout` 2 la referme une fois), flottante sous 1400 px (`placeCalculator`, relancé au redimensionnement). En split, une commande Ctrl vise le panneau qui a le focus. Sous un dialogue, les commandes Ctrl sont prises sans rien faire (sauf Ctrl+Z/Y) ; F5 et Ctrl+Maj+R ne rechargent jamais le WebView2 (`isReloadKey`). Page en vue en défilement : `getBoundingClientRect` relatif à la vue (pas `offsetTop`, mesuré depuis le body). Tests : `src/tests/shortcuts.test.ts`.
- Chrome de l'écran cahier (passe design 1) : jetons CSS sur `:root` dans style.css (surfaces, texte, bordures, accent, états, rayons, ombres, espaces, tailles, durées ≤ 150 ms, `prefers-reduced-motion`), police UI Segoe UI Variable ; le chrome n'utilise que ces jetons (`--line`/`--panel` restent des alias ; dans `.text-doc`, `--line` est l'interligne). Thème : `src/core/theme.ts` (`effectiveTheme`, `nextThemePref`, `settings.theme` clair/sombre/système, défaut système, Ctrl+Maj+T, menu ⋯) appliqué par `applyAppearance` (`src/ui/tooltip.ts`) sur `html[data-theme]`, suivi de Windows (`onSystemThemeChange`). Feuille : `settings.sheet` claire (défaut)/sépia/sombre sur `.app[data-sheet]` SEULEMENT (l'export PDF, posé dans `.print-host` hors de `.app`, reste blanc à encre noire) ; canvas : `InkSurface.readTone` lit `--page-bg` et `data-sheet` à chaque `layout`, `inkDisplayColor` (encre Normal claire, couleurs éclaircies `DARK_SHEET_INK`), `retoneSurfaces` repeint ; texte tapé et mots convertis : `inkCssColor` = `var(--ink-<clé>, couleur stockée)`. Jamais dans les fichiers. Barre du haut (`App.paintTabs`, `.topbar` 48 px) : maison (« Menu »), fil d'Ariane du panneau visé (matière → `openNotebookSwitcher`, groupes → `toggleGroup`, intercalaire → liste des pages), onglets seulement s'il y en a plusieurs (ou au menu), champ-bouton Rechercher (icône sous 1180 px), Split, aide, indicateur d'état. Rail (`App.buildToolbar`, `.rail` 64 px, `iconButton` : aria-label stable + `data-tip`/`data-keys` pour l'infobulle `installTooltips`, souris seule) : outils, couleur et épaisseur (volets), annuler/rétablir, ∑ Maths, Pas compris (`.flag-btn`), ⋯ ; sous-choix (gomme précise, lasso/espace, doigt sans stylet) en mini-volet au second appui ou appui long ; tient sans défiler en 1366×768 et 1280×720 (`@media (max-height: 740px)`). Volets : `App.openFlyout`/`closeFlyout` (appui à côté, Échap, choix). Ruban Maths : `mathPanelMode` (`src/core/chrome.ts`) fermé / volet flottant `.math-panel.float` à côté du rail (`mathFly`, non retenu, Échap = `popover`) / épinglé `settings.mathPinned` (colonne ≥ `MATH_DOCK_MIN` 1600 px hors split, sinon volet qui reste), `App.paintMath`, Ctrl+Maj+M. Pages : `.page-pill` par panneau en bas à droite (`buildPagePill` : ‹ « p. 4 / 12 » › + et le zoom, `pageLabels` par vue). État : `statusSummary` (`src/core/status.ts`) → `.status-btn` (point vert, ou orange/rouge + texte court : Non enregistré, Hors ligne, Lecture seule, Quota, Clés refusées), détail `openStatusPanel` (dossier, Clés MyScript) ; plus de barre d'état ; « Mode navigateur » seulement en dev. Toasts (`dom.ts`) : `toastsToDrop` (3 au plus, celui à « Annuler » gardé), `toastPlacement` (haut droite sous la barre, sinon bas droite, sinon à gauche de la calculatrice détachée), plus récent en haut, croix de fermeture. Icônes : `src/ui/icons.ts` (Lucide, ISC, sans CDN). Tests : `src/tests/chrome.test.ts` (thème, encre, contraste AA, ruban, toasts, état, valeurs de style.css).
- Calculatrice : logique pure dans `src/core/calc/` (`engine.ts` : `normalizeInput` = virgule décimale seulement hors appel et hors crochets, `ln`→`log`, `log(x)`→`log10`, µ/Ω ; trigonométrie et `+`/`-` nettoyés des résidus par seuil relatif, jamais absolu ; fonctions `f(x)=` gardées ; l'historique garde la saisie tapée. `screen.ts` : `EditState`, `insertText` (D10 : `+ * / ^ ² !` en tête reprend `ans`), `HistoryRecall`. `solve.ts` : inconnue déduite, degré 0, Durand-Kerner (degré ≥ 3, complexes, multiplicités), formes exactes du second degré, pôles rejetés, 10 racines au plus. `integrate.ts` : `findSingularity` avant toute primitive, recoupée par Simpson. `plot.ts` : `autoWindow` (quantiles), `niceTicks`, `plotWindow`/`readRange` (ymin/ymax saisis, sinon auto), `angle` DEG sur `samplePlot`/`rootsInWindow`/`valueTable`/`extremaInWindow` via `angleScope` (engine.ts) ; `live.ts` : LaTeX des blocs vivants relu par `toLatex` (`calcTex`, `graphTex`, `resultTex` : virgule `{,}`, `1.5e-12` → `1{,}5 \cdot 10^{-12}`), jamais le texte mathjs brut). UI `src/ui/calculator/` : `mapKey` (keys.ts : Ctrl/Alt ignorés, AltGr, touche morte `^` ; tout autre imprimable traduit par `acceptText` ou `reject`, jamais rendu à la page), armée : focus ET sélection dans un récepteur invisible `.calc-sink` (sinon un caractère sans keydown, Ω par insertText, IME, AltGr, part dans la sélection restée dans la page), `textInput`/`beforeinput` repris en capture, Échap sur saisie vide rend le curseur de la page (`savedRange`) ; Échap de l'appli avec le clavier dans la calculatrice : `releaseKeys()` (reste ouverte, blur + `giveBack`) ; préfixes collés à un nombre (`siPrefixes`, onglet Calcul seul : `2,2k`, `10n`, `4,7µ`, `100m` = milli ; jamais `5 m`, `2pi`, `1e-3`, une unité ou une variable définie) en 2nd sur les chiffres ; lecture ingénieur `eng` (`engFormat` : unité, ou nombre si préfixe saisi), saisies gardées par onglet, « Lu par le moteur » sous chaque champ, Entrée (Ctrl+Entrée en zone multiligne) ; `toggle()` arme le clavier ; `host.onSend(expr, result, latex, meta)` = « Envoyer dans la page » des onglets Matrices, Résoudre, Littéral → `PageView.insertFormula` (formule `.eq` du texte) ; Calcul et Courbes → `insertCalc`/`insertGraph` (`CalcSpec`/`GraphSpec`) → `PageView.insertLive` ; au curseur si `TextDoc.hasCaret()` (dernier texte touché, page en vue), sinon fin du texte descendue sous l'encre (`belowInk` + `pushBelow`), sans voler la sélection de la calculatrice armée (`caretAfter`). `sendLast` = Ctrl+Maj+L (`sendCalc`). Tracé partagé onglet Courbes / blocs courbe : `src/ui/plotdraw.ts` (`drawPlot`). Électronique (engine.ts) : `j` isolé = i (`imagJ`, sauf variable j), affichage `imagUnit` j par défaut (2nd i bascule, `cahiers.calc.imag`), forme polaire, `arg` suit DEG ; `R1//R2`, `R1||R2` → `par()` (plus fort que +, plus faible que *, associatif ; `installCalcFunctions` dans chaque instance mathjs) ; `text` = forme machine stockée dans les blocs, `display`/`full`/`polar` = lecture française (`frNumber` : 6 chiffres significatifs, virgule, `1,5·10⁻¹²`, ∞, « non défini ») ; erreurs citées telles que tapées ; une frappe après une erreur remplace la saisie (`insertText(..., afterError)`). Blocs : `≈ 7234,32`, `10 n` (`__si`). Courbes : `log x` (`logTicks`/`engTick`, tableau 1-2-5), `dB` (`dbWrap`, fn stockée enveloppée), coupure −3 dB (`levelCrossings`), variable déduite (`plotVariable`), `GraphSpec.logX` (copié dans le bloc par `App.insertGraph`, lu par `PageView.renderLive`). Primitives : `arctan` (`texArc`), parties P·exp/sin/cos et P·ln x, vérifiées par dérivée numérique. Tests : `src/tests/calc.test.ts`, `calc-lot9.test.ts`, `calc-prefixes.test.ts`, `calc-elec.test.ts`.
- Blocs vivants calc/graph (section 2, lot 9) : logique pure dans `src/core/liveblock.ts`. Posés dans le texte comme les photos (même jeton `![](img:<id>)`, `isInTextBlock` : l'annulation de l'encre et la recherche les traitent comme des photos) ; ancien bloc flottant (rect) rangé dans le texte au premier affichage (`adoptFloatingImages`) ; retiré du texte par ✕ (Annuler 8 s) puis oublié à l'ouverture suivante (`orphanLiveIds`). `TextDoc` : `DocImages.live`/`openLive`, `makeLive` (courbe retaillable, `GraphBlock.width`), `refreshLive` ; un appui sans glisser (`tapImage`) sélectionne et rouvre la calculatrice (`PageViewHost.editLive` → `Calculator.editCalc`/`editGraph`, bandeau + « Mettre à jour », `applyCalcSpec`/`applyGraphSpec` : RAD jamais écrit, `range` absent = auto). `CalcBlock.angle`, `GraphBlock.angle`/`range`/`width` optionnels (rétrocompatibles). Rendu : `PageView.renderLive` (mathjs chargé à la demande, tracé en unités de page ×2, `ready` attendu par l'export PDF). Tests : `src/tests/liveblock.test.ts`.
- Synchronisation OneDrive (section 11) : logique pure dans `src/core/sync.ts`. Copies de conflit : `parseConflictName` (`0003.page-PC.json`, `0003.page - Copie.json`, `0003.page (1).json` ; jamais une page, `parsePageNumber` reste strict), `Repo.listConflicts`/`readConflict`/`trashConflict` (corbeille, `restoreConflict`)/`adoptConflict` (copie seule → page en fin) ; insertion, suppression et restauration renumérotent aussi les copies (`movePage`, `renumberConflictName`), une page supprimée emporte ses copies (`TrashEntry.copies`). `mergeInk` : traits absents repris par id (fond de page rejoint même si les ids de bloc diffèrent, zone à moitié connue repasse `pending`), rien n'est retiré, texte tapé jamais fusionné (`textDiffers`). Présence : un fichier par machine `.presence-<PC>.json` à la racine du cahier (`platform.ts`, aussi en mode navigateur sous le nom NAVIGATEUR), `othersPresent` (périmée à 15 min, horloge en avance tolérée 1 h). App : `enterNotebook` au premier onglet d'un cahier (avant le montage : `chooseDialog`, Échap = lecture seule), `claim` toutes les 5 min (`presenceTick`, qui revoit aussi l'autre PC), `leaveNotebook` au dernier onglet fermé (`dropTab`), `releaseAll` dans `onCloseRequested` et `beforeunload`. Lecture seule = `PageView.setNotice({kind:"lock"})` : `queueSave`, `flush`, création/suppression de page, mode (cahier.json), photo refusés, feuilles `.readonly` ; App refuse les actions d'intercalaire/matière (`refuseLocked`) et garde les résultats de reconnaissance (`toBlock` rend faux). Bandeaux : `.view-notes` (présence, copies sans page) et `.page-notes` par page (version future, copies), Voir la copie = `peek` (copie seule, jamais écrite), pastille `.conflict-dot` sur l'intercalaire (`paintConflictBadges`). Tests : `src/tests/sync.test.ts`.
- Photos (lot 10, D9) : logique pure dans `src/core/image/` (`dewarp.ts` : homographie, `binarize` ; `photo.ts` : `cropLayout` = photo entière à l'écran en largeur ET hauteur, aperçu à droite (en bandeau sous 700 px), `cropKey` Échap/Entrée/N/R/S, `isPhotoImportKey` Alt+Maj+P (Alt+P = Puissance), rayon de binarisation proportionnel (`binarizeRadius`), noms `<id>.png|jpg` + `<id>.original.jpg`, message HEIC, dernier choix noir et blanc local `cahiers.photo.v1`, couleur au premier import ; `cache.ts` : `DataUrlCache`, LRU 48 Mo des data URL lues, utilisé par `TauriFs.readDataUrl`, oublié à l'écriture, suppression, renommage). UI `src/ui/image-import.ts` : `pickFiles` (multiple, accepte .heic pour dire pourquoi il ne passe pas), `loadImage`, `importPhotos` (dialogues enchaînés « Insérer et suivante » / « Passer », toast par fichier illisible, arrêt si `ImportFlow.insert` rend false), `cropDialog` (touches prises en capture avant la page et App ; travail sur l'original réduit à 2560 px, final ≤ 1600 px, PNG en noir et blanc sinon JPEG q85, original toujours gardé en JPEG avec son `quad`), `recropPhoto` (« Redresser à nouveau » : original du bloc, ses coins et son noir et blanc, original non réécrit), `savePhoto` (écrit les deux fichiers, rend les champs du bloc). `ImageBlock.original`/`quad`/`bw` optionnels. Côté Rust : `ocr_image` en `spawn_blocking`, `read_binary`/`write_binary` en `command(async)`, hors du thread principal. Tests : `src/tests/photo.test.ts`, `image.test.ts`.
- Photos dans le texte (lot 10, `textdoc.ts`) : collage d'une image seule (Win+Maj+S ; le texte d'un copier Word passe avant) ou dépôt d'un fichier (`dragDropEnabled: false` dans tauri.conf.json, `imageFiles`) → `DocImages.addFile` (`PageView.addImageFile` : JPEG via `savePhoto`, sans recadrage, OCR en fond puis `refreshImage`) ; un fichier lâché hors de la page est bloqué (App). Plus de glisser-déposer HTML5 pour les photos : pointer events (`onImageDown`, souris/stylet glissent, doigt = appui puis glisser si sélectionnée, sinon défilement via `routePointers`), point de dépose ramené au début ou à la fin de la ligne (`dropRangeAt`, trait `.doc-img-drop`), sélection `.selected` + `.doc-img-bar` (monter/descendre par ligne `lineUnits` : `\n`, `<br>` ou photo ; « Redresser à nouveau » si `original` ; retirer avec Annuler, Suppr), poignée 44 px tous pointeurs. `TextDoc.imagesReady()` : src posé ET image décodée.
- Titres et listes (D11) : logique pure dans `src/core/text/doc.ts` (jeton `line` en debut de ligne : h1-h3, ul/ol avec `level` <= 4 et `num` de depart ; disque `# `, `- `, `1. `, deux espaces par niveau ; texte qui ressemblerait a un marqueur echappe `\# `, `\- `, `1\. ` ; `docLines`, `listNumbers` (une ligne normale ou un titre coupe la numerotation), `docTitle`, `markerStyle`). DOM (`textdoc.ts`) : une ligne mise en forme = un bloc `div.dl` qui la termine, le reste du texte reste a plat ; `autoLine` a l'Espace (dans une puce, « # » + Espace en tete la change en titre : `listToHeading`), `newLine` (Entree), `joinLines` (Retour arriere/Suppr aux bords, faits a la main), `indentList` (Tab hors formule), `tidyLines` (saut dans un bloc = coupe), `lastLine` = Ctrl+Z de la derniere mise en forme, numeros par `renumber` (data-num). `indexPage` : `title` = premier titre de plus haut niveau, prefere par la liste des pages. Tests : `src/tests/doc-lines.test.ts`.
- Export PDF (`PageView.exportPdf` + `printSheets`) : drapeau `exporting`, try/finally ; attend `imagesReady`, puis chaque page est remplacée à l'impression par ses feuilles `.print-slice` (clone du texte et des blocs décalé, `cloneWithCanvases`) ; plan pur dans `src/core/print.ts` (`planPrint` : ≤ `PRINT_FIT` 1060 px telle quelle, ≤ `PRINT_ZOOM_MAX` 1150 px réduite, au-delà coupée entre deux lignes, jamais dans une photo/formule, si possible hors de l'encre ; `findCut` coupe au milieu de l'interligne). Encre en densité 3 (`InkSurface.layout(w, h, density)`) copiée en tranches PNG (URL `blob:`, autorisée dans la CSP), densité écran rétablie aussitôt. Tests : `src/tests/print.test.ts`.
- Fonds de page (D12) : logique pure dans `src/core/paper.ts` (uni, ligne 8 mm, seyes, quadrille 5×5, millimetre 1/5/10 mm, points 5 mm ; espacements en mm d'A4, `MM = PAGE_W/210` ; `paperLines`/`paperDots` par zone sale, niveau omis sous `MIN_GAP_PX` à l'écran). `cahier.json` `paper` par intercalaire (absent = uni, `Repo.setPaper`, suit le renommage), menu « ⋯ ». Peint par `InkSurface` sous l'encre (canvas opaque sous WebView2 : un fond CSS ne se verrait pas), donc aussi à l'export PDF, très clair.
- Mise en page du texte tapé : logique pure dans `src/core/textlayout.ts`, DOM dans `src/ui/linesnap.ts` (`snapLines`, appelé par `fitSheet`). Interligne `LINE` = 8 mm (pas du Ligné/Seyès, `--line` dans style.css), marge haute `TEXT_TOP` : la ligne de base tombe juste au-dessus d'une ligne du fond. Ligne haute = nombre entier de lignes : formule `.eq` (`snapInline`, marges en em mesurées sur les struts KaTeX, une fois par formule `data-snap` ; fraction = 2 lignes, ligne de base hors grille si besoin), photo/bloc (`blockMargins`, px), titres h1/h2 = 2 lignes, h3 = 1 (`headingShift`). Clic souris sous la fin du texte : lignes vides jusque-là (`TextDoc.caretBelowEnd`). Frappe sur une ligne vide posée sur de l'encre (stylo, hors marges, effleurement < 30 % toléré) : la ligne descend sous l'encre (`clearOfInk`, `padBeforeCaret`). Le texte qui grandit ou raccourcit sous la ligne de la dernière frappe (`preEdit`, 2 s) emmène l'encre et les repères situés dessous (`shiftBelow` dans selection.ts, ids gardés, pas les annotations PDF) ; lignes ajoutées par l'appli (`noPush`) : l'encre ne bouge pas. Tests : `src/tests/textlayout.test.ts` (vérifie aussi les valeurs de style.css).
- Pagination automatique façon Word : logique pure dans `src/core/paginate.ts` (DOM `src/ui/pagebreak.ts` : `measureRows` = lignes visuelles, sauts, titres (`keep` : jamais seuls en bas), formules/photos/blocs mesurés entiers ; `rowStart` remonte la coupe hors d'une puce ou d'un titre qu'elle commence). Page = A4, `TEXT_ROWS` 33 (`TEXT_LIMIT`), encre jusqu'à `PAGE_H` ; `planFlow` coupe entre deux rangées, amas d'encre (`clusterInk`, puis plus fin, puis trait par trait) entier ; `composeFlowText` + `moveFlowBlocks` passent texte, traits (ids gardés, mots et `recoSkip` avec eux), zones, repères et blocs en tête de la page suivante, l'ancien contenu descend. Orchestration `PageView` (`maybeFlow` → `flowOut`) : seulement après une action (`editedAt`, `FLOW_EDIT_MS` 3 s) ou sur une page de suite (`Page.continues` = id de la page d'avant, le flux y continue ; sinon nouvelle page insérée, `repo.createPage(…, page)`) ; page d'arrivée écrite AVANT que la page d'avant perde quoi que ce soit ; touches retenues pendant l'écriture puis rejouées (`holdKeys`/`releaseKeys`) ; lignes vides seules jamais déplacées sauf celle du curseur ; curseur suivi par `CARET_MARK` (`TextDoc.splitOff`/`takeMarker`/`tailFrom`/`caretFrom`), mode pages → `goTo`, défilement → `insertLoaded`. `settle` (photos + polices) : avant, rien ; page longue sans `continues` = ancienne page (`long`) : TOUTE page est une A4, répartie d'office (`autoSplit` → `splitLongPage`, une à la fois, une fois par session, nouvel essai si écriture en cours, défilement temporaire, toast d'info sans Annuler) ; pointillés `paintBreaks` seulement si ça ne se coupe pas ou en lecture seule. Plus de bandeau ni de « Laisser ainsi ». Ctrl+Z juste après (`flowUndo`, `editSeq`) : texte d'avant la frappe (`prevText`, `caretOffset`), décalage d'encre défait (`lastShift`), page créée à la corbeille. Stylet borné au bas de la feuille (canvas `addPoint`, lasso), `growForStroke` seulement sur page longue ; insertion d'espace → `maybeFlow`. Photo ≤ `BLOCK_MAX_H` (`fitPageHeight`). Export : `planPrint(…, single)` = une page, une feuille. Tests : `src/tests/paginate.test.ts`, `print.test.ts`.
- Zoom (lot 11, encre-11) : logique pure dans `src/core/zoom.ts` (50–300 %, aimant à 100 %, paliers Ctrl+=/−/0, `wheelFactor`, `pinchOf`, `anchorAt` + `scrollToAnchor` = centré sur le point visé, `inkDensity` : pages hors écran en défilement au poids de 100 %, canvas ≤ `MAX_CANVAS_PX`). `PageView` : zoom par vue (chaque panneau du split), largeur de feuille × zoom (jamais sous `READABLE_W` 558 px hors zoom, texte ≥ 13 px : un split étroit défile de côté, `relayout`), aperçu en transform CSS pendant le pinch / Ctrl+molette, rendu net au lâcher ; 100 % pendant l'export. `.pages` en `touch-action: none` (pas de pinch natif), doigt hors feuille = défilement géré par la vue ; `InkSurface.toPage` lit l'échelle sur `getBoundingClientRect` (stylet sous la pointe à tout zoom). Indicateur `.zoom-chip` dans le panneau, un appui = 100 %. Tests : `src/tests/zoom.test.ts`.
- Défilement virtualisé (donnees-12) : logique pure dans `src/core/virtual.ts` (`visibleRange`, `planWindow` : pages à l'écran + `MOUNT_MARGIN` 1 de chaque côté, démontage au-delà de `KEEP_MARGIN` 2, `isFastScroll` ; `estimateSize`/`measureSize`/`slotHeight`, `SizeMemo` ; `anchorIndex`/`anchoredScroll`, `pageAt`). `PageView` en défilement : un `Slot` par page (`renderSlots`), page montée (`this.list`) près de l'écran sinon emplacement `.page-slot` de même hauteur ; `updateWindow` à chaque image de défilement (rien pendant un débordement, un geste de zoom, un export ; défilement rapide = on attend l'arrêt) ; jamais démontée si `isPinned` (focus, écriture en attente, lasso, trait, formule) ; `mountSlot` relit la page si `diskEpoch` a bougé (débordement, `runIo`) ; `anchored` garde la page lue en place ; `releasePage` libère (TextDoc, ResizeObserver, canvas à 0, fond PDF). `goTo`/`focusBlock` (`ensureMounted`), `revealPage`, `applyRestore` visent l'emplacement ; export PDF : pages montées puis démontées une à une. Tests : `src/tests/virtual.test.ts`.
- Vue de révision par couleur (lot 11, section 8) : logique pure dans `src/core/review.ts`. `extractReview(page)` : texte tapé coloré (`textRuns`, formules gardées en LaTeX pour KaTeX), encre groupée par proximité (`clusterStrokes`, `CLUSTER_PAD` 18), zones reconnues dont ≥ 50 % des traits sont d'une couleur (`zoneColor`), surligneur avec l'encre qu'il recouvre ; l'encre `normal` n'est jamais extraite. Calculée dans `indexPage` (`PageIndex.review`, cache de `Repo.scanDivider`). `groupReview` : matière › intercalaire › page, couleurs, préfixe d'intercalaire (`dividerMatches`), compteurs `byColor` ; `focusQuery` = phrase passée à `focusBlock`. Collecte : `collectReview(repo, filtre, { notebook, isStale })` (search.ts, saute les intercalaires hors filtre). UI `src/ui/review.ts` (`buildReviewView`, écran `review` d'App) : puces 44 px matière / couleurs (1 à 5, un appui sur une couleur quand toutes sont affichées ne garde qu'elle) / intercalaire ; `ReviewState` gardé par App (filtres, extrait focalisé, défilement) ; clavier sur le document (une puce repeinte perd le focus). Vignettes redessinées depuis les points (`drawVignette`, à la demande par IntersectionObserver, densité 3 à l'export) ; surlignage sur du texte tapé seul : vignette + « ouvrir la page pour le lire » (pas de mise en page du texte côté core). Ouverture : texte → `focusBlock` + `focusQuery`, zone → son cadre, encre → `App.openAt(..., rect)` + `markRect` ; `App.reviewBack` (taille de `nav` après le saut) : Alt+← revient à la vue. Export : `printReview`, même chemin que l'export des pages (`body.printing` + `.print-host`). Entrées : `Ctrl+Maj+K` (`review`), « Réviser » du menu ⋯ d'une matière, puces de la recherche (`MenuHost.openReview`). Tests : `src/tests/review.test.ts`.
- Import et annotation de PDF (priorité 3) : logique pure dans `src/core/pdf/pdf.ts` (`parsePageRange` « 1-3, 5 », « 6- », « toutes » ; `hashBytes` empreinte 64 bits sans crypto.subtle ; `pdfAssetName`/`findPdfAsset` = `<nom>-<12 hex>.pdf` dédoublonné dans `assets/` (`Repo.listAssets`) ; `fitPdfRect` A4, centré en largeur, calé en haut (paysage ajusté en largeur, place dessous pour les notes) ; `makePdfPage` une page de l'appli par page du PDF, bloc `pdf` avec `rect`, `size`, `name`, `text` ; `joinTextItems` recolle les mots coupés ; `locateTerms`/`placeTextItem` cadre du mot cherché ; `backdropPixels`). pdf.js (`pdfjs-dist`, Apache-2.0) chargé à la demande : `src/ui/pdf.ts` (`loadPdfJs`, worker servi par Vite = 'self', `useWasm: false`, polices non embarquées = système ; documents en LRU de 3 `pdfDoc`/`adoptPdfDoc` ; `renderPage` un rendu à la fois, abandonné si `wanted()` faux ; `pageText`, `placedText`). CSP : `worker-src 'self' blob:`, `font-src … blob:`. Fond : `InkSurface.setBackdrop(rect, img, w, h)` peint la page sur le papier, sous l'encre, zone sale seule (`drawBackdrop`), cadre blanc tant que le rendu manque. `src/ui/pdflayer.ts` (`PdfLayer`, un par PageView) : `sync` à chaque `fitSheet` et `syncAll` au défilement ; rendu seulement à l'écran ou à moins d'un écran, sinon canvas remis à 0 ; taille = celle de la zone dans le canvas d'encre (déjà bornée), refait au lâcher du zoom, ancien rendu étiré en attendant ; `drop` dans `releasePage` ; `ensure` attendu par `printSheets` (densité 3, puis `drop` aussitôt) ; `locate` pour `focusBlock` (Ctrl+K encadre le mot). Annotation : l'encre va dans le bloc `ink` de fond comme sur toute page (lasso, gomme, Ctrl+Z, surligneur inchangés), le texte tapé dans le texte de la page ; `annotations` du bloc `pdf` seulement lu. Page de PDF jamais paginée : `maybeFlow` → `pdfPageFull` défait la frappe qui déborde (`prevText`, garde `pdfReverting`) + toast. Import : `src/ui/pdf-import.ts` (`importPdf` : menu « ⋯ » « Importer un PDF », Ctrl+O (`importPdf` dans shortcuts.ts), dépôt d'un .pdf pris en capture par App avant le dépôt d'images du texte, dans le panneau sous le dépôt ; `askFields` + `parsePageRange` ; refus en lecture seule) → `PageView.insertPages` (après la page courante, renumérotation par `createPage`). Recherche : `searchableText` lit `PdfBlock.text`. Tests : `src/tests/pdf.test.ts` (plages, empreinte, A4, index Ctrl+K, aller-retour disque, texte extrait).
- Export Word (.docx) : logique pure dans `src/core/export/`, sans dépendance npm (`docx` non retenu, `mathml2omml` est LGPL). `zip.ts` : ZIP « stocké » (`zipStore`, `crc32`, `unzipStore` pour les tests). `omml.ts` : LaTeX → MathML (KaTeX `output: "mathml"`) → OMML éditable (`latexToOmml` ; fractions, `m:nary` avec intégrande jusqu'à la relation, `m:limLow`/`m:func`, matrices/cases `m:m`, `\left\right` → `m:d`, accents, barres, ℝ, couleur ; élément inconnu = ses enfants ; null si KaTeX ne lit pas). `docx.ts` : `buildDocx(DxDoc)` (XML écrit à la main ; A4, marges 2,5 cm, Calibri 11, Cambria Math, `w:lang` fr-FR ; styles intégrés heading 1-3 = Titre 1-3 du volet de navigation ; listes `numbering.xml`, une instance `w:num` par liste numérotée avec `startOverride` ; équation seule = `m:oMathPara` ; repli d'une formule : image `MathFallback`, sinon `texToPlain`, jamais le LaTeX brut). `plan.ts` : `planPage` (lignes du texte tapé + zones d'encre `inkZones` = `clusterStrokes` puis zones qui se chevauchent en hauteur ; une zone passe avant la première ligne dont le milieu est sous son haut, lignes vides recouvertes retirées ; lignes mesurées à l'écran sinon `estimateSpans` ; option `replaceRecognized` : mots/zones texte/zones math en texte ou équation ; surligneur seul = fond de ligne), `planToParas` (retrait `indentOf`, taille `fitEmu`, `EMU_PER_UNIT` = encre ×0,8 pour garder ses proportions avec le Calibri 11), `joinPages` (`pageBreakBefore`), `reviewToParas`, `docxFileName` (« Matière - Intercalaire - p.N.docx »). UI `src/ui/docx-export.ts` (chargé par `import()`) : `measureLineSpans` (suit la construction de TextDoc : `div.dl` = une ligne, sinon `<br>`), encre PNG densité 3 fond transparent (`paintStroke` de review.ts), photos JPEG/PNG telles quelles, courbes `drawPlot`, calc = équation `calcTex`, repli MathML natif → PNG ; dialogue « Remplacer l'écriture reconnue par du texte » seulement si la page en porte (`cahiers.docx.v1`) ; `saveDocx` : commande Rust `save_export` (boîte « Enregistrer sous » de tauri-plugin-dialog côté Rust, écriture `write_durable` ; le chemin vient de la boîte, jamais du JS), téléchargement en mode navigateur. Entrées : Ctrl+E (page), Ctrl+Maj+E (intercalaire), menu ⋯, bouton « Exporter en Word » de la vue Réviser ; `PageView.docxSources()` (écrit, puis pages en mémoire + leur DOM). Tests : `src/tests/docx-export.test.ts`.
- Liens entre pages (lot 11, rech-10/manque-liens) : logique pure dans `src/core/links.ts`. Cible = `Page.id`, jamais le numéro ; dans le texte tapé `[libellé](cahiers:<pageId>[#<blockId>|#titre:<titre encodé>] "Elec/Cours/0003")` (jeton `link` de `doc.ts`, chemin lisible = repli seulement) ; bloc `link` : `target` lisible + `pageId` (`blockLinkRef`, `linkBlockFields`). `resolveLink` : id (index `indexById` d'un scan `collectLinkPages`, search.ts, cache de `scanDivider`), page à la corbeille jamais remplacée par celle qui a pris son numéro (`Repo.findTrashedPage`, toast « Restaurer »), puis chemin. `PageIndex` porte `id`, `headings`, `links`, `anchors` (formules, zones) ; la recherche indexe le libellé. Rétroliens `backlinksTo` calculés à la volée, « Mentionné dans… » sous la page (`buildBacklinks`). Sélecteur `[[` (`src/ui/linkpicker.ts`, `linkCandidates` + `rankCandidates` flou par `fold`, page courante exclue ; Échap rend « [[ » tapé). `TextDoc` : puce `.doc-link` (contenteditable=false), clic / appui doigt ou stylet sans glisser (le stylet n'écrit pas, `onLinkDown`) / Ctrl+Entrée suit (`App.followRef` → `openAt`, NavHistory), clic droit ou F2 renomme, lien collé depuis « Copier le lien » de la recherche (Ctrl+Maj+C) ; liens grisés (`check`). Export : `linkLabel` (libellé visible). Tests : `src/tests/links.test.ts`.
- **Tests dès le début.** Une vingtaine de calculs à résultat connu, lancés automatiquement. Ajouter les matrices ne doit pas casser la dérivation sans qu'on le voie tout de suite.

---

## 11. Synchronisation OneDrive

Le dossier `ESEO/` est synchronisé entre un portable et un PC fixe.

- Un fichier par page (déjà dit, mais c'est la raison).
- **Fichier de présence** dans le dossier partagé : à l'ouverture d'un cahier, si un autre PC semble l'avoir ouvert, afficher un avertissement non bloquant (« ouvrir quand même en lecture seule ? »). Le verrou d'instance local ne peut pas détecter ce cas.
- **Copies de conflit OneDrive** (`0003.page-NOMPC.json`) : signalées (pastille, bandeau), jamais prises pour une page, jamais supprimées automatiquement ; voir, fusionner l'encre par id de trait, ou mettre à la corbeille. Implémentation : section 10, « Synchronisation OneDrive ».
- Recommander à l'utilisateur d'activer « Toujours conserver sur cet appareil » sur le dossier `ESEO/`, sinon les anciens cahiers sont injoignables hors ligne.
- **Optionnel mais recommandé :** dépôt git dans le dossier avec commit automatique quotidien. Donne l'historique, le retour arrière, et une vraie fusion en cas de conflit.

---

## 12. À ne pas faire

- Ne pas coller une image quand un bloc vivant est possible (calculs, courbes).
- Ne pas jeter l'encre brute après reconnaissance.
- Ne pas utiliser SQLite ni un fichier global dans le dossier synchronisé.
- Ne pas mettre le verrou d'instance dans OneDrive.
- Ne pas bloquer l'écriture quand le réseau est absent.
- Ne pas ouvrir de navigateur, ne pas afficher d'URL.
- Ne pas ajouter de fonctionnalité de priorité 3 avant que la priorité 1 soit solide.

---

## 13. Machine cible

| | |
|---|---|
| Modèle | HP Envy x360 2-en-1 15-fe0xxx (convertible 360°) |
| Processeur | Intel Core i7-1355U, 10 cœurs |
| RAM | 16 Go |
| Écran | tactile + **digitizer actif MPP** (périphérique « Stylet HID » présent) |
| Batterie | 43 800 mWh utiles sur 55 670 d'origine (79 % de santé) |
| Autonomie | ~4 h en usage courant (9 W), ~3 h 20 en usage lourd (13 W) |
| Veille | 0,2 à 0,3 W, aucune fuite |
| Synchro | dossier `ESEO/` dans OneDrive, second PC fixe |

Conséquences pour le développement :

- Viser une consommation de l'app **sous 1 W au-dessus du repos**. À 4 h d'autonomie il n'y a pas de marge : chaque watt gaspillé coûte une demi-heure de cours.
- Le développement se fait branché. L'usage en amphi se fait avec l'app seule, sans build ni serveur en fond.
- Ne jamais supposer le réseau disponible.

### Question encore ouverte

- Primitives : table de formes usuelles écrite à la main seule, ou ajout de **Nerdamer** pour l'intégration par parties et par substitution. À trancher quand le besoin réel se manifeste, pas avant.

---

## 14. Première étape

Avant toute architecture : **une page blanche qui capture les traits** et affiche en direct `pointerType`, `pressure`, et le nombre de points par trait. Une soirée.

Cela répond à la seule question qui conditionne tout le reste : que renvoie réellement cet écran ?

Ensuite seulement : brancher iinkTS sur cette page et écrire une intégrale généralisée avec une fraction à deux étages et des bornes de 0 à +∞. Si le LaTeX sort propre, tout le reste est de l'exécution.
