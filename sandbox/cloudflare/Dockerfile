# An agent's ground on Cloudflare (DESIGN §9): the Sandbox SDK's runtime — its tag is the
# npm package's version, the two move together — plus the tools an agent's bash expects
# and the harness's own binaries.
FROM docker.io/cloudflare/sandbox:0.12.10

RUN apt-get update && apt-get install -y --no-install-recommends \
    tar git curl wget ripgrep fd-find jq procps sed gawk ca-certificates \
    && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# fusermount finds the active mounts through /etc/mtab, which the base image lacks
RUN ln -sf /proc/mounts /etc/mtab

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python
RUN uv python install 3.13 \
    && ln -s "$(uv python find 3.13)" /usr/local/bin/python3 \
    && ln -s /usr/local/bin/python3 /usr/local/bin/python

COPY --from=docker.io/denoland/deno:bin-2.9.6 /deno /usr/local/bin/deno

# aread · awrite · aedit · fetch, the package's binaries at the version named here, run
# out of a module cache filled at build: the shims never fetch their own code, and an
# agent's scripts keep a cache of their own
ARG LIQUEN_VERSION=0.1.56
ENV LIQUEN_DENO_DIR=/opt/liquen/deno
RUN set -eu; \
    base="https://jsr.io/@liquen/liquen/${LIQUEN_VERSION}/src/bin"; \
    DENO_DIR="$LIQUEN_DENO_DIR" deno cache "$base/afs.ts" "$base/fetch.ts"; \
    chmod -R a+rX /opt/liquen; \
    for pair in aread:read awrite:write aedit:edit; do \
      name="${pair%%:*}"; verb="${pair#*:}"; \
      printf '#!/bin/sh\nexec env DENO_DIR=%s deno run --cached-only --allow-read --allow-write %s %s "$@"\n' \
        "$LIQUEN_DENO_DIR" "$base/afs.ts" "$verb" > "/usr/local/bin/$name"; \
    done; \
    printf '#!/bin/sh\nexec env DENO_DIR=%s deno run --cached-only --allow-net --allow-env --allow-read --allow-write %s "$@"\n' \
      "$LIQUEN_DENO_DIR" "$base/fetch.ts" > /usr/local/bin/fetch; \
    chmod 755 /usr/local/bin/aread /usr/local/bin/awrite /usr/local/bin/aedit /usr/local/bin/fetch

# the agent's home is the workspace, owned by an unprivileged user every exec runs as
RUN mkdir -p /workspace \
    && useradd -m -s /bin/bash -d /home/sandbox sandbox \
    && chown sandbox:sandbox /workspace \
    && chmod 700 /root

USER sandbox
WORKDIR /workspace
