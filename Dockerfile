# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-debian AS bun
FROM node:24.22.3-bookworm-slim AS swarm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git procps ffmpeg python3 chromium xvfb x11-utils \
    x11vnc novnc websockify openbox gosu util-linux fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium \
    SWARM_CONTAINER=1 \
    DISPLAY=:99
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Fetch only the pinned public revision; host .git, saves and credentials stay out of the image.
RUN git init vendor/rs-sdk \
    && git -C vendor/rs-sdk remote add origin https://github.com/MaxBittker/rs-sdk.git \
    && git -C vendor/rs-sdk fetch --depth 1 origin 3aa493c3d26680df5bae2b475cc1805e3db05ae3 \
    && git -C vendor/rs-sdk checkout --detach FETCH_HEAD
# The harness imports this checkout's SDK, separately from the prepared game copy.
RUN bun install --cwd vendor/rs-sdk --frozen-lockfile
COPY . .
RUN node --import tsx docker/build-world.ts \
    && npm run check \
    && chown -R node:node /opt/swarm-world /app/.local

EXPOSE 6080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
CMD []

# Keep the viewer's React/toolchain dependencies out of the running game image.
FROM node:20-bookworm-slim AS viewer
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY scripts/viewer-revision.txt scripts/prepare-viewer.mjs /build-tools/
RUN git init /viewer \
    && git -C /viewer remote add origin https://github.com/MaxBittker/rs-world.git \
    && git -C /viewer fetch --depth 1 origin "$(cat /build-tools/viewer-revision.txt)" \
    && git -C /viewer checkout --detach FETCH_HEAD
WORKDIR /viewer
RUN yarn install --frozen-lockfile --ignore-scripts \
    && node /build-tools/prepare-viewer.mjs /viewer
COPY --from=swarm /opt/swarm-world/game/server/engine/data/pack /engine-pack
RUN bun scripts/sync-rs-sdk-cache.ts --pack /engine-pack --revision 289 \
    && CI=false PUBLIC_URL=/viewer GENERATE_SOURCEMAP=false yarn build \
    && cp -r caches build/caches \
    && cp LICENSE build/UPSTREAM-LICENSE.txt \
    && cp /build-tools/viewer-revision.txt build/UPSTREAM-REVISION.txt

FROM swarm
COPY --from=viewer /viewer/build /opt/swarm-viewer
ENV SWARM_VIEWER_DIR=/opt/swarm-viewer
