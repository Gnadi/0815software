# Production image template for a Business Module. Build from the repo ROOT:
#   docker build -f deploy/module.Dockerfile --build-arg MODULE=mod-04-invoice-billing -t mod-04 .
# A generated customer stack (deploy/provision.mjs) passes MODULE per module.
#
# It builds the module's web UI (Vite → dist/client) and its compiled server
# (tsc → dist/server), then runs the compiled server, which serves the built SPA
# and the API from one origin.
#
# This is the PRODUCTION counterpart of deploy/demo/module.Dockerfile. The
# differences are deliberate: the database lives on a mounted volume rather
# than tmpfs (so it survives a restart), no demo data is staged, and
# NODE_ENV=production is set — which arms every module's boot guard, so the
# container refuses to start on a default secret.
FROM node:22-alpine

ARG MODULE
WORKDIR /app

# Every module depends on @0815software/platform-clients through a file: link
# (install-links). From /app that link resolves to /platform/clients, so the
# clients package must sit there — already built — before the module installs.
COPY platform/clients /platform/clients
RUN cd /platform/clients && npm ci --no-audit --no-fund && npm run build

# Install, build the UI + server, then drop dev dependencies.
COPY modules/${MODULE}/ ./
RUN npm ci --no-audit --no-fund \
 && npx vite build \
 && npx tsc -p tsconfig.server.json \
 && npm prune --omit=dev

ENV NODE_ENV=production
# The database (and anything else the module persists: documents, exports,
# uploads) lives on the mounted volume — see the generated docker-compose.yml.
ENV DATABASE_PATH=/data/data.db
# `npm run backup` writes here, on the same volume; deploy/backup.sh drives it.
ENV BACKUP_DIR=/data/backups

CMD ["node", "dist/server/server/index.js"]
