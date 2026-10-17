# Feuille de route Cahiers

Mise à jour le 17/10/2026. Décisions et idées de Maxence, dans l'ordre prévu.
Rien ici ne remplace la spec (`CLAUDE.md`) : un point qui la contredit attend son accord.

## 0. Corrections en attente (petites)

- [x] Touche `ln` de la calculatrice qui calculait un log₁₀ (corrigé, commit du 16/10, exe à reconstruire hors cours).
- [ ] Script Simulink du cours du 16/10 (`Bureau/simulink_cours_16oct.m`) : ne s'ouvre pas dans MATLAB Online, message d'erreur à récupérer.

## 1. Stockage dans l'appli (feu vert du 16/10, fait le 17/10, exe à reconstruire hors cours)

- [x] Par défaut, cahiers rangés dans l'espace privé de l'appli (Windows : `%APPDATA%\fr.mdlf.cahiers\Cahiers`, Mac : `~/Library/Application Support/fr.mdlf.cahiers/Cahiers`, dans le conteneur sandbox). Premier lancement : bloc « Bienvenue » et dialogue « Nouvelle matière » directement, pas de dossier à choisir.
- [x] Installation existante (root.txt présent, cas de Maxence, dossier ESEO) : gardée telle quelle, mode « dossier synchronisé ». Dossier de root.txt absent au lancement : espace privé pour la session, root.txt intact, avertissement dans les Réglages.
- [x] Réglages « Emplacement des cahiers » : mode et chemin, « Passer à un dossier synchronisé… », « Ramener dans l'appli… », « Changer de dossier… », « Ouvrir l'emplacement ». Copie vérifiée (fichiers, pages, octets), jamais d'écrasement, l'ancien emplacement n'est jamais supprimé.
- [x] Présence par PC et copies de conflit actives dans les deux modes. Spec mise à jour (section 1).
- [ ] Mac App Store : « security-scoped bookmark » pour garder l'accès à un dossier choisi entre deux lancements, entitlements sandbox (`files.user-selected.read-write`). Non testable ici.
- [ ] Essai réel dans l'exe : premier lancement sur un compte Windows neuf, puis bascule aller-retour avec un petit dossier de test (pas le dossier ESEO).

## 2. Saisie plus rapide

- [x] Outil **tableau** : cases au clavier, Tab = case suivante, Entrée = ligne suivante (fait le 17/10 : Ctrl+Maj+G ou menu ⋯ « Tableau », tableau pipe dans le fichier, tableau Word).
- [x] Schémas-blocs type Simulink en quelques gestes : symbole **gain** (triangle), comparateur avec signes + / − posés d'un geste, bloc **intégrateur ∫dt**, boucle de retour facile, bloc dont la taille suit le texte, modèles « 1er ordre » et « 2e ordre » (fait le 17/10).
- [x] **Bulle d'aide aux raccourcis** : en commençant à taper `ome…`, proposer `omega → ω` (apprentissage sans manuel). Aussi `sum`, `lim p->0`, `tau`, `int`, matrices (fait le 17/10, Réglages › Écriture pour la couper).
- [x] **Matrices** : raccourci pour une matrice vide à remplir (2×2, 3×3) (fait le 17/10 : `mat2x2` puis Espace ou Tab).
- [x] Blocs de code avec coloration (``` puis langage), pour les cours d'info (fait le 17/10 : ```python puis Entrée).

## 3. Distribution

- Mac : `.dmg` signé Developer ID et notarisé (fait, GitHub Actions, 15/10). Raccourcis Alt à adapter (Option tape des caractères sur Mac).
- Bouton « Mettre à jour » (Tauri updater) : dépôt public `cahiers-releases` à créer (accord en attente).
- Microsoft Store (Windows, compte développeur particulier gratuit) et Mac App Store (sandbox, deux certificats en plus), une page de confidentialité commune.

## 4. Partage (bouche-à-oreille)

- **Lien de consultation** d'un cours : page web lisible sans l'appli, à envoyer sur le groupe de classe.
- **Import en un clic** d'un cours partagé dans ses propres cahiers, modifiable.

## 5. Plus tard

- Comptes et synchro multi-appareils (Supabase, hors-ligne d'abord, suppression de compte, RGPD). CloudKit écarté : Apple seulement, Windows exclu.
- Cahiers partagés en temps réel et commentaires (type Google Docs) : gros chantier, risque de perte de notes, pas avant une version stable avec de vrais utilisateurs.
- Version iPhone / iPad.
- Modèle payant : à décider une fois l'appli sur les stores et utilisée.
