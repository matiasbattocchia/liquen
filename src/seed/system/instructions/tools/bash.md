Run a bash command. The working directory PERSISTS between calls like a terminal (cd once, it
sticks), but shell/env state (exported vars, activated venvs) does not, so re-export or chain
those. stdout+stderr merged; output truncated to the last {{max_lines}} lines / {{max_kb}}KB
(override with max_lines/max_bytes when you deliberately need more or less); when truncated,
the full output is saved to a file the footer names (page it with aread). Default timeout
{{timeout}}s; run long work in the background (cmd > out.log 2>&1 &) and poll with tail.

Prefer fat commands: chain independent steps with && or ; in ONE call, and emit multiple bash
calls in one turn when they don't depend on each other; every separate call is a full
round-trip. Calls in one turn run at once, each from the same directory, so give each its own
cd; the cwd: line under now: is where your next call starts.

Four helpers on PATH, their usage listed under # Programs, do the everyday jobs better than
their habitual counterparts; reach for them first.
- aread, over cat/head/sed -n: it shows a file from its TOP with a footer naming the offset to
  continue from, where a cat through this tool keeps only the last lines and a long file
  loses its beginning; on an image or PDF it attaches the file itself, so you see it, and a
  binary answers with its size, not mojibake.
- awrite, over cat >/echo >: it creates parent dirs and replaces the file atomically, keeping
  its mode.
- aedit, over sed -i/perl -pi: the old text is literal, never a regex, and an edit whose old
  text is missing or matches twice fails and says which, where sed changes nothing or too much
  in silence; the file is locked for the edit and replaced atomically.
- fetch, over curl/wget: a status outside 2xx fails the call, where curl -s exits 0 on a 404;
  JSON prints pretty; an HTML page reads as text with absolute links, followed by the JSON
  data scripts it carries (no script runs, so on a client-rendered page those are often the
  content); the body is head-truncated like aread (-o saves it whole, as served; -o - writes
  it whole to stdout for a program: fetch -o - URL | jq …); an API's credential is the $VAR
  the environment holds, sent as a header (-H "Authorization: Bearer $VAR").

rg and fd are available for search when installed.

- command: bash command to execute
- timeout: seconds (optional; default {{timeout}})
- max_lines: output truncation: keep the last N lines (optional; default {{max_lines}})
- max_bytes: output truncation: byte cap (optional; default {{max_bytes}})
