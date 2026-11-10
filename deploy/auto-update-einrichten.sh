#!/usr/bin/env bash
# Richtet die automatischen Updates einmalig ein (als root im Chorus-Ordner ausführen, z. B. /opt/inbox).
# Danach prüft der Server alle 5 Minuten selbst, ob es auf GitHub einen neuen Stand gibt.
#   Status:    systemctl list-timers chorus-update.timer
#   Protokoll: journalctl -u chorus-update -n 50
#   Abschalten: systemctl disable --now chorus-update.timer
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -d "$DIR/.git" ] || { echo "Der Ordner $DIR ist noch kein Git-Klon (siehe README → Automatische Updates)."; exit 1; }

cat > /etc/systemd/system/chorus-update.service <<UNIT
[Unit]
Description=Chorus: neuen Stand von GitHub holen und einspielen
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/usr/bin/env bash $DIR/deploy/auto-update.sh
TimeoutStartSec=20min
UNIT

cat > /etc/systemd/system/chorus-update.timer <<'UNIT'
[Unit]
Description=Chorus alle 5 Minuten auf Updates prüfen

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now chorus-update.timer
echo "Fertig. Automatische Updates sind an:"
systemctl list-timers chorus-update.timer --no-pager | head -3
