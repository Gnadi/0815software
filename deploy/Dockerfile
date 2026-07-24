# Shared image template for every Platform Service.
# Build (from the repository root) with:
#   docker build -f deploy/Dockerfile --build-arg SERVICE=ps-01-identity -t ps-01 .
# docker-compose.yml passes SERVICE per service.

FROM node:22-alpine

ARG SERVICE
WORKDIR /app

COPY platform/${SERVICE}/package.json platform/${SERVICE}/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY platform/${SERVICE}/ ./
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
# Databases (and backups) live on the mounted volume.
ENV DATABASE_PATH=/data/data.db
ENV BACKUP_DIR=/data/backups

CMD ["npm", "start"]
