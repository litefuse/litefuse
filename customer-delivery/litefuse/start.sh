#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import secrets; print(secrets.token_hex($bytes))"
    return
  fi

  echo "openssl or python3 is required to generate secrets" >&2
  exit 1
}

need_cmd docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required. Please install Docker Compose and retry." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Creating $ENV_FILE with generated secrets..."
  {
    echo "NEXTAUTH_URL=http://localhost:3000"
    echo "NEXTAUTH_SECRET=$(random_hex 32)"
    echo "SALT=$(random_hex 32)"
    echo "ENCRYPTION_KEY=$(random_hex 32)"
    echo "POSTGRES_PASSWORD=$(random_hex 16)"
    echo "REDIS_AUTH=$(random_hex 16)"
    echo "MINIO_ROOT_PASSWORD=$(random_hex 16)"
    echo "TELEMETRY_ENABLED=false"
    echo "LITEFUSE_ENABLE_EXPERIMENTAL_FEATURES=false"
  } > "$ENV_FILE"
fi

echo "Starting Litefuse..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is not installed; skipping HTTP health check."
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
  echo "Open http://localhost:3000 after services finish starting."
  exit 0
fi

echo "Waiting for Litefuse health check..."
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3000/api/public/health >/dev/null 2>&1; then
    echo "Litefuse is ready: http://localhost:3000"
    curl -fsS http://localhost:3000/api/public/health
    echo
    exit 0
  fi
  sleep 5
done

echo "Services were started, but the health check did not pass within 5 minutes."
echo "Run this command to inspect status:"
echo "docker compose --env-file .env -f docker-compose.yml ps"
exit 1
