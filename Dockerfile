# Every image is pinned by digest, so a build uses exactly what was tested;
# Dependabot proposes updates.

# The UI and the server build side by side. Downloads and compiled
# dependencies live in BuildKit caches that outlast each build, so a change
# rebuilds only what it touched.

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM rust:1-bookworm@sha256:7085845219c18e7c5b1f34ed9ce89b84f822f2e3d54a02774cedc996ac0f304f AS server
WORKDIR /server
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/server/target \
    cargo build --release --locked \
    && cp target/release/server /usr/local/bin/server

FROM cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba AS cloudflared

# Convert's video work: one static ffmpeg and ffprobe, far smaller than
# Debian's package and everything it pulls in.
FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
        ghostscript imagemagick libheif-examples \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /data app \
    && mkdir -p /data \
    && chown app /data
# ImageMagick reads and writes only the photo formats Convert uses.
COPY server/imagemagick-policy.xml /etc/ImageMagick-6/policy.xml
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=server /usr/local/bin/server /usr/local/bin/server
COPY --from=ui /ui/dist /app/ui
ENV DATA_DIR=/data \
    UI_DIR=/app/ui \
    ADMIN_ADDR=0.0.0.0:7070 \
    GATE_ADDR=127.0.0.1:7080 \
    UPSTREAM_HOST=host.docker.internal
USER app
VOLUME /data
EXPOSE 7070
ENTRYPOINT ["/usr/local/bin/server"]
