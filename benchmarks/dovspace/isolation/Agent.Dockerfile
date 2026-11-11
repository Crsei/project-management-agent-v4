FROM node:24.21.0-bookworm
# Caller must pin and review an exact native Codex release; no host CLI/Home copied.
ARG CODEX_VERSION
RUN test -n "$CODEX_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "@openai/codex@$CODEX_VERSION" \
 && npm cache clean --force
ENV NODE_ENV=production
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node"]
