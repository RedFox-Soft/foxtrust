// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["node_modules/", "var/", "specs/", ".specify/", ".claude/", "tools/"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Bun.sql types every row as `any`; these rules would flag each column read. They are back on
      // below for the parsers of untrusted input.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // ESLint reads TS 6 types while `tsc` is TS 7, which may need assertions TS 6 calls unnecessary.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // A leading underscore marks a value that is unused on purpose.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Modules that parse untrusted input and never touch Bun.sql: here an `any` is a real hole.
    files: [
      "src/feeds/**/*.ts", "src/verify/**/*.ts", "src/policy/**/*.ts", "src/mmdb/**/*.ts", "src/decision/**/*.ts",
      "src/ip/**/*.ts", "src/ingest/fetch.ts", "src/ingest/licence-gate.ts", "src/scoring/config.ts",
      "src/alerts/telegram.ts", "src/alerts/settings.ts", "src/alerts/redact.ts", "src/alerts/message.ts",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
  {
    // This config and the Cloudflare Worker in deploy/tor-mirror (Workers runtime globals).
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { fetch: "readonly", Request: "readonly", Response: "readonly", URL: "readonly" },
    },
  },
);
