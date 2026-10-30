ARG NODE_IMAGE=node:24-bookworm-slim
ARG CADDY_IMAGE=caddy:2-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
# The root allowlist includes every workspace manifest and source, never private data.
COPY . .
RUN node -e "const fs=require('node:fs');if(['.env','.env.agent','.local','.git','apps/web/.env'].some(p=>fs.existsSync(p)))throw new Error('Private files in build context')" \
    && pnpm install --frozen-lockfile \
    && PM_ENABLE_LAB=false VITE_ENABLE_UI_LAB=0 pnpm build:v4

FROM build AS agent-deps
RUN pnpm --filter @agent-workspace/server --config.hoist-workspace-packages=false deploy --prod --legacy /agent-runtime

FROM build AS production-deps
RUN pnpm --filter project-management-agent-v4 --config.hoist-workspace-packages=false deploy --prod --legacy /backend-runtime

FROM ${NODE_IMAGE} AS backend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4194 BLOB_ROOT=/var/lib/pm/blobs CORE_WORKSPACE_ROOT=/var/lib/pm/core
WORKDIR /app
COPY --chown=node:node --from=production-deps /backend-runtime/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node deploy/manage.mjs ./deploy/manage.mjs
RUN mkdir -p /var/lib/pm/blobs /var/lib/pm/core /var/lib/pm/projects && chown -R node:node /var/lib/pm
USER node
EXPOSE 4194
CMD ["node", "dist/apps/server/pm/src/main.js"]

FROM ${NODE_IMAGE} AS agent
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4325 AGENT_WORKSPACE_API_ONLY=1 AGENT_WORKSPACE_DATA_DIR=/var/lib/agent
WORKDIR /app
COPY --chown=node:node --from=agent-deps /agent-runtime ./apps/server/agent
COPY --chown=node:node --from=build /app/packages/pm-cli/agent-tools.mjs ./packages/pm-cli/agent-tools.mjs
COPY --chown=node:node --from=build /app/packages/pm-cli/pi-tools.ts ./packages/pm-cli/pi-tools.ts
RUN mkdir -p /var/lib/agent /var/lib/pm/projects && chown -R node:node /var/lib/agent /var/lib/pm/projects
USER node
EXPOSE 4325
CMD ["node", "apps/server/agent/dist/index.mjs"]

FROM ${CADDY_IMAGE} AS web
RUN setcap -r /usr/bin/caddy
COPY --from=build /app/apps/web/dist /srv/pm
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
