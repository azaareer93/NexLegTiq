#!/bin/sh
# Roll out one image tag on the staging host (D-103). Run by .github/workflows/deploy-staging.yml over SSH, or by hand
# for a rollback: `API_DOMAIN=… STAGING_ALLOWED_IPS=… sh deploy.sh ghcr.io/<owner>/nexlegtiq <previous-sha>`.
# Steps: pull → one-off migrate (migrator role) → up (waits for health checks) → /health/ready smoke test.
set -eu

repo=${1:?usage: deploy.sh <image-repo> <tag>}
tag=${2:?usage: deploy.sh <image-repo> <tag>}
cd "$(dirname "$0")"

# Everything below ends up in .env / the Caddyfile: refuse anything but the expected shapes (no newlines or quotes).
echo "$repo" | grep -Eqx 'ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+' || { echo "invalid image repo" >&2; exit 2; }
echo "$tag" | grep -Eqx '[0-9a-f]{40}' || { echo "invalid tag (full commit SHA expected)" >&2; exit 2; }
echo "${API_DOMAIN:?}" | grep -Eqx '[a-z0-9.-]+' || { echo "invalid API_DOMAIN" >&2; exit 2; }
echo "${STAGING_ALLOWED_IPS:?}" | grep -Eqx '[0-9a-fA-F.:/ ]+' || { echo "invalid STAGING_ALLOWED_IPS" >&2; exit 2; }
[ -s app.env ] && [ -s migrate.env ] || { echo "app.env and migrate.env must exist (see docs/runbooks/deploy.md)" >&2; exit 2; }

umask 077
printf 'IMAGE_REPO=%s\nIMAGE_TAG=%s\nAPI_DOMAIN=%s\nSTAGING_ALLOWED_IPS=%s\n' \
  "$repo" "$tag" "$API_DOMAIN" "$STAGING_ALLOWED_IPS" > .env

docker compose --profile tools pull --quiet
# Forward-only migrations (expand/contract): the running containers keep working while the schema changes.
docker compose run --rm migrate
docker compose up -d --remove-orphans --wait --wait-timeout 600

ready=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker compose exec -T api node -e \
    "fetch('http://127.0.0.1:3000/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
    ready=true && break
  fi
  echo "readiness check $attempt failed, retrying" >&2
  sleep 5
done
[ "$ready" = true ] || { echo "smoke test failed: /health/ready is not OK" >&2; exit 1; }

[ -f deployed-tag ] && cp deployed-tag previous-tag
echo "$tag" > deployed-tag
echo "staging now runs $tag (previous: $(cat previous-tag 2>/dev/null || echo none))"
