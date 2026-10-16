#!/usr/bin/env bash
#
# Applies the currently published runtime bundle to the instance, over SSM Run Command.
#
# This is the step that actually makes a deployment take effect. `cdk deploy` publishes the bundle
# and updates the SSM parameter that points at it, but nothing on the instance re-reads that
# parameter by itself: user data runs once, at first boot. On every subsequent deploy the instance
# keeps running the old bundle until something invokes openwa-refresh. That something is this.
#
# Leaving it out produced a deadlock worth remembering: a first boot that failed left no container,
# so verify-deployment.sh failed, so the CDK Deploy workflow failed, so the app-deploy workflow that
# chained off its success never ran, so the fixed bundle was never applied, so the container never
# started. Every subsequent deploy failed the same way. Applying the bundle inside the deploy
# workflow, before verification, is what breaks that cycle.
#
# Shared by aws-cdk-deploy.yml and aws-app-deploy.yml so the two cannot drift.
set -euo pipefail

STACK_NAME="${STACK_NAME:-OpenwaStack}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"

if [ -z "$REGION" ]; then
  echo "apply-runtime-bundle: set AWS_REGION (or AWS_DEFAULT_REGION)" >&2
  exit 2
fi

say() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nFAILED: %s\n' "$*" >&2
  exit 1
}

INSTANCE_ID="${OPENWA_INSTANCE_ID:-}"
if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text 2>/dev/null || true)"
fi
[ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != 'None' ] ||
  fail "could not resolve the instance id from the ${STACK_NAME} outputs. Deploy the infrastructure first."

say "Applying the runtime bundle to ${INSTANCE_ID} (${REGION})"

# The instance must be registered before Run Command can reach it. On a first create the SSM agent
# comes up well before cloud-init finishes, so this is usually immediate.
PING=''
for _ in $(seq 1 30); do
  PING="$(aws ssm describe-instance-information --region "$REGION" \
    --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "$PING" = 'Online' ] && break
  sleep 10
done
[ "$PING" = 'Online' ] ||
  fail "the instance is not registered with Systems Manager, so the bundle cannot be applied. Check the instance role and that outbound 443 is permitted."

# Waits for cloud-init before refreshing, so this cannot run concurrently with the first-boot
# invocation of openwa-refresh and have two `docker compose up` racing each other. It reports
# cloud-init's state either way: `error` means user data failed, which is worth seeing even when the
# refresh below then succeeds.
read -r -d '' APPLY <<'APPLY_SCRIPT' || true
set -u
for _ in $(seq 1 90); do
  state="$(cloud-init status 2>/dev/null | sed -n 's/^status: //p' | tr -d '\r\n')"
  [ "$state" = 'running' ] || break
  sleep 10
done
echo "cloud-init: ${state:-unknown}"
echo "applying the published runtime bundle"
exec /usr/local/bin/openwa-refresh
APPLY_SCRIPT

# --parameters must be a whole JSON object: the `commands=<json>` shorthand keeps newlines escaped,
# so the instance would receive this as one line and bash would reject it.
COMMAND_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "openwa apply-runtime-bundle" \
  --timeout-seconds 1800 \
  --parameters "$(printf '%s' "$APPLY" | python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()]}))')" \
  --query 'Command.CommandId' --output text)"
printf 'SSM command: %s\n' "$COMMAND_ID"

STATUS='Pending'
for _ in $(seq 1 160); do
  STATUS="$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in
  Success | Failed | Cancelled | TimedOut) break ;;
  esac
  sleep 15
done

say 'Output (deploy.sh redacts credentials before printing)'
aws ssm get-command-invocation --region "$REGION" \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text 2>/dev/null || true

if [ "$STATUS" != 'Success' ]; then
  say 'Error output'
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query 'StandardErrorContent' --output text 2>/dev/null >&2 || true
  fail "applying the runtime bundle ended as ${STATUS}. deploy.sh leaves the session intact on failure: it refuses to start on an unmounted volume or a wiped session, never removes a volume, and rolls back to the previous image. See /var/log/openwa-deploy.log on the instance."
fi

say 'Runtime bundle applied'
