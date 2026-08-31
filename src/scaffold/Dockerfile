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

# the mu CLI ships with core — the project carries no runnable code
RUN deno install -gArf jsr:@mu/core/mu

WORKDIR /app
COPY . .

VOLUME /data
ENTRYPOINT ["./entrypoint.sh"]
