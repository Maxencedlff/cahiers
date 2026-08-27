//! Cahiers : couche native.
//!
//! Deux responsabilites, et rien d'autre :
//!  1. donner au frontend un acces controle a un seul dossier du disque ;
//!  2. garantir qu'une seule instance tourne a la fois (section 1).
//!
//! Le verrou d'instance est LOCAL a la machine : il n'ecrit jamais rien dans
//! le dossier synchronise, sinon un plantage sur un PC bloquerait l'autre.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};

/// Racine des cahiers, resolue une fois au demarrage.
struct Root(Mutex<PathBuf>);

#[derive(Serialize)]
struct AppError {
    message: String,
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError { message: e.to_string() }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

type Res<T> = Result<T, String>;

fn fail(msg: impl Into<String>) -> String {
    msg.into()
}

/// Resout un chemin relatif SOUS la racine.
///
/// Tout composant `..` est refuse : le frontend ne doit jamais pouvoir sortir
/// du dossier des cahiers, meme par accident.
fn resolve(root: &Path, rel: &str) -> Res<PathBuf> {
    let rel = rel.trim_start_matches(['/', '\\']);
    let candidate = Path::new(rel);
    for c in candidate.components() {
        match c {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return Err(fail(format!("chemin refuse : {rel}"))),
        }
    }
    Ok(root.join(candidate))
}

fn root_of(state: &State<Root>) -> Res<PathBuf> {
    state.0.lock().map(|p| p.clone()).map_err(|_| fail("racine indisponible"))
}

/* ------------------------------------------------------------------ */
/* Commandes exposees au frontend                                      */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn root_path(state: State<Root>) -> Res<String> {
    Ok(root_of(&state)?.to_string_lossy().to_string())
}

#[tauri::command]
fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "un autre PC".to_string())
}

#[tauri::command]
fn list_dirs(state: State<Root>, rel: String) -> Res<Vec<String>> {
    let path = resolve(&root_of(&state)?, &rel)?;
    let mut out = Vec::new();
    if !path.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&path).map_err(|e| fail(e.to_string()))? {
        let entry = entry.map_err(|e| fail(e.to_string()))?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            out.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn list_files(state: State<Root>, rel: String) -> Res<Vec<String>> {
    let path = resolve(&root_of(&state)?, &rel)?;
    let mut out = Vec::new();
    if !path.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&path).map_err(|e| fail(e.to_string()))? {
        let entry = entry.map_err(|e| fail(e.to_string()))?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            out.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn read_text(state: State<Root>, rel: String) -> Res<String> {
    let path = resolve(&root_of(&state)?, &rel)?;
    fs::read_to_string(&path).map_err(|e| fail(format!("{} : {}", rel, e)))
}

/// Ecriture atomique : on ecrit a cote puis on renomme.
///
/// Sur un dossier synchronise par OneDrive, une ecriture interrompue laisserait
/// un fichier tronque, donc une page de cours perdue. Le renommage, lui, est
/// atomique : le fichier est soit l'ancien, soit le nouveau, jamais un moitie.
#[tauri::command]
fn write_text(state: State<Root>, rel: String, content: String) -> Res<()> {
    let path = resolve(&root_of(&state)?, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| fail(e.to_string()))?;
    }
    let temp = path.with_extension("tmp-write");
    fs::write(&temp, content.as_bytes()).map_err(|e| fail(e.to_string()))?;
    fs::rename(&temp, &path).map_err(|e| fail(e.to_string()))?;
    Ok(())
}

#[tauri::command]
fn path_exists(state: State<Root>, rel: String) -> Res<bool> {
    if rel.is_empty() {
        return Ok(true);
    }
    Ok(resolve(&root_of(&state)?, &rel)?.exists())
}

#[tauri::command]
fn make_dir(state: State<Root>, rel: String) -> Res<()> {
    let path = resolve(&root_of(&state)?, &rel)?;
    fs::create_dir_all(&path).map_err(|e| fail(e.to_string()))
}

#[tauri::command]
fn remove_path(state: State<Root>, rel: String) -> Res<()> {
    let path = resolve(&root_of(&state)?, &rel)?;
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| fail(e.to_string()))
    } else {
        fs::remove_file(&path).map_err(|e| fail(e.to_string()))
    }
}

#[tauri::command]
fn rename_path(state: State<Root>, from: String, to: String) -> Res<()> {
    let root = root_of(&state)?;
    let src = resolve(&root, &from)?;
    let dst = resolve(&root, &to)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| fail(e.to_string()))?;
    }
    fs::rename(&src, &dst).map_err(|e| fail(format!("{} vers {} : {}", from, to, e)))
}

/// Change la racine et la retient pour les prochains lancements.
#[tauri::command]
fn set_root(state: State<Root>, path: String) -> Res<String> {
    let candidate = PathBuf::from(&path);
    if !candidate.is_dir() {
        return Err(fail(format!("{path} n'est pas un dossier")));
    }
    save_root_preference(&candidate);
    let mut guard = state.0.lock().map_err(|_| fail("racine verrouillee"))?;
    *guard = candidate.clone();
    Ok(candidate.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ */
/* Resolution de la racine                                             */
/* ------------------------------------------------------------------ */

/// Fichier de preference, dans les donnees locales de l'application.
/// Volontairement HORS du dossier synchronise : le chemin du dossier n'a
/// aucune raison d'etre le meme sur les deux PC.
fn preference_file() -> Option<PathBuf> {
    dirs::config_local_dir().map(|d| d.join("Cahiers").join("root.txt"))
}

fn save_root_preference(path: &Path) {
    if let Some(file) = preference_file() {
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(file, path.to_string_lossy().as_bytes());
    }
}

/// Ou sont les cahiers ?
///
/// 1. le choix deja enregistre ;
/// 2. les emplacements habituels d'un dossier ESEO dans OneDrive ;
/// 3. a defaut, on cree Documents/ESEO plutot que d'echouer au demarrage.
fn resolve_root() -> PathBuf {
    if let Some(file) = preference_file() {
        if let Ok(saved) = fs::read_to_string(&file) {
            let p = PathBuf::from(saved.trim());
            if p.is_dir() {
                return p;
            }
        }
    }

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let candidates = [
        home.join("OneDrive").join("Desktop").join("ESEO"),
        home.join("OneDrive").join("Bureau").join("ESEO"),
        home.join("OneDrive").join("ESEO"),
        home.join("Desktop").join("ESEO"),
        dirs::document_dir().unwrap_or_else(|| home.join("Documents")).join("ESEO"),
    ];
    for c in candidates.iter() {
        if c.is_dir() {
            save_root_preference(c);
            return c.clone();
        }
    }

    let fallback = dirs::document_dir()
        .unwrap_or_else(|| home.join("Documents"))
        .join("ESEO");
    let _ = fs::create_dir_all(&fallback);
    save_root_preference(&fallback);
    fallback
}

/* ------------------------------------------------------------------ */
/* Demarrage                                                           */
/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Instance unique : un second lancement ramene la fenetre existante
        // au premier plan au lieu d'ouvrir une deuxieme fenetre (section 1).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Root(Mutex::new(resolve_root())))
        .invoke_handler(tauri::generate_handler![
            root_path,
            machine_name,
            list_dirs,
            list_files,
            read_text,
            write_text,
            path_exists,
            make_dir,
            remove_path,
            rename_path,
            set_root,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au demarrage de Cahiers");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuse_de_sortir_de_la_racine() {
        let root = PathBuf::from("/base");
        assert!(resolve(&root, "../secret").is_err());
        assert!(resolve(&root, "Maths/../../etc").is_err());
    }

    #[test]
    fn accepte_un_chemin_normal() {
        let root = PathBuf::from("/base");
        let p = resolve(&root, "Maths/Cours/0001.page.json").unwrap();
        assert!(p.ends_with("Maths/Cours/0001.page.json"));
    }

    #[test]
    fn ignore_le_slash_initial() {
        let root = PathBuf::from("/base");
        assert_eq!(
            resolve(&root, "/Maths").unwrap(),
            resolve(&root, "Maths").unwrap()
        );
    }
}
