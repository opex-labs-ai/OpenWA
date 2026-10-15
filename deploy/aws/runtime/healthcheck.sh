#!/bin/bash
#
# Publishes the four states that actually matter to CloudWatch, as separate metrics.
#
# They are separate on purpose: an HTTP 200 from the health endpoint does NOT mean WhatsApp is
# authenticated. A deployment can be perfectly healthy by every infrastructure measure while the
# session is logged out and no message can be sent. Only WhatsAppConnected catches that.
#
#   ContainerRunning   the container exists and its state is running
#   ApiReady           /api/health/ready answers 200 (process up, both databases answer)
#   WhatsAppConnected  the configured session reports status "ready"
#   ContainerRestarts  Docker's restart counter, so a crash loop is visible
#
# Nothing here logs the API key or the QR payload.
set -uo pipefail

APP_DIR="$(cat /etc/openwa-app-dir)"
DATA_DIR="$(cat /etc/openwa-data-dir)"
REGION="$(cat /etc/openwa-region)"

# shellcheck disable=SC1090,SC1091
set -a && . /etc/openwa-runtime.conf && set +a

NAMESPACE="${OPENWA_METRIC_NAMESPACE:-OpenWA/Health}"
PORT="${OPENWA_PORT:-2785}"
SESSION_ID="${OPENWA_SESSION_ID:-primary}"
BASE="http://127.0.0.1:${PORT}"

INSTANCE_ID="$(curl -fsS -m 2 -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
  -X PUT http://169.254.169.254/latest/api/token 2>/dev/null |
  { read -r token && curl -fsS -m 2 -H "X-aws-ec2-metadata-token: ${token}" \
    http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null; })"
INSTANCE_ID="${INSTANCE_ID:-unknown}"

log() { printf '[openwa-health] %s %s\n' "$(date -Is)" "$*"; }

# The key is handed to curl through a 0600 config file, never through argv, so it cannot be read out
# of the process list by another local account.
curl_with_key() {
  local cfg rc
  cfg="$(mktemp)"
  chmod 0600 "$cfg"
  {
    printf 'header = "X-API-Key: '
    sed -n 's/^API_MASTER_KEY=//p' "${APP_DIR}/.env.runtime" 2>/dev/null | tr -d '\n'
    printf '"\n'
  } >"$cfg"
  curl --config "$cfg" "$@"
  rc=$?
  rm -f "$cfg"
  return "$rc"
}

# ------------------------------------------------------------ container state ----
container_running=0
container_restarts=0
if state="$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' openwa 2>/dev/null)"; then
  case "$state" in
  'true '*) container_running=1 ;;
  esac
  container_restarts="${state##* }"
fi
case "$container_restarts" in
'' | *[!0-9]*) container_restarts=0 ;;
esac

# ----------------------------------------------------------------- API state ----
api_ready=0
if curl -fsS -m 5 "${BASE}/api/health/ready" >/dev/null 2>&1; then
  api_ready=1
fi

# ------------------------------------------------------- WhatsApp session state ----
# Resolved from the session list rather than a per-session route, so the probe does not depend on
# whether the path parameter is the session name or its UUID.
whatsapp_connected=0
if [ "$api_ready" = '1' ]; then
  sessions_json="$(curl_with_key -fsS -m 10 "${BASE}/api/sessions" 2>/dev/null)"
  if [ -n "${sessions_json:-}" ]; then
    whatsapp_connected="$(SESSION_ID="$SESSION_ID" python3 - "$sessions_json" <<'PY' 2>/dev/null || echo 0
import json
import os
import sys

want = os.environ.get('SESSION_ID', '')
try:
    payload = json.loads(sys.argv[1])
except (ValueError, IndexError):
    print(0)
    raise SystemExit(0)

# The list route has been returned both bare and wrapped in a data envelope; accept either.
if isinstance(payload, dict):
    rows = payload.get('data') or payload.get('sessions') or payload.get('items') or []
else:
    rows = payload
if not isinstance(rows, list):
    rows = []

def ready(row):
    return isinstance(row, dict) and str(row.get('status', '')).lower() == 'ready'

named = [r for r in rows if isinstance(r, dict) and r.get('name') == want]
# Prefer the configured session. With none matching by name, fall back to any ready session so a
# renamed session still reports connectivity rather than a false outage.
print(1 if (any(map(ready, named)) if named else any(map(ready, rows))) else 0)
PY
)"
  fi
fi
case "$whatsapp_connected" in
'' | *[!0-9]*) whatsapp_connected=0 ;;
esac

log "container=${container_running} restarts=${container_restarts} apiReady=${api_ready} whatsapp=${whatsapp_connected}"

# ------------------------------------------------------------------ publish ----
metric_json="$(
  cat <<JSON
[
  {"MetricName":"ContainerRunning","Value":${container_running},"Unit":"None",
   "Dimensions":[{"Name":"InstanceId","Value":"${INSTANCE_ID}"}]},
  {"MetricName":"ApiReady","Value":${api_ready},"Unit":"None",
   "Dimensions":[{"Name":"InstanceId","Value":"${INSTANCE_ID}"}]},
  {"MetricName":"WhatsAppConnected","Value":${whatsapp_connected},"Unit":"None",
   "Dimensions":[{"Name":"InstanceId","Value":"${INSTANCE_ID}"}]},
  {"MetricName":"ContainerRestarts","Value":${container_restarts},"Unit":"Count",
   "Dimensions":[{"Name":"InstanceId","Value":"${INSTANCE_ID}"}]}
]
JSON
)"

aws cloudwatch put-metric-data \
  --region "$REGION" \
  --namespace "$NAMESPACE" \
  --metric-data "$metric_json" ||
  log 'WARNING could not publish metrics; the alarms treat missing data as breaching'

# A logged-out session is the one failure the infrastructure cannot see, so say so plainly in the
# log that ships to CloudWatch.
if [ "$api_ready" = '1' ] && [ "$whatsapp_connected" = '0' ]; then
  log "WARNING the API is healthy but no session reports status \"ready\". WhatsApp is not connected. Check ${DATA_DIR} for authentication state and the session endpoints for the current status; a logged-out session needs a new QR scan."
fi
