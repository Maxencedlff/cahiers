//! Cahiers : couche native.
//!
//! Deux responsabilites, et rien d'autre :
//!  1. donner au frontend un acces controle a un seul dossier du disque ;
//!  2. garantir qu'une seule instance tourne a la fois (section 1).
//!
//! Le verrou d'instance est LOCAL a la machine : il n'ecrit jamais rien dans
//! le dossier synchronise, sinon un plantage sur un PC bloquerait l'autre.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::sleep;
use std::time::Duration;

use tauri::{Manager, State};

mod location;

/// Racine des cahiers, resolue une fois au demarrage.
struct Root(Mutex<PathBuf>);

/// Emplacement des cahiers (location.rs) : espace prive de l'appli, dossier
/// retenu introuvable au lancement, dossier choisi dans la boite de dialogue.
/// Seuls ces chemins-la peuvent devenir la racine : le frontend ne passe
/// jamais un chemin absolu de son choix.
#[derive(Default)]
struct Storage {
    internal: Mutex<PathBuf>,
    missing: Mutex<Option<PathBuf>>,
    picked: Mutex<Option<PathBuf>>,
}

/// Les erreurs remontent au frontend en clair : c'est ce qui s'affiche dans
/// le bandeau de statut quand une ecriture echoue.
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

/// Nom de la machine : il signe les fichiers de presence et les copies de
/// conflit (`0003.page-<PC>.json`). Il doit etre stable d'un lancement a
/// l'autre et identique quelle que soit la facon dont l'appli est lancee
/// (HOSTNAME n'est presque jamais exporte hors d'un terminal).
#[tauri::command]
fn machine_name() -> String {
    host_name().unwrap_or_else(|| "un autre PC".to_string())
}

fn clean_host(raw: &str) -> Option<String> {
    let t = raw.trim().trim_end_matches('\0').trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

#[cfg(windows)]
fn host_name() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::SystemInformation::{ComputerNameNetBIOS, GetComputerNameExW};
    // Nom NetBIOS : celui que montre Windows (et que COMPUTERNAME recopie).
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    let api = unsafe { GetComputerNameExW(ComputerNameNetBIOS, PWSTR(buf.as_mut_ptr()), &mut len) }
        .ok()
        .and_then(|_| clean_host(&String::from_utf16_lossy(&buf[..len as usize])));
    api.or_else(|| std::env::var("COMPUTERNAME").ok().and_then(|v| clean_host(&v)))
}

#[cfg(not(windows))]
fn host_name() -> Option<String> {
    if let Some(v) = std::env::var("HOSTNAME").ok().and_then(|v| clean_host(&v)) {
        return Some(v);
    }
    for file in ["/etc/hostname", "/proc/sys/kernel/hostname"] {
        if let Some(v) = fs::read_to_string(file).ok().and_then(|v| clean_host(&v)) {
            return Some(v);
        }
    }
    // macOS : pas de /etc/hostname.
    for args in [&["--get", "ComputerName"][..], &["--get", "LocalHostName"][..]] {
        if let Ok(out) = std::process::Command::new("scutil").args(args).output() {
            if out.status.success() {
                if let Some(v) = clean_host(&String::from_utf8_lossy(&out.stdout)) {
                    return Some(v);
                }
            }
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| clean_host(&String::from_utf8_lossy(&o.stdout)))
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

/// Un fichier avec sa date et sa taille : le frontend sait si une page a
/// change depuis sa derniere lecture sans la relire (cache de recherche).
#[derive(serde::Serialize)]
struct FileMeta {
    name: String,
    /// Millisecondes depuis 1970, avec decimales.
    mtime: f64,
    size: u64,
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Date et taille d'un fichier, ou None s'il n'existe pas (ou n'est pas un fichier).
fn stat_of(path: &Path) -> Option<FileMeta> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(FileMeta {
        name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        mtime: mtime_ms(&meta),
        size: meta.len(),
    })
}

/// Date et taille attendues par une ecriture conditionnelle.
#[derive(serde::Deserialize)]
struct Expect {
    mtime: f64,
    size: u64,
}

/// Le fichier est-il encore celui qu'on a lu (meme date, meme taille) ?
/// `None` attendu : le fichier ne doit pas exister.
fn matches(current: Option<&FileMeta>, expect: Option<&Expect>) -> bool {
    match (current, expect) {
        (None, None) => true,
        (Some(c), Some(e)) => c.size == e.size && (c.mtime - e.mtime).abs() < 0.001,
        _ => false,
    }
}

#[tauri::command]
fn stat_path(state: State<Root>, rel: String) -> Res<Option<FileMeta>> {
    let path = resolve(&root_of(&state)?, &rel)?;
    Ok(stat_of(&path))
}

#[derive(serde::Serialize)]
struct TextWithMeta {
    content: String,
    stat: Option<FileMeta>,
}

/// Lit un fichier avec sa date et sa taille, prises AVANT la lecture : si le
/// fichier change entre les deux, la date gardee est l'ancienne, et la
/// prochaine ecriture conditionnelle verra le changement (jamais l'inverse).
#[tauri::command(async)]
fn read_text_meta(state: State<'_, Root>, rel: String) -> Res<TextWithMeta> {
    let path = resolve(&root_of(&state)?, &rel)?;
    let stat = stat_of(&path);
    let content = fs::read_to_string(&path).map_err(|e| fail(format!("{} : {}", rel, e)))?;
    Ok(TextWithMeta { content, stat })
}

#[derive(serde::Serialize)]
struct CondWrite {
    ok: bool,
    /// Apres une ecriture reussie : le fichier ecrit. Sinon : ce qui est sur le disque.
    stat: Option<FileMeta>,
}

/// Ecriture conditionnelle (R1) : le fichier n'est remplace que s'il est
/// encore celui qu'on a lu (`expect`, date + taille), ou absent si
/// `expect` est null. Sinon rien n'est ecrit et l'etat du disque est rendu :
/// une page modifiee par OneDrive (l'autre PC) n'est jamais ecrasee en
/// silence. Le verrou du chemin couvre la verification ET l'ecriture.
#[tauri::command(async)]
fn write_text_if(state: State<'_, Root>, rel: String, content: String, expect: Option<Expect>) -> Res<CondWrite> {
    let path = resolve(&root_of(&state)?, &rel)?;
    let lock = path_lock(&path);
    let _guard = lock.lock().map_err(|_| fail("verrou d'ecriture indisponible"))?;
    let current = stat_of(&path);
    if !matches(current.as_ref(), expect.as_ref()) {
        return Ok(CondWrite { ok: false, stat: current });
    }
    write_durable_unlocked(&path, &rel, content.as_bytes())?;
    Ok(CondWrite { ok: true, stat: stat_of(&path) })
}

#[tauri::command]
fn list_files_meta(state: State<Root>, rel: String) -> Res<Vec<FileMeta>> {
    let path = resolve(&root_of(&state)?, &rel)?;
    let mut out = Vec::new();
    if !path.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&path).map_err(|e| fail(e.to_string()))? {
        let entry = entry.map_err(|e| fail(e.to_string()))?;
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = mtime_ms(&meta);
        out.push(FileMeta {
            name: entry.file_name().to_string_lossy().to_string(),
            mtime,
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
fn read_text(state: State<Root>, rel: String) -> Res<String> {
    let path = resolve(&root_of(&state)?, &rel)?;
    fs::read_to_string(&path).map_err(|e| fail(format!("{} : {}", rel, e)))
}

/// Fichier tenu par un autre programme : OneDrive pendant la synchro,
/// l'antivirus pendant son analyse. Erreurs Windows 5 (acces refuse),
/// 32 (fichier utilise) et 33 (zone verrouillee).
fn is_locked(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Retente une operation sur un fichier verrouille : 5 essais en tout,
/// apres 50, 100, 200 puis 400 ms. Le verrou de OneDrive dure rarement plus.
fn retry_locked<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let waits = [50u64, 100, 200, 400];
    let mut tries = 0;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if tries < waits.len() && is_locked(&e) => {
                sleep(Duration::from_millis(waits[tries]));
                tries += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Ecriture atomique et durable : on ecrit a cote, on force les donnees sur
/// le disque (sync_all), puis on renomme.
///
/// Sur un dossier synchronise par OneDrive, une ecriture interrompue laisserait
/// un fichier tronque, donc une page de cours perdue. Le renommage, lui, est
/// atomique : le fichier est soit l'ancien, soit le nouveau, jamais un moitie.
/// Sans sync_all, une coupure de batterie juste apres pouvait garder le
/// renommage mais pas les donnees : une page de 0 octet.
///
/// Deux ecritures du meme chemin en meme temps (commandes async, sur des
/// fils differents) passent l'une apres l'autre (`path_lock`), et chaque
/// ecriture a son propre fichier temporaire (`temp_path`) : avant, les deux
/// ecrivaient le meme « .tmp-write » et l'une renommait le fichier de
/// l'autre a moitie ecrit.
fn write_durable(path: &Path, rel: &str, bytes: &[u8]) -> Res<()> {
    let lock = path_lock(path);
    let _guard = lock.lock().map_err(|_| fail("verrou d'ecriture indisponible"))?;
    write_durable_unlocked(path, rel, bytes)
}

/// Verrous par chemin, pour toute la vie du processus. Une entree n'est
/// retiree que si plus personne ne la tient.
fn path_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let table = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = match table.lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    // Menage : les verrous que personne ne tient (le tableau ne grossit pas).
    if map.len() > 256 {
        map.retain(|_, l| Arc::strong_count(l) > 1);
    }
    // Windows ignore la casse : « Cours » et « cours » sont le meme fichier.
    let key = if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    };
    map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Fichier temporaire propre a cette ecriture : nom du fichier, numero du
/// processus et compteur. Jamais une page ni une copie de conflit (il ne
/// finit pas par .json).
fn temp_path(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!("{name}.{}-{n}.tmp-write", std::process::id()))
}

fn write_durable_unlocked(path: &Path, rel: &str, bytes: &[u8]) -> Res<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| fail(format!("{rel} : {e}")))?;
    }
    let temp = temp_path(path);
    let written = retry_locked(|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })
    .and_then(|_| retry_locked(|| fs::rename(&temp, path)));
    if let Err(e) = written {
        // Pas de fichier temporaire oublie a cote des pages.
        let _ = fs::remove_file(&temp);
        return Err(fail(format!("{rel} : {e}")));
    }
    Ok(())
}

#[tauri::command(async)]
fn write_text(state: State<'_, Root>, rel: String, content: String) -> Res<()> {
    let path = resolve(&root_of(&state)?, &rel)?;
    write_durable(&path, &rel, content.as_bytes())
}

/* ------------------------------------------------------------------ */
/* Fichiers binaires : images importees, PDF                           */
/* ------------------------------------------------------------------ */

#[tauri::command(async)]
fn write_binary(state: State<'_, Root>, rel: String, base64: String) -> Res<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| fail(format!("image illisible : {e}")))?;
    let path = resolve(&root_of(&state)?, &rel)?;
    write_durable(&path, &rel, &bytes)
}

/* ------------------------------------------------------------------ */
/* Export : document enregistre ou l'utilisateur le choisit            */
/* ------------------------------------------------------------------ */

/// Export (Word) : boite « Enregistrer sous » de Windows, puis ecriture.
/// Le chemin vient de la boite, jamais du frontend : la page ne peut rien
/// ecrire hors du dossier des cahiers sans que l'utilisateur l'ait choisi.
/// Rend le chemin ecrit, ou None si la boite a ete fermee.
#[tauri::command(async)]
fn save_export(
    app: tauri::AppHandle,
    name: String,
    filter: String,
    extension: String,
    base64: String,
) -> Res<Option<String>> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| fail(format!("document illisible : {e}")))?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Exporter")
        .set_file_name(&name)
        .add_filter(&filter, &[extension.as_str()]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| fail(format!("chemin refuse : {e}")))?;
    let shown = path.display().to_string();
    write_durable(&path, &shown, &bytes)
        .map_err(|e| fail(format!("{e} (document ouvert dans Word ?)")))?;
    Ok(Some(shown))
}

/// Async : hors du thread principal. Chaque photo affichee passe par ici, et
/// une page qui en porte plusieurs figeait la fenetre le temps de les lire.
#[tauri::command(async)]
fn read_binary(state: State<'_, Root>, rel: String) -> Res<String> {
    use base64::Engine;
    let path = resolve(&root_of(&state)?, &rel)?;
    let bytes = fs::read(&path).map_err(|e| fail(format!("{rel} : {e}")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Cles MyScript rangees a cote de la preference de racine, dans les donnees
/// locales de l'application.
///
/// Volontairement HORS du dossier synchronise : des cles d'API n'ont rien a
/// faire dans OneDrive, et elles restent valables quelle que soit la machine.
#[tauri::command]
fn myscript_keys() -> Res<serde_json::Value> {
    let file = match preference_file() {
        Some(p) => p.with_file_name("myscript.json"),
        None => return Ok(serde_json::json!({})),
    };
    match fs::read_to_string(&file) {
        // Un fichier ecrit par un editeur Windows commence souvent par un BOM,
        // que le parseur JSON refuse. Le retirer evite des cles ignorees en
        // silence, et donc une file de conversion bloquee sans explication.
        Ok(raw) => Ok(serde_json::from_str(raw.trim_start_matches('\u{feff}').trim())
            .unwrap_or_else(|_| serde_json::json!({}))),
        Err(_) => Ok(serde_json::json!({})),
    }
}

#[tauri::command]
fn set_myscript_keys(application_key: String, hmac_key: String) -> Res<()> {
    let file = preference_file()
        .map(|p| p.with_file_name("myscript.json"))
        .ok_or_else(|| fail("emplacement de configuration introuvable"))?;
    let body = serde_json::json!({
        "applicationKey": application_key,
        "hmacKey": hmac_key,
    });
    // Meme ecriture atomique que les pages : une coupure ne laisse jamais un
    // fichier de cles a moitie ecrit (cles ignorees en silence ensuite).
    write_durable(&file, "myscript.json", body.to_string().as_bytes())
}

/* ------------------------------------------------------------------ */
/* OCR                                                                 */
/* ------------------------------------------------------------------ */

/// Lit le texte d'une image avec le moteur OCR de Windows.
///
/// Sans OCR, une photo de tableau est un trou noir dans la recherche
/// (section 6). Le moteur est celui du systeme : rien ne sort de la machine.
///
/// Une a plusieurs secondes de calcul, avec des attentes bloquantes (`.get()`)
/// sur les operations WinRT : la commande tourne donc sur un fil de travail
/// dedie (`spawn_blocking`), jamais sur le thread principal, sinon la fenetre
/// et le stylet gelent pendant toute la lecture.
#[tauri::command]
async fn ocr_image(base64: String) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64.as_bytes())
            .map_err(|e| fail(format!("image illisible : {e}")))?;
        ocr_bytes(&bytes)
    })
    .await
    .map_err(|e| fail(format!("OCR interrompu : {e}")))?
}

#[cfg(windows)]
fn ocr_bytes(bytes: &[u8]) -> Res<String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    let win = |e: windows::core::Error| fail(format!("OCR Windows : {e}"));

    let stream = InMemoryRandomAccessStream::new().map_err(win)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(win)?;
    writer.WriteBytes(bytes).map_err(win)?;
    writer.StoreAsync().map_err(win)?.get().map_err(win)?;
    writer.FlushAsync().map_err(win)?.get().map_err(win)?;
    writer.DetachStream().map_err(win)?;
    stream.Seek(0).map_err(win)?;

    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(win)?.get().map_err(win)?;
    let bitmap = decoder.GetSoftwareBitmapAsync().map_err(win)?.get().map_err(win)?;

    // Le francais d'abord, puis les langues du profil utilisateur.
    let engine = Language::CreateLanguage(&HSTRING::from("fr-FR"))
        .ok()
        .and_then(|lang| OcrEngine::TryCreateFromLanguage(&lang).ok())
        .or_else(|| OcrEngine::TryCreateFromUserProfileLanguages().ok())
        .ok_or_else(|| {
            fail(
                "Aucun moteur OCR disponible. Ajoute le module de reconnaissance \
                 optique de caracteres dans Parametres, Langue et region.",
            )
        })?;

    let result = engine.RecognizeAsync(&bitmap).map_err(win)?.get().map_err(win)?;
    Ok(result.Text().map_err(win)?.to_string())
}

#[cfg(not(windows))]
fn ocr_bytes(_bytes: &[u8]) -> Res<String> {
    Err(fail("OCR disponible uniquement sous Windows"))
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

/// Renommage, retente si OneDrive tient le fichier : une renumerotation de
/// pages interrompue a mi-chemin laisserait un trou dans l'intercalaire.
/// Jamais par-dessus un fichier ou un dossier existant (R2) : une page
/// arrivee entre-temps sous ce numero (OneDrive) serait ecrasee sans trace.
#[tauri::command(async)]
fn rename_path(state: State<'_, Root>, from: String, to: String) -> Res<()> {
    let root = root_of(&state)?;
    let src = resolve(&root, &from)?;
    let dst = resolve(&root, &to)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| fail(e.to_string()))?;
    }
    retry_locked(|| rename_no_replace(&src, &dst)).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            fail(format!("{to} existe deja : rien n'a ete ecrase"))
        } else {
            fail(format!("{} vers {} : {}", from, to, e))
        }
    })
}

/// Meme fichier a la casse pres (Windows, macOS) : « Cours » vers « cours ».
fn same_entry(src: &Path, dst: &Path) -> bool {
    match (fs::canonicalize(src), fs::canonicalize(dst)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Renomme sans jamais remplacer la destination. Windows : MoveFileExW
/// sans MOVEFILE_REPLACE_EXISTING (le systeme refuse, rien n'est perdu).
#[cfg(windows)]
fn rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    if dst.exists() && !same_entry(src, dst) {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "destination deja presente"));
    }
    let a = HSTRING::from(src.as_os_str());
    let b = HSTRING::from(dst.as_os_str());
    unsafe { MoveFileExW(&a, &b, MOVEFILE_WRITE_THROUGH) }.map_err(|e| {
        // HRESULT_FROM_WIN32 : le code Windows est dans les 16 bits du bas.
        let code = (e.code().0 as u32) & 0xFFFF;
        let err = io::Error::from_raw_os_error(code as i32);
        if code == 80 || code == 183 {
            io::Error::new(io::ErrorKind::AlreadyExists, err.to_string())
        } else {
            err
        }
    })
}

/// Unix : un fichier passe par un lien dur (refuse si la destination
/// existe, atomique), puis l'ancien nom est retire. Un dossier : verifie
/// puis renomme (renameat2 NOREPLACE n'existe pas partout).
#[cfg(not(windows))]
fn rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    if fs::symlink_metadata(dst).is_ok() && !same_entry(src, dst) {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "destination deja presente"));
    }
    let meta = fs::symlink_metadata(src)?;
    if meta.is_file() && !same_entry(src, dst) {
        match fs::hard_link(src, dst) {
            Ok(()) => return fs::remove_file(src),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(e),
            // Systeme de fichiers sans liens durs : on retombe sur le renommage verifie.
            Err(_) => {}
        }
    }
    fs::rename(src, dst)
}

/// Montre un fichier dans l'explorateur Windows, selectionne. Sert a la
/// feuille « Page illisible » : verifier que OneDrive l'a bien telecharge.
#[tauri::command]
fn reveal_path(state: State<Root>, rel: String) -> Res<()> {
    let path = resolve(&root_of(&state)?, &rel)?;
    reveal(&path).map_err(|e| fail(format!("{rel} : {e}")))
}

#[cfg(windows)]
fn reveal(path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    // /select, puis le chemin entre guillemets, sans autre echappement :
    // c'est la seule forme qu'explorer.exe comprend avec des espaces.
    let target = if path.exists() { path.to_path_buf() } else { path.parent().unwrap_or(path).to_path_buf() };
    // Le chemin relatif arrive avec des "/" (Maths/Cours/0001.page.json) :
    // explorer ne selectionne rien avec, il ouvre Documents.
    let target = target.display().to_string().replace('/', "\\");
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{target}\""))
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn reveal(path: &Path) -> io::Result<()> {
    let dir = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open").arg(dir).spawn().map(|_| ())
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
/* Emplacement des cahiers : dans l'appli ou dossier synchronise       */
/* ------------------------------------------------------------------ */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageInfo {
    /// « app » : espace prive de l'appli ; « folder » : dossier synchronise.
    mode: &'static str,
    path: String,
    internal: String,
    /// Dossier retenu dans root.txt mais introuvable a ce lancement.
    missing: Option<String>,
}

fn lock_of<T: Clone>(m: &Mutex<T>) -> Res<T> {
    m.lock().map(|g| g.clone()).map_err(|_| fail("etat indisponible"))
}

fn info_of(root: &State<Root>, st: &State<Storage>) -> Res<StorageInfo> {
    let path = root_of(root)?;
    let internal = lock_of(&st.internal)?;
    Ok(StorageInfo {
        mode: if location::same_dir(&path, &internal) { "app" } else { "folder" },
        path: path.to_string_lossy().to_string(),
        internal: internal.to_string_lossy().to_string(),
        missing: lock_of(&st.missing)?.map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command]
fn storage_info(root: State<Root>, st: State<Storage>) -> Res<StorageInfo> {
    info_of(&root, &st)
}

/// Chemin vise par une bascule : « internal » (espace prive), « picked »
/// (dernier dossier choisi dans la boite), « current » (racine actuelle),
/// « missing » (dossier de root.txt introuvable au lancement). `sub` : un
/// seul nom de dossier dedans (« Cahiers »), jamais un chemin.
fn target_path(root: &State<Root>, st: &State<Storage>, target: &str, sub: Option<&str>) -> Res<PathBuf> {
    let base = match target {
        "internal" => lock_of(&st.internal)?,
        "current" => root_of(root)?,
        "picked" => lock_of(&st.picked)?.ok_or_else(|| fail("aucun dossier choisi"))?,
        "missing" => lock_of(&st.missing)?.ok_or_else(|| fail("aucun dossier introuvable"))?,
        _ => return Err(fail(format!("emplacement inconnu : {target}"))),
    };
    match sub {
        None => Ok(base),
        Some(name) => {
            let ok = !name.is_empty()
                && Path::new(name).components().count() == 1
                && matches!(Path::new(name).components().next(), Some(Component::Normal(_)));
            if !ok {
                return Err(fail(format!("nom de dossier refuse : {name}")));
            }
            Ok(base.join(name))
        }
    }
}

/// Boite « Choisir un dossier » du systeme. Le chemin vient de la boite,
/// jamais du frontend (sandbox Mac : seul un dossier choisi ainsi est permis).
#[tauri::command(async)]
fn pick_sync_folder(app: tauri::AppHandle, st: State<'_, Storage>) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title("Dossier synchronisé pour les cahiers");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| fail(format!("chemin refuse : {e}")))?;
    *st.picked.lock().map_err(|_| fail("etat indisponible"))? = Some(path.clone());
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Decrit un emplacement avant d'y basculer. Rien n'est ecrit.
#[tauri::command(async)]
fn inspect_location(
    root: State<'_, Root>, st: State<'_, Storage>, target: String, sub: Option<String>,
) -> Res<location::DirReport> {
    let path = target_path(&root, &st, &target, sub.as_deref())?;
    Ok(location::inspect(&root_of(&root)?, &path))
}

/// Copie verifiee de la racine actuelle vers l'emplacement vise (location.rs).
/// `aside` : seulement pour l'espace prive qui n'a aucune page (Vrac vide du
/// premier lancement), son contenu est renomme a cote, jamais efface.
#[tauri::command(async)]
fn copy_to_location(
    root: State<'_, Root>, st: State<'_, Storage>, target: String, sub: Option<String>, aside: Option<bool>,
) -> Res<location::CopyReport> {
    let src = root_of(&root)?;
    let dst = target_path(&root, &st, &target, sub.as_deref())?;
    let mut moved = None;
    if aside.unwrap_or(false) {
        if target != "internal" || sub.is_some() {
            return Err(fail("mise de cote refusee hors de l'espace de l'appli"));
        }
        if location::inspect(&src, &dst).inventory.pages > 0 {
            return Err(fail("l'espace de l'appli contient des pages : rien n'a ete deplace"));
        }
        moved = location::set_aside(&dst)?;
    }
    let mut report = location::copy_tree(&src, &dst)?;
    report.aside = moved.map(|p| p.to_string_lossy().to_string());
    Ok(report)
}

/// Bascule la racine vers l'emplacement vise, retenu pour les lancements
/// suivants. L'ancien emplacement n'est pas touche.
#[tauri::command]
fn switch_location(
    root: State<Root>, st: State<Storage>, target: String, sub: Option<String>,
) -> Res<StorageInfo> {
    let path = target_path(&root, &st, &target, sub.as_deref())?;
    if target == "internal" {
        fs::create_dir_all(&path).map_err(|e| fail(format!("{} : {e}", path.display())))?;
    }
    if !path.is_dir() {
        return Err(fail(format!("{} n'est pas un dossier", path.display())));
    }
    save_root_preference(&path);
    *root.0.lock().map_err(|_| fail("racine verrouillee"))? = path;
    *st.missing.lock().map_err(|_| fail("etat indisponible"))? = None;
    info_of(&root, &st)
}

/// Ouvre le dossier des cahiers dans l'explorateur Windows ou le Finder.
#[tauri::command]
fn open_root(state: State<Root>) -> Res<()> {
    let path = root_of(&state)?;
    open_folder(&path).map_err(|e| fail(format!("{} : {e}", path.display())))
}

#[cfg(windows)]
fn open_folder(path: &Path) -> io::Result<()> {
    std::process::Command::new("explorer").arg(path).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_folder(path: &Path) -> io::Result<()> {
    std::process::Command::new("open").arg(path).spawn().map(|_| ())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn open_folder(path: &Path) -> io::Result<()> {
    std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ())
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
        // Ecriture atomique : un root.txt tronque renverrait au dossier par defaut.
        let _ = write_durable(&file, "root.txt", path.to_string_lossy().as_bytes());
    }
}

/// Espace prive de l'appli : `Cahiers/` dans le dossier de donnees de Tauri
/// (Windows %APPDATA%\fr.mdlf.cahiers, Mac ~/Library/Application Support/
/// fr.mdlf.cahiers, conteneur sandbox compris).
fn internal_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .ok()
        .or_else(|| dirs::data_dir().map(|d| d.join("fr.mdlf.cahiers")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Cahiers")
}

/// Anciens emplacements d'un dossier ESEO, repris seulement s'ils
/// contiennent deja des cahiers (second PC sans root.txt).
fn legacy_candidates() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    vec![
        home.join("OneDrive").join("Desktop").join("ESEO"),
        home.join("OneDrive").join("Bureau").join("ESEO"),
        home.join("OneDrive").join("ESEO"),
        home.join("Desktop").join("ESEO"),
        dirs::document_dir().unwrap_or_else(|| home.join("Documents")).join("ESEO"),
    ]
}

/// Ou sont les cahiers ? Voir `location::choose_root` : root.txt d'abord,
/// tel quel ; sinon un ancien dossier ESEO de cahiers ; sinon l'espace prive.
fn resolve_root(app: &tauri::AppHandle) -> (PathBuf, PathBuf, Option<PathBuf>) {
    let internal = internal_dir(app);
    let saved = preference_file().and_then(|f| fs::read_to_string(f).ok());
    let r = location::choose_root(saved.as_deref(), &internal, &legacy_candidates());
    if location::same_dir(&r.root, &internal) {
        let _ = fs::create_dir_all(&internal);
    }
    if r.save {
        save_root_preference(&r.root);
    }
    (r.root, internal, r.missing)
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
        .plugin(tauri_plugin_dialog::init())
        .manage(Root(Mutex::new(PathBuf::new())))
        .manage(Storage::default())
        .setup(|app| {
            let (root, internal, missing) = resolve_root(app.handle());
            if let Ok(mut g) = app.state::<Root>().0.lock() { *g = root; }
            let st = app.state::<Storage>();
            if let Ok(mut g) = st.internal.lock() { *g = internal; }
            if let Ok(mut g) = st.missing.lock() { *g = missing; }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            root_path,
            machine_name,
            list_dirs,
            list_files,
            list_files_meta,
            stat_path,
            read_text,
            read_text_meta,
            write_text,
            write_text_if,
            read_binary,
            write_binary,
            save_export,
            ocr_image,
            myscript_keys,
            set_myscript_keys,
            path_exists,
            make_dir,
            remove_path,
            rename_path,
            reveal_path,
            set_root,
            storage_info,
            pick_sync_folder,
            inspect_location,
            copy_to_location,
            switch_location,
            open_root,
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
    fn ecriture_durable_sans_fichier_temporaire() {
        let dir = std::env::temp_dir().join(format!("cahiers-test-{}", std::process::id()));
        let path = dir.join("Maths").join("Cours").join("0001.page.json");
        write_durable(&path, "Maths/Cours/0001.page.json", b"{}").unwrap();
        write_durable(&path, "Maths/Cours/0001.page.json", b"{\"a\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        let left: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp-write"))
            .collect();
        assert!(left.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fichiers_temporaires_uniques() {
        let p = PathBuf::from("/base/0001.page.json");
        let a = temp_path(&p);
        let b = temp_path(&p);
        assert_ne!(a, b);
        assert!(a.to_string_lossy().ends_with(".tmp-write"));
        assert!(a.file_name().unwrap().to_string_lossy().starts_with("0001.page.json."));
    }

    #[test]
    fn ecritures_paralleles_du_meme_fichier() {
        let dir = std::env::temp_dir().join(format!("cahiers-par-{}", std::process::id()));
        let path = dir.join("0001.page.json");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let p = path.clone();
                std::thread::spawn(move || {
                    let body = format!("{{\"n\":{i}}}").repeat(2000);
                    write_durable(&p, "0001.page.json", body.as_bytes()).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        // Un seul des contenus, entier : jamais un melange de deux ecritures.
        let first = &text[..7];
        assert_eq!(text, first.repeat(2000));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn renommage_sans_ecraser() {
        let dir = std::env::temp_dir().join(format!("cahiers-ren-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("0001.page.json");
        let b = dir.join("0002.page.json");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let e = rename_no_replace(&a, &b).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
        assert_eq!(fs::read_to_string(&a).unwrap(), "a");
        let c = dir.join("0003.page.json");
        rename_no_replace(&a, &c).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read_to_string(&c).unwrap(), "a");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn condition_d_ecriture() {
        let m = FileMeta { name: "x".into(), mtime: 1000.5, size: 10 };
        assert!(matches(None, None));
        assert!(!matches(Some(&m), None));
        assert!(!matches(None, Some(&Expect { mtime: 1000.5, size: 10 })));
        assert!(matches(Some(&m), Some(&Expect { mtime: 1000.5, size: 10 })));
        assert!(!matches(Some(&m), Some(&Expect { mtime: 1000.5, size: 11 })));
        assert!(!matches(Some(&m), Some(&Expect { mtime: 1001.0, size: 10 })));
    }

    #[test]
    fn nom_de_machine() {
        assert!(host_name().map(|n| !n.is_empty()).unwrap_or(true));
        assert_eq!(clean_host("  PC-MAX\n"), Some("PC-MAX".to_string()));
        assert_eq!(clean_host(" \n"), None);
    }

    #[test]
    fn retente_un_fichier_verrouille() {
        let mut calls = 0;
        let r = retry_locked(|| {
            calls += 1;
            if calls < 3 {
                Err(io::Error::from_raw_os_error(32))
            } else {
                Ok(calls)
            }
        });
        assert_eq!(r.unwrap(), 3);
        let mut other = 0;
        let r: io::Result<()> = retry_locked(|| {
            other += 1;
            Err(io::Error::new(io::ErrorKind::NotFound, "absent"))
        });
        assert!(r.is_err());
        assert_eq!(other, 1);
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
