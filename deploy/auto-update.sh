#!/usr/bin/env bash
# Chorus automatisch aktualisieren (läuft per systemd-Timer, siehe auto-update-einrichten.sh)
#
# Ablauf:
#  1. Schaut auf GitHub nach, ob es auf "main" einen neuen Stand gibt.
#  2. Wartet, bis GitHub das fertige Docker-Image dazu gebaut hat (ghcr.io …:sha-<commit>).
#     Schlägt der Build bei GitHub fehl, gibt es kein Image – dann bleibt einfach alles, wie es ist.
#  3. Holt das Image, aktualisiert die Dateien im Ordner (nur die aus dem Repo) und startet Chorus neu.
#  4. Wird Chorus nicht innerhalb von 4 Minuten "healthy", geht es automatisch zurück auf den alten Stand.
#     Dieser Commit wird dann nicht noch einmal versucht (erst der nächste, oder von Hand mit --force).
#
# Unangetastet bleiben: data/ (Tresor, Datenbank, Dateien), .env und alle anderen Dateien,
# die nicht im Repo liegen (z. B. data.bak-*). Es wird nie "git clean" ausgeführt.
#
# Aufruf von Hand:  bash deploy/auto-update.sh           (nur wenn es etwas Neues gibt)
#                   bash deploy/auto-update.sh --force   (aktuellen Stand von main auf jeden Fall einspielen)

main() {
  set -euo pipefail
  local DIR BRANCH IMAGE SERVICE FORCE=0
  DIR="${CHORUS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  BRANCH="${CHORUS_BRANCH:-main}"
  IMAGE="${CHORUS_IMAGE:-ghcr.io/robinvonmises/chorus}"
  SERVICE="${CHORUS_SERVICE:-chorus}"
  [ "${1:-}" = "--force" ] && FORCE=1
  cd "$DIR"

  # Nie zweimal gleichzeitig
  exec 9>"/tmp/chorus-auto-update.lock"
  flock -n 9 || { log "Läuft schon – übersprungen"; return 0; }

  git fetch -q origin "$BRANCH"
  local OLD NEW SHORT
  OLD=$(git rev-parse HEAD)
  NEW=$(git rev-parse "origin/$BRANCH")
  if [ "$OLD" = "$NEW" ] && [ "$FORCE" = 0 ]; then return 0; fi
  SHORT=${NEW:0:7}
  local FAILED_MARK=.git/chorus-update-fehlgeschlagen WAIT_MARK=.git/chorus-update-wartet
  if [ "$FORCE" = 0 ] && [ "$(cat "$FAILED_MARK" 2>/dev/null)" = "$NEW" ]; then
    return 0   # dieser Stand ist schon einmal gescheitert – erst der nächste Commit wird wieder versucht
  fi

  if ! docker pull -q "$IMAGE:sha-$SHORT" >/dev/null 2>&1; then
    [ "$(cat "$WAIT_MARK" 2>/dev/null)" = "$NEW" ] && return 0   # nur einmal ins Protokoll schreiben
    echo "$NEW" > "$WAIT_MARK"
    log "Image für $SHORT gibt es (noch) nicht – GitHub baut vermutlich noch oder der Build ist fehlgeschlagen. Alter Stand bleibt, nächster Versuch beim nächsten Lauf."
    return 0
  fi
  log "Neuer Stand ${OLD:0:7} → $SHORT, Image ist da, spiele ein"
  rm -f "$WAIT_MARK"

  # Aktuell laufendes Image merken, für den Rückweg
  local PREV_IMG
  PREV_IMG=$(docker inspect -f '{{.Image}}' "$SERVICE" 2>/dev/null || true)
  [ -n "$PREV_IMG" ] && docker tag "$PREV_IMG" "$IMAGE:vorher"

  git reset -q --hard "$NEW"
  docker tag "$IMAGE:sha-$SHORT" "$IMAGE:latest"

  if docker compose up -d --no-build "$SERVICE" && wait_healthy "$SERVICE"; then
    log "Chorus läuft jetzt auf $SHORT"
    docker rmi "$IMAGE:sha-$SHORT" >/dev/null 2>&1 || true   # nur das Etikett, das Image bleibt als :latest
    docker image prune -f >/dev/null 2>&1 || true            # alte, unbenutzte Images aufräumen
    return 0
  fi

  log "FEHLER: $SHORT startet nicht sauber – zurück auf ${OLD:0:7}. Dieser Stand wird nicht noch einmal versucht."
  echo "$NEW" > "$FAILED_MARK"
  git reset -q --hard "$OLD"
  if [ -n "$PREV_IMG" ]; then
    docker tag "$IMAGE:vorher" "$IMAGE:latest"
    docker compose up -d --no-build "$SERVICE" || true
  fi
  return 1
}

log() { echo "[chorus-update] $*"; }

# Wartet, bis der Healthcheck des Containers "healthy" meldet (max. 4 Minuten)
wait_healthy() {
  local s i
  for i in $(seq 1 48); do
    sleep 5
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo fehlt)
    case "$s" in
      healthy) return 0 ;;
      unhealthy|exited|dead|fehlt) log "Zustand: $s"; return 1 ;;
    esac
  done
  log "Zeitüberschreitung, Zustand: $s"
  return 1
}

main "$@"
exit $?
