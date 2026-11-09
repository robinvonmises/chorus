# Version von signal-cli (https://github.com/AsamK/signal-cli/releases)
ARG SIGNAL_CLI_VERSION=0.14.10

# ---------- Oberfläche bauen ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

# ---------- Server bauen ----------
FROM node:22-bookworm-slim AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --ignore-scripts
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- signal-cli (Signal-Anbindung) ----------
# x86_64: native Version (ohne Java)
FROM debian:bookworm-slim AS signal-amd64
ARG SIGNAL_CLI_VERSION
ADD https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz /tmp/sc.tgz
RUN mkdir -p /opt/signal-cli/bin && tar -xzf /tmp/sc.tgz -C /opt/signal-cli/bin && chmod +x /opt/signal-cli/bin/signal-cli && rm /tmp/sc.tgz
# ARM (z. B. Raspberry Pi): Java-Version mit eigener Java-Laufzeit
FROM eclipse-temurin:25-jre AS signal-arm64
ARG SIGNAL_CLI_VERSION
ADD https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz /tmp/sc.tgz
RUN mkdir -p /opt && tar -xzf /tmp/sc.tgz -C /opt && mv /opt/signal-cli-${SIGNAL_CLI_VERSION} /opt/signal-cli && rm /tmp/sc.tgz \
 && cp -r /opt/java/openjdk /opt/jre
FROM signal-${TARGETARCH} AS signal
RUN mkdir -p /opt/jre

# ---------- Laufzeit ----------
FROM node:22-bookworm-slim
# ffmpeg wandelt Sprachnachrichten ins richtige Format
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIR=/app/web/dist \
    SIGNAL_CLI=/opt/signal-cli/bin/signal-cli JAVA_HOME=/opt/jre
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./
COPY --from=web /app/web/dist /app/web/dist
COPY --from=signal /opt/signal-cli /opt/signal-cli
COPY --from=signal /opt/jre /opt/jre
COPY docker-entrypoint.sh /usr/local/bin/
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
