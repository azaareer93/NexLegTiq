#!/bin/sh
# Roll out one image tag on the production host without downtime (D-225). Run by .github/workflows/release.yml over SSH,
# or by hand: `API_DOMAIN=… ADMIN_ALLOWED_IPS=… sh deploy.sh ghcr.io/<owner>/nexlegtiq <sha>`.
# Steps: pull → one-off migrate (migrator role; SKIP_MIGRATE=1 for a rollback) → replace api-a, wait until healthy,
# then api-b (Caddy serves from the other one meanwhile) → worker → reload Caddy → /health/ready on both API containers.
set -eu

repo=${1:?usage: deploy.sh <image-repo> <tag>}
tag=${2:?usage: deploy.sh <image-repo> <tag>}
cd "$(dirname "$0")"

# Everything below ends up in .env / the Caddyfile: refuse anything but the expected shapes (no newlines or quotes).
echo "$repo" | grep -Eqx 'ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+' || { echo "invalid image repo" >&2; exit 2; }
echo "$tag" | grep -Eqx '[0-9a-f]{40}' || { echo "invalid tag (full commit SHA expected)" >&2; exit 2; }
echo "${API_DOMAIN:?}" | grep -Eqx '[a-z0-9.-]+' || { echo "invalid API_DOMAIN" >&2; exit 2; }
echo "${ADMIN_ALLOWED_IPS:?}" | grep -Eqx '[0-9a-fA-F.:/ ]+' || { echo "invalid ADMIN_ALLOWED_IPS" >&2; exit 2; }
[ -s app.env ] && [ -s migrate.env ] || { echo "app.env and migrate.env must exist (see docs/runbooks/release.md)" >&2; exit 2; }

umask 077
printf 'IMAGE_REPO=%s\nIMAGE_TAG=%s\nAPI_DOMAIN=%s\nADMIN_ALLOWED_IPS=%s\n' \
  "$repo" "$tag" "$API_DOMAIN" "$ADMIN_ALLOWED_IPS" > .env

ready() {
  docker compose exec -T "$1" node -e \
    "fetch('http://127.0.0.1:3000/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

docker compose --profile tools pull --quiet
if [ "${SKIP_MIGRATE:-0}" = 1 ]; then
  echo "SKIP_MIGRATE=1: no migration (rollback to an image the current schema already serves)"
else
  # Forward-only migrations (expand/contract): the running containers keep working while the schema changes.
  docker compose run --rm migrate
fi

# Shared dependencies first (no-ops when unchanged; ClamAV's first start takes minutes).
docker compose up -d --wait --wait-timeout 600 clamav caddy
# One API container at a time: the other keeps serving through Caddy. A failure stops here with one old container
# still up, so the API never goes fully dark; re-run with the previous tag to roll back.
for svc in api-a api-b; do
  docker compose up -d --no-deps --wait --wait-timeout 300 "$svc"
  ready "$svc" || { sleep 5; ready "$svc"; } || { echo "smoke test failed: $svc /health/ready is not OK" >&2; exit 1; }
done
docker compose up -d --no-deps --wait --wait-timeout 300 worker
docker compose up -d --remove-orphans --wait --wait-timeout 300
# A changed Caddyfile is a bind mount: compose does not restart Caddy for it, so reload (graceful, keeps connections).
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile

[ -f deployed-tag ] && cp deployed-tag previous-tag
echo "$tag" > deployed-tag
echo "production now runs $tag (previous: $(cat previous-tag 2>/dev/null || echo none))"
