# The demo hub page. Build from deploy/demo/hub/.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
ENV PORT=8080
CMD ["node", "server.mjs"]
