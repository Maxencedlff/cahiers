// ESLint (flat config) : erreurs réelles seulement, pas de règles de style.
// Règles coupées ou assouplies ci-dessous = choix délibérés du code, pas des bugs.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "obsolete/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // Typage souple voulu aux frontières (mathjs, MathLive, Tauri).
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-this-alias": "off",
      // Sentinelles \u0000 / \u0001 et filtres de caractères de contrôle voulus.
      "no-control-regex": "off",
      "no-useless-escape": "off",
      // Espaces insécables (U+202F) et ​ font partie du texte de l'appli.
      "no-irregular-whitespace": ["error", { skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true }],
      // « _x » = ignoré exprès (paramètre réservé, champ retiré d'une copie).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true, allowShortCircuit: true }],
    },
  },
  {
    // Valeurs float32 écrites telles quelles pour tester l'arrondi du format v2.
    files: ["src/tests/**"],
    rules: { "no-loss-of-precision": "off" },
  },
);
