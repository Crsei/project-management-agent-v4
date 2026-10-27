ARG NODE_IMAGE=node:24-bookworm-slim
ARG CADDY_IMAGE=caddy:2-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/pm-views/package.json packages/pm-views/package.json
RUN pnpm install --frozen-lockfile
COPY . .
# Lab is closed in this image; also reject private files if the root allowlist regresses.
RUN node -e "const fs=require('node:fs');if(['.env','.local','.git','apps/web/.env'].some(p=>fs.existsSync(p)))throw new Error('Private files in build context');console.log('build_context_private_files_absent')" \
    && pnpm build && PM_ENABLE_LAB=false pnpm build:web

FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --ignore-workspace

FROM ${NODE_IMAGE} AS backend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100 BLOB_ROOT=/var/lib/pm/blobs CORE_WORKSPACE_ROOT=/var/lib/pm/core
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY deploy/manage.mjs ./deploy/manage.mjs
RUN mkdir -p /var/lib/pm/blobs /var/lib/pm/core /var/lib/pm/projects && chown -R node:node /var/lib/pm
USER node
EXPOSE 4100
CMD ["node", "dist/apps/api/src/main.js"]

FROM ${CADDY_IMAGE} AS web
# Port 8080 needs no file capability; retain Compose cap_drop: ALL without exec EPERM.
RUN setcap -r /usr/bin/caddy
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
