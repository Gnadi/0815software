# Image template for a demo business app (module). Build from the repo ROOT:
#   docker build -f deploy/demo/module.Dockerfile --build-arg MODULE=mod-04-invoice-billing -t demo-invoicing .
# docker-compose.yml passes MODULE per app.
#
# It builds the module's web UI (Vite → dist/client) and its compiled server
# (tsc → dist/server), then runs the compiled server — which serves the built
# SPA and the API from one origin, exactly as `demo/serve.mjs` does locally.
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

# Demo databases are ephemeral (compose mounts /data as tmpfs), so a restart
# resets the whole demo to its freshly-seeded state.
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/data.db

CMD ["node", "dist/server/server/index.js"]
