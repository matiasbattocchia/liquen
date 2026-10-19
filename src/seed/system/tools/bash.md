---
kind: tool
---

Run a bash command. Each call is a fresh shell in the folder the cwd: line under now: names:
a cd lasts its call, and so does shell/env state (exported vars, activated venvs), so chain
those. stdout+stderr merged; output truncated to the last {{max_lines}} lines / {{max_kb}}KB
(override with max_lines/max_bytes when you deliberately need more or less); when truncated,
the full output is saved to a file the footer names (page it with aread).

The turn waits for a command up to wait seconds (default {{wait}}). One still running then is
not killed: the call answers with what it printed so far, the command runs on, and you are
told when it ends, with its exit status and the lines it printed since. So set wait to what
you want to see before going on: 0 to start a server and go on at once, a few seconds to see
it boot, longer for a build you would wait for anyway. While it runs, its output goes to the
file the answer names, its last line stands beside it under now:, and kill <pid> stops it,
kill -- -<group> all of its group. It runs until it ends or is killed, through restarts of
the harness, and you are told its end all the same: nothing stops it for you, so kill what
you no longer need.

wake is a regular expression: each line the command prints after the call answered that
matches it is told to you as it comes, a few lines at a time, and wakes you; the rest only
go to the file. Watch a build for its errors, a log for a pattern, a deploy for its last
step: bash(command: "tail -F app.log", wait: 0, wake: "ERROR|panic").

A command that leaves work in the background (cmd &) answers at once, and you are told when
what it left ends, but not how: the harness can see a background job's status only when it
is the command itself, so prefer wait to &. When you do use &, write the exit status as its
last line: { cmd; echo "exit $?"; } > out.log 2>&1 &. The call runs as bash -c with your
text, so a pkill -f on words from your own command kills the shell running it.

Prefer fat commands: chain independent steps with && or ; in ONE call, and emit multiple bash
calls in one turn when they don't depend on each other; every separate call is a full
round-trip. Calls in one turn run at once, each from the same directory, so give each its own
cd. A non-zero exit fails the call, but only the last command's status reaches it: a step
that fails in the middle of a ; chain (a cd to a folder that isn't there, and the write after
it that never ran) shows only in the output, so read its head, and join with && the steps
that must not go on after a failure.

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
  JSON prints pretty; an HTML page reads as text with absolute links, its main content first
  and its navigation after, followed by the JSON data scripts it carries (no script runs, so
  on a client-rendered page those are often the content); the body is head-truncated like
  aread (-o saves it whole, as served; -o - writes it whole to stdout for a program: fetch -o
  - URL | jq …); an API's credential is the $VAR the environment holds, sent as a header
  (-H "Authorization: Bearer $VAR"). To grep a page, grep its text (fetch URL 5000 500000 |
  grep -n -C3 …): served HTML often packs the page onto a few huge lines, so a grep of
  fetch -o - prints whole minified blobs, and a match without its neighbor line (a label
  without its value) misleads.

rg and fd may be missing from this machine's PATH: a missing program is a "command not found"
on stderr, so a search that hides stderr (2>/dev/null) and finds nothing proves nothing. Check
with command -v rg first, or search with grep -rn and find, which are always there.

- command: bash command to execute
- wait: seconds the turn waits before answering with what it printed so far; the command runs on, and its end is told (optional; default {{wait}})
- wake: a regular expression; the lines printed after the answer that match it are told as they come (optional)
- max_lines: output truncation: keep the last N lines (optional; default {{max_lines}})
- max_bytes: output truncation: byte cap (optional; default {{max_bytes}})
