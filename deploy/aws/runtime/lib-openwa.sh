#!/usr/bin/env bash
# shellcheck shell=bash
#
# Helpers shared by deploy.sh and healthcheck.sh. Sourced, never executed.
#
# These two lived in both scripts and had already drifted apart (one swallowed sed's stderr, the
# other toggled errexit around curl), which is exactly the kind of divergence that makes a security
# property true in one place and not the other.

# Path to the runtime env file holding API_MASTER_KEY. Overridable for testing.
OPENWA_ENV_RUNTIME="${OPENWA_ENV_RUNTIME:-/opt/openwa/app/.env.runtime}"

# Runs curl with the API key supplied through a mode-0600 config file rather than on the command
# line, so the key is never visible in the process list to another local account.
#
# Safe to call under `set -e`: curl's exit status is captured and returned rather than aborting the
# caller, so a non-2xx response is the caller's decision to interpret.
openwa_curl_with_key() {
  local cfg rc
  cfg="$(mktemp)"
  chmod 0600 "$cfg"
  {
    printf 'header = "X-API-Key: '
    sed -n 's/^API_MASTER_KEY=//p' "$OPENWA_ENV_RUNTIME" 2>/dev/null | tr -d '\n'
    printf '"\n'
  } >"$cfg"
  rc=0
  curl --config "$cfg" "$@" || rc=$?
  rm -f "$cfg"
  return "$rc"
}

# Masks anything credential-shaped in captured output. Applied to every diagnostic before it is
# printed, because these logs are shipped to CloudWatch and surfaced in workflow output.
openwa_redact() {
  sed -E 's/((API_MASTER_KEY|api[_-]?key|authorization|x-api-key|token|secret|password)[[:space:]]*[:=][[:space:]]*"?)[^[:space:],"}]+/\1***REDACTED***/Ig'
}
