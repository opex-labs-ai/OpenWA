#!/bin/bash
#
# OpenWA EC2 bootstrap, inlined into EC2 user data and run once per instance launch by cloud-init.
#
# This file is DELIBERATELY STABLE. Anything that changes here changes the user data, and changing
# user data replaces the instance. Everything that changes often — the compose file, the deploy
# script, the pinned image digest — is fetched at runtime from the bundle and the config parameter,
# so editing those never touches this.
#
# Double-at delimited placeholders below are substituted at synth time by
# lib/constructs/openwa-ec2.ts, which fails the synth if any is left unresolved.
set -euo pipefail

MOUNT_POINT='@@MOUNT_POINT@@'
APP_DIR='@@APP_DIR@@'
DEVICE_ALIAS='@@DEVICE_ALIAS@@'
FS_LABEL='@@FS_LABEL@@'
BUNDLE_PARAM='@@BUNDLE_PARAM@@'
CONFIG_PARAM='@@CONFIG_PARAM@@'
TARGET_REGION='@@REGION@@'
COMPOSE_VERSION='@@COMPOSE_VERSION@@'
COMPOSE_SHA_X86='@@COMPOSE_SHA_X86@@'
COMPOSE_SHA_ARM='@@COMPOSE_SHA_ARM@@'
SWAP_MIB='@@SWAP_MIB@@'
RUN_UID='@@RUN_UID@@'
RUN_GID='@@RUN_GID@@'

exec > >(tee -a /var/log/openwa-bootstrap.log) 2>&1
log() { printf '[openwa-bootstrap] %s %s\n' "$(date -Is)" "$*"; }
log "start"

# ---------------------------------------------------------------- packages ----
dnf -y install docker amazon-cloudwatch-agent unzip tar >/dev/null
if ! command -v aws >/dev/null 2>&1; then
  dnf -y install awscli-2 >/dev/null || dnf -y install awscli >/dev/null
fi
log "packages installed"

# ------------------------------------------------- docker compose plugin ------
# Amazon Linux 2023 ships no docker-compose-plugin package, so the binary is fetched. Pinned to an
# exact version and checksum-verified: an unpinned download would make the deployment depend on
# whatever upstream serves that day.
case "$(uname -m)" in
x86_64)
  COMPOSE_ARCH='x86_64'
  COMPOSE_SHA="$COMPOSE_SHA_X86"
  ;;
aarch64)
  COMPOSE_ARCH='aarch64'
  COMPOSE_SHA="$COMPOSE_SHA_ARM"
  ;;
*)
  log "FATAL unsupported architecture $(uname -m)"
  exit 1
  ;;
esac

install -d -m 0755 /usr/libexec/docker/cli-plugins
COMPOSE_TMP="$(mktemp)"
curl -fsSL --retry 5 --retry-delay 3 -o "$COMPOSE_TMP" \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}"
printf '%s  %s\n' "$COMPOSE_SHA" "$COMPOSE_TMP" | sha256sum -c -
install -m 0755 "$COMPOSE_TMP" /usr/libexec/docker/cli-plugins/docker-compose
rm -f "$COMPOSE_TMP"
log "docker compose ${COMPOSE_VERSION} installed and verified"

# ------------------------------------------------------------ docker daemon ----
# live-restore keeps the container running across a daemon restart. The json-file defaults here are
# the dual-logging cache that keeps `docker logs` usable over SSM even though the container itself
# ships its logs to CloudWatch with the awslogs driver.
install -d -m 0755 /etc/docker
cat >/etc/docker/daemon.json <<'JSON'
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
# Deliberately NOT started here. Docker must not run until the session volume is mounted, so both
# the drop-in and the start happen after the mount below.
log "docker configured (start deferred until the data volume is mounted)"

# --------------------------------------------------------- persistent volume ----
# On Nitro instances the /dev/sdf alias is not honoured: the volume shows up as an NVMe device whose
# number is not stable. ebsnvme-id maps an NVMe device back to the alias that was requested.
resolve_device() {
  local alias_name candidate mapped
  alias_name="$(basename "$DEVICE_ALIAS")"
  # Up to five minutes: the attachment can lag behind boot. The counter itself is unused, hence `_`.
  for _ in $(seq 1 60); do
    if [ -b "$DEVICE_ALIAS" ]; then
      printf '%s' "$DEVICE_ALIAS"
      return 0
    fi
    for candidate in /dev/nvme*n1; do
      [ -b "$candidate" ] || continue
      mapped="$(/sbin/ebsnvme-id -b "$candidate" 2>/dev/null || true)"
      case "$mapped" in
      *"$alias_name"*)
        printf '%s' "$candidate"
        return 0
        ;;
      esac
    done
    sleep 5
  done
  return 1
}

DEVICE="$(resolve_device)" || {
  log "FATAL data volume ${DEVICE_ALIAS} never appeared after 5 minutes"
  exit 1
}
log "data volume resolved to ${DEVICE}"

# Format ONLY when the volume carries no filesystem. Reformatting would destroy the WhatsApp
# authentication state, which cannot be recovered without scanning a new QR code.
if blkid -p "$DEVICE" >/dev/null 2>&1; then
  log "existing filesystem on ${DEVICE} — preserving it, not formatting"
else
  log "no filesystem on ${DEVICE} — first boot, creating ext4 labelled ${FS_LABEL}"
  mkfs.ext4 -m 0 -L "$FS_LABEL" "$DEVICE"
fi

FS_UUID="$(blkid -s UUID -o value "$DEVICE")"
[ -n "$FS_UUID" ] || {
  log "FATAL could not read a filesystem UUID from ${DEVICE}"
  exit 1
}

install -d -m 0755 "$MOUNT_POINT"
# Mounted by UUID, never by device name. nofail plus a device timeout so a detached volume leaves a
# reachable instance to debug rather than a boot hang; deploy.sh then refuses to start the app.
if ! grep -qF "UUID=${FS_UUID}" /etc/fstab; then
  printf 'UUID=%s %s ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2\n' \
    "$FS_UUID" "$MOUNT_POINT" >>/etc/fstab
fi
systemctl daemon-reload
mount -a
mountpoint -q "$MOUNT_POINT" || {
  log "FATAL ${MOUNT_POINT} did not mount"
  exit 1
}
printf '%s\n' "$FS_UUID" >/etc/openwa-data-uuid
log "mounted ${MOUNT_POINT} (UUID ${FS_UUID})"

# The container drops to uid/gid 997 via gosu, so the data tree must be owned by it. 0750 keeps the
# session files unreadable to any other unprivileged account on the host.
install -d -o "$RUN_UID" -g "$RUN_GID" -m 0750 "$MOUNT_POINT"
for sub in sessions baileys media plugins; do
  install -d -o "$RUN_UID" -g "$RUN_GID" -m 0750 "${MOUNT_POINT}/${sub}"
done

# ------------------------------------------------------- docker, after the mount ----
# THE structural guard against an apparent session loss.
#
# openwa.service carries RequiresMountsFor, but that only governs the unit. Docker can start a
# container by itself through its restart policy, and the fstab entry is `nofail`, which means the
# mount is NOT ordered before local-fs.target and therefore not before docker.service. On a slow
# EBS attach, dockerd could come up first, resolve the bind mount to the still-empty mountpoint
# directory on the root disk, and the application would initialise a fresh data directory and show
# a new QR code -- indistinguishable from having lost the session.
#
# Making the mount a requirement of docker.service itself closes that hole regardless of any
# container's restart policy: no mount, no Docker, so nothing can write to the wrong directory.
# If the volume genuinely cannot mount, Docker fails to start, the health metrics stop, and the
# alarms fire -- which is the correct outcome, and the instance is still reachable over SSM.
install -d -m 0755 /etc/systemd/system/docker.service.d
cat >/etc/systemd/system/docker.service.d/10-openwa-data-mount.conf <<DROPIN
[Unit]
RequiresMountsFor=${MOUNT_POINT}
DROPIN
systemctl daemon-reload
systemctl enable --now docker
log "docker enabled, gated on ${MOUNT_POINT} being mounted"

# ------------------------------------------------------------------- swap ----
# Insurance against a transient spike on a 2 GiB host. Not a substitute for sizing: switching to the
# whatsapp-web.js engine needs a larger instance, not more swap.
if [ "$SWAP_MIB" -gt 0 ] && [ ! -f /swapfile ]; then
  fallocate -l "${SWAP_MIB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MIB" status=none
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
  log "swap enabled (${SWAP_MIB} MiB)"
fi

# ------------------------------------------------- runtime refresh entrypoint ----
printf '%s\n' "$BUNDLE_PARAM" >/etc/openwa-bundle-param
printf '%s\n' "$CONFIG_PARAM" >/etc/openwa-config-param
printf '%s\n' "$TARGET_REGION" >/etc/openwa-region
printf '%s\n' "$MOUNT_POINT" >/etc/openwa-data-dir
printf '%s\n' "$APP_DIR" >/etc/openwa-app-dir

cat >/usr/local/bin/openwa-refresh <<'REFRESH'
#!/bin/bash
#
# Fetches the current runtime bundle and applies it. This is the entry point the application-deploy
# workflow invokes through SSM Run Command. Static by design — see userdata/bootstrap.sh.
set -euo pipefail
BUNDLE_PARAM="$(cat /etc/openwa-bundle-param)"
REGION="$(cat /etc/openwa-region)"
APP_DIR="$(cat /etc/openwa-app-dir)"

BUNDLE_URL="$(aws ssm get-parameter --name "$BUNDLE_PARAM" --region "$REGION" \
  --query 'Parameter.Value' --output text)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
aws s3 cp "$BUNDLE_URL" "$TMP/bundle.zip" --region "$REGION" --only-show-errors
install -d -m 0755 "$APP_DIR"
unzip -oq "$TMP/bundle.zip" -d "$APP_DIR"
chmod 0755 "$APP_DIR"/*.sh
exec "$APP_DIR/install.sh"
REFRESH
chmod 0755 /usr/local/bin/openwa-refresh

log "running first bundle refresh"
/usr/local/bin/openwa-refresh
log "done"
