#!/usr/bin/env bash
# Trigger a Coolify redeploy and then *verify it actually finished*.
#
# This replaces the fire-and-forget `curl -X POST .../restart` that used to sit
# inline in `.github/workflows/publish.yml`. That call reported success as long
# as Coolify accepted the HTTP request, so a queued deployment that failed to
# pull the image, failed to start, or was never scheduled still showed a green
# workflow. Everything here exists to close that gap:
#
#   1. every input comes from the environment (repository variables/secrets), so
#      neither the token, the host nor the resource UUID is hardcoded in a
#      workflow file;
#   2. the trigger is retried on transient failures (5xx/connection resets) but
#      never on 401/403/404/422 — repeating a bad token or a wrong UUID only
#      turns one clear error into five;
#   3. if Coolify returns a `deployment_uuid`, it is polled to a terminal state
#      and a failed/cancelled deployment fails this script;
#   4. an optional external health check then proves the new container is really
#      serving, which is the only end-to-end evidence a deploy worked.
#
# The API token is only ever passed in an `Authorization:` header, never in a
# URL or a log line — CI logs are readable by anyone with repo access, and
# Coolify tokens carry deploy rights.
#
# Exercised by tests/int/coolify-deploy.int.spec.ts against a stub Coolify API.
set -euo pipefail

log() { printf 'coolify-deploy: %s\n' "$*" >&2; }
fail() {
  log "$*"
  exit 1
}

# ---------------------------------------------------------------- inputs ----
base_url="${COOLIFY_URL:-}"
[[ -n "$base_url" ]] || fail 'COOLIFY_URL is not set (e.g. https://manage.example.com).'
base_url="${base_url%/}"

token="${COOLIFY_API_TOKEN:-}"
[[ -n "$token" ]] || fail 'COOLIFY_API_TOKEN is not set (Coolify API token with the "deploy" ability).'

uuid="${COOLIFY_RESOURCE_UUID:-}"
[[ -n "$uuid" ]] || fail 'COOLIFY_RESOURCE_UUID is not set (the Coolify service/application UUID).'

kind="${COOLIFY_RESOURCE_KIND:-services}"
case "$kind" in
  services | applications) ;;
  *) fail "COOLIFY_RESOURCE_KIND must be 'services' or 'applications', got '$kind'." ;;
esac

# `latest=true` is what makes Coolify re-pull the image tag instead of restarting
# the container it already has — without it a deploy after a new `:latest` push
# silently keeps running the old image.
deploy_path="${COOLIFY_DEPLOY_PATH:-$kind/$uuid/restart?latest=true}"

max_attempts="${COOLIFY_MAX_ATTEMPTS:-5}"
retry_delay="${COOLIFY_RETRY_DELAY:-5}"
poll_interval="${COOLIFY_POLL_INTERVAL:-10}"
timeout_seconds="${COOLIFY_TIMEOUT:-900}"
http_timeout="${COOLIFY_HTTP_TIMEOUT:-30}"
health_url="${COOLIFY_HEALTHCHECK_URL:-}"
# The app's own container healthcheck asks `/api/domain-check` and treats the
# deliberate 404 for an unknown domain as healthy (docker-compose.srv1.yml); an
# external check of the same endpoint wants the same expectation, so the status
# is configurable and may be a comma-separated list.
health_expect="${COOLIFY_HEALTHCHECK_STATUS:-200}"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

now() { date +%s; }
snippet() { head -c 300 "$body_file" | tr -d '\r' | tr '\n' ' '; }

# Reads the token from the environment inside the call: it never reaches argv of
# a logged command, and `%{http_code}` on stdout keeps the body out of the log.
#
# A transport-level failure (refused connection, DNS, timeout) makes curl exit
# non-zero AND still print `000`, so the output is normalised here — without it
# the caller sees `000000` and matches none of its cases.
request() {
  local method="$1" url="$2" code
  code="$(
    curl --silent --show-error --location \
      --max-time "$http_timeout" \
      --request "$method" \
      --header "Authorization: Bearer $token" \
      --header 'Accept: application/json' \
      --output "$body_file" \
      --write-out '%{http_code}' \
      "$url" 2>/dev/null
  )" || code=000
  printf '%s' "${code:-000}"
}

# jq is present on GitHub-hosted runners; fall back to a narrow grep so a slim
# container without it degrades to "cannot poll" rather than "deploy failed".
json_field() {
  if command -v jq >/dev/null 2>&1; then
    jq -r "$1 // empty" "$body_file" 2>/dev/null || true
  else
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$body_file" | head -n 1
  fi
}

# ------------------------------------------------------- trigger a deploy ----
log "triggering $kind/$uuid on $base_url"
attempt=1
while :; do
  status="$(request POST "$base_url/api/v1/$deploy_path")"
  [[ -n "$status" ]] || status=000

  case "$status" in
    2*)
      break
      ;;
    400 | 401 | 403 | 404 | 422)
      # Configuration, not weather. Retrying repeats the same answer and hides it.
      fail "Coolify refused the deploy request with HTTP $status: $(snippet)"
      ;;
  esac

  if ((attempt >= max_attempts)); then
    fail "Coolify deploy request failed with HTTP $status after $attempt attempt(s): $(snippet)"
  fi

  log "attempt $attempt/$max_attempts got HTTP $status; retrying in $((retry_delay * attempt))s"
  sleep "$((retry_delay * attempt))"
  attempt=$((attempt + 1))
done

deployment_uuid="$(json_field '.deployment_uuid // .deployment_uuids[0].deployment_uuid' deployment_uuid)"
log "deploy queued (HTTP $status)${deployment_uuid:+, deployment $deployment_uuid}"

# ------------------------------------------ wait for a terminal deploy state --
# Coolify's service-restart endpoint does not always return a deployment handle
# (coollabsio/coolify#9755). When it does, this is the authoritative result;
# when it does not, the health check below is the only verification available.
deadline=$(($(now) + timeout_seconds))
if [[ -n "$deployment_uuid" ]]; then
  while :; do
    status="$(request GET "$base_url/api/v1/deployments/$deployment_uuid")"
    if [[ "$status" == 404 ]]; then
      log "deployment $deployment_uuid is not queryable (HTTP 404); relying on the health check"
      deployment_uuid=''
      break
    fi

    if [[ "$status" =~ ^2 ]]; then
      state="$(json_field '.status // .state' status)"
      case "$state" in
        finished | success | succeeded)
          log "deployment $deployment_uuid finished ($state)"
          break
          ;;
        failed | error | cancelled | cancelled_by_user)
          fail "deployment $deployment_uuid ended as '$state' — the running container was NOT updated: $(snippet)"
          ;;
      esac
      log "deployment $deployment_uuid is '${state:-unknown}'; waiting"
    else
      log "deployment poll returned HTTP $status; waiting"
    fi

    (($(now) < deadline)) ||
      fail "timed out after ${timeout_seconds}s waiting for deployment $deployment_uuid to finish"
    sleep "$poll_interval"
  done
fi

# -------------------------------------------------- verify it really serves ---
if [[ -z "$health_url" ]]; then
  if [[ -z "$deployment_uuid" ]]; then
    fail 'Coolify returned no deployment handle and COOLIFY_HEALTHCHECK_URL is unset — the deploy could not be verified. Set COOLIFY_HEALTHCHECK_URL so a failed rollout fails this step.'
  fi
  log 'no COOLIFY_HEALTHCHECK_URL set; skipping the external health check'
  exit 0
fi

log "waiting for $health_url to answer $health_expect"
IFS=',' read -r -a expected_codes <<<"$health_expect"
while :; do
  status="$(
    curl --silent --location --max-time "$http_timeout" \
      --output /dev/null --write-out '%{http_code}' "$health_url" 2>/dev/null
  )" || status=000
  status="${status:-000}"

  for code in "${expected_codes[@]}"; do
    if [[ "$status" == "${code// /}" ]]; then
      log "health check OK (HTTP $status) — deployment verified"
      exit 0
    fi
  done

  (($(now) < deadline)) ||
    fail "timed out after ${timeout_seconds}s: $health_url last answered HTTP $status, expected $health_expect"
  log "health check got HTTP $status; retrying in ${poll_interval}s"
  sleep "$poll_interval"
done
