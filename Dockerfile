# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS builder

WORKDIR /src

COPY . .
RUN bun install --frozen-lockfile

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) bun_target="bun-linux-x64-baseline" ;; \
      arm64) bun_target="bun-linux-arm64" ;; \
      *) echo "Unsupported container architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && mkdir -p /out \
    && bun build --compile --minify --target="$bun_target" \
      apps/router/src/main.ts --outfile /out/aihub-auto

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 aihub-auto \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/aihub-auto aihub-auto \
    && install -d -o aihub-auto -g aihub-auto /data

COPY --from=builder --chown=root:root /out/aihub-auto /usr/local/bin/aihub-auto

ENV AIHUB_AUTO_CONFIG_DIR=/data \
    AIHUB_AUTO_HOST=0.0.0.0 \
    AIHUB_AUTO_PORT=8787

USER aihub-auto
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:8787/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/aihub-auto"]
