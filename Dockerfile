# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-debian AS bun
FROM node:24.22.3-bookworm-slim

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
COPY . .
RUN node --import tsx docker/build-world.ts \
    && npm run check \
    && chown -R node:node /opt/swarm-world /app/.local

EXPOSE 6080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
CMD []
