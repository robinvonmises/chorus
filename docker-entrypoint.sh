#!/bin/sh
# Datenordner gehört beim ersten Start oft root (Docker legt ihn an). Rechte setzen, dann als "node" starten.
set -e
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA_DIR"
  [ "$(stat -c %U "$DATA_DIR")" = node ] || chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
