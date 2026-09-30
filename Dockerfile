# FoxTrust scheduler: feed ingestion on Bun.cron plus nightly retention (`foxtrust schedule`).
# Docker keeps it running (restart policy in docker-compose.yml) and the healthcheck below
# reports a hung scheduler through the heartbeat file it rewrites every minute.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY db ./db
COPY config ./config
# Licence records are the input of the ingestion licence gate (FR-014). Rebuild after editing them.
COPY docs/wiki/entities ./docs/wiki/entities

RUN mkdir -p /app/var && chown bun:bun /app/var
USER bun
VOLUME /app/var

HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD test -f /app/var/heartbeat && [ $(( $(date +%s) - $(stat -c %Y /app/var/heartbeat) )) -lt 180 ]

CMD ["sh", "-c", "bun run src/cli/main.ts db migrate && exec bun run src/cli/main.ts schedule --init-config config/scoring/2026-09-24.1.json --heartbeat /app/var/heartbeat"]
