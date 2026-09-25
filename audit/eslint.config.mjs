/**
 * The promise audit: the two rules `deno lint` cannot run, because they need types. A store
 * port answers with a promise, so a write nobody awaits and a lookup read as a boolean both
 * type-check; these rules are what flags them. Types come from `tsconfig.json` beside this
 * file, which resolves the repo's own modules — the ports live there — and leaves Deno's
 * globals and the registry's packages untyped.
 */
// pinned inline: the audit's tooling stays out of the import map and the lockfile
// deno-lint-ignore no-import-prefix
import tseslint from "npm:typescript-eslint@8.70.1";

export default [{
  files: ["src/**/*.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
  },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
  },
}];
