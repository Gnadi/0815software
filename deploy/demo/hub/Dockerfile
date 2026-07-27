# The demo hub page. Build from the repository ROOT:
#   docker build -f deploy/demo/hub/Dockerfile -t demo-hub .
# The root context is required because the hub derives its card grid from
# modules/registry.json (via modules/registry.mjs) rather than duplicating it.
FROM node:22-alpine
WORKDIR /app
COPY modules/registry.json modules/registry.mjs /app/modules/
COPY deploy/demo/hub/server.mjs /app/deploy/demo/hub/
ENV PORT=8080
CMD ["node", "deploy/demo/hub/server.mjs"]
