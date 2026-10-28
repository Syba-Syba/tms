# Threshold, hosted: the self-hosted build in one image. The API serves the web app from the
# same port, so there is one process and no CORS. Build from the repository root:
#   docker build -f deploy/Dockerfile -t threshold .

FROM mirror.gcr.io/library/node:22-bookworm-slim AS build
WORKDIR /app
# The whole tree before installing: the toolbox builds itself as part of npm ci.
COPY . .
RUN npm ci --no-audit --no-fund
RUN npm run build -w @hlonie/toolbox \
 && VITE_API_URL=/ npm run build -w tms-app

FROM mirror.gcr.io/library/node:22-bookworm-slim
ENV NODE_ENV=production \
    APP_MODE=self-hosted \
    HOST=0.0.0.0 \
    PORT=3001 \
    WEB_ROOT=/app/tms/app/dist \
    STORAGE_DIR=/data/storage
WORKDIR /app
# The API runs its TypeScript through tsx, so the image keeps the workspace as built.
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /data/storage && chown node:node /data/storage && chmod +x /usr/local/bin/entrypoint.sh
USER node
WORKDIR /app/tms/api
EXPOSE 3001
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
