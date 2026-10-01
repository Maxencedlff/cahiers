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
│   ├── cahier.json            <- titre, couleur, ordre des intercalaires, dernière position
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
    { "type": "link",  "target": "Maths/Cours/0012#block-3", "label": "théorème" },
    { "type": "flag",  "note": "revoir le critère de Riemann" }
  ]
}
```

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
- Éditeur PDF intégré (existe déjà par ailleurs, à porter) : annoter les documents fournis par les profs.
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
- Formules automatiques du texte tapé : logique pure dans `src/core/text/automath.ts` (`findFormulas` avec un mode `final`/`space`/`pause`, `planLine` pour relire une ligne déjà en partie en forme), DOM dans `src/ui/textdoc.ts`. Variable seule (« Vz », « I1 ») : liste blanche, convertie au mot suivant ou à Entrée, jamais à la pause ; une unité (`isUnit`) n'en est jamais une.
- Recherche : logique pure dans `src/core/text/find.ts` (`fold` = casse, accents, grec par son nom, ligatures, avec indices d'origine ; `parseQuery` : mots en ET, "phrase", `@matière`, `#couleur` ; `makeExcerpt`, `flagContext`). `storage/search.ts` et `TextDoc.revealText` plient le texte avec ce même module. `indexPage` (search.ts) : texte simple d'une page (markdown retiré, formules par `texToPlain`, OCR d'une photo retirée du texte ignoré) et ses repères ; `Repo.scanDivider` le garde en cache de session par chemin, revérifié par date+taille (`listFilesStat`, commande Rust `list_files_meta`), oublié à chaque écriture ou renumérotation ; jamais écrit. `summary` porte les repères (un seul parcours pour le menu). Recherche annulable (`isStale`), triée par date. Résultat ou repère → `App.openAt` → `focusBlock(page, id, query)` (2 images d'attente avant de mesurer). Repère : hauteur du curseur (`TextDoc.caretSpot`) ou du dernier trait selon le dernier geste, `context` + `created` ; « Compris » depuis la liste passe par la vue qui a la page en mémoire (`PageView.setFlagResolved`), sinon par le disque. Recherche et repères : Échap/Retour reviennent à l'écran d'origine (`auxFrom`).
- Annulation : `src/core/history.ts`, logique pure. `PageHistory` garde des piles par id de page (jamais par numéro), `drop` à la suppression ; un trait ajouté = commande légère (`applyStrokeCommand`), le reste = instantané JSON (un seul par geste de gomme, `onEraseStart`) ; `restoreBlocks` ne restaure ni le texte tapé (il a son propre Ctrl+Z) ni les photos posées dedans. Tests : `src/tests/history.test.ts`.
- Sauvegarde (`pageview.ts`) : file indexée par id de page, numéro lu au moment d'écrire ; écritures et renumérotations passent l'une après l'autre (`serial`) ; échec = nouvel essai 3 s et pastille « Non enregistré ». Aucune renumérotation tant qu'une page reste non écrite. Vue quittée avec une écriture en échec : gardée dans `App.orphans` (barre d'état, fermeture), et `adopt(old)` avant `load()` quand on rouvre son intercalaire (une seule vue écrit la page). Fermeture de la fenêtre : `onCloseRequested` (main.ts) attend `flushAll`. Côté Rust : `sync_all` avant le renommage, 5 essais si le fichier est verrouillé.
- Suppression = corbeille, jamais effacement : `ESEO/.corbeille/<horodatage>/<chemin relatif>` (`repo.deletePage`/`deleteDivider` rendent un `TrashEntry`, `restorePage`/`restoreDivider` le remettent). Toast « Annuler » de 8 s (`toast(..., action)` dans dom.ts).
- Encre : logique pure dans `src/core/ink/` (`sheet.ts` : `PAGE_W`/`PAGE_H`, feuille plus haute que l'A4 via `Page.height` optionnel, le canvas suit `sheetHeight` ; `pointer.ts` : bout gomme et bouton latéral = gomme, outil figé pour le geste, paume ignorée 400 ms autour du stylet ; `stroke.ts` : points arrondis, bornes en cache). Encre neutre `'normal'` (noire) par défaut, une seule couleur active pour l'encre et le texte. Surligneur ×7, peint sous l'encre, jamais envoyé à la reconnaissance. Zones math/texte ponctuelles (Alt+Z deux fois = verrou). `penSeen` mémorisé ; Ctrl+D l'oublie (stylet à plat : le doigt réécrit jusqu'au prochain contact du stylet). `Page.height` redescend à l'ouverture et à l'annulation du trait qui l'avait allongée (`shrinkToInk`), jamais pendant la gomme. `fitSheet` mesure le texte seul (`min-height` de la couche texte à 0 le temps de la lecture), sinon la feuille ne redescendait jamais. Pages écrites en JSON indenté, points d'un trait sur une ligne (`serializePage`). Tests : `src/tests/encre.test.ts`.
- Raccourcis clavier : table unique `SHORTCUTS` dans `src/core/shortcuts.ts` (logique pure). Elle sert à `ctrlCommand` (App.onKey ; Ctrl+Alt = AltGr, ignoré ; `code === "Backslash"` = split en AZERTY), à la fiche d'aide (F1 / Ctrl+/ : `showShortcuts`, `src/ui/help.ts`) et aux infobulles (`titleOf`). Le README la recopie. Aussi `pageLabel` et `parsePageInput` (Ctrl+G). Modèles du ruban Maths : `src/core/templates.ts`. Colonne d'outils : outils, couleurs, épaisseur, annuler, pages (« p. 4 / 12 », `onPageChange`) et « Pas compris » en haut ; ruban Maths repliable (`settings.mathOpen`) ; actions rares et réglages segmentés dans le menu « ⋯ ». Calculatrice fermée par défaut (`settings.layout` 2 la referme une fois), flottante sous 1400 px (`placeCalculator`, relancé au redimensionnement). En split, une commande Ctrl vise le panneau qui a le focus. Sous un dialogue, les commandes Ctrl sont prises sans rien faire (sauf Ctrl+Z/Y) ; F5 et Ctrl+Maj+R ne rechargent jamais le WebView2 (`isReloadKey`). Page en vue en défilement : `getBoundingClientRect` relatif à la vue (pas `offsetTop`, mesuré depuis le body). Tests : `src/tests/shortcuts.test.ts`.
- **Tests dès le début.** Une vingtaine de calculs à résultat connu, lancés automatiquement. Ajouter les matrices ne doit pas casser la dérivation sans qu'on le voie tout de suite.

---

## 11. Synchronisation OneDrive

Le dossier `ESEO/` est synchronisé entre un portable et un PC fixe.

- Un fichier par page (déjà dit, mais c'est la raison).
- **Fichier de présence** dans le dossier partagé : à l'ouverture d'un cahier, si un autre PC semble l'avoir ouvert, afficher un avertissement non bloquant (« ouvrir quand même en lecture seule ? »). Le verrou d'instance local ne peut pas détecter ce cas.
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
