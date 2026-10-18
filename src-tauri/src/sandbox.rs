//! Sandbox du Mac App Store (feature `app-store`, job « mas » de build.yml).
//!
//! Une appli sandboxee ne voit que son conteneur. Un dossier choisi dans la
//! boite « Choisir un dossier » lui est ouvert pour la session seulement ;
//! pour le retrouver au lancement suivant, il faut un « security-scoped
//! bookmark » cree au moment du choix (entitlements
//! files.user-selected.read-write + files.bookmarks.app-scope), garde a cote
//! de root.txt, puis resolu au demarrage avec
//! startAccessingSecurityScopedResource.
//!
//! Le bookmark n'est qu'une cle d'acces : la racine reste celle de root.txt.
//! Bookmark absent ou illisible : le dossier est traite comme introuvable
//! (`location::confine`), l'appli s'ouvre dans son espace prive avec
//! l'avertissement des Reglages, rien n'est perdu.
//!
//! Partout ailleurs (Windows, Linux, .dmg Developer ID), `ACTIVE` est faux et
//! rien de ce fichier ne sert : le code Objective-C n'est compile que pour
//! macOS avec la feature.

use std::fs;
use std::path::{Path, PathBuf};

/// Vrai seulement dans la build Mac App Store.
pub const ACTIVE: bool = cfg!(all(target_os = "macos", feature = "app-store"));

/// Le bookmark, a cote de root.txt (donnees locales de l'appli, conteneur).
pub fn bookmark_file(preference: &Path) -> PathBuf {
    preference.with_file_name("root.bookmark")
}

/// Bookmark d'un dossier ouvert par la boite de dialogue (pendant la session
/// ou l'acces est accorde).
pub fn create(dir: &Path) -> Result<Vec<u8>, String> {
    imp::create(dir)
}

/// Rouvre l'acces retenu : resout le bookmark et commence l'acces au dossier,
/// garde pour toute la session. Rend le dossier ouvert et, si le bookmark
/// etait perime (dossier deplace, systeme mis a jour), un bookmark neuf a
/// reecrire.
pub fn open(data: &[u8]) -> Result<(PathBuf, Option<Vec<u8>>), String> {
    imp::open(data)
}

/// Au lancement : lit le bookmark, ouvre l'acces, rafraichit un bookmark
/// perime. Rend le dossier accessible, ou None (aucun, ou plus resolvable).
pub fn restore(preference: &Path) -> Option<PathBuf> {
    let file = bookmark_file(preference);
    let data = fs::read(&file).ok()?;
    match open(&data) {
        Ok((dir, fresh)) => {
            if let Some(bytes) = fresh {
                let _ = super::write_durable(&file, "root.bookmark", &bytes);
            }
            Some(dir)
        }
        Err(e) => {
            eprintln!("bookmark du dossier synchronise illisible : {e}");
            None
        }
    }
}

#[cfg(all(target_os = "macos", feature = "app-store"))]
mod imp {
    use std::path::{Path, PathBuf};

    use objc2::runtime::Bool;
    use objc2_foundation::{
        NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
    };

    pub fn create(dir: &Path) -> Result<Vec<u8>, String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&dir.to_string_lossy()));
        bookmark_of(&url)
    }

    fn bookmark_of(url: &NSURL) -> Result<Vec<u8>, String> {
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope,
            None,
            None,
        )
        .map(|data| data.to_vec())
        .map_err(|e| e.localizedDescription().to_string())
    }

    pub fn open(data: &[u8]) -> Result<(PathBuf, Option<Vec<u8>>), String> {
        let data = NSData::with_bytes(data);
        let mut stale = Bool::NO;
        // SAFETY : `stale` est une variable locale valide pendant l'appel.
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut stale,
            )
        }
        .map_err(|e| e.localizedDescription().to_string())?;
        // SAFETY : URL issue d'un bookmark a portee de securite. L'acces est
        // garde jusqu'a la fermeture de l'appli (pas de stopAccessing...) :
        // la racine sert pendant toute la session.
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            return Err("accès refusé par le système".into());
        }
        let path = url.path().map(|p| PathBuf::from(p.to_string())).ok_or("bookmark sans chemin")?;
        // Perime : on en refait un tant que l'acces est ouvert.
        let fresh = if stale.as_bool() { bookmark_of(&url).ok() } else { None };
        Ok((path, fresh))
    }
}

#[cfg(not(all(target_os = "macos", feature = "app-store")))]
mod imp {
    use std::path::{Path, PathBuf};

    const NONE: &str = "bookmarks réservés à la version Mac App Store";

    pub fn create(_dir: &Path) -> Result<Vec<u8>, String> {
        Err(NONE.into())
    }

    pub fn open(_data: &[u8]) -> Result<(PathBuf, Option<Vec<u8>>), String> {
        Err(NONE.into())
    }
}
