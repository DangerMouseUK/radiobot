# syntax=docker/dockerfile:1.7
# Radio Bot — reproducible multi-stage build. Pin the base image; bump deliberately.
ARG NODE_IMAGE=node:24.22.1-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: the ffmpeg-static dev dependency's download is only for local tests.
# pnpm's store (its default path for root) is a BuildKit cache, so rebuilds don't download every
# package again. Only the build stage sees it; the image gets the same node_modules as before.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm run build && pnpm prune --prod --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
# Debian's FFmpeg includes libopus (required) and is LGPL/GPL-licensed; see docs/rights-and-disclaimer.md.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/radio-bot.sqlite \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY catalog ./catalog
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
LABEL org.opencontainers.image.title="Radio Bot" \
      org.opencontainers.image.description="Unofficial, self-hosted Discord internet-radio bot" \
      org.opencontainers.image.licenses="MIT"
# At the lowest CPU priority, so the check can't delay voice packets on a one-core host.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD ["nice", "-n", "19", "node", "dist/scripts/healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
