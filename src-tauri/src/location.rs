//! Emplacement des cahiers (decision du 16/10/2026).
//!
//! Par defaut les cahiers sont dans l'espace prive de l'appli (Tauri
//! `app_data_dir`, `Cahiers/` dedans : Windows %APPDATA%\fr.mdlf.cahiers,
//! Mac ~/Library/Application Support/fr.mdlf.cahiers, dans le conteneur
//! sandbox). Un dossier synchronise (OneDrive, iCloud Drive) choisi par
//! l'utilisateur reste possible. Memes fichiers JSON dans les deux cas.
//!
//! Rien ici ne supprime jamais un fichier : une bascule COPIE (sans jamais
//! ecraser), verifie le nombre de fichiers et d'octets, puis seulement
//! change de racine. L'ancien emplacement reste tel quel.
//!
//! Sandbox Mac App Store (sandbox.rs) : un dossier choisi par la boite de
//! dialogue n'est accessible que pour la session ; il est retrouve au
//! lancement suivant par un « security-scoped bookmark » garde a cote de
//! root.txt. Sans acces (`confine`), le dossier est vu comme introuvable et
//! l'appli s'ouvre dans son espace prive avec un avertissement, sans rien
//! perdre.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use super::{rename_no_replace, retry_locked, temp_path};

/// Ce que donne un dossier : fichiers, pages, octets.
#[derive(serde::Serialize, Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inventory {
    pub files: u64,
    pub pages: u64,
    pub bytes: u64,
}

/// Une racine possible, vue avant de basculer.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirReport {
    pub path: String,
    pub exists: bool,
    /// Noms du premier niveau (dossiers et fichiers), tels quels.
    pub entries: Vec<String>,
    /// Matieres : dossiers du premier niveau qui ont un cahier.json, hors Vrac.
    pub notebooks: u64,
    #[serde(flatten)]
    pub inventory: Inventory,
    /// Parcours arrete avant la fin (dossier enorme, choisi par erreur).
    pub truncated: bool,
    /// Place par rapport a la racine actuelle : same, inside, contains, none.
    pub relation: &'static str,
}

/// Resultat d'une copie verifiee.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub path: String,
    /// Ce qu'il fallait copier (racine actuelle).
    pub source: Inventory,
    /// Ce qui est a destination, relu fichier par fichier apres la copie.
    pub dest: Inventory,
    pub copied: u64,
    /// Deja presents a destination, octet pour octet identiques.
    pub same: u64,
    /// Ancien contenu (sans page) de l'espace prive, mis de cote ici.
    pub aside: Option<String>,
}

/// Plafond du parcours d'un dossier pour le decrire (pas pour copier).
const INSPECT_BUDGET: usize = 100_000;

/// Fichiers jamais copies : presence d'un PC (section 11), ecriture en cours.
pub fn skipped(name: &str) -> bool {
    (name.starts_with(".presence-") && name.ends_with(".json")) || name.ends_with(".tmp-write")
}

/// Une page compte si elle n'est pas dans un dossier cache (corbeille, versions).
pub fn is_page(rel: &Path) -> bool {
    let name = rel.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    name.ends_with(".page.json")
        && !rel.components().any(|c| matches!(c, Component::Normal(s) if s.to_string_lossy().starts_with('.')))
}

/// Le dossier ressemble-t-il a une racine de cahiers (Vrac, ou une matiere) ?
/// Sert seulement a reprendre un ancien dossier ESEO sans root.txt.
pub fn looks_like_cahiers(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    if dir.join("Vrac").is_dir() {
        return true;
    }
    fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok()).any(|e| e.path().join("cahier.json").is_file()))
        .unwrap_or(false)
}

/// Choix de la racine au lancement.
#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub root: PathBuf,
    /// root.txt a (re)ecrire.
    pub save: bool,
    /// Dossier retenu dans root.txt mais introuvable : on ne l'oublie pas.
    pub missing: Option<PathBuf>,
}

/// 1. root.txt existe et son dossier aussi : on le garde, tel quel (cas de
///    Maxence, rien ne bouge) ;
/// 2. root.txt pointe un dossier absent : espace prive pour cette session,
///    root.txt intact, avertissement dans les Reglages ;
/// 3. pas de root.txt : un ancien dossier ESEO qui contient deja des cahiers
///    (second PC) est repris ;
/// 4. sinon : espace prive de l'appli, retenu dans root.txt.
pub fn choose_root(saved: Option<&str>, internal: &Path, candidates: &[PathBuf]) -> Resolved {
    if let Some(s) = saved {
        let t = s.trim_start_matches('\u{feff}').trim();
        if !t.is_empty() {
            let p = PathBuf::from(t);
            if p.is_dir() {
                return Resolved { root: p, save: false, missing: None };
            }
            return Resolved { root: internal.to_path_buf(), save: false, missing: Some(p) };
        }
    }
    for c in candidates {
        if looks_like_cahiers(c) {
            return Resolved { root: c.clone(), save: true, missing: None };
        }
    }
    Resolved { root: internal.to_path_buf(), save: true, missing: None }
}

/// Sandbox (build Mac App Store) : une racine hors de l'espace prive n'est
/// gardee que si un bookmark en a rouvert l'acces (`granted` : le dossier
/// ouvert, la racine peut etre dedans, ex. sous-dossier « Cahiers »). Sinon
/// elle est traitee comme introuvable : espace prive pour la session,
/// root.txt intact, avertissement dans les Reglages.
pub fn confine(r: Resolved, internal: &Path, granted: Option<&Path>) -> Resolved {
    if same_dir(&r.root, internal) {
        return r;
    }
    if let Some(g) = granted {
        if matches!(relation(g, &r.root), "same" | "inside") {
            return r;
        }
    }
    Resolved { root: internal.to_path_buf(), save: false, missing: Some(r.root) }
}

/// Sandbox : un dossier synchronise deplace ou renomme dans le Finder. Le
/// bookmark le suit (`granted` : le dossier qu'il rouvre), root.txt garde
/// l'ancien chemin, et `confine` le declarerait introuvable (C-10).
///
/// Si la racine retenue (`r.root`, ou `r.missing` quand son dossier a
/// disparu) n'est plus dans `granted`, elle y est replacee : le dossier
/// rouvert lui-meme, ou son sous-dossier de meme nom que l'ancienne racine
/// quand c'est lui qui a les cahiers (« Cahiers », seul sous-dossier qu'une
/// bascule cree). `save` : root.txt est reecrit avec ce chemin. None = rien
/// a suivre (espace prive, racine deja couverte, dossier rouvert absent).
pub fn follow_bookmark(r: &Resolved, internal: &Path, granted: &Path) -> Option<Resolved> {
    let saved = r.missing.as_deref().unwrap_or(&r.root);
    if same_dir(saved, internal) || !granted.is_dir() {
        return None;
    }
    if matches!(relation(granted, saved), "same" | "inside") {
        return None;
    }
    let root = saved
        .file_name()
        .map(|name| granted.join(name))
        .filter(|sub| looks_like_cahiers(sub) && !looks_like_cahiers(granted))
        .unwrap_or_else(|| granted.to_path_buf());
    Some(Resolved { root, save: true, missing: None })
}

/// Dossier existant le plus proche d'un chemin (lui-meme ou un parent, jamais
/// la racine du disque) : point de depart de la boite « Choisir un dossier »
/// pour retrouver un dossier introuvable.
pub fn nearest_dir(p: &Path) -> Option<PathBuf> {
    p.ancestors()
        .filter(|a| a.parent().is_some())
        .find(|a| a.is_dir())
        .map(Path::to_path_buf)
}

/// Chemin comparable : canonique s'il existe, sinon celui du parent + nom.
fn canonical(p: &Path) -> PathBuf {
    if let Ok(c) = fs::canonicalize(p) {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) if parent != p => canonical(parent).join(name),
        _ => p.to_path_buf(),
    }
}

fn norm(p: &Path) -> String {
    let s = canonical(p).to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(any(windows, target_os = "macos")) { s.to_lowercase() } else { s }
}

pub fn same_dir(a: &Path, b: &Path) -> bool {
    norm(a) == norm(b)
}

/// `target` par rapport a `root` : meme dossier, dedans, ou le contenant.
pub fn relation(root: &Path, target: &Path) -> &'static str {
    let (r, t) = (norm(root), norm(target));
    if r == t {
        "same"
    } else if t.starts_with(&format!("{r}/")) {
        "inside"
    } else if r.starts_with(&format!("{t}/")) {
        "contains"
    } else {
        "none"
    }
}

/// Parcours sans suivre les liens : dossiers et fichiers (chemin relatif, taille).
struct Walk {
    dirs: Vec<PathBuf>,
    files: Vec<(PathBuf, u64)>,
    truncated: bool,
}

fn walk(base: &Path, budget: Option<usize>) -> io::Result<Walk> {
    let mut out = Walk { dirs: Vec::new(), files: Vec::new(), truncated: false };
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(base.join(&rel))?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if let Some(max) = budget {
                if out.files.len() + out.dirs.len() >= max {
                    out.truncated = true;
                    return Ok(out);
                }
            }
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(meta) = fs::symlink_metadata(e.path()) else { continue };
            let child = rel.join(&name);
            if meta.is_dir() {
                out.dirs.push(child.clone());
                stack.push(child);
            } else if meta.is_file() && !skipped(&name) {
                out.files.push((child, meta.len()));
            }
        }
    }
    Ok(out)
}

fn inventory_of(files: &[(PathBuf, u64)]) -> Inventory {
    let mut inv = Inventory::default();
    for (rel, size) in files {
        inv.files += 1;
        inv.bytes += size;
        if is_page(rel) {
            inv.pages += 1;
        }
    }
    inv
}

/// Decrit un dossier avant d'y basculer. Rien n'est ecrit.
pub fn inspect(root: &Path, target: &Path) -> DirReport {
    let relation = relation(root, target);
    let path = target.to_string_lossy().to_string();
    if !target.is_dir() {
        return DirReport {
            path, exists: target.exists(), entries: Vec::new(), notebooks: 0,
            inventory: Inventory::default(), truncated: false, relation,
        };
    }
    let mut entries = Vec::new();
    let mut notebooks = 0;
    if let Ok(it) = fs::read_dir(target) {
        for e in it.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            // Vrac n'est pas une matiere : « 2 matières » pour Maths seule egarait.
            if name != "Vrac" && e.path().join("cahier.json").is_file() {
                notebooks += 1;
            }
            entries.push(name);
        }
    }
    entries.sort();
    let (inventory, truncated) = match walk(target, Some(INSPECT_BUDGET)) {
        Ok(w) => (inventory_of(&w.files), w.truncated),
        Err(_) => (Inventory::default(), true),
    };
    DirReport { path, exists: true, entries, notebooks, inventory, truncated, relation }
}

fn same_bytes(a: &Path, b: &Path) -> bool {
    match (retry_locked(|| fs::read(a)), retry_locked(|| fs::read(b))) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Copie d'un fichier sans jamais ecraser : ecrit a cote, force sur le
/// disque, puis renomme sans remplacer (refuse si la destination existe).
fn copy_new(src: &Path, dst: &Path) -> io::Result<()> {
    let bytes = retry_locked(|| fs::read(src))?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = temp_path(dst);
    let r = retry_locked(|| {
        let mut f = fs::File::create(&temp)?;
        f.write_all(&bytes)?;
        f.sync_all()
    })
    .and_then(|_| rename_no_replace(&temp, dst));
    if r.is_err() {
        let _ = fs::remove_file(&temp);
    }
    r
}

/// Met de cote l'ancien contenu (sans aucune page) de l'espace prive :
/// renomme en « Cahiers-avant-<horodatage> », jamais efface.
pub fn set_aside(dir: &Path) -> Result<Option<PathBuf>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let base = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Cahiers".into());
    let mut next = dir.with_file_name(format!("{base}-avant-{stamp}"));
    let mut i = 2;
    while next.exists() {
        next = dir.with_file_name(format!("{base}-avant-{stamp}-{i}"));
        i += 1;
    }
    rename_no_replace(dir, &next).map_err(|e| format!("mise de cote impossible : {e}"))?;
    Ok(Some(next))
}

/// Copie toute la racine `src` vers `dst`, verifiee.
///
/// - refuse si l'un est dans l'autre ;
/// - verification complete AVANT d'ecrire : un fichier deja present a
///   destination doit etre identique octet pour octet, sinon rien n'est
///   copie du tout ;
/// - dossiers vides recopies (un intercalaire vide est un intercalaire) ;
/// - apres la copie, chaque fichier est relu (presence + taille).
pub fn copy_tree(src: &Path, dst: &Path) -> Result<CopyReport, String> {
    match relation(src, dst) {
        "same" => return Err("c'est déjà l'emplacement actuel".into()),
        "inside" | "contains" => {
            return Err("un emplacement ne peut pas être dans l'autre : choisis un dossier à part".into())
        }
        _ => {}
    }
    let w = walk(src, None).map_err(|e| format!("lecture des cahiers impossible : {e}"))?;
    let source = inventory_of(&w.files);

    let mut conflicts: Vec<String> = Vec::new();
    let mut todo: Vec<&(PathBuf, u64)> = Vec::new();
    let mut same = 0u64;
    for d in &w.dirs {
        if let Ok(m) = fs::symlink_metadata(dst.join(d)) {
            if !m.is_dir() {
                conflicts.push(d.to_string_lossy().to_string());
            }
        }
    }
    for f in &w.files {
        let (rel, size) = f;
        let target = dst.join(rel);
        match fs::symlink_metadata(&target) {
            Err(_) => todo.push(f),
            Ok(m) if m.is_file() && m.len() == *size && same_bytes(&src.join(rel), &target) => same += 1,
            Ok(_) => conflicts.push(rel.to_string_lossy().to_string()),
        }
    }
    if !conflicts.is_empty() {
        return Err(format!(
            "{} élément(s) existent déjà à destination et diffèrent (dont « {} ») : rien n'a été copié",
            conflicts.len(),
            conflicts[0].replace('\\', "/")
        ));
    }

    fs::create_dir_all(dst).map_err(|e| format!("{} : {e}", dst.display()))?;
    for d in &w.dirs {
        fs::create_dir_all(dst.join(d)).map_err(|e| format!("{} : {e}", d.display()))?;
    }
    let mut copied = 0u64;
    for (rel, _) in todo {
        copy_new(&src.join(rel), &dst.join(rel)).map_err(|e| {
            format!(
                "copie interrompue après {copied} fichier(s) ({} : {e}). L'emplacement actuel est intact, rien n'a basculé",
                rel.display()
            )
        })?;
        copied += 1;
    }

    // Relecture : chaque fichier de la source doit etre la, a la meme taille.
    let mut dest = Inventory::default();
    for (rel, _) in &w.files {
        if let Ok(m) = fs::metadata(dst.join(rel)) {
            if m.is_file() {
                dest.files += 1;
                dest.bytes += m.len();
                if is_page(rel) {
                    dest.pages += 1;
                }
            }
        }
    }
    Ok(CopyReport {
        path: dst.to_string_lossy().to_string(),
        source, dest, copied, same, aside: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cahiers-loc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn root_txt_garde_le_dossier_tel_quel() {
        let base = tmp("keep");
        let eseo = base.join("ESEO");
        fs::create_dir_all(&eseo).unwrap();
        let internal = base.join("interne");
        let saved = eseo.to_string_lossy().to_string();
        let r = choose_root(Some(&format!("{saved}\r\n")), &internal, &[]);
        assert_eq!(r, Resolved { root: eseo.clone(), save: false, missing: None });
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn root_txt_vers_un_dossier_absent_ne_l_oublie_pas() {
        let base = tmp("missing");
        let internal = base.join("interne");
        let gone = base.join("parti");
        let r = choose_root(Some(&gone.to_string_lossy()), &internal, &[]);
        assert_eq!(r.root, internal);
        assert!(!r.save, "root.txt ne doit pas etre reecrit");
        assert_eq!(r.missing, Some(gone));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sans_root_txt_espace_prive_sauf_ancien_dossier_de_cahiers() {
        let base = tmp("fresh");
        let internal = base.join("interne");
        let random = base.join("Desktop").join("ESEO");
        put(&random.join("cours.pdf"), "x");
        let r = choose_root(None, &internal, &[random.clone()]);
        assert_eq!(r, Resolved { root: internal.clone(), save: true, missing: None });
        fs::create_dir_all(random.join("Vrac")).unwrap();
        let r = choose_root(None, &internal, &[random.clone()]);
        assert_eq!(r, Resolved { root: random, save: true, missing: None });
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sandbox_garde_seulement_un_dossier_rouvert_par_bookmark() {
        let base = tmp("confine");
        let internal = base.join("interne");
        let sync = base.join("iCloud");
        let root = sync.join("Cahiers");
        fs::create_dir_all(&root).unwrap();
        let chosen = Resolved { root: root.clone(), save: false, missing: None };
        // Bookmark du dossier choisi (la racine est dedans) : garde tel quel.
        let kept = confine(chosen, &internal, Some(&sync));
        assert_eq!(kept.root, root);
        assert_eq!(kept.missing, None);
        // Pas de bookmark, ou celui d'un autre dossier : introuvable, rien d'oublie.
        for granted in [None, Some(base.join("autre"))] {
            let r = confine(Resolved { root: root.clone(), save: false, missing: None }, &internal, granted.as_deref());
            assert_eq!(r, Resolved { root: internal.clone(), save: false, missing: Some(root.clone()) });
        }
        // Espace prive : jamais touche.
        let own = Resolved { root: internal.clone(), save: true, missing: None };
        assert_eq!(confine(own, &internal, None), Resolved { root: internal.clone(), save: true, missing: None });
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sandbox_suit_un_dossier_deplace_ou_renomme() {
        let base = tmp("deplace");
        let internal = base.join("interne");
        // Racine = sous-dossier « Cahiers » du dossier choisi, puis le dossier
        // choisi est renomme : le bookmark rouvre le nouveau nom.
        let old_root = base.join("iCloud").join("Cahiers");
        let moved = base.join("iCloud renomme");
        fs::create_dir_all(moved.join("Cahiers").join("Vrac")).unwrap();
        let lost = Resolved { root: internal.clone(), save: false, missing: Some(old_root.clone()) };
        let r = follow_bookmark(&lost, &internal, &moved).expect("nouveau chemin suivi");
        assert_eq!(r, Resolved { root: moved.join("Cahiers"), save: true, missing: None });
        // Ce chemin est ensuite garde par confine (acces rouvert dessus).
        assert_eq!(confine(r, &internal, Some(&moved)).root, moved.join("Cahiers"));

        // Racine = le dossier choisi lui-meme, deplace ailleurs.
        let old_eseo = base.join("OneDrive").join("ESEO");
        let new_eseo = base.join("Archives").join("ESEO 2026");
        fs::create_dir_all(new_eseo.join("Vrac")).unwrap();
        let lost = Resolved { root: internal.clone(), save: false, missing: Some(old_eseo) };
        let r = follow_bookmark(&lost, &internal, &new_eseo).unwrap();
        assert_eq!(r.root, new_eseo);
        assert!(r.save);

        // Rien a suivre : racine deja dans le dossier rouvert, espace prive,
        // dossier rouvert absent.
        let ok = Resolved { root: moved.join("Cahiers"), save: false, missing: None };
        assert_eq!(follow_bookmark(&ok, &internal, &moved), None);
        let own = Resolved { root: internal.clone(), save: true, missing: None };
        assert_eq!(follow_bookmark(&own, &internal, &moved), None);
        let lost = Resolved { root: internal.clone(), save: false, missing: Some(old_root) };
        assert_eq!(follow_bookmark(&lost, &internal, &base.join("disparu")), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn boite_ouverte_pres_du_dossier_introuvable() {
        let base = tmp("proche");
        assert_eq!(nearest_dir(&base.join("absent").join("Cahiers")), Some(base.clone()));
        assert_eq!(nearest_dir(&base), Some(base.clone()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copie_verifiee_sans_ecraser() {
        let base = tmp("copy");
        let src = base.join("src");
        put(&src.join("Maths/cahier.json"), "{}");
        put(&src.join("Maths/Cours/0001.page.json"), "{\"a\":1}");
        put(&src.join(".corbeille/x/Maths/Cours/0002.page.json"), "{}");
        put(&src.join("Maths/.presence-PC.json"), "{}");
        fs::create_dir_all(src.join("Maths/TD")).unwrap();
        let dst = base.join("dst");
        let r = copy_tree(&src, &dst).unwrap();
        assert_eq!(r.source, Inventory { files: 3, pages: 1, bytes: 2 + 7 + 2 });
        assert_eq!(r.dest, r.source);
        assert_eq!(r.copied, 3);
        assert!(dst.join("Maths/TD").is_dir(), "intercalaire vide recopie");
        assert!(!dst.join("Maths/.presence-PC.json").exists());
        assert!(src.join("Maths/Cours/0001.page.json").exists(), "source intacte");
        // Seconde copie : tout est identique, rien n'est recopie.
        let again = copy_tree(&src, &dst).unwrap();
        assert_eq!((again.copied, again.same), (0, 3));
        // Un fichier different a destination : refus total, rien n'est ecrit.
        fs::write(dst.join("Maths/Cours/0001.page.json"), "autre").unwrap();
        put(&src.join("Elec/cahier.json"), "{}");
        let e = copy_tree(&src, &dst).unwrap_err();
        assert!(e.contains("rien n'a été copié"), "{e}");
        assert_eq!(fs::read_to_string(dst.join("Maths/Cours/0001.page.json")).unwrap(), "autre");
        assert!(!dst.join("Elec").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn refuse_un_emplacement_dans_l_autre() {
        let base = tmp("nest");
        let src = base.join("src");
        put(&src.join("Vrac/cahier.json"), "{}");
        assert!(copy_tree(&src, &src).is_err());
        assert!(copy_tree(&src, &src.join("Sous")).is_err());
        assert!(copy_tree(&src, &base).is_err());
        assert_eq!(relation(&src, &base.join("autre")), "none");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn mise_de_cote_sans_effacer() {
        let base = tmp("aside");
        let dir = base.join("Cahiers");
        put(&dir.join("Vrac/cahier.json"), "{}");
        let moved = set_aside(&dir).unwrap().unwrap();
        assert!(!dir.exists());
        assert!(moved.join("Vrac/cahier.json").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn decrit_un_dossier() {
        let base = tmp("inspect");
        put(&base.join("Maths/cahier.json"), "{}");
        put(&base.join("Maths/Cours/0001.page.json"), "{}");
        put(&base.join("Vrac/cahier.json"), "{}");
        put(&base.join(".versions/a/1.json"), "{}");
        let r = inspect(&std::env::temp_dir().join("cahiers-loc-ailleurs"), &base);
        assert!(r.exists);
        assert_eq!(r.notebooks, 1);
        assert_eq!(r.inventory.pages, 1);
        assert_eq!(r.inventory.files, 4);
        assert_eq!(r.relation, "none");
        assert_eq!(inspect(&base.join("Maths"), &base).relation, "contains");
        assert_eq!(inspect(&base, &base.join("Maths")).relation, "inside");
        let _ = fs::remove_dir_all(&base);
    }
}
