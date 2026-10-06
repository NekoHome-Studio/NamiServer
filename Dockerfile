# syntax=docker/dockerfile:1
#
# Nami — self-hosted AI agent server carrier.
#
# Why this image is unusual, and deliberately so:
#
#   * ZERO runtime dependencies. `package.json` declares `dependencies: {}`,
#     so there is intentionally NO `npm install` here — the image carries no
#     node_modules at all. (`typescript` / `@types/node` are dev-only and exist
#     solely for `npm run typecheck` on a workstation.)
#
#   * NO build step and no `dist/`. The server is executed as TypeScript
#     directly through Node's built-in type stripping (`node src/index.ts`),
#     which is why the `.ts` sources are the shipped artifact.
#
#   * Node >= 22.6 is required (type stripping + the built-in `node:sqlite`
#     module). Node 24 is the recommended runtime, hence node:24-alpine.
#
#   * The only writable path is /app/data, which holds the SQLite database.
#
FROM node:24-alpine

# Production mode, plus container-friendly defaults. NAMI_HOST must be
# 0.0.0.0 for a published port to be reachable from outside the container.
ENV NODE_ENV=production \
    NAMI_HOST=0.0.0.0 \
    NAMI_PORT=8787 \
    NAMI_DB_PATH=/app/data/nami.sqlite

WORKDIR /app

# Copy only what the runtime needs. `src/` also carries the static web assets
# (they live under src/, e.g. src/web/) and `scripts/` carries the smoke test,
# so both are covered without a separate COPY per asset.
# No `npm install`, no `npm ci`, no lockfile: there is nothing to install.
COPY package.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Unprivileged runtime user. /app/data is the one path the process writes to,
# and it is declared a volume in docker-compose.yml.
RUN addgroup -S -g 10001 nami \
 && adduser -S -u 10001 -G nami -h /app -s /sbin/nologin nami \
 && mkdir -p /app/data \
 && chown -R nami:nami /app

USER nami

EXPOSE 8787

# Node's built-in fetch is used because alpine ships neither curl nor wget.
# interval/timeout/start-period are generous enough for SQLite WAL setup on a
# cold start. Compose declares an equivalent healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The ExperimentalWarning comes from node:sqlite; it is expected and hidden.
CMD ["node","--disable-warning=ExperimentalWarning","src/index.ts"]
