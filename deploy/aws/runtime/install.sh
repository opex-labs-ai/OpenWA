#!/bin/bash
#
# Applies a freshly downloaded runtime bundle: fetches the runtime configuration, configures the
# CloudWatch agent, installs the systemd units, then hands over to deploy.sh.
#
# Invoked by /usr/local/bin/openwa-refresh, which the application-deploy workflow runs over SSM.
set -euo pipefail

APP_DIR="$(cat /etc/openwa-app-dir)"
DATA_DIR="$(cat /etc/openwa-data-dir)"
REGION="$(cat /etc/openwa-region)"
CONFIG_PARAM="$(cat /etc/openwa-config-param)"

log() { printf '[openwa-install] %s %s\n' "$(date -Is)" "$*"; }
log "applying bundle in ${APP_DIR}"

# The runtime configuration lives in SSM rather than in user data so that changing the pinned image
# digest does not replace the instance. It holds no secret — only the secret's ARN.
CONFIG_FILE=/etc/openwa-runtime.conf
umask 077
aws ssm get-parameter --name "$CONFIG_PARAM" --region "$REGION" \
  --query 'Parameter.Value' --output text >"$CONFIG_FILE"
chmod 0640 "$CONFIG_FILE"
# shellcheck disable=SC1090,SC1091
set -a && . "$CONFIG_FILE" && set +a

: "${OPENWA_IMAGE_REF:?runtime config is missing OPENWA_IMAGE_REF}"
: "${OPENWA_SYSTEM_LOG_GROUP:?runtime config is missing OPENWA_SYSTEM_LOG_GROUP}"

# ------------------------------------------------------- CloudWatch agent ----
# EC2 cannot report memory or filesystem use from the hypervisor, so the agent is the only way to
# alarm on either. It also ships the bootstrap and deploy logs, which are the two places a failed
# deployment explains itself.
AGENT_DIR=/opt/aws/amazon-cloudwatch-agent/etc
install -d -m 0755 "$AGENT_DIR"
sed -e "s#@@SYSTEM_LOG_GROUP@@#${OPENWA_SYSTEM_LOG_GROUP}#g" \
  -e "s#@@DATA_DIR@@#${DATA_DIR}#g" \
  "${APP_DIR}/cloudwatch-agent.json" >"${AGENT_DIR}/openwa.json"
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c "file:${AGENT_DIR}/openwa.json" >/dev/null
log "cloudwatch agent configured"

# ------------------------------------------------------------- systemd ----
for unit in openwa.service openwa-health.service openwa-health.timer; do
  sed -e "s#@@APP_DIR@@#${APP_DIR}#g" -e "s#@@DATA_DIR@@#${DATA_DIR}#g" \
    "${APP_DIR}/${unit}" >"/etc/systemd/system/${unit}"
done
systemctl daemon-reload
systemctl enable openwa.service openwa-health.timer >/dev/null 2>&1
log "systemd units installed"

exec "${APP_DIR}/deploy.sh"
