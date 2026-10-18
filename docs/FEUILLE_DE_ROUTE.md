# Feuille de route Cahiers

Mise à jour le 18/10/2026. Décisions et idées de Maxence, dans l'ordre prévu.
Rien ici ne remplace la spec (`CLAUDE.md`) : un point qui la contredit attend son accord.

## 0. Corrections en attente (petites)

- [x] Touche `ln` de la calculatrice qui calculait un log₁₀ (corrigé, commit du 16/10, exe à reconstruire hors cours).
- [ ] Script Simulink du cours du 16/10 (`Bureau/simulink_cours_16oct.m`) : ne s'ouvre pas dans MATLAB Online, message d'erreur à récupérer.

## 1. Stockage dans l'appli (feu vert du 16/10, fait le 17/10, exe à reconstruire hors cours)

- [x] Par défaut, cahiers rangés dans l'espace privé de l'appli (Windows : `%APPDATA%\fr.mdlf.cahiers\Cahiers`, Mac : `~/Library/Application Support/fr.mdlf.cahiers/Cahiers`, dans le conteneur sandbox). Premier lancement : bloc « Bienvenue » et dialogue « Nouvelle matière » directement, pas de dossier à choisir.
- [x] Installation existante (root.txt présent, cas de Maxence, dossier ESEO) : gardée telle quelle, mode « dossier synchronisé ». Dossier de root.txt absent au lancement : espace privé pour la session, root.txt intact, avertissement dans les Réglages.
- [x] Réglages « Emplacement des cahiers » : mode et chemin, « Passer à un dossier synchronisé… », « Ramener dans l'appli… », « Changer de dossier… », « Ouvrir l'emplacement ». Copie vérifiée (fichiers, pages, octets), jamais d'écrasement, l'ancien emplacement n'est jamais supprimé.
- [x] Présence par PC et copies de conflit actives dans les deux modes. Spec mise à jour (section 1).
- [x] Mac App Store : « security-scoped bookmark » créé au choix du dossier, rouvert au lancement (`sandbox.rs`), entitlements sandbox (`files.user-selected.read-write`, `files.bookmarks.app-scope`) ; bookmark illisible = espace privé + avertissement (18/10). Compilé en CI, jamais essayé sur un vrai Mac.
- [ ] Essai réel dans l'exe : premier lancement sur un compte Windows neuf, puis bascule aller-retour avec un petit dossier de test (pas le dossier ESEO).

## 2. Saisie plus rapide

- [x] Outil **tableau** : cases au clavier, Tab = case suivante, Entrée = ligne suivante (fait le 17/10 : Ctrl+Maj+G ou menu ⋯ « Tableau », tableau pipe dans le fichier, tableau Word).
- [x] Schémas-blocs type Simulink en quelques gestes : symbole **gain** (triangle), comparateur avec signes + / − posés d'un geste, bloc **intégrateur ∫dt**, boucle de retour facile, bloc dont la taille suit le texte, modèles « 1er ordre » et « 2e ordre » (fait le 17/10).
- [x] **Bulle d'aide aux raccourcis** : en commençant à taper `ome…`, proposer `omega → ω` (apprentissage sans manuel). Aussi `sum`, `lim p->0`, `tau`, `int`, matrices (fait le 17/10, Réglages › Écriture pour la couper).
- [x] **Matrices** : raccourci pour une matrice vide à remplir (2×2, 3×3) (fait le 17/10 : `mat2x2` puis Espace ou Tab).
- [x] Blocs de code avec coloration (``` puis langage), pour les cours d'info (fait le 17/10 : ```python puis Entrée).

## 3. Distribution

- [x] Mac : `.dmg` signé Developer ID et notarisé (GitHub Actions, 15/10).
- [x] Raccourcis sur Mac (17/10) : Option+touche lue sur la touche physique (Option+= « ≠ » = Alt+=), Cmd vaut Ctrl sauf Cmd+Q/H/W/M laissés à macOS (fermer l'onglet ⌃W, accueil ⌃M), libellés ⌘ ⌥ ⌃. Non essayé sur un vrai Mac.
- [x] Bouton « Mettre à jour » (Tauri updater, 17/10) : vérification 5 s après le lancement, bandeau « Cahiers X.Y disponible » posé hors frappe, pages écrites avant l'installation, relance ; menu ⋯ et Réglages « Rechercher des mises à jour ». Release publique `Maxencedlff/cahiers-releases` + `latest.json` à chaque tag `v*` (mode d'emploi : `docs/PUBLIER.md`).
- [ ] Premier vrai cycle : publier v0.2.0 (installée à la main), puis v0.2.1, et vérifier que la 0.2.0 propose et installe la 0.2.1 (Windows, puis Mac).
- [x] Mac App Store (18/10) : job `mas` (build sandboxée sans updater, `.pkg` signé, envoi App Store Connect à chaque tag), mode d'emploi dans `docs/PUBLIER.md`.
- [ ] Mac App Store : essayer le build TestFlight sur un vrai Mac (premier lancement, dossier synchronisé choisi puis relance, export Word, MyScript), puis soumettre la version.
- Microsoft Store (Windows, compte développeur particulier gratuit), même page de confidentialité.

## 4. Partage (bouche-à-oreille)

- **Lien de consultation** d'un cours : page web lisible sans l'appli, à envoyer sur le groupe de classe.
- **Import en un clic** d'un cours partagé dans ses propres cahiers, modifiable.

## 5. Plus tard

- Comptes et synchro multi-appareils (Supabase, hors-ligne d'abord, suppression de compte, RGPD). CloudKit écarté : Apple seulement, Windows exclu.
- Cahiers partagés en temps réel et commentaires (type Google Docs) : gros chantier, risque de perte de notes, pas avant une version stable avec de vrais utilisateurs.
- Version iPhone / iPad.
- Modèle payant : à décider une fois l'appli sur les stores et utilisée.
