#!/usr/bin/env bash
# Destructive ONLY to a dedicated test project/database. Run on a clean CI/staging
# host, never srv1. Requires a freshly built eshobe-cms-web image and Compose v2.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
project=eshobe-cms-migration-test

# Refuse a host with production data/containers, even if they are stopped. The
# production image tag and loopback port are deliberately identical to srv1.
if docker volume inspect eshobe-cms_pgdata >/dev/null 2>&1 ||
   docker volume inspect eshobe-cms_media_uploads >/dev/null 2>&1 ||
   [[ -n "$(docker ps -aq --filter label=com.docker.compose.project=eshobe-cms)" ]]; then
  echo 'Refusing to run migration smoke tests on a production/development stack host.' >&2
  exit 1
fi
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]]; then
  echo "Remove the previous $project test stack before running this test." >&2
  exit 1
fi
docker image inspect eshobe-cms-web >/dev/null

tmp="$(mktemp -d)"
# Synthetic credentials only; --env-file /dev/null prevents loading a real .env.
# Explicit exports also override any production credentials in the caller's shell.
export POSTGRES_USER=eshobe POSTGRES_DB=eshobe_migration_test
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export DATABASE_URL="postgres://eshobe_app:$(openssl rand -hex 24)@db:5432/$POSTGRES_DB"
export MIGRATE_DATABASE_URL="postgres://eshobe:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB"
export TEST_DATABASE_URL="$DATABASE_URL"
# The one-shot derives the owning runtime role from this, never from a guess.
export APP_DATABASE_ROLE=eshobe_app
export PAYLOAD_SECRET="$(openssl rand -hex 32)"
export CRON_SECRET="$(openssl rand -hex 24)" PREVIEW_SECRET="$(openssl rand -hex 24)"
export CONTROL_PLANE_HOST=admin.example.com JOBS_AUTORUN=false
unset COMPOSE_PROJECT_NAME

cat >"$tmp/compose.yml" <<'YAML'
services:
  web:
    # Exercise the image just built by CI, not a second build with different args.
    # `docker-compose.srv1.yml` pins the ghcr-mirror pull-through tag for Komodo; the
    # smoke test must override it back to the image docker-build-push-action just
    # built and loaded, or compose pulls `latest` from the mirror and the topology
    # assertions below compare against the wrong image.
    image: eshobe-cms-web
    pull_policy: never
  migrate:
    # Byte-identical to web in production; keep it so against the locally-built image.
    image: eshobe-cms-web
    pull_policy: never
YAML

dc() {
  docker compose --project-name "$project" --env-file /dev/null \
    -f "$root/docker-compose.srv1.yml" -f "$tmp/compose.yml" "$@"
}
failing_dc() {
  dc -f "$tmp/failure.yml" "$@"
}
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$status" != 0 ]]; then
    dc logs --no-color --tail 60 migrate web >&2 || true
  fi
  # Never use this flag on production. -p is fixed to the test project above.
  dc down -v --remove-orphans >/dev/null || true
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT

# Validate the actual srv1 model, before applying the test-only overrides. These
# config dumps contain ONLY synthetic test credentials and never leave $tmp.
docker compose --env-file /dev/null -f "$root/docker-compose.srv1.yml" \
  config --format json >"$tmp/config.json"
docker compose --env-file /dev/null -f "$root/docker-compose.srv1.yml" \
  config --no-interpolate --format json >"$tmp/raw-config.json"
python3 - "$tmp" <<'PY'
import traceback
try:
    import json, pathlib, sys
    root = pathlib.Path(sys.argv[1])
    cfg = json.loads((root / 'config.json').read_text())
    raw = json.loads((root / 'raw-config.json').read_text())
    assert cfg['name'] == 'eshobe-cms'
    assert set(cfg['services']) == {'web', 'migrate', 'db'}
    web, migrate, db = (cfg['services'][name] for name in ('web', 'migrate', 'db'))
    # web and migrate must stay byte-identical, and that image is the literal
    # ghcr-mirror tag docker-compose.srv1.yml pins for Komodo (see its header — the
    # tag is written out literally on purpose). The test-only override in
    # $tmp/compose.yml swaps this back to the locally-built `eshobe-cms-web`.
    assert web['image'] == migrate['image'] == 'ghcr-mirror.liara.ir/hamidnoshady/eshobe-cms:latest'
    assert web['depends_on']['migrate']['condition'] == 'service_completed_successfully'
    assert migrate['depends_on']['db']['condition'] == 'service_healthy'
    assert migrate['restart'] == 'no'
    assert 'MIGRATE_DATABASE_URL' not in web['environment']
    assert 'DATABASE_URL' not in migrate['environment']
    # The runtime role reaches the one-shot explicitly, never via DATABASE_URL.
    assert migrate['environment']['APP_DATABASE_ROLE'] == 'eshobe_app'
    assert raw['services']['migrate']['environment']['APP_DATABASE_ROLE'].startswith(
        '${APP_DATABASE_ROLE'
    )
    assert 'APP_DATABASE_ROLE' not in web['environment']
    assert len(web['ports']) == 1
    assert web['ports'][0]['host_ip'] == '127.0.0.1'
    assert str(web['ports'][0]['published']) == '3001'
    assert web['ports'][0]['target'] == 3000
    assert not migrate.get('ports') and not db.get('ports')
    assert set(cfg['volumes']) == {'pgdata', 'media_uploads'}
    assert cfg['volumes']['pgdata']['name'] == 'eshobe-cms_pgdata'
    assert cfg['volumes']['media_uploads']['name'] == 'eshobe-cms_media_uploads'
    assert web['volumes'][0]['source'] == 'media_uploads'
    assert db['volumes'][0]['source'] == 'pgdata'
    assert not migrate.get('volumes')
    def memory_bytes(value):
        # Compose versions serialize ByteValue as either a number or a string.
        text = str(value).lower()
        units = {'k': 1024, 'm': 1024**2, 'g': 1024**3}
        return int(text[:-1]) * units[text[-1]] if text[-1] in units else int(text)
    for name, service in cfg['services'].items():
        assert not service.get('env_file')
        expected_memory = (384 if name == 'db' else 512) * 1024**2
        assert memory_bytes(service['mem_limit']) == expected_memory, f'{name}: memory limit changed'
        assert memory_bytes(service['memswap_limit']) == expected_memory, f'{name}: swap limit changed'
        assert int(service['pids_limit']) == (128 if name == 'db' else 256)
        assert 'no-new-privileges:true' in [opt.replace('=', ':') for opt in service['security_opt']]
        assert all('${' in value for value in raw['services'][name]['environment'].values())
    print('srv1 Compose topology, hardening and credential allowlists OK')
except Exception:
    detail = traceback.format_exc().replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print(f'::error file=tests/deployment/compose-smoke.sh::Compose validation failed: {detail}', flush=True)
    raise
PY

fixture() {
  dc run --rm --no-deps -T -e TEST_DATABASE_URL \
    -v "$root/tests/deployment:/app/migrator/tests/deployment:ro" \
    migrate node node_modules/payload/bin.js run tests/deployment/database.ts "$1"
}

dc up -d --wait --wait-timeout 60 db
fixture prepare

# Break wave10 AFTER it alters the owner-only enums, in a bind-mounted copy only.
# This tests both non-zero exit propagation and transaction rollback, without
# modifying any committed migration or rebuilding a different test image.
python3 - "$root" "$tmp" <<'PY'
import pathlib, sys
root, tmp = map(pathlib.Path, sys.argv[1:])
name = '20260905_003232_wave10_payment_gateways.ts'
source = (root / 'src/migrations' / name).read_text()
needle = '  CREATE TABLE "payment_gateways" ('
assert needle in source
(tmp / 'broken.ts').write_text(source.replace(needle, '  SELECT migration_smoke_test_deliberate_failure();\n' + needle, 1))
(tmp / 'failure.yml').write_text(f'''services:
  migrate:
    volumes:
      - {tmp / 'broken.ts'}:/app/migrator/src/migrations/{name}:ro
''')
PY

if failing_dc up -d --no-build; then
  echo 'FAIL: Compose accepted a deliberately broken migration.' >&2
  exit 1
fi
migrator_id="$(failing_dc ps -aq migrate)"
[[ -n "$migrator_id" ]]
[[ "$(docker inspect -f '{{.State.Status}}' "$migrator_id")" == exited ]]
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$migrator_id")" != 0 ]]
web_id="$(failing_dc ps -aq web)"
if [[ -n "$web_id" ]]; then
  [[ "$(docker inspect -f '{{.State.Running}}' "$web_id")" == false ]]
fi
fixture assert-baseline

# Removing the test-only failed migration mount must unblock the real rollout.
dc up -d --no-build --wait --wait-timeout 180
fixture assert-current
dc exec -T web node -e '
  if ("MIGRATE_DATABASE_URL" in process.env) process.exit(1);
  if (new URL(process.env.DATABASE_URL).username !== "eshobe_app") process.exit(1);
  if (process.getuid() === 0) process.exit(1);
  console.log("Healthy web is non-root and has only the restricted database credential");
'
# A subsequent one-shot run must be a no-op, not a second application of the DDL.
dc run --rm --no-deps -T migrate
fixture assert-current
printf '\nMigration failure gate, four-migration upgrade, runtime isolation, ownership normalisation and rerun OK\n'
