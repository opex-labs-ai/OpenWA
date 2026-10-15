#!/usr/bin/env bash
#
# Post-deployment verification. Read-only: it inspects, it never changes anything.
#
# Answers four separate questions, because a green answer to one says nothing about the others:
#   1. Did CloudFormation finish?
#   2. Is the instance reachable through Systems Manager?
#   3. Is the persistent volume mounted and the container running?
#   4. Is WhatsApp actually connected?
#
# Exits non-zero on 1-3. Question 4 is reported but does NOT fail the run: on a first deployment
# nobody has scanned the QR code yet, and that is not a deployment failure.
set -euo pipefail

STACK_NAME="${STACK_NAME:-OpenwaStack}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"

if [ -z "$REGION" ]; then
  echo "verify-deployment: set AWS_REGION (or AWS_DEFAULT_REGION)" >&2
  exit 2
fi

say() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nFAILED: %s\n' "$*" >&2
  exit 1
}

# ------------------------------------------------------- 1. stack completed ----
say "CloudFormation stack ${STACK_NAME} (${REGION})"
STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo 'MISSING')"
printf 'status: %s\n' "$STATUS"
case "$STATUS" in
CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE) : ;;
MISSING) fail "stack ${STACK_NAME} does not exist in ${REGION}" ;;
*) fail "stack is in ${STATUS}, not a completed state" ;;
esac

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
[ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != 'None' ] || fail 'the stack has no InstanceId output'
printf 'instance: %s\n' "$INSTANCE_ID"

# ----------------------------------------------- 2. Systems Manager reachable ----
# This is the only administrative path: there is no SSH and no inbound port. If it is not Online,
# an operator cannot get in at all, which matters more than any application symptom.
say 'Systems Manager connectivity'
PING=''
for _ in $(seq 1 30); do
  PING="$(aws ssm describe-instance-information --region "$REGION" \
    --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "$PING" = 'Online' ] && break
  sleep 10
done
printf 'ping status: %s\n' "${PING:-unknown}"
[ "$PING" = 'Online' ] ||
  fail "the instance is not registered with Systems Manager. Without it there is no way in: check the instance role, the SSM agent, and that outbound 443 is permitted."

# --------------------------------------- 3 & 4. on-instance state, via Run Command ----
say 'On-instance state'
# Deliberately read-only, and prints no secret. .env.runtime is only tested for existence.
read -r -d '' PROBE <<'PROBE_SCRIPT' || true
set -u
DATA_DIR="$(cat /etc/openwa-data-dir 2>/dev/null || echo /opt/openwa/data)"
echo "mounted=$(mountpoint -q "$DATA_DIR" && echo yes || echo no)"
echo "data_uuid=$(findmnt -n -o UUID --target "$DATA_DIR" 2>/dev/null || echo none)"
echo "disk_use=$(df -h --output=pcent "$DATA_DIR" 2>/dev/null | tail -1 | tr -d ' ' || echo unknown)"
echo "container=$(docker inspect --format '{{.State.Status}}' openwa 2>/dev/null || echo absent)"
echo "restarts=$(docker inspect --format '{{.RestartCount}}' openwa 2>/dev/null || echo 0)"
echo "image=$(docker inspect --format '{{.Config.Image}}' openwa 2>/dev/null || echo none)"
echo "runtime_env=$([ -s /opt/openwa/app/.env.runtime ] && echo present || echo missing)"
echo "api_live=$(curl -fsS -m 5 http://127.0.0.1:2785/api/health/live >/dev/null 2>&1 && echo yes || echo no)"
echo "api_ready=$(curl -fsS -m 5 http://127.0.0.1:2785/api/health/ready >/dev/null 2>&1 && echo yes || echo no)"
if [ -d "$DATA_DIR/baileys" ]; then
  echo "baileys_creds=$(find "$DATA_DIR/baileys" -name creds.json 2>/dev/null | wc -l)"
else
  echo "baileys_creds=0"
fi
PROBE_SCRIPT

COMMAND_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment 'openwa verify-deployment (read-only)' \
  --parameters "commands=$(printf '%s' "$PROBE" | python3 -c 'import json,sys; print(json.dumps([sys.stdin.read()]))')" \
  --query 'Command.CommandId' --output text)"

for _ in $(seq 1 30); do
  INVOCATION_STATUS="$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo Pending)"
  case "$INVOCATION_STATUS" in
  Success | Failed | Cancelled | TimedOut) break ;;
  esac
  sleep 5
done

OUTPUT="$(aws ssm get-command-invocation --region "$REGION" \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text 2>/dev/null || true)"
printf '%s\n' "$OUTPUT"

[ "$INVOCATION_STATUS" = 'Success' ] || fail "the on-instance probe ended as ${INVOCATION_STATUS}"

field() { printf '%s\n' "$OUTPUT" | sed -n "s/^$1=//p" | head -1; }

[ "$(field mounted)" = 'yes' ] ||
  fail 'the persistent volume is NOT mounted. Do not deploy again until this is fixed: the application would initialise an empty data directory and the session would appear lost.'
[ "$(field container)" = 'running' ] || fail "the container is $(field container), not running"
[ "$(field api_ready)" = 'yes' ] || fail 'the API is not answering /api/health/ready'

say 'Infrastructure verification passed'

# Reported, never fatal: an unauthenticated session is the expected state before the first QR scan.
if [ "$(field baileys_creds)" = '0' ]; then
  cat <<'NOTE'

WhatsApp is NOT yet authenticated (no Baileys credentials on the volume).
That is expected on a first deployment. Follow "First-time authentication" in
deploy/aws/README.md to scan the QR code through an SSM port-forwarding session.
NOTE
else
  printf '\nWhatsApp credentials are present on the persistent volume.\n'
  printf 'Connection state is published as the OpenWA/Health WhatsAppConnected metric.\n'
fi
