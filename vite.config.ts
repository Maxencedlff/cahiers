import { defineConfig } from "vite";

/**
 * Cible du JavaScript produit, selon le WebView de la plateforme (forme de la
 * doc Tauri, TAURI_ENV_PLATFORM pose par `tauri build`) :
 *  - Windows : WebView2, a jour avec Edge ;
 *  - Mac (et le reste) : WKWebView, dont le WebKit est celui du systeme.
 *    safari16.4 = WebKit de macOS 13.3, la version minimale de
 *    tauri.conf.json (bundle.macOS.minimumSystemVersion) : c'est le premier
 *    systeme qui garantit les blocs statiques de classe du worker de pdf.js
 *    (build legacy, copie tel quel, sans transpilation). Les API recentes,
 *    elles, sont couvertes par les polyfills de ce build legacy (ui/pdf.ts).
 */
const target = process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome110" : "safari16.4";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Variables d'environnement visibles du JS livre : jamais tout « TAURI_ »,
  // sinon TAURI_SIGNING_PRIVATE_KEY (presente pendant le build) finirait dans
  // le bundle des qu'un code lirait import.meta.env. TAURI_ENV_* = variables
  // publiques posees par la CLI Tauri (plateforme, cible, debug).
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target,
    minify: "esbuild",
    // Pas de .map dans l'appli livree : ils embarqueraient le code source
    // d'un depot prive dans l'exe, le dmg et le pkg. `npm run dev` garde les
    // siennes.
    sourcemap: false,
    rollupOptions: {
      output: {
        // mathjs et katex partent dans leurs propres morceaux : ils ne sont
        // charges qu'a l'ouverture de la calculatrice ou d'une formule.
        manualChunks: {
          mathjs: ["mathjs"],
          katex: ["katex"],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
  },
} as any);
