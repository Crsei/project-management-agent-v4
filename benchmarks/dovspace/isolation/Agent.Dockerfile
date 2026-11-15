FROM node:24.21.0-bookworm
# Caller pins Codex as before. OMP is an optional explicitly supplied standalone
# release binary; no host executable/Home, package manager state or credentials
# enter the image. Review URL/version/digest together before building.
ARG CODEX_VERSION
ARG OMP_URL
ARG OMP_VERSION
ARG OMP_SHA256
RUN test -n "$CODEX_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "@openai/codex@$CODEX_VERSION" \
 && npm cache clean --force \
 && if [ -n "$OMP_URL" ]; then \
      test -n "$OMP_VERSION" && test "${#OMP_SHA256}" = 64 \
      && case "$OMP_URL" in https://*) ;; *) exit 1;; esac \
      && curl --fail --location --proto '=https' --proto-redir '=https' "$OMP_URL" --output /usr/local/bin/omp \
      && printf '%s  /usr/local/bin/omp\n' "$OMP_SHA256" | sha256sum --check --strict \
      && chmod 0755 /usr/local/bin/omp \
      && mkdir -m 0700 /tmp/omp-image-version-home \
      && env -i HOME=/tmp/omp-image-version-home PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/omp --version | /bin/grep -Fx "omp/$OMP_VERSION" \
      && rm -rf /tmp/omp-image-version-home; \
    else test -z "$OMP_VERSION" && test -z "$OMP_SHA256"; fi
ENV NODE_ENV=production
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node"]
