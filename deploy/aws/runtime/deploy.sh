#!/bin/bash
#
# Idempotent application deployment for OpenWA on EC2.
#
# Contract, in order of importance:
#   1. It never deletes, reformats or recreates the data volume.
#   2. It refuses to run at all if the persistent volume is not mounted, or if authentication state
#      that used to exist has vanished. Starting fresh in that situation looks like success and
#      silently costs the operator a QR re-scan.
#   3. It rolls back to the previously running image if the new one fails validation.
#   4. It never prints a secret, and redacts diagnostics before they reach CloudWatch.
set -euo pipefail

APP_DIR="$(cat /etc/openwa-app-dir)"
DATA_DIR="$(cat /etc/openwa-data-dir)"
REGION="$(cat /etc/openwa-region)"
LOG_FILE=/var/log/openwa-deploy.log

exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '[openwa-deploy] %s %s\n' "$(date -Is)" "$*"; }
die() {
  log "FATAL $*"
  exit 1
}

# Masks anything that looks like a credential in captured output. Applied to every diagnostic before
# it is printed, because this log is shipped to CloudWatch and surfaced in workflow output.
redact() {
  sed -E 's/((API_MASTER_KEY|api[_-]?key|authorization|x-api-key|token|secret|password)[[:space:]]*[:=][[:space:]]*"?)[^[:space:],"}]+/\1***REDACTED***/Ig'
}

COMPOSE=(docker compose --file "${APP_DIR}/compose.yaml")

# shellcheck disable=SC1090,SC1091
set -a && . /etc/openwa-runtime.conf && set +a

: "${OPENWA_IMAGE_REF:?runtime config is missing OPENWA_IMAGE_REF}"
: "${OPENWA_ENGINE_TYPE:?runtime config is missing OPENWA_ENGINE_TYPE}"
: "${OPENWA_SECRET_ARN:?runtime config is missing OPENWA_SECRET_ARN}"
: "${OPENWA_PORT:?runtime config is missing OPENWA_PORT}"

log "deploying ${OPENWA_IMAGE_REF} (engine ${OPENWA_ENGINE_TYPE})"

# ------------------------------------------------- 1. validate configuration ----
case "$OPENWA_IMAGE_REF" in
*@sha256:*) : ;;
*) die "image reference is not digest-pinned: ${OPENWA_IMAGE_REF}" ;;
esac

case "$OPENWA_ENGINE_TYPE" in
baileys | whatsapp-web.js) : ;;
*) die "unsupported engine ${OPENWA_ENGINE_TYPE}" ;;
esac

# ----------------------------------------- 2. the persistent volume is mounted ----
mountpoint -q "$DATA_DIR" ||
  die "${DATA_DIR} is not a mount point. The persistent volume is missing, and starting here would create a fresh, empty data directory on the root disk. Refusing. Check the volume attachment and the systemd mount unit for ${DATA_DIR}."

EXPECTED_UUID="$(cat /etc/openwa-data-uuid 2>/dev/null || true)"
ACTUAL_UUID="$(findmnt -n -o UUID --target "$DATA_DIR" 2>/dev/null || true)"
if [ -n "$EXPECTED_UUID" ] && [ -n "$ACTUAL_UUID" ] && [ "$EXPECTED_UUID" != "$ACTUAL_UUID" ]; then
  die "${DATA_DIR} is mounted from filesystem ${ACTUAL_UUID}, but this instance was provisioned against ${EXPECTED_UUID}. Refusing to touch an unexpected volume."
fi
log "persistent volume verified (${DATA_DIR}, UUID ${ACTUAL_UUID:-unknown})"

# ------------------------------------------- 3. the session has not been wiped ----
# The engines keep authentication state in different places, so the probe differs per engine.
auth_state_present() {
  case "$OPENWA_ENGINE_TYPE" in
  baileys) compgen -G "${DATA_DIR}/baileys/*/creds.json" >/dev/null 2>&1 ;;
  whatsapp-web.js) compgen -G "${DATA_DIR}/sessions/session-*" >/dev/null 2>&1 ;;
  *) return 1 ;;
  esac
}

AUTH_MARKER="${DATA_DIR}/.openwa-auth-present"
if auth_state_present; then
  if [ ! -f "$AUTH_MARKER" ]; then
    : >"$AUTH_MARKER"
    chmod 0640 "$AUTH_MARKER"
    log "authentication state found; recorded the marker that guards future deployments"
  else
    log "authentication state present"
  fi
elif [ -f "$AUTH_MARKER" ]; then
  die "REFUSING TO DEPLOY. ${AUTH_MARKER} records that WhatsApp authentication state existed on this volume, but none is present now. Deploying would bring up an unauthenticated instance and make the loss look like a normal start. Investigate before continuing, and restore from a snapshot if the state is genuinely gone. To proceed deliberately and accept a new QR scan, remove ${AUTH_MARKER} by hand."
else
  log "no authentication state yet - first deployment, a QR scan will be required"
fi

# --------------------------------------------- 4. render the compose environment ----
# ./.env supplies compose interpolation only. It holds nothing secret.
umask 022
cat >"${APP_DIR}/.env" <<ENVFILE
OPENWA_IMAGE_REF=${OPENWA_IMAGE_REF}
OPENWA_ENGINE_TYPE=${OPENWA_ENGINE_TYPE}
OPENWA_PORT=${OPENWA_PORT}
OPENWA_DATA_DIR=${DATA_DIR}
OPENWA_MEM_LIMIT=${OPENWA_MEM_LIMIT:-1400m}
OPENWA_PIDS_LIMIT=${OPENWA_PIDS_LIMIT:-2048}
OPENWA_REGION=${REGION}
OPENWA_CONTAINER_LOG_GROUP=${OPENWA_CONTAINER_LOG_GROUP}
ENVFILE
chmod 0644 "${APP_DIR}/.env"

# ------------------------------------------------------- 5. fetch the API key ----
# Written to the ROOT volume, never the data volume, so it cannot end up inside an EBS snapshot.
# Nothing is echoed, and the key never appears in a command-line argument.
write_runtime_env() {
  local secret_json key
  secret_json="$(aws secretsmanager get-secret-value --secret-id "$OPENWA_SECRET_ARN" \
    --region "$REGION" --query 'SecretString' --output text)"
  key="$(printf '%s' "$secret_json" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["apiMasterKey"])')"
  if [ "${#key}" -lt 32 ]; then
    die "the API key in Secrets Manager is shorter than the 32 characters the application requires in production; it would refuse to boot"
  fi
  umask 077
  printf 'API_MASTER_KEY=%s\n' "$key" >"${APP_DIR}/.env.runtime"
  chmod 0600 "${APP_DIR}/.env.runtime"
  unset secret_json key
}
write_runtime_env
log "runtime secret written to ${APP_DIR}/.env.runtime (mode 0600)"

# Runs curl with the API key supplied through a 0600 config file rather than argv, so the key is
# never visible in the process list.
curl_with_key() {
  local cfg rc
  cfg="$(mktemp)"
  chmod 0600 "$cfg"
  {
    printf 'header = "X-API-Key: '
    sed -n 's/^API_MASTER_KEY=//p' "${APP_DIR}/.env.runtime" | tr -d '\n'
    printf '"\n'
  } >"$cfg"
  set +e
  curl --config "$cfg" "$@"
  rc=$?
  set -e
  rm -f "$cfg"
  return "$rc"
}

# ------------------------------------------------------ 6. validate and pull ----
"${COMPOSE[@]}" config -q || die "compose configuration is invalid"
log "compose configuration valid"

PREVIOUS_REF=''
if [ -f "${APP_DIR}/.image-previous" ]; then
  PREVIOUS_REF="$(cat "${APP_DIR}/.image-previous")"
fi
RUNNING_REF="$(docker inspect --format '{{.Config.Image}}' openwa 2>/dev/null || true)"
if [ -n "$RUNNING_REF" ]; then
  PREVIOUS_REF="$RUNNING_REF"
fi

"${COMPOSE[@]}" pull --quiet || die "could not pull ${OPENWA_IMAGE_REF}"
log "image pulled"

capture_diagnostics() {
  log '--- diagnostics (secrets redacted) ---'
  "${COMPOSE[@]}" ps 2>&1 | redact || true
  docker inspect --format '{{json .State}}' openwa 2>&1 | redact || true
  docker logs --tail 200 openwa 2>&1 | redact || true
  df -h "$DATA_DIR" / 2>&1 || true
  free -m 2>&1 || true
  log '--- end diagnostics ---'
}

rollback() {
  if [ -z "$PREVIOUS_REF" ] || [ "$PREVIOUS_REF" = "$OPENWA_IMAGE_REF" ]; then
    log "no previous image to roll back to; leaving the container as it is for inspection"
    return 0
  fi
  log "rolling back to ${PREVIOUS_REF}"
  sed -i "s#^OPENWA_IMAGE_REF=.*#OPENWA_IMAGE_REF=${PREVIOUS_REF}#" "${APP_DIR}/.env"
  "${COMPOSE[@]}" up -d --remove-orphans || log "rollback start failed as well"
}

# -------------------------------------------------------------- 7. start it ----
"${COMPOSE[@]}" up -d --remove-orphans || {
  capture_diagnostics
  rollback
  die "container failed to start"
}
log "container started"

# ------------------------------------- 8. HTTP health, then application readiness ----
# These are two different questions. /api/health/ready proves the process serves traffic and both
# database connections answer. It says nothing about whether WhatsApp is authenticated.
wait_for_http_health() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS -m 5 "http://127.0.0.1:${OPENWA_PORT}/api/health/ready" >/dev/null 2>&1; then
      log "HTTP health passed after $((attempt * 5))s"
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_for_http_health || {
  capture_diagnostics
  rollback
  die "the API never became healthy on /api/health/ready within 5 minutes"
}

# Application readiness: an authenticated call through the API-key layer. Proves the key in Secrets
# Manager actually works against this data volume, which HTTP health cannot tell us.
API_CODE="$(curl_with_key -s -o /dev/null -w '%{http_code}' -m 15 \
  "http://127.0.0.1:${OPENWA_PORT}/api/sessions" || true)"
case "$API_CODE" in
200)
  log "application readiness passed: the API key authenticates and /api/sessions answers"
  ;;
401 | 403)
  log "WARNING the API answered ${API_CODE} to an authenticated request, so the key in Secrets Manager is not a valid key for this data volume. That is expected only when the volume was first initialised with a different key: the seed applies on FIRST BOOT ONLY and is ignored afterwards. Use the key in ${DATA_DIR}/.api-key, or mint one through the application API-key endpoints. The container is left running."
  ;;
*)
  capture_diagnostics
  rollback
  die "authenticated readiness probe returned ${API_CODE:-no response}"
  ;;
esac

printf '%s\n' "$OPENWA_IMAGE_REF" >"${APP_DIR}/.image-previous"

# One health publish straight away so CloudWatch reflects reality without waiting for the timer.
systemctl start openwa-health.service || log "could not run the health probe; the timer will retry"

log "deployment complete"
