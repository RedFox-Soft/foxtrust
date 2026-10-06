# FoxTrust image. By default it runs the scheduler: feed ingestion on Bun.cron, nightly retention
# and, with a signing key, the snapshot jobs (`foxtrust schedule`). docker-compose.yml also runs
# it as `publication serve` and `verify serve`. Docker keeps it running (restart policy), and
# the healthcheck below reports a hung scheduler through the heartbeat file it rewrites every minute.
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

# New named volumes take the owner of these directories, so the scheduler can write to them.
RUN mkdir -p /app/var/publication /app/var/snapshots /app/var/verify && chown -R bun:bun /app/var
USER bun
VOLUME /app/var

HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD test -f /app/var/heartbeat && [ $(( $(date +%s) - $(stat -c %Y /app/var/heartbeat) )) -lt 180 ]

CMD ["sh", "-c", "bun run src/cli/main.ts db migrate && exec bun run src/cli/main.ts schedule --init-config config/scoring/2026-10-06.1.json --heartbeat /app/var/heartbeat"]
