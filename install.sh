#!/bin/sh
# Puts the liquen command on this machine, and Deno first when it is missing. Given a folder
# name, it also makes the org there, adds you to its roster and stores your API key.
#
#   curl -fsSL https://raw.githubusercontent.com/matiasbattocchia/liquen/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/matiasbattocchia/liquen/main/install.sh | sh -s -- myorg
#
# Every step keeps what an earlier run made, so running it again is safe. The questions are
# asked on the terminal, since the script itself arrives on stdin; with no terminal they
# are skipped.
set -eu

org="${1:-}"
path0="$PATH"
bin="${DENO_INSTALL_ROOT:-$HOME/.deno}/bin"
export PATH="${DENO_INSTALL:-$HOME/.deno}/bin:$bin:$PATH"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'liquen: %s\n' "$*" >&2
  exit 1
}
tty() { (: </dev/tty) 2>/dev/null; }
ask() {
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
}

if ! command -v deno >/dev/null 2>&1; then
  say "Installing Deno"
  curl -fsSL https://deno.land/install.sh | sh -s -- -y
fi
major=$(deno --version | sed -n 's/^deno \([0-9][0-9]*\)\..*/\1/p')
[ "${major:-0}" -ge 2 ] || fail "liquen needs Deno 2 or newer: run deno upgrade"

say "Installing the liquen command"
deno install -g -A -f -q --reload=jsr:@liquen/liquen -n liquen jsr:@liquen/liquen/liquen
deno install -g -A -f -q -n lq jsr:@liquen/liquen/liquen

if ! PATH="$path0" command -v liquen >/dev/null 2>&1; then
  say "liquen is in $bin. Open a new terminal, or add that folder to your PATH."
fi

if [ -z "$org" ]; then
  say "Done. Make an org with: deno run -A jsr:@liquen/liquen/init myorg"
  exit 0
fi

if [ -f "$org/config.jsonc" ]; then
  say "$org is already an org"
else
  say "Making the org in $org"
  deno run -A --reload=jsr:@liquen/liquen jsr:@liquen/liquen/init "$org"
fi

if tty && [ -z "$(ls -A "$org/data/agents" 2>/dev/null)" ]; then
  me=$(id -un | tr 'A-Z' 'a-z')
  printf '%s\n' "$me" | grep -Eq '^[a-z][a-z0-9-]{0,30}$' || me=""
  ask "Your name on the roster${me:+ [$me]}: "
  name="${answer:-$me}"
  if [ -n "$name" ]; then liquen --dir "$org" agent "$name"; fi
fi

if ! grep -Eq '^(ANTHROPIC|GEMINI)_API_KEY=.' "$org/.env" 2>/dev/null; then
  key=""
  if tty; then
    trap 'stty echo </dev/tty' EXIT
    stty -echo </dev/tty
    ask "Anthropic API key (Enter to skip): "
    stty echo </dev/tty
    printf '\n' >/dev/tty
    key="$answer"
  fi
  if [ -n "$key" ]; then
    printf 'ANTHROPIC_API_KEY=%s\n' "$key" >>"$org/.env"
  else
    say "Put ANTHROPIC_API_KEY=sk-ant-... in $org/.env before you start."
  fi
fi

say ""
if [ -z "$(ls -A "$org/data/agents" 2>/dev/null)" ]; then
  say "Add yourself to the roster, then talk to your agent:"
  say "  cd $org && liquen agent <you> && liquen repl"
else
  say "Ready. Talk to your agent:"
  say "  cd $org && liquen repl"
fi
