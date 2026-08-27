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
npm test           # 82 tests du noyau
npm run app:dev    # vraie application Tauri (necessite Rust + build tools)
npm run app:build  # produit l'installateur .exe
```

Le mode navigateur existe pour developper et verifier l'interface sans build
natif. Les donnees y restent dans le navigateur et ne touchent jamais le
dossier reel.

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
│   └── app.ts            onglets, split, raccourcis
├── platform.ts           Tauri ou navigateur
└── tests/
src-tauri/src/lib.rs      acces disque controle, instance unique
```

## Reconnaissance manuscrite

Elle passe par MyScript iink, dont le service est **distant**. Consequence
assumee : en amphi sans reseau, les traits sont captures et empiles, la
conversion part au retour de la connexion. L'ecriture n'est jamais bloquee et
l'encre brute n'est jamais jetee, meme apres conversion.

Les cles se saisissent dans l'application, en bas a droite, bouton
« Cles MyScript ». Sans cles, tout fonctionne sauf la conversion : les blocs
math restent en attente indefiniment, l'encre reste lisible.

## Raccourcis

| | |
|---|---|
| `Ctrl+M` | menu, et retour au meme endroit |
| `Ctrl+K` | recherche globale |
| `Ctrl+L` | calculatrice |
| `Ctrl+F` | repere « pas compris » |
| `Ctrl+N` | nouvelle page |
| `Ctrl+Z` / `Ctrl+Y` | annuler, retablir |
| `Ctrl+\` | split gauche/droite |
| `Ctrl+Maj+X` | permuter les panneaux |
| `Ctrl+Maj+W` | fermer le panneau droit |
| `Ctrl+Tab` / `Ctrl+W` | onglet suivant, fermer l'onglet |
| `1` a `5` | couleurs de la palette |
| `S` `H` `G` `Z` | stylo, surligneur, gomme, zone math |
| `←` `→` `Pg↑` `Pg↓` | page precedente, suivante |

## Etat

Priorites 1 et 2 de la specification faites. La priorite 3 attend, comme le
demande la section 12 : rien de la priorite 3 avant que la priorite 1 soit
solide a l'usage.
