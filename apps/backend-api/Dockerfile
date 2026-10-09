# syntax=docker/dockerfile:1.7
# backend-api images, built from the repository root (D-103):
#   docker build -f apps/backend-api/Dockerfile --target runtime -t nexlegtiq-backend-api .
#   docker build -f apps/backend-api/Dockerfile --target migrate -t nexlegtiq-migrate .
# runtime: the HTTP API (default command) and the worker (`node --enable-source-maps worker.js`): one image, two commands.
# migrate: one-off `prisma migrate deploy` + reference data (plans), run with the migrator role before each rollout.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# CI=true also skips the git-hook installer (`prepare`, D-094).
ENV CI=true NX_DAEMON=false NX_NO_CLOUD=true npm_config_store_dir=/pnpm-store
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --offline
# Bundles main.js + worker.js and writes a pruned package.json/lockfile next to them (project.json `prune`).
RUN pnpm nx run backend-api:prune --skip-nx-cache
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    cd apps/backend-api/dist && pnpm install --prod --frozen-lockfile --config.package-import-method=copy

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 METRICS_HOST=0.0.0.0
WORKDIR /app
# Owned by root and not writable by the process user; compose also mounts the root filesystem read-only.
COPY --from=build /repo/apps/backend-api/dist ./
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "main.js"]

# The runtime image plus the schema and migrations: `prisma` is a runtime dependency (its bin is needed here) and
# seed.js is the plan seed bundled by webpack, so no dev dependencies ship to the host.
FROM runtime AS migrate
COPY apps/backend-api/prisma.config.ts ./
COPY apps/backend-api/prisma/schema.prisma ./prisma/
COPY apps/backend-api/prisma/migrations ./prisma/migrations
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node seed.js"]
