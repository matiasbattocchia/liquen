#!/bin/sh
# entrypoint — the container's one step before the org runs. Root supervises, and boot
# gives Linux to the agents: each agent in the roster is a Linux user whose $HOME is its
# folder on the volume, made from the store's rows at every start, and the data root gets
# its owners and modes (log/ root's, shared/ the agents' group's, system/ read-only).
# What is the org's own to do before it runs goes here, above the last line.
set -eu

# the single volume: the project addresses ./data, the container mounts /data. The link
# replaces an empty folder and refuses a populated one — state baked into the image would
# otherwise shadow the volume.
rmdir /app/data 2>/dev/null || true
ln -sfnT /data /app/data

exec deno task start
