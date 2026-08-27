// Empeche l'ouverture d'une console Windows en plus de la fenetre.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cahiers_lib::run()
}
