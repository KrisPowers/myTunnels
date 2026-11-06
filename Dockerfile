ARG CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest
# Convert's video work: one static ffmpeg and ffprobe, far smaller than
# Debian's package and everything it pulls in.
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:9.0.2-1

# The UI and the server build side by side. Downloads and compiled
# dependencies live in BuildKit caches that outlast each build, so a change
# rebuilds only what it touched.

FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /server
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/server/target \
    cargo build --release --locked \
    && cp target/release/server /usr/local/bin/server

FROM ${CLOUDFLARED_IMAGE} AS cloudflared

FROM ${FFMPEG_IMAGE} AS ffmpeg

FROM debian:bookworm-slim
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
