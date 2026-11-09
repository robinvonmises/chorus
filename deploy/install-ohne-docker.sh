#!/usr/bin/env bash
# Chorus ohne Docker installieren (Debian/Ubuntu, x86_64 oder arm64), z. B. in einem LXC-Container.
# Aufruf als root im Quellordner:  bash deploy/install-ohne-docker.sh
# Erneut ausführen = Update. Daten liegen in /var/lib/inbox und bleiben erhalten.
set -euo pipefail

PORT="${PORT:-8080}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
SIGNAL_CLI_VERSION="${SIGNAL_CLI_VERSION:-0.14.10}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/inbox
DATA=/var/lib/inbox

[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen."; exit 1; }
ARCH="$(uname -m)"

echo "==> Pakete (ffmpeg, Caddy für HTTPS)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Dienste beim Installieren nicht starten (Caddy würde sonst Port 80 belegen wollen, z. B. neben nginx)
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils tar ffmpeg caddy >/dev/null
rm -f /usr/sbin/policy-rc.d

echo "==> Node.js 22"
if ! /opt/node/bin/node -v 2>/dev/null | grep -q '^v22'; then
  case "$ARCH" in x86_64) NA=x64 ;; aarch64) NA=arm64 ;; *) echo "Architektur $ARCH nicht unterstützt"; exit 1 ;; esac
  FILE="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk "/linux-$NA.tar.xz/ {print \$2}")"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$FILE" -o /tmp/node.tar.xz
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz
fi
export PATH=/opt/node/bin:$PATH

echo "==> signal-cli $SIGNAL_CLI_VERSION"
if ! /opt/signal-cli/bin/signal-cli --version 2>/dev/null | grep -q "$SIGNAL_CLI_VERSION"; then
  rm -rf /opt/signal-cli && mkdir -p /opt/signal-cli/bin
  if [ "$ARCH" = x86_64 ]; then
    curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v$SIGNAL_CLI_VERSION/signal-cli-$SIGNAL_CLI_VERSION-Linux-native.tar.gz" | tar -xz -C /opt/signal-cli/bin
    chmod +x /opt/signal-cli/bin/signal-cli
  else
    apt-get install -y -qq --no-install-recommends openjdk-25-jre-headless >/dev/null || apt-get install -y -qq --no-install-recommends default-jre-headless >/dev/null
    curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v$SIGNAL_CLI_VERSION/signal-cli-$SIGNAL_CLI_VERSION.tar.gz" | tar -xz -C /opt/signal-cli --strip-components=1
  fi
fi

echo "==> App bauen (dauert ein paar Minuten)"
id inbox >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin inbox
mkdir -p "$APP" "$DATA"
(cd "$SRC/web" && npm ci --ignore-scripts --no-audit --no-fund && npm run build)
(cd "$SRC/server" && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm prune --omit=dev)
rm -rf "$APP/server" "$APP/web"
mkdir -p "$APP/server" "$APP/web"
cp -r "$SRC/server/dist" "$SRC/server/node_modules" "$SRC/server/package.json" "$APP/server/"
cp -r "$SRC/web/dist" "$APP/web/"
chown -R inbox:inbox "$DATA"

echo "==> Dienst einrichten"
cat > /etc/systemd/system/inbox.service <<EOF
[Unit]
Description=Chorus (Telegram, Signal, WhatsApp)
After=network-online.target
Wants=network-online.target

[Service]
User=inbox
WorkingDirectory=$APP/server
Environment=NODE_ENV=production PORT=$PORT HOST=0.0.0.0 DATA_DIR=$DATA WEB_DIR=$APP/web/dist
Environment=SIGNAL_CLI=/opt/signal-cli/bin/signal-cli PATH=/opt/node/bin:/usr/bin:/bin
ExecStart=/opt/node/bin/node dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
{
	auto_https disable_redirects
}

:$HTTPS_PORT {
	tls internal {
		on_demand
	}
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF

systemctl daemon-reload
systemctl enable --now inbox >/dev/null
systemctl restart inbox caddy

sleep 3
if curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null; then
  IP="$(hostname -I | awk '{print $1}')"
  echo
  echo "Fertig. Chorus läuft:"
  echo "  https://$IP:$HTTPS_PORT   (empfohlen, Zertifikatswarnung einmal bestätigen)"
  echo "  http://$IP:$PORT"
else
  echo "Chorus antwortet nicht. Log: journalctl -u inbox -n 50"; exit 1
fi
