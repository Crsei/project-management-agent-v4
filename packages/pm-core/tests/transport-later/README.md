# Transport tests pending the PM Fastify transport

These tests were written against the markdown-pm-lab Hono server (`apps/server/index.ts`),
its web client (`apps/web/src/api.ts`), and the Lab CLI entry point. PM has no Hono
server, so they are intentionally excluded from `packages/pm-core/tests/*.test.ts` and
from the root `pnpm test` glob.

- `transport.test.ts` — Hono HTTP/SSE surface plus CLI behavior.
- `advanced-transport.test.ts` — Hono API, CLI and web-client integration.
- `core-http.test.ts` — the single Hono-dependent test extracted from `core.test.ts`.

When the PM Fastify transport lands, point the app/client imports at the PM entries,
rewrite the CLI path if it moved, and move these files up into `packages/pm-core/tests/`.
Package imports have already been rewritten to the PM layout. The `../apps/...` imports
are still Lab-relative and are the only unresolved references.
