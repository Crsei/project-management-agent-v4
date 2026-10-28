#!/usr/bin/env bash
# Production v3 deployment only; host development is `pnpm dev:v3`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${V3_DEPLOY_ENV_FILE:-$ROOT/.env.deploy}"
PROJECT=project-management-agent-v3-app
if [[ ! -f "$ENV_FILE" ]]; then
  printf '%s\n' 'Create a private v3 deployment env file per deploy/README.md; no old secrets are copied.' >&2
  exit 1
fi
case "${1:-}" in
  build) ACTION=(build) ;;
  start) ACTION=(up -d --wait) ;;
  stop) ACTION=(stop) ;;
  status) ACTION=(ps) ;;
  logs) ACTION=(logs --follow --tail 100) ;;
  *) printf '%s\n' "Usage: $0 {build|start|stop|status|logs}" 'For local development use pnpm dev:v3.' >&2; exit 1 ;;
esac
exec docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/deploy/compose.app.yaml" "${ACTION[@]}"
