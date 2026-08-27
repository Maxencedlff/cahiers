import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
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
