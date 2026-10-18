//! Ce que l'appli confie au systeme : ouvrir un dossier, montrer un fichier
//! dans l'explorateur ou le Finder, ouvrir une page web dans le navigateur.
//!
//! Un seul endroit pour le « quel outil selon le systeme » : avant, deux
//! fonctions avaient diverge et « Montrer le fichier » lancait xdg-open sur
//! Mac, qui n'existe pas. Tout passe par tauri-plugin-opener (fonctions
//! libres, le plugin n'est pas enregistre : le frontend n'a aucune commande
//! d'ouverture a lui, seulement celles de lib.rs, qui choisissent le chemin
//! ou l'adresse).
//!  - montrer : explorateur (SHOpenFolderAndSelectItems) sous Windows,
//!    NSWorkspace activateFileViewerSelectingURLs sur Mac (API prevue pour
//!    l'App Sandbox), gestionnaire de fichiers (D-Bus) sous Linux ;
//!  - ouvrir : programme par defaut du systeme (explorateur, Finder, xdg-open).

use std::io;
use std::path::Path;

/// Politique de confidentialite (page publique, exigee par l'App Store).
/// Meme adresse que PRIVACY_URL de src/core/privacy.ts.
pub const PRIVACY_URL: &str = "https://cahiers.vercel.app/confidentialite.html";

fn to_io(e: tauri_plugin_opener::Error) -> io::Error {
    io::Error::other(e.to_string())
}

/// Ouvre un dossier dans l'explorateur Windows ou le Finder.
pub fn open_dir(dir: &Path) -> io::Result<()> {
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(to_io)
}

/// Montre un fichier, selectionne, dans son dossier. Fichier absent (OneDrive
/// ne l'a pas encore telecharge) : son dossier, selectionne dans le parent.
pub fn reveal(path: &Path) -> io::Result<()> {
    let target = if path.exists() { path } else { path.parent().unwrap_or(path) };
    tauri_plugin_opener::reveal_item_in_dir(target).map_err(to_io)
}

/// Ouvre la politique de confidentialite dans le navigateur par defaut.
/// Adresse fixe : le frontend ne peut pas faire ouvrir une URL de son choix.
pub fn open_privacy() -> io::Result<()> {
    tauri_plugin_opener::open_url(PRIVACY_URL, None::<&str>).map_err(to_io)
}
