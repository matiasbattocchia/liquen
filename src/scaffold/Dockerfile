# Dockerfile — the org in a box: root runs the system, each agent is a Linux user whose
# $HOME lives on the volume. One mount is the whole deployment:
#
#   docker run --env-file .env -v ./data:/data <image>
#
# config.jsonc ships WITH the image (it is the project, git-tracked); data/ is the org's
# living state and stays on the volume.
FROM denoland/deno:latest

RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl jq acl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# one module cache for the box, at a path every uid can read: the harness fills it (the
# package here at build, the file shims' module at boot) and the agents' shims read it —
# an agent's uid has no cache of its own and no road to the registry (the egress proxy)
ENV DENO_DIR=/deno-dir
RUN deno install && chmod -R a+rX /deno-dir

VOLUME /data
ENTRYPOINT ["./entrypoint.sh"]
