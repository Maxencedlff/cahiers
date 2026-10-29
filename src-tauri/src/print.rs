//! Impression de la page sur Mac (export PDF : boite d'impression native,
//! « Enregistrer au format PDF »). Partout ailleurs, `window.print` suffit.
//!
//! Tauri passe `window.print` a wry, qui cree l'operation d'impression de la
//! WKWebView sans donner de taille a la vue imprimee (WKPrintingView). Depuis
//! macOS 26, cette vue reste a NSZeroRect et la boite ne s'ouvre pas : rien ne
//! se passe au clic sur « Exporter » (refus App Review du 29/10/2026, macOS
//! 27). Contournement donne par Apple (forum developpeurs, fil 811901) :
//! poser le cadre de la vue imprimee sur celui de la WKWebView avant de
//! lancer l'operation.

/// Ouvre la boite d'impression de la fenetre de cette webview. Ne bloque
/// pas : la boite est une feuille, la page sait qu'elle est fermee par
/// `afterprint` ou le retour du focus (core/printwait.ts).
#[cfg(target_os = "macos")]
pub fn print(webview: &tauri::Webview) -> Result<(), String> {
    use objc2_app_kit::{NSPrintInfo, NSWindow};
    use objc2_web_kit::WKWebView;

    webview
        .with_webview(|pw| {
            // Safety : pointeurs rendus par Tauri pour cette webview, valides
            // pendant ce rappel, appele sur le fil principal.
            unsafe {
                let wk: &WKWebView = &*pw.inner().cast();
                let window: &NSWindow = &*pw.ns_window().cast();
                // Marges nulles comme wry : les feuilles A4 sont deja mises en
                // page par la vue (@page, core/print.ts).
                let info = NSPrintInfo::sharedPrintInfo();
                info.setTopMargin(0.0);
                info.setRightMargin(0.0);
                info.setBottomMargin(0.0);
                info.setLeftMargin(0.0);
                let operation = wk.printOperationWithPrintInfo(&info);
                if let Some(view) = operation.view() {
                    view.setFrame(wk.bounds());
                }
                operation.setShowsPrintPanel(true);
                operation.setShowsProgressPanel(true);
                operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                    window,
                    None,
                    None,
                    std::ptr::null_mut(),
                );
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn print(_webview: &tauri::Webview) -> Result<(), String> {
    Err("impression native reservee a macOS (ailleurs : window.print)".into())
}
