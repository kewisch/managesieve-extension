import js from "@eslint/js";
import globals from "globals";
import stylistic from "@stylistic/eslint-plugin";

export default [
  {
    ignores: [
      "node_modules/**",
      "web-ext-artifacts/**",
    ],
  },
  js.configs.recommended,
  {
    files: [
      "src/**/*.mjs",
      "test/**/*.mjs",
      "eslint.config.js",
      "commitlint.config.js",
    ],
    plugins: {
      "@stylistic": stylistic,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.es2021,
        messenger: true,
      },
    },
    rules: {
      "@stylistic/list-style": "error",
      "@stylistic/arrow-spacing": ["error", { before: true, after: true }],
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: true }],
      "@stylistic/comma-dangle": "off",
      "@stylistic/comma-spacing": ["error", { before: false, after: true }],
      "@stylistic/eol-last": "error",
      "@stylistic/function-call-spacing": "error",
      "@stylistic/keyword-spacing": "error",
      "@stylistic/key-spacing": ["error", { beforeColon: false, afterColon: true, mode: "minimum" }],
      "@stylistic/no-extra-semi": "error",
      "@stylistic/no-mixed-spaces-and-tabs": "error",
      "@stylistic/no-multi-spaces": "error",
      "@stylistic/no-multiple-empty-lines": ["error", { max: 2, maxEOF: 0, maxBOF: 0 }],
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/padded-blocks": ["error", "never"],
      "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
      "@stylistic/semi": ["error", "always"],
      "@stylistic/space-before-blocks": "error",
      "@stylistic/space-before-function-paren": ["error", { anonymous: "never", named: "never" }],
      "@stylistic/space-in-parens": ["error", "never"],
      "@stylistic/spaced-comment": ["error", "always"],
      "block-scoped-var": "error",
      "curly": "error",
      "no-array-constructor": "error",
      "no-duplicate-imports": "error",
      "no-extend-native": "error",
      "no-new-wrappers": "error",
      "no-object-constructor": "error",
      "no-octal-escape": "error",
      "no-return-assign": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-unneeded-ternary": "error",
      "no-unused-vars": ["error", { args: "none" }],
      "no-void": "error",
      "radix": "error",
      "yoda": "error",
    },
  },
  {
    files: [
      "test/**/*.mjs",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
