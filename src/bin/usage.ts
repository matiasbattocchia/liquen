/**
 * bin/usage.ts — the harness's programs, each by its one-line usage: what its own errors
 * print, and what the prefix's `# Programs` lists under the directory that holds it (§5).
 */

export const USAGE: Record<string, string> = {
  aread: "aread <path> [offset] [limit] [maxBytes]",
  awrite: "awrite <path>, the content on stdin",
  aedit: "aedit <path>, conflict-marker blocks on stdin, each marker on a line of its own: " +
    "<<<<<<<, the old text, =======, the new text, >>>>>>>",
  fetch: "fetch [-X METHOD] [-H 'k: v']... [-d BODY|@-|@FILE] [-i] [-o PATH|-] URL [limit] " +
    "[maxBytes]",
};
