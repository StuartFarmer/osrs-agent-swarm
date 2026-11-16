#!/bin/sh
set -eu
# Bind mounts may be created as root; only writable swarm data is assigned to the runtime user.
install -d -o node -g node /app/.local /app/.local/hiscores /app/runs
find /app/.local/hiscores -maxdepth 1 -type f -name 'names.sqlite*' -exec chown node:node {} +
exec gosu node flock --no-fork --nonblock /app/.local/container.lock \
  node --import tsx /app/docker/run.ts "$@"
