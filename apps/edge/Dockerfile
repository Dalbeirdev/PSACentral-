# Standard PSA Edge image — one image for every client deployment.
# Per-client configuration comes from the deployment package, never from a custom build.
#
#   docker build -t psacc/psa-edge:0.1.0 --build-arg VERSION=0.1.0 apps/edge

FROM golang:1.25-alpine AS build
ARG VERSION=0.0.0-dev
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
RUN go vet ./... \
 && go test ./... \
 && go build -ldflags "-s -w -X main.Version=${VERSION}" -o /out/bin/psa-edge ./cmd/psa-edge \
 && cd /out/bin && for c in edge-migrate edge-api edge-worker edge-agent; do ln -s psa-edge "$c"; done \
 && mkdir -p /out/var/log/psa-edge /out/var/backups/psa-edge /out/var/lib/psa-edge-agent /out/etc/psa-edge

# Distroless: no shell, no package manager; static binary only.
FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="psa-edge" \
      org.opencontainers.image.description="PSA Edge appliance: edge-migrate, edge-api (local admin UI), edge-worker, edge-agent" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.vendor="PSA Control Center"
COPY --from=build /out/bin/ /usr/local/bin/
COPY --from=build --chown=10001:10001 /out/var/ /var/
COPY --from=build /out/etc/ /etc/
USER 10001:10001
EXPOSE 8480
ENTRYPOINT []
CMD ["/usr/local/bin/psa-edge", "version"]
