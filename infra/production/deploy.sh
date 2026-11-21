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
[ -z "${RELEASE_VERSION:-}" ] || echo "$RELEASE_VERSION" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' || { echo "invalid RELEASE_VERSION" >&2; exit 2; }
[ -s app.env ] || { echo "app.env must exist (see docs/runbooks/release.md)" >&2; exit 2; }
[ "${SKIP_MIGRATE:-0}" = 1 ] || [ -s migrate.env ] || { echo "migrate.env must exist to migrate" >&2; exit 2; }

umask 077
# .env (read by every later `docker compose`, also a manual restart) only names the new tag once it is pulled and migrated.
printf 'IMAGE_REPO=%s\nIMAGE_TAG=%s\nAPI_DOMAIN=%s\nADMIN_ALLOWED_IPS=%s\n' \
  "$repo" "$tag" "$API_DOMAIN" "$ADMIN_ALLOWED_IPS" > .env.next

ready() {
  docker compose exec -T "$1" node -e \
    "fetch('http://127.0.0.1:3000/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

# Only the app images: a fresh upstream build of caddy or clamav must not recreate them mid-release (edge or scanner down).
docker compose --env-file .env.next --profile tools pull --quiet api-a api-b worker migrate
if [ "${SKIP_MIGRATE:-0}" = 1 ]; then
  echo "SKIP_MIGRATE=1: no migration (rollback to an image the current schema already serves)"
else
  # Forward-only migrations (expand/contract): the running containers keep working while the schema changes.
  docker compose --env-file .env.next run --rm migrate
fi
# The migrator's credentials only live on the host for the length of a release (the workflow writes them each time).
rm -f migrate.env
mv .env.next .env

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

if [ -f deployed-tag ] && [ "$(cat deployed-tag)" != "$tag" ]; then cp deployed-tag previous-tag; fi
echo "$tag" > deployed-tag
[ -z "${RELEASE_VERSION:-}" ] || echo "$RELEASE_VERSION $tag" >> releases.log
echo "production now runs $tag (previous: $(cat previous-tag 2>/dev/null || echo none))"
