import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Variables d'environnement visibles du JS livre : jamais tout « TAURI_ »,
  // sinon TAURI_SIGNING_PRIVATE_KEY (presente pendant le build) finirait dans
  // le bundle des qu'un code lirait import.meta.env. TAURI_ENV_* = variables
  // publiques posees par la CLI Tauri (plateforme, cible, debug).
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: true,
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
