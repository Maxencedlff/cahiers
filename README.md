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
│   ├── cahier.json          titre, couleur, ordre des intercalaires, position
│   ├── Cours/
│   │   ├── 0001.page.json   une page = un fichier
│   │   └── assets/
│   └── Exos/
└── Vrac/
```

Un fichier par page, du JSON en clair, indente. Un conflit OneDrive coute une
page, pas un semestre. L'application lit l'arborescence, elle ne la possede
pas : un dossier cree dans l'explorateur Windows apparait au lancement suivant.

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
│   ├── calc/             mathjs : evaluation, derivation, primitives,
│   │                     equations, matrices, courbes
│   ├── ink/              modele de trait, file de reconnaissance hors ligne
│   └── storage/          lecture et ecriture des pages, recherche
├── ui/
│   ├── canvas.ts         surface d'encre, dirty-rect, pointer events
│   ├── pageview.ts       pages, blocs, annulation, ecriture groupee
│   ├── calculator/       les cinq onglets
│   ├── menu.ts           accueil, recherche, reperes "pas compris"
│   ├── probe.ts          sonde stylet
│   ├── help.ts           fiche des raccourcis (F1, Ctrl+/)
│   └── app.ts            onglets, split, colonne d'outils, menu « ⋯ »
├── platform.ts           Tauri ou navigateur
└── tests/
src-tauri/src/lib.rs      acces disque controle, instance unique
```

## Photos du tableau

« Photo du tableau » dans le menu « ⋯ » de la colonne d'outils. On choisit l'image, on pose les quatre
coins du tableau, l'application redresse la perspective, passe en noir et blanc
par seuil adaptatif, puis lit le texte avec le moteur OCR **de Windows**. Rien
ne part sur un service externe. Le texte extrait rend la photo trouvable par la
recherche.

Si Windows n'a pas de module OCR installe, l'image est inseree quand meme et
l'application le dit : la photo est simplement absente de la recherche.

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
confusions classiques dx/dz, a/α, x/×, v/ν, u/μ, e/ε), rendues en formules ;
« Corriger a la main » ouvre la formule dans un editeur visuel (MathLive),
LaTeX modifiable dessous.

Les cles se saisissent dans l'application, en bas a droite, bouton
« Clés MyScript » (ou `Ctrl+R` sans cles). Elles sont essayees avant d'etre
enregistrees et servent tout de suite, sans relancer. Sans cles, tout
fonctionne sauf la conversion : les blocs restent en attente, l'encre reste
lisible, et ils partent des que les cles sont la.

La file d'attente survit a la fermeture de l'appli : les blocs « en attente »
repartent au lancement suivant, page ouverte ou non. Un envoi abandonne apres
15 s ; au retour du reseau ou de la fenetre, la file repart tout de suite.
Cles refusees : la file s'arrete et la barre d'etat le dit (appui = saisie
des cles). Quota atteint : pause de 10 min. Un bloc refuse par MyScript
affiche « non reconnu, réessayer ». La barre d'etat compte les envois du mois
(alerte a 80 % du quota, compte par machine).

## Recherche et reperes « pas compris »

`Ctrl+K` cherche dans tous les cahiers, ou seulement dans le cahier ouvert
(bouton a cote du champ). Le texte est compare tel qu'on le lit : sans
casse ni accents, gras et couleurs ignores, formules relues (« vbe » trouve
V_be, « pi » trouve π). Plusieurs mots : tous doivent y etre, dans n'importe
quel ordre ; `"phrase exacte"` entre guillemets ; `@maths` pour une matiere,
`#theoreme` pour une couleur (seul : tous les theoremes). Fleches pour
choisir, Entree ouvre la page au passage trouve, surligne ; Echap revient a
la page ou l'on ecrivait. Les resultats les plus recents viennent d'abord.

`Ctrl+F` pose le repere a la hauteur du curseur (ou du dernier trait) et
garde la ligne : la vue « Pas compris » (depuis le menu, ou le badge d'une
matiere) dit ce qui n'etait pas compris, ouvre l'endroit exact, et
« Compris » (ou `Suppr`) le retire sans ouvrir la page.

Rien n'est indexe sur le disque : l'appli garde en memoire, le temps de la
seance, ce qu'elle a deja lu de chaque page, et relit une page des que la
date ou la taille de son fichier change (OneDrive, explorateur).

## Raccourcis

La liste complete est dans l'application : **F1** (ou `Ctrl+/`, ou le bouton
« ? » en haut a droite). Elle est generee depuis la table unique
`src/core/shortcuts.ts`, qui sert aussi au clavier : elle ne peut pas mentir.
Les lettres seules tapent du texte, comme dans Word ; les raccourcis passent
tous par Ctrl ou Alt, et marchent aussi pendant la frappe.

| | |
|---|---|
| `Ctrl+F` | repere « pas compris » (meme en tapant ; « Annuler » dans le message) |
| `Ctrl+Pg↓` / `Ctrl+Pg↑` | page suivante, precedente (`Pg↓` `Pg↑` seuls hors du texte) |
| `Ctrl+Maj+Pg↓` / `Ctrl+Maj+Pg↑` | intercalaire suivant, precedent |
| `Ctrl+N` / `Ctrl+Maj+N` | nouvelle page a la fin, inserer apres la page courante |
| `Ctrl+G` | aller a la page (ou un appui sur « p. 4 / 12 ») |
| `Ctrl+P` / `Ctrl+Maj+P` | exporter en PDF la page, tout l'intercalaire |
| `Ctrl+Z` / `Ctrl+Y` (ou `Ctrl+Maj+Z`) | annuler, retablir |
| `Ctrl+M` | menu, et retour au meme endroit |
| `Ctrl+K` | recherche globale |
| `Ctrl+L` | calculatrice |
| `Ctrl+R` | conversion de l'ecriture : au fil de la plume ou sur zone |
| `Ctrl+D` | doigt : ecrire ou naviguer (avec un stylet : l'oublier) |
| `Ctrl+Tab` / `Ctrl+Maj+Tab` | onglet suivant, precedent |
| `Ctrl+W` | fermer l'onglet |
| `Ctrl+\` (AZERTY : `Ctrl+*`) | split gauche/droite |
| `Ctrl+Maj+X` / `Ctrl+Maj+W` | permuter les panneaux, fermer le panneau droit |
| `Alt+E` `Alt+H` `Alt+G` | stylo, surligneur, gomme |
| `Alt+Z` `Alt+T` | zone math, zone texte (deux fois : verrou) |
| `Alt+0` a `Alt+5` | noir, puis les 5 couleurs de la palette |
| `Alt+=` | nouvelle formule ; `Alt+F P I R N S L D V M` : modeles du ruban Maths |
| `Echap` | quitter le texte ; une seconde fois, retour au menu |
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
