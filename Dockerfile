# topdown-city (gta-2): the authoritative WebSocket game server, which also
# serves the built client on the same port (CLIENT_DIR). One origin behind the
# edge TLS proxy at https://gta.mich312.com — the browser speaks wss:// there.
#
#   docker build -t gta-2 .
#   docker run -p 8080:8080 -v ./data:/app/data gta-2
FROM node:24-slim AS build
RUN npm install -g pnpm@10.10.0
WORKDIR /app
# Manifests first so the dependency layer caches across source changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN pnpm install --frozen-lockfile
# Sources, then build. `pnpm build` covers all three packages: shared+server
# via `tsc -b`, client via Vite.
COPY . .
RUN pnpm build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CLIENT_DIR=/app/client/dist \
    PERSIST_PATH=/app/data/persist.db \
    REPLAY=0
# Copy the whole built tree: preserves pnpm's relative node_modules symlinks,
# the compiled server/shared dist, the client bundle, and shared/data tunables.
# Runtime state (SQLite) lives on the mounted /app/data volume.
COPY --from=build /app /app
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
