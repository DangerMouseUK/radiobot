# syntax=docker/dockerfile:1.7
# Radio Bot — reproducible multi-stage build. Pin the base image; bump deliberately.
# The base image is written out in both FROM lines (not an ARG) so Dependabot can propose bumps;
# keep the two the same.
FROM node:24.22.1-trixie-slim AS build
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

FROM node:24.22.1-trixie-slim AS base
# Debian's FFmpeg includes libopus (required) and is LGPL/GPL-licensed; see docs/rights-and-disclaimer.md.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# CI only (`docker build --target test`): the integration tests on the image's own Node and FFmpeg.
# Never published; the runtime image below is built without it.
FROM base AS test
RUN corepack enable && mkdir -p /app && chown node:node /app
WORKDIR /app
USER node
ENV CI=true \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe
COPY --chown=node:node package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-test,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
  pnpm install --frozen-lockfile --ignore-scripts
COPY --chown=node:node tsconfig.json vitest.config.ts ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node catalog ./catalog
COPY --chown=node:node tests ./tests
# Vitest directly, not through pnpm, so the tests can run without a network (`--network none`).
CMD ["./node_modules/.bin/vitest", "run", "tests/integration"]

FROM base AS runtime
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
