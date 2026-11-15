# Build context contains ONLY this reviewed Dockerfile and the explicit omp ELF artifact.
# BASE_IMAGE is the inspected immutable Codex/Bubblewrap Agent image ID, never a mutable tag.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
ARG BASE_IMAGE
ARG OMP_SHA256
ARG OMP_VERSION
COPY omp /usr/local/bin/omp
RUN chmod 0755 /usr/local/bin/omp \
 && case "$BASE_IMAGE" in sha256:*) ;; *) exit 1;; esac \
 && test "${#OMP_SHA256}" = 64 && test -n "$OMP_VERSION" \
 && printf '%s  /usr/local/bin/omp\n' "$OMP_SHA256" | sha256sum --check --strict \
 && mkdir -m 0700 /tmp/omp-image-version-home \
 && env -i HOME=/tmp/omp-image-version-home PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/omp --version > /tmp/omp-image-version \
 && /bin/grep -Fx "omp/$OMP_VERSION" /tmp/omp-image-version \
 && rm -rf /tmp/omp-image-version-home /tmp/omp-image-version
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node"]
