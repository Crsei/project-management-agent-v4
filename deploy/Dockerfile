ARG NODE_IMAGE=node:24.21.0-bookworm-slim
ARG CADDY_IMAGE=caddy:2-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Native Node dependencies are built in this stage. Final Agent, backend and Web
# images contain no Cargo, Rust sources, TypeScript host source or desktop GUI.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
# The root allowlist includes every workspace manifest and source, never private data.
COPY . .
RUN node -e "const fs=require('node:fs');if(['.env','.env.agent','.local','.git','apps/web/.env'].some(p=>fs.existsSync(p)))throw new Error('Private files in build context')" \
    && corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate \
    && node scripts/doctor.mjs \
    && pnpm install --frozen-lockfile \
    && PM_ENABLE_LAB=false pnpm build:v4 \
    && node --input-type=module -e "import {collectNotices} from './apps/desktop/scripts/license-notices.mjs'; await collectNotices(['/app/apps/web'],'/app/apps/web/dist/licenses/dependencies')"

FROM build AS agent-deps
RUN pnpm --filter @agent-workspace/server --config.hoist-workspace-packages=false deploy --prod --legacy /agent-runtime \
    && node apps/server/agent/scripts/external-agent-packages.mjs --prune-deployment /agent-runtime

FROM build AS production-deps
RUN pnpm --filter project-management-agent-v4 --config.hoist-workspace-packages=false deploy --prod --legacy /backend-runtime \
    && node apps/server/agent/scripts/external-agent-packages.mjs --prune-deployment /backend-runtime

FROM ${NODE_IMAGE} AS backend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4194 BLOB_ROOT=/var/lib/pm/blobs CORE_WORKSPACE_ROOT=/var/lib/pm/core
WORKDIR /app
COPY --chown=node:node --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
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
COPY --chown=node:node --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md /app/LICENSE.t3code ./
COPY --chown=node:node --from=build /app/vendor/t3code/LICENSE ./vendor/t3code/LICENSE
COPY --chown=node:node --from=build /app/vendor/cc-switch/LICENSE /app/vendor/cc-switch/LICENSING.md ./vendor/cc-switch/
COPY --chown=node:node --from=build /app/vendor/openhands-extensions/LICENSE /app/vendor/openhands-extensions/LICENSING.md ./vendor/openhands-extensions/
COPY --chown=node:node --from=build /app/vendor/openhands-extensions/extensions/LICENSE ./vendor/openhands-extensions/extensions/LICENSE
COPY --chown=node:node --from=build /app/vendor/openhands-automations/LICENSE.agent-canvas /app/vendor/openhands-automations/LICENSE.extensions ./vendor/openhands-automations/
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
COPY --from=build /app/vendor/cc-switch/LICENSE /srv/pm/licenses/cc-switch-MIT.txt
COPY --from=build /app/vendor/cc-switch/LICENSING.md /srv/pm/licenses/cc-switch-LICENSING.md
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
