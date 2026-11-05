# Test-only upstream MinIO, not a product runtime or a published image.
# Official release identity:
# https://github.com/minio/minio/releases/tag/RELEASE.2025-09-07T16-13-09Z
# Official Go image manifest:
# https://hub.docker.com/v2/repositories/library/golang/tags/1.24.7-alpine3.22
FROM golang:1.24.7-alpine3.22@sha256:fc2cff6625f3c1c92e6c85938ac5bd09034ad0d4bc2dfb08278020b68540dbb5 AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=readonly
WORKDIR /src
RUN wget -O /tmp/minio.tar.gz https://codeload.github.com/minio/minio/tar.gz/07c3a429bfed433e49018cb0f78a52145d4bedeb \
    && echo '8819e3e7817e46b7b3798f8f200ead208562e571563c2e040352378031abe9f2  /tmp/minio.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/minio.tar.gz --strip-components=1 -C /src \
    && mkdir /out \
    && go build -p 2 -trimpath -buildvcs=false -o /out/minio .

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="07c3a429bfed433e49018cb0f78a52145d4bedeb" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.dovspace.ci.fixture="test-only-minio"
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /licenses/minio-LICENSE
# Retain the corresponding original source in this disposable local fixture.
COPY --from=build /tmp/minio.tar.gz /usr/share/minio-source/minio.tar.gz
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV HOME=/tmp MINIO_BROWSER=off MINIO_UPDATE=off
USER 1000:1000
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/minio"]
