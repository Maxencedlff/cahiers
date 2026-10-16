# Feuille de route Cahiers

Mise à jour le 16/10/2026. Décisions et idées de Maxence, dans l'ordre prévu.
Rien ici ne remplace la spec (`CLAUDE.md`) : un point qui la contredit attend son accord.

## 0. Corrections en attente (petites)

- [x] Touche `ln` de la calculatrice qui calculait un log₁₀ (corrigé, commit du 16/10, exe à reconstruire hors cours).
- [ ] Script Simulink du cours du 16/10 (`Bureau/simulink_cours_16oct.m`) : ne s'ouvre pas dans MATLAB Online, message d'erreur à récupérer.

## 1. Stockage dans l'appli (en attente du feu vert)

- Par défaut, cahiers rangés dans l'espace privé de l'appli (Windows : profil utilisateur, Mac : conteneur sandbox). On crée ses matières dans l'appli, pas de dossier à choisir.
- Option Réglages « Synchroniser avec un dossier » (OneDrive, iCloud Drive…) : cas de Maxence, dossier ESEO.
- Mêmes fichiers JSON lisibles dans les deux cas, passage de l'un à l'autre par copie.
- Contredit la règle « l'appli lit l'arborescence du disque » de la spec section 1 : à valider avant de coder.

## 2. Saisie plus rapide

- Outil **tableau** : cases au clavier, Tab = case suivante, Entrée = ligne suivante (aujourd'hui : formule `\begin{array}`).
- Schémas-blocs type Simulink en quelques gestes : symbole **gain** (triangle), comparateur avec signes + / − posés d'un geste, bloc **intégrateur ∫dt**, boucle de retour facile, bloc dont la taille suit le texte, modèles « 1er ordre » et « 2e ordre ».
- **Bulle d'aide aux raccourcis** : en commençant à taper `ome…`, proposer `omega → ω` (apprentissage sans manuel). Aussi `sum`, `lim p->0`, `tau`, `int`, matrices.
- **Matrices** : raccourci pour une matrice vide à remplir (2×2, 3×3).
- Blocs de code avec coloration (``` puis langage), pour les cours d'info.

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
