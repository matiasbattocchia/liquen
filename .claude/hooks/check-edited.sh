#!/usr/bin/env bash
#
# PostToolUse (Edit|Write|MultiEdit) — format + check the edited file with THIS
# repo's CI tools (deno; see .github/workflows/check.yml) so Claude gets
# immediate feedback on its own edits.
#
#   format -> deno fmt <file>   (CI gate: deno fmt --check)
#   lint   -> deno lint <file>  (CI gate: deno lint)
#   types  -> deno check <file> (CI gate: deno check src)
#
# Formatting is applied in place. lint/type failures are written to stderr with
# exit 2, which Claude Code feeds back so the error can be fixed in-flow.
# Only acts on files inside this repo ($CLAUDE_PROJECT_DIR). The single root
# deno.json carries the import map + config, so every command runs from there.

set -euo pipefail

file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0
case "$file" in "$CLAUDE_PROJECT_DIR"/*) ;; *) exit 0 ;; esac
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.json | *.jsonc) ;;
  *) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR"
deno fmt "$file" >/dev/null 2>&1 || true

problems=""
case "$file" in
  *.ts | *.tsx | *.js | *.jsx)
    if ! out=$(deno lint "$file" 2>&1); then
      problems+="[deno lint]"$'\n'"$out"$'\n\n'
    fi
    ;;
esac
case "$file" in
  *.ts | *.tsx)
    if ! out=$(deno check "$file" 2>&1); then
      problems+="[deno check]"$'\n'"$out"$'\n'
    fi
    ;;
esac

if [ -n "$problems" ]; then
  printf '%s' "$problems" >&2
  exit 2
fi
exit 0
