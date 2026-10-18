/**
 * Confidentialite : ce que l'appli dit de ses donnees (exige par l'App
 * Store, Guideline 5.1.1 et 5.1.2).
 *
 * Rien ne sort de la machine, sauf les traits a convertir, envoyes a MyScript
 * avec les cles de l'utilisateur (src/core/ink/recognizer.ts).
 */

/** Page publique de la politique. Meme adresse que PRIVACY_URL de src-tauri/src/shell.rs. */
export const PRIVACY_URL = "https://cahiers.vercel.app/confidentialite.html";

/** Phrase de la boite et des Reglages « Reconnaissance manuscrite ». */
export const MYSCRIPT_NOTICE = "Les traits convertis sont envoyés à MyScript (cloud.myscript.com) avec tes clés.";
