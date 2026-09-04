#!/bin/sh
# entrypoint — give Linux to the agents. Root supervises; each agent in the roster is a
# Linux user whose $HOME is its folder on the volume. Idempotent: every step converges
# on the same state, so restarts and roster edits are safe.
set -eu

# the single volume: the project addresses ./data, the container mounts /data. The link
# replaces an empty folder and refuses a populated one — state baked into the image would
# otherwise shadow the volume.
rmdir /app/data 2>/dev/null || true
ln -sfnT /data /app/data

# one Linux user per agent. The uid is pinned by NAME (a hash, probed past collisions),
# so file ownership on the volume survives rebuilds and roster edits alike.
agents=$(deno eval --quiet '
  import { parse } from "jsr:@std/jsonc@1";
  const c = parse(Deno.readTextFileSync("/app/config.jsonc"));
  console.log(Object.keys(c.agents ?? {}).join("\n"));
')
getent group agents >/dev/null || groupadd agents
for a in $agents; do
  uid=$((20000 + $(printf %s "$a" | cksum | cut -d' ' -f1) % 10000))
  while getent passwd "$uid" >/dev/null && [ "$(getent passwd "$uid" | cut -d: -f1)" != "$a" ]; do
    uid=$((uid + 1))
  done
  getent passwd "$a" >/dev/null || useradd -u "$uid" -g agents -M -d "/home/$a" -s /bin/bash "$a"
  mkdir -p "/data/agents/$a"
  ln -sfn "/data/agents/$a" "/home/$a" # the agent's $HOME IS its workspace on the volume
  chown -R "$a:agents" "/data/agents/$a"
  chmod 700 "/data/agents/$a" # personal: the agent's own, invisible to its peers
done

# the data classification:
#   log/    root only — the substrate is the system's, no agent reads it directly
#   org/    the shared floor — group-writable, setgid + default ACL keep it shared
#   system/ the harness's docs — readable by all, writable by none
mkdir -p /data/log /data/org /data/system
chown -R root:root /data/log
chmod 700 /data/log
chown -R root:agents /data/org
chmod -R 2775 /data/org
setfacl -R -d -m g:agents:rwX /data/org
chmod -R a-w,a+rX /data/system

exec mu start
