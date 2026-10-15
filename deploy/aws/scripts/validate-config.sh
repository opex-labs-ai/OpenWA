#!/usr/bin/env bash
#
# Every local check, in one place. Needs no AWS credentials.
#
# Run before pushing, and run by the `cdk` job in .github/workflows/ci.yml, so a change that would
# fail in CI fails here first.
set -euo pipefail

cd "$(dirname "$0")/.."
FAILED=0

step() { printf '\n==> %s\n' "$*"; }
check() {
  local label="$1"
  shift
  if "$@"; then
    printf '    ok: %s\n' "$label"
  else
    printf '    FAILED: %s\n' "$label" >&2
    FAILED=1
  fi
}

step 'cdk.json is valid JSON and digest-pins the image'
check 'cdk.json parses' node -e "JSON.parse(require('fs').readFileSync('cdk.json','utf8'))"
check 'image reference is digest-pinned' node -e "
  const ctx = JSON.parse(require('fs').readFileSync('cdk.json','utf8')).context;
  const ref = ctx['openwa:imageRef'] || '';
  if (!ref.includes('@sha256:')) {
    console.error('openwa:imageRef must be pinned to a digest, got: ' + ref);
    process.exit(1);
  }
"

step 'shell scripts parse'
for script in runtime/*.sh scripts/*.sh userdata/*.sh; do
  check "bash -n ${script}" bash -n "$script"
done

step 'shellcheck'
# SC1091: the sourced runtime config only exists on the instance.
SHELLCHECK_ARGS=(--severity=warning --exclude=SC1091 runtime/*.sh scripts/*.sh userdata/*.sh)
if command -v shellcheck >/dev/null 2>&1; then
  check 'shellcheck' shellcheck "${SHELLCHECK_ARGS[@]}"
elif command -v docker >/dev/null 2>&1; then
  # Falls back to the container so a machine without shellcheck still runs the same check CI does.
  # Skipping it locally is how an SC2034 warning once reached CI unnoticed.
  printf '    shellcheck is not installed; using the container image instead\n'
  # cygpath and MSYS_NO_PATHCONV keep Git Bash on Windows from rewriting either side of the -v pair.
  SC_MOUNT="$PWD"
  if command -v cygpath >/dev/null 2>&1; then SC_MOUNT="$(cygpath -w "$PWD")"; fi
  check 'shellcheck (container)' env MSYS_NO_PATHCONV=1 docker run --rm \
    -v "${SC_MOUNT}:/mnt:ro" -w /mnt koalaman/shellcheck:stable "${SHELLCHECK_ARGS[@]}"
else
  printf '    SKIPPED: neither shellcheck nor docker is available — CI will still run this\n'
fi

step 'the bootstrap script has no unsubstituted placeholder outside its own token list'
check 'placeholder tokens are all known' node -e "
  const fs = require('fs');
  const source = fs.readFileSync('userdata/bootstrap.sh', 'utf8');
  const construct = fs.readFileSync('lib/constructs/openwa-ec2.ts', 'utf8');
  const used = new Set((source.match(/@@[A-Z_]+@@/g) || []).map(t => t.slice(2, -2)));
  const missing = [...used].filter(token => !construct.includes(token));
  if (missing.length) {
    console.error('bootstrap.sh uses placeholders the construct does not substitute: ' + missing.join(', '));
    process.exit(1);
  }
"

step 'the compose file is well formed and publishes no public port'
check 'compose.yaml parses' node -e "
  const text = require('fs').readFileSync('runtime/compose.yaml', 'utf8');
  if (!text.includes(\"'\\\${OPENWA_BIND_ADDRESS:-127.0.0.1}:\\\${OPENWA_PORT}:2785'\")) {
    console.error('the API port must be published on OPENWA_BIND_ADDRESS, defaulting to loopback');
    process.exit(1);
  }
  if (/['\\\"]0\\.0\\.0\\.0:/.test(text)) {
    console.error('compose.yaml publishes a port on all interfaces');
    process.exit(1);
  }
"
if command -v docker >/dev/null 2>&1; then
  # Validated against a throwaway copy. The compose file requires .env.runtime, which
  # deploy.sh writes on the instance from Secrets Manager and which must never exist in the
  # working tree; a stub here keeps the check honest without inventing a file in the repo.
  COMPOSE_TMP="$(mktemp -d)"
  trap 'rm -rf "$COMPOSE_TMP"' EXIT
  cp runtime/compose.yaml "$COMPOSE_TMP/compose.yaml"
  printf 'API_MASTER_KEY=validation-stub-not-a-real-key\n' >"$COMPOSE_TMP/.env.runtime"

  # Interpolation needs the variables the instance would supply; values are irrelevant to validation.
  check 'docker compose config' env \
    OPENWA_IMAGE_REF='example@sha256:0000000000000000000000000000000000000000000000000000000000000000' \
    OPENWA_ENGINE_TYPE=baileys OPENWA_PORT=2785 OPENWA_BIND_ADDRESS=127.0.0.1 OPENWA_DATA_DIR=/opt/openwa/data \
    OPENWA_MEM_LIMIT=1400m OPENWA_PIDS_LIMIT=2048 OPENWA_REGION=ap-south-1 \
    OPENWA_CONTAINER_LOG_GROUP=/openwa/test/container \
    docker compose --file "$COMPOSE_TMP/compose.yaml" config --quiet
else
  printf '    skipped: docker is not available\n'
fi

step 'the CloudWatch agent configuration is valid JSON'
check 'cloudwatch-agent.json parses' node -e "
  const text = require('fs').readFileSync('runtime/cloudwatch-agent.json', 'utf8')
    .replace(/@@DATA_DIR@@/g, '/opt/openwa/data')
    .replace(/@@SYSTEM_LOG_GROUP@@/g, '/openwa/test/system');
  JSON.parse(text);
"

step 'TypeScript'
check 'tsc --noEmit' npx tsc --noEmit

step 'Result'
if [ "$FAILED" -ne 0 ]; then
  echo 'validate-config: one or more checks failed' >&2
  exit 1
fi
echo 'validate-config: all checks passed'
