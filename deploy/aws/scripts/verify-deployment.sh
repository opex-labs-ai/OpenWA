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
CREATE_COMPLETE | UPDATE_COMPLETE) : ;;
MISSING) fail "stack ${STACK_NAME} does not exist in ${REGION}" ;;
# A rolled-back stack is NOT a successful deployment. It means the update failed and CloudFormation
# reverted it, so whatever this run intended to ship is not deployed. Treating it as passing would
# report success for a deploy that did not happen.
UPDATE_ROLLBACK_COMPLETE | ROLLBACK_COMPLETE)
  fail "stack is in ${STATUS}: the last update failed and was rolled back, so this deployment did not take effect. Check: aws cloudformation describe-stack-events --stack-name ${STACK_NAME} --region ${REGION}"
  ;;
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
# The probe WAITS for readiness rather than sampling once. On a first deployment, and after any
# instance replacement, cloud-init is still installing Docker and pulling a large image when this
# runs, so a single sample would report container=absent and fail a deployment that was simply not
# finished yet. There is no CreationPolicy/cfn-signal on the instance, so this is where the waiting
# has to happen. Set OPENWA_READY_TIMEOUT=0 to sample once instead.
READY_TIMEOUT="${OPENWA_READY_TIMEOUT:-600}"

# Deliberately read-only, and prints no secret. .env.runtime is only tested for existence.
read -r -d '' PROBE <<'PROBE_SCRIPT' || true
set -u
DATA_DIR="$(cat /etc/openwa-data-dir 2>/dev/null || echo /opt/openwa/data)"

deadline=$(($(date +%s) + READY_TIMEOUT))
while :; do
  now_container="$(docker inspect --format '{{.State.Status}}' openwa 2>/dev/null || echo absent)"
  if curl -fsS -m 5 http://127.0.0.1:2785/api/health/ready >/dev/null 2>&1; then
    now_ready=yes
  else
    now_ready=no
  fi
  if [ "$now_container" = 'running' ] && [ "$now_ready" = 'yes' ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
  sleep 10
done

echo "cloud_init=$(cloud-init status 2>/dev/null | sed -n 's/^status: //p' || echo unknown)"
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

# READY_TIMEOUT is prepended rather than interpolated, because the heredoc above is quoted so that
# nothing in the probe is expanded locally by mistake.
PROBE="READY_TIMEOUT=${READY_TIMEOUT}
${PROBE}"

printf 'waiting up to %ss for the container and API to become ready\n' "$READY_TIMEOUT"
COMMAND_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment 'openwa verify-deployment (read-only)' \
  --timeout-seconds 900 \
  --parameters "commands=$(printf '%s' "$PROBE" | python3 -c 'import json,sys; print(json.dumps([sys.stdin.read()]))')" \
  --query 'Command.CommandId' --output text)"

# Long enough to outlast the in-instance wait above plus delivery.
for _ in $(seq 1 90); do
  INVOCATION_STATUS="$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo Pending)"
  case "$INVOCATION_STATUS" in
  Success | Failed | Cancelled | TimedOut) break ;;
  esac
  # 90 x 15s = 22 minutes, comfortably longer than the probe's own 10-minute readiness wait plus
  # Run Command delivery. A shorter budget here would time out while the probe was still waiting.
  sleep 15
done

OUTPUT="$(aws ssm get-command-invocation --region "$REGION" \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text 2>/dev/null || true)"
printf '%s\n' "$OUTPUT"

[ "$INVOCATION_STATUS" = 'Success' ] || fail "the on-instance probe ended as ${INVOCATION_STATUS}"

field() { printf '%s\n' "$OUTPUT" | sed -n "s/^$1=//p" | head -1; }

[ "$(field mounted)" = 'yes' ] ||
  fail 'the persistent volume is NOT mounted. Do not deploy again until this is fixed: the application would initialise an empty data directory and the session would appear lost.'
if [ "$(field container)" != 'running' ]; then
  # cloud-init still running means the instance has simply not finished provisioning, which is a
  # different problem from a container that will not start, and is fixed by waiting or re-running.
  case "$(field cloud_init)" in
  running)
    fail "the container is $(field container) and cloud-init is still running, so provisioning has not finished within ${READY_TIMEOUT}s. Re-run this script, or raise OPENWA_READY_TIMEOUT. Progress: the /openwa/${STACK_NAME}/system log group, stream <instance-id>/cloud-init."
    ;;
  *)
    fail "the container is $(field container), not running (cloud-init: $(field cloud_init)). Check /var/log/openwa-deploy.log over Session Manager."
    ;;
  esac
fi
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
