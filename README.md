# Cahiers

Application de bureau native pour remplacer les cahiers papier en ecole
d'ingenieur : prise de notes au stylet, reconnaissance des maths manuscrites,
calculatrice complete, recherche sur trois ans de cours.

La specification qui fait foi est [`CLAUDE.md`](CLAUDE.md). Ce fichier-ci
n'explique que la mise en route et l'organisation du code.

## Demarrer

```bash
npm install
npm run dev        # interface dans un navigateur, donnees locales de demo
npm test           # tests du noyau (vitest)
npm run app:dev    # vraie application Tauri
npm run app:build  # produit l'installateur .exe
```

**A lancer depuis Windows** (PowerShell), pas depuis WSL : `npm install` pose
des binaires natifs propres a la plateforme, et une installation faite sous
WSL ne peut pas construire l'executable Windows.

Prerequis pour `app:dev` et `app:build` : Rust (`winget install Rustlang.Rustup`)
et les Visual Studio Build Tools avec la charge de travail C++.

Le mode navigateur existe pour developper et verifier l'interface sans build
natif. Les donnees y restent dans le navigateur et ne touchent jamais le
dossier reel.

Verification de l'interface, serveur de dev lance a cote :

```bash
python3 scripts/verifier-ui.py captures
```

## Ou sont les cahiers

L'application cherche dans l'ordre :

1. le dossier deja choisi, retenu dans `%LOCALAPPDATA%\Cahiers\root.txt` ;
2. `OneDrive\Desktop\ESEO`, `OneDrive\Bureau\ESEO`, `OneDrive\ESEO`,
   `Desktop\ESEO` ;
3. a defaut `Documents\ESEO`, qu'elle cree.

Ce chemin est retenu **hors du dossier synchronise** : il n'a aucune raison
d'etre le meme sur le portable et sur le PC fixe.

## Structure sur le disque

```
ESEO/
├── Maths/
│   ├── cahier.json          titre, couleur, ordre des intercalaires, mode
│   ├── Cours/
│   │   ├── 0001.page.json   une page = un fichier
│   │   └── assets/
│   └── Exos/
└── Vrac/
```

Un fichier par page, du JSON en clair, indente. Un conflit OneDrive coute une
page, pas un semestre. L'application lit l'arborescence, elle ne la possede
pas : un dossier cree dans l'explorateur Windows apparait au lancement suivant.

Un dossier de la racine est une matiere s'il a un `cahier.json` ou des pages ;
le reste (documents, projets, depots git) est liste a part, dans « Autres
dossiers », et l'application n'y ecrit rien. Lire le menu ou ouvrir un cahier
n'ecrit jamais `cahier.json` : seules les actions (renommer, couleur, ordre
des intercalaires, mode) le modifient. Un intercalaire range en sous-dossiers
n'est pas rempli d'une page d'office. La derniere position (par cahier et par
intercalaire) reste sur chaque PC, dans le stockage local, jamais dans le
dossier synchronise. Une page ecrite par une version plus recente de
l'application s'ouvre en lecture seule.

Format des pages, version 2 : les points d'un trait sont ecrits en tableaux
plats, un trait par ligne :

```json
{"id":"uuid","points":[],"color":"normal","width":1.4,"tool":"pen","pts":[611.2,113.6,611.8,113.6],"p":0.5,"t":[0,191]}
```

`pts` = x0, y0, x1, y1... au dixieme ; `p` = pression au centieme (un seul
nombre si elle est constante, absent si nulle) ; `t` = temps en ms, le premier
puis l'ecart avec le point precedent (absent si tous nuls) ; `tilt` =
inclinaison, seulement si le stylet la donne. `points: []` reste vide pour que
l'ancienne version de l'appli ne plante pas. Les pages v1 (un objet
`{x, y, p, t}` par point) se lisent toujours et ne passent en v2 qu'a leur
premiere modification. Gain mesure sur de vraies pages : environ 37 octets
par point en v1 arrondie contre 16 en v2 (40 Ko de pages actuelles → 12 Ko).
Un PC pas encore mis a jour ouvre une page v2 en lecture seule : mettre a jour
les deux PC.

## Deux PC (OneDrive)

- Presence : un cahier ouvert pose `.presence-<NOMPC>.json` a sa racine,
  rafraichi toutes les 5 min, retire a la fermeture de son dernier onglet ou
  de la fenetre ; perime au bout de 15 min (appli tuee, PC en veille). Si
  l'autre PC a le cahier ouvert, l'ouverture propose la lecture seule
  (bandeau, rien n'est ecrit : ni page, ni renumerotation, ni `cahier.json`),
  avec « Modifier quand meme ». L'autre PC qui ouvre le cahier en cours de
  route : bandeau d'avertissement, « Passer en lecture seule ». Le verrou
  d'instance, lui, reste sur la machine.
- Copies de conflit : quand les deux PC ont modifie la meme page, OneDrive
  garde `0003.page-NOMPC.json` a cote. Ce n'est jamais une page (numerotation
  intacte, la copie suit sa page quand on insere ou supprime). Pastille sur
  l'intercalaire, bandeau sur la page : « Voir la copie » (lecture seule),
  « Fusionner l'encre » (traits absents repris par id, `Ctrl+Z` annule, le
  texte tape n'est pas fusionne), « Supprimer la copie » (corbeille,
  « Annuler »). Aucune copie n'est jamais supprimee automatiquement. Une copie
  dont la page n'existe plus peut devenir une page (« En faire une page »).

## Navigation

- Menu : « Reprendre » (ou `Entree`) rouvre la derniere page ; taper des
  lettres filtre les matieres, les fleches passent de l'une a l'autre. Vrac
  reste en dernier. Le bouton « ⋯ » d'une carte (ou un appui long) : renommer
  (le dossier aussi), couleur, supprimer vers la corbeille.
- Un onglet = un cahier et un intercalaire : Cours a gauche, Exos a droite
  dans le meme cahier. Appui long (ou clic droit) sur un intercalaire : ouvrir
  a droite, renommer, deplacer, supprimer ; le glisser (a la souris, ou appui
  long puis glisser au doigt ou au stylet) le change de place. `Ctrl+T` : nouvel
  intercalaire. En split, outils et clavier visent le panneau touche en
  dernier ; portable tourne (portrait), les deux panneaux s'empilent.
- Ecran cahier : barre du haut (maison = menu, fil d'Ariane matiere ›
  intercalaire, recherche, split, aide, point d'etat), rail d'outils a gauche
  (icones ; nom et raccourci au survol ; second appui ou appui long sur la
  gomme, le lasso ou le stylo sans stylet : ses options), indicateur de page
  en bas a droite de chaque panneau. Le point d'etat est vert quand tout va
  bien, orange ou rouge avec un mot (« Non enregistré », « Hors ligne »,
  « Lecture seule ») sinon ; un appui donne le detail et les cles MyScript.
- Ruban Maths : bouton ∑ du rail ou `Ctrl+Maj+M`, volet a cote du rail ;
  l'epingle le garde ouvert (en colonne sur un ecran d'au moins 1600 px).
- Apparence (menu « ⋯ ») : theme Clair, Sombre ou Systeme (`Ctrl+Maj+T`),
  feuille Claire, Sepia ou Sombre ; la feuille sombre montre l'encre noire en
  clair a l'ecran seulement, l'export PDF et Word reste blanc a encre noire.
- Un appui sur « p. 4 / 12 » (ou `Ctrl+G`) : liste des pages avec date et
  premiere ligne. `Alt+←` (ou le bouton retour de la souris) revient d'avant un
  saut : recherche, repere, lien, liste des pages.
- Liens entre pages : taper `[[` dans le texte ouvre un selecteur (titres de
  pages, titres #, formules ; matiere et intercalaire filtrent), `Entree` pose
  le lien. Dans la recherche (`Ctrl+F`), « Copier le lien » (`Ctrl+Maj+C`) puis
  `Ctrl+V` dans une page. Un clic, un appui au doigt ou au stylet (sans encre)
  ou `Ctrl+Entree` suit le lien ; clic droit ou `F2` change son texte. Le lien
  vise l'id de la page : il survit aux insertions et a la pagination. Page a la
  corbeille : lien grise, « Restaurer ». « Mentionne dans… » sous une page
  liste celles qui la citent.

## Organisation du code

La logique de calcul et de stockage ne connait pas l'interface (section 10 de
la specification) : on doit pouvoir ajouter un bouton sans risquer de casser
la derivation.

```
src/
├── core/                 aucune dependance a l'interface, entierement teste
│   ├── types.ts          schema des pages et des blocs
│   ├── palette.ts        les 5 couleurs a semantique fixe
│   ├── shortcuts.ts      table unique des raccourcis (clavier, aide F1)
│   ├── templates.ts      modeles du ruban Maths
│   ├── theme.ts          theme, teinte de feuille, encre a l'affichage, contraste
│   ├── chrome.ts         ruban Maths (volet/colonne), placement des messages
│   ├── status.ts         indicateur d'etat compact
│   ├── sync.ts           OneDrive : copies de conflit, fusion d'encre, presence
│   ├── calc/             mathjs : evaluation, derivation, primitives,
│   │                     equations, matrices, courbes, ecran facon TI
│   ├── ink/              modele de trait, file de reconnaissance hors ligne
│   └── storage/          lecture et ecriture des pages, recherche
├── ui/
│   ├── canvas.ts         surface d'encre, dirty-rect, pointer events
│   ├── pageview.ts       pages, blocs, annulation, ecriture groupee
│   ├── calculator/       les cinq onglets
│   ├── menu.ts           accueil, recherche, reperes "pas compris"
│   ├── pagelist.ts       liste des pages (numero, date, premiere ligne)
│   ├── probe.ts          sonde stylet
│   ├── help.ts           fiche des raccourcis (F1, Ctrl+/)
│   ├── icons.ts          icones SVG inline (Lucide, ISC)
│   ├── tooltip.ts        infobulles, application du theme
│   └── app.ts            barre du haut, rail d'outils, split, menu « ⋯ »
├── platform.ts           Tauri ou navigateur
└── tests/
src-tauri/src/lib.rs      acces disque controle, instance unique
```

## Photos du tableau

« Photo du tableau » dans le menu « ⋯ » de la colonne d'outils. On choisit une
ou plusieurs images (les photos d'un cours d'un coup : un dialogue par photo,
« Insérer et suivante » ou « Passer »), on pose les quatre coins du tableau,
l'application redresse la perspective, en couleur ou en noir et blanc (seuil
adaptatif ; le dernier choix est retenu), puis lit le texte avec le moteur OCR
**de Windows**, sans geler la fenêtre. Rien ne part sur un service externe. Le
texte extrait rend la photo trouvable par la recherche.

Dans le dialogue : Entrée insère, Échap annule, N bascule le noir et blanc,
R remet les coins, S passe à la photo suivante. La photo entière tient à
l'écran, en portrait comme en paysage, avec l'aperçu redressé à côté.

Fichiers dans `assets/` : l'image redressée (PNG en noir et blanc, JPEG en
couleur, 1600 px au plus) et **toujours l'original** (`<id>.original.jpg`,
2560 px au plus) avec ses coins dans le bloc, pour pouvoir redresser à nouveau.
Une photo HEIC d'iPhone n'est pas lisible : un message le dit et donne le
réglage (« Le plus compatible »).

Si Windows n'a pas de module OCR installe, l'image est inseree quand meme et
l'application le dit : la photo est simplement absente de la recherche.

**Capture d'écran et fichier déposé.** `Win+Maj+S` puis `Ctrl+V` dans la page :
la capture est posée au curseur, telle quelle (ni recadrage ni noir et blanc),
et l'OCR suit en fond. Une image glissée depuis l'Explorateur se pose là où on
la lâche.

**Photo dans le texte.** Un appui (stylet, doigt ou souris) la sélectionne :
poignée de retaille au coin (44 px de prise) et mini-barre monter, descendre,
redresser à nouveau, retirer (« Annuler » dans le message ; `Suppr` marche
aussi). Au stylet et à la souris, glisser la photo la déplace ; au doigt,
glisser une photo sélectionnée la déplace, sinon le doigt fait défiler.

## Pages A4 (pagination automatique)

Une page est une feuille A4, comme dans Word. Quand le texte tapé (ou une
photo, un calcul, une courbe, ou l'encre poussée par le texte) dépasse le bas,
ce qui déborde passe en tête de la page suivante : jamais au milieu d'une
ligne, d'une formule ou d'une photo, un titre ne reste pas seul en bas, un
schéma part entier et garde sa place par rapport au texte. La page suivante est
créée (renumérotation) ; si elle a été créée par un débordement précédent, le
texte y continue. Le curseur suit (en mode pages, la vue passe à la page
suivante). `Ctrl+Z` juste après un débordement le défait d'un coup. Le stylet
n'écrit plus hors de la feuille. Toutes les pages ont la taille d'une A4 : une
ancienne page plus longue est répartie d'office sur plusieurs pages dès son
ouverture (sauf en lecture seule). Une photo plus haute qu'une
page est réduite à la hauteur de page.

Limites : supprimer du texte ne fait pas remonter les lignes de la page
suivante ; `Ctrl+Z` ne défait le débordement que tout de suite après (une autre
frappe l'invalide) et l'historique d'encre des deux pages repart de zéro ; en
mode pages, une page suivante qui déborde à son tour se reporte quand on
l'ouvre.

## Export PDF

`Ctrl+P` (la page) ou `Ctrl+Maj+P` (l'intercalaire), puis « Enregistrer au
format PDF ». Chaque page de l'appli est une feuille A4 : elle part telle
quelle, jamais coupée. Une ancienne page longue n'est jamais réduite : elle est
coupée sur plusieurs feuilles A4, entre deux lignes, jamais au milieu d'une
photo ou d'une formule. L'encre est rendue en haute densité et découpée par
feuille.

## Export Word

`Ctrl+E` (la page) ou `Ctrl+Maj+E` (l'intercalaire, un saut de page Word entre
deux pages), aussi dans le menu « ⋯ », et « Exporter en Word » dans la vue
Réviser. Nom proposé : « Matière - Intercalaire - p.N.docx ». Le document est
éditable : titres en styles Titre 1 à 3 (volet de navigation), puces et listes
numérotées Word avec leurs niveaux, gras, italique, couleurs, formules en vraies
équations Word (Cambria Math), photos, courbes en image, calculs en équation.
L'écriture manuscrite part en images nettes, une par zone, à sa place entre les
lignes du texte. Si la page porte de l'écriture reconnue, une case « Remplacer
l'écriture reconnue par du texte » la convertit en texte et en équations. A4,
marges normales, Calibri, langue française pour le correcteur.

Limites : l'encre posée sur du texte tapé (soulignement, flèche) part en image
à côté de la ligne, pas par-dessus ; dans une ligne de texte, Word affiche les
fractions en petit (équation en ligne) ; les PDF importés ne sont pas exportés.

## Import et annotation de PDF

Sujets de TD, polys, datasheets : menu « ⋯ » → « Importer un PDF », `Ctrl+O`,
ou déposer le fichier `.pdf` sur la page. On choisit les pages (« toutes »,
« 1-3, 5 », « 6- ») ; elles arrivent après la page courante, une page de
l'appli par page du PDF, à l'échelle A4 (une page paysage est ajustée en
largeur, avec de la place dessous pour les notes). Le PDF est copié une seule
fois dans `assets/` de l'intercalaire (`<nom>-<empreinte>.pdf`) : l'importer
de nouveau ne le recopie pas.

On écrit, surligne, tape du texte et des formules par-dessus exactement comme
sur une page normale (lasso, gomme, `Ctrl+Z` compris) ; le PDF reste un fond,
jamais modifié. Une page de PDF ne déborde jamais : le texte tapé s'arrête au
bas de la feuille. Le texte du PDF est indexé : `Ctrl+F` retrouve un mot du
poly et l'encadre sur la page. L'export PDF de l'intercalaire rend le document
d'origine avec les annotations par-dessus (rendu en haute densité).

Limites : un PDF scanné (sans texte) n'est pas lu par l'OCR ; un PDF protégé
par mot de passe est refusé ; les polices non embarquées sont remplacées par
celles de Windows.

## Reconnaissance manuscrite

Elle passe par MyScript iink, dont le service est **distant**. Consequence
assumee : en amphi sans reseau, les traits sont captures et empiles, la
conversion part au retour de la connexion. L'ecriture n'est jamais bloquee et
l'encre brute n'est jamais jetee, meme apres conversion.

### Conversion mot a mot (mode « Auto »)

En mode « Auto » avec le rendu propre, chaque mot manuscrit se transforme en
texte tape **a sa place**, facon Scribble sur iPad : meme endroit, meme
couleur, une taille et un axe communs par ligne. Le mot en cours d'ecriture
reste a l'encre jusqu'a une pause de 1,5 s, puis se convertit (une zone
entouree part apres 500 ms).

- MyScript renvoie la boite de chaque mot sur l'encre d'origine (requete
  sans `DIGITAL_EDIT`, qui remettrait le texte en page) ; chaque trait est
  rattache au mot dont la boite le contient (`src/core/ink/words.ts`). Un
  surlignage, un schema ou un trait trop loin d'un mot n'est rattache a rien :
  il reste visible en rendu propre.
- L'encre reste dans la page : « Encre : Brute » (menu « ⋯ ») la ramene, la gomme efface un mot
  tape en frottant dessus.
- Correction : appui au doigt ou clic droit sur un mot. Une correction est
  reportee sur les conversions suivantes tant que l'encre du mot est la meme ;
  un mot qui grandit garde sa nouvelle lecture (l'ancienne reste proposee).
- Gommer une partie d'un mot relance sa lecture.

Formule : un appui propose les autres lectures (celles du moteur, puis les
confusions classiques dx/dz, z/x, a/α, x/×, v/ν, u/μ, e/ε), rendues en formules ;
« Corriger a la main » ouvre la formule dans un editeur visuel (MathLive),
LaTeX modifiable dessous.

Les cles se saisissent dans l'application, en bas a droite, bouton
« Clés MyScript » (ou `Ctrl+R` sans cles). Elles sont essayees avant d'etre
enregistrees et servent tout de suite, sans relancer. Sans cles, tout
fonctionne sauf la conversion : les blocs restent en attente, l'encre reste
lisible, et ils partent des que les cles sont la.

La file d'attente survit a la fermeture de l'appli : les blocs « en attente »
repartent au lancement suivant, page ouverte ou non (le fond de page, seulement
en mode « Auto » : il part des qu'on le reactive). Un envoi abandonne apres
15 s ; au retour du reseau ou de la fenetre, la file repart tout de suite.
Cles refusees : la file s'arrete et la barre d'etat le dit (appui = saisie
des cles). Quota atteint : pause de 10 min. Un bloc refuse par MyScript
affiche « non reconnu, réessayer ». La barre d'etat compte les envois du mois
(alerte a 80 % du quota, compte par machine).

## Recherche et reperes « pas compris »

`Ctrl+F` cherche dans tous les cahiers, ou seulement dans le cahier ouvert
(bouton a cote du champ). Le texte est compare tel qu'on le lit : sans
casse ni accents, gras et couleurs ignores, formules relues (« vbe » trouve
V_be, « pi » trouve π). Plusieurs mots : tous doivent y etre, dans n'importe
quel ordre ; `"phrase exacte"` entre guillemets ; `@maths` pour une matiere,
`#theoreme` pour une couleur (seul : tous les theoremes). Fleches pour
choisir, Entree ouvre la page au passage trouve, surligne ; Echap revient a
la page ou l'on ecrivait. Les resultats les plus recents viennent d'abord.

Reviser (`Ctrl+Maj+K`, menu « ⋯ » d'une matiere, ou les puces de couleur de
la recherche) : tous les extraits d'une couleur, « tous les theoremes de
Maths », groupes par intercalaire puis page dans l'ordre du cahier. Texte
tape colore (formules rendues), encre de cette couleur redessinee et
recadree, zones math/texte reconnues, surligneur. Filtres en puces :
matiere, couleurs (touches 1 a 5), intercalaire. Un appui ouvre la page a
l'endroit, `Alt+←` revient a la vue. « Exporter en PDF » imprime la fiche.

`Ctrl+Maj+F` pose le repere a la hauteur du curseur (ou du dernier trait) et
garde la ligne : la vue « Pas compris » (depuis le menu, ou le badge d'une
matiere) dit ce qui n'etait pas compris, ouvre l'endroit exact, et
« Compris » (ou `Suppr`) le retire sans ouvrir la page.

Rien n'est indexe sur le disque : l'appli garde en memoire, le temps de la
seance, ce qu'elle a deja lu de chaque page, et relit une page des que la
date ou la taille de son fichier change (OneDrive, explorateur).

## Raccourcis

La liste complete est dans l'application : **F1** (ou `Ctrl+/`, ou « Raccourcis
clavier » dans le menu ⋯ et les Reglages ; d'abord l'essentiel, puis tout). Sur Mac,
les touches s'affichent ⌘ ⇧ ⌥. Elle est generee depuis la table unique
`src/core/shortcuts.ts`, qui sert aussi au clavier : elle ne peut pas mentir.
Les lettres seules tapent du texte, comme dans Word ; les raccourcis passent
tous par Ctrl ou Alt, et marchent aussi pendant la frappe.

| | |
|---|---|
| `Ctrl+Maj+F` | repere « pas compris » (meme en tapant ; « Annuler » dans le message) |
| `Ctrl+Pg↓` / `Ctrl+Pg↑` | page suivante, precedente (`Pg↓` `Pg↑` seuls hors du texte) |
| `Ctrl+Maj+Pg↓` / `Ctrl+Maj+Pg↑` | intercalaire suivant, precedent |
| `Ctrl+N` / `Ctrl+Maj+N` | nouvelle page a la fin, inserer apres la page courante |
| `Ctrl+T` | nouvel intercalaire dans le cahier en vue |
| `Ctrl+G` | liste des pages de la barre laterale, taper un numero y va (ou un appui sur « p. 4 / 12 ») |
| `Alt+←` | revenir d'avant un saut (aussi le bouton retour de la souris) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | zoom avant, arrière (50 à 300 %), retour à 100 % ; aussi Ctrl+molette et pinch à deux doigts, chaque panneau le sien |
| `Ctrl+P` / `Ctrl+Maj+P` | exporter en PDF la page, tout l'intercalaire |
| `Ctrl+E` / `Ctrl+Maj+E` | exporter en Word (.docx) la page, tout l'intercalaire |
| `Ctrl+O` | importer un PDF apres la page courante, pour l'annoter (aussi : deposer un .pdf sur la page) |
| `Ctrl+Z` / `Ctrl+Y` (ou `Ctrl+Maj+Z`) | annuler, retablir |
| `Ctrl+M` | accueil, et retour au meme endroit |
| `Ctrl+Maj+S` | barre laterale : afficher ou masquer |
| `Ctrl+,` | reglages |
| `Ctrl+Maj+M` | volet des formules (Σ) : ouvrir ou fermer |
| `Ctrl+Maj+T` | theme : clair, sombre, celui de Windows |
| `Ctrl+F` (ou `Ctrl+K`) | recherche dans tous les cahiers, en panneau par-dessus la page |
| `Ctrl+Maj+K` | reviser : extraits d'une couleur (theoremes, definitions...) par matiere, export PDF |
| `Ctrl+L` | calculatrice |
| `Ctrl+Maj+L` | envoyer le dernier resultat de la calculatrice dans la page (au curseur du texte, sinon sous le dernier contenu) |
| `Alt+Maj+P` | photos du tableau (`Alt+P` seul = modele Puissance) |
| `Ctrl+R` | conversion de l'ecriture : au fil de la plume ou sur zone |
| `Ctrl+Maj+D` | affichage : pages ou defilement (defilement par defaut) |
| `Ctrl+Tab` / `Ctrl+Maj+Tab` | onglet suivant, precedent (dans le panneau vise) |
| `Ctrl+W` | fermer l'onglet |
| `Ctrl+\` (AZERTY : `Ctrl+*`) | split gauche/droite |
| `Ctrl+Maj+X` / `Ctrl+Maj+W` | permuter les panneaux, fermer le panneau droit |
| `Alt+E` `Alt+H` `Alt+G` | stylo, surligneur, gomme (`Alt+G` deux fois : trait entier ou précise, qui coupe le trait) |
| `Alt+A` | lasso : entourer, glisser (stylet, souris ou doigt), poignée d'angle pour retailler, pastilles pour recolorer ; deux fois : insérer de l'espace (glisser une ligne vers le bas) |
| `Suppr` / `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | sélection du lasso : supprimer, copier, couper, coller (sur n'importe quelle page, même d'un autre cahier ; dans le texte, ces touches restent celles du texte) |
| `Alt+Z` `Alt+T` | zone math, zone texte (deux fois : verrou) |
| `Alt+0` a `Alt+5` | noir, puis les 5 couleurs de la palette (avec une sélection au lasso : la recolore) |
| `Alt+=` | nouvelle formule ; `Alt+F P I R B` : fraction, puissance, indice, racine, barre (les autres modeles sont dans le ruban Maths ; touche physique, Option sur Mac) |
| `Echap` | fermer ce qui est ouvert (ruban en volet, sélection du lasso), rendre le clavier de la calculatrice à la page (elle reste ouverte), quitter le texte ou y revenir depuis un bouton ; un second `Echap` de suite : retour au menu (jamais celui qui termine une saisie) |
| `#` `##` `###` puis Espace | en debut de ligne : titre, sous-titre, niveau 3 ; `-` ou `*` : puce ; `1.` ou `1)` : liste numerotee (Entree continue, Entree sur un element vide en sort, Tab / Maj+Tab : retrait, Retour arriere au debut : texte normal, Ctrl+Z juste apres : le marqueur revient) |
| `F1` | fiche des raccourcis |

## Etat

Priorites 1 et 2 de la specification faites, y compris la calculatrice, le
split, le marqueur « pas compris » et l'import de photos avec OCR.

La priorite 3 attend volontairement, comme le demande la section 12 : rien de
la priorite 3 avant que la priorite 1 soit solide a l'usage.

Deux ecarts assumes par rapport a la specification, tous deux signales :

- la calculatrice a **cinq** onglets et non quatre. La section 7 annonce quatre
  onglets puis decrit cinq rubriques : Calcul, Courbes, Matrices, Resoudre et
  Calcul litteral. Les fusionner arbitrairement aurait ete pire ;
- les primitives utilisent la table de formes usuelles ecrite a la main
  (option 1). Nerdamer n'est pas branche, la question restant ouverte dans la
  specification. Le point d'extension est `tryExternal` dans
  `src/core/calc/integrate.ts`, et une integrale definie tombe de toute facon
  sur un calcul numerique quand la primitive manque.

Calculatrice, conventions de saisie (clavier francais) :

- virgule decimale : `3,5` vaut 3.5, mais dans un appel ou une matrice la
  virgule separe les arguments (`max(1,2)`, `nthRoot(8,3)`, `[1,2;3,4]`) ;
- `ln` = logarithme neperien, `log(x)` = logarithme decimal (comme la touche
  log), `log(x, b)` garde sa base ;
- apres un resultat, une saisie qui commence par `+ * / ^ ² !` reprend `ans`
  (decision D10) ; `-` reste le moins unaire ;
- `^` (touche morte), `²`, fleches, Debut/Fin, Suppr, ↑/↓ pour l'historique,
  Echap pour vider ; Ctrl+V colle une expression ;
- unites mathjs avec `µ` et `Ω` : `1/(2*pi*2,2kΩ*10nF)` donne des kHz ;
- prefixes d'ingenieur colles a un nombre, sans unite : `2,2k` = 2200,
  `10n`, `4,7µ` (ou `u`), `100m` = 0,1 (`5 m` avec espace reste le metre),
  `1M`, `G`, `T`, `p` ; une variable definie du meme nom garde le produit.
  Au pave : 2nd puis 7 8 9 / 4 5 6 / 1 2 3 = p n µ / m k M / G T Ω.
  Resultat en lecture ingenieur (`7,234 kHz`, `22 µ`), valeur complete a cote ;
- calculatrice armee, toute frappe lui revient, meme sans touche (Ω par
  insertText, AltGr, IME) ; un caractere illisible est ignore, l'ecran
  clignote. Echap sur une saisie vide rend le clavier au curseur de la page ;
- un resultat douteux n'est jamais affiche comme exact : integrale a travers
  un pole refusee, poles de `tan` exclus des racines, `tan(90°)` en erreur,
  residus `sin(pi)` et `0.1+0.2-0.3` ramenes a 0 (seuil relatif, jamais
  absolu : 3 fF reste 3e-15) ;
- « Envoyer dans la page » (ou `Ctrl+Maj+L`) : le resultat se pose dans la
  page en vue du panneau vise, au curseur du texte tape s'il y en a un, sinon
  sous le dernier contenu (texte et encre). Calcul et Courbes donnent des
  blocs vivants poses dans le texte comme une photo (deplacer, monter,
  descendre, ✕ avec Annuler) : un appui rouvre la calculatrice preremplie,
  « Mettre a jour » recalcule et redessine sur place. Le bloc garde
  l'expression, le mode DEG/RAD et, pour une courbe, la fenetre ymin/ymax
  (vide = auto). Matrices, Resoudre et Litteral donnent une formule du texte,
  editable comme les autres ;
- l'onglet Courbes suit le mode d'angle (bouton RAD/DEG a cote de la
  fonction) : en DEG, `sin(x)` sur [0 ; 360] fait une periode.

## Licences des icones

Les icones de l'interface (`src/ui/icons.ts`) reprennent des traces de
[Lucide](https://lucide.dev), licence ISC : « Copyright (c) for portions of
Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other
copyright (c) for Lucide are held by Lucide Contributors 2022. » Permission
d'utiliser, copier, modifier et distribuer avec ou sans contrepartie, sous
reserve de cette mention. Elles sont embarquees dans l'application (aucun CDN).
