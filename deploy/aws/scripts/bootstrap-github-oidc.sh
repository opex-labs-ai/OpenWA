#!/usr/bin/env bash
#
# Idempotent bootstrap of the account-level GitHub OIDC provider.
#
# WHEN YOU NEED THIS
# The normal path is `cdk deploy OpenwaOidcStack`, which creates the provider and the deployment
# role together. Use this script instead when:
#   - the account ALREADY has a GitHub OIDC provider (AWS permits exactly one per URL per account,
#     so CDK must import it rather than create a second); or
#   - you would rather not run CDK with administrative credentials.
#
# It prints the provider ARN. Put that in deploy/aws/cdk.json as openwa:githubOidcProviderArn and
# then run `cdk deploy OpenwaOidcStack`, which will import it instead of creating one.
#
# Safe to run repeatedly: an existing provider is reported, never modified or replaced. It creates
# no role and grants nothing — the role stays in CDK so it is reviewable in version control.
set -euo pipefail

OIDC_HOST='token.actions.githubusercontent.com'
OIDC_URL="https://${OIDC_HOST}"
AUDIENCE='sts.amazonaws.com'

command -v aws >/dev/null 2>&1 || {
  echo 'bootstrap-github-oidc: the AWS CLI is required' >&2
  exit 2
}

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER="$(aws sts get-caller-identity --query Arn --output text)"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"

printf 'account: %s\n' "$ACCOUNT_ID"
printf 'caller:  %s\n' "$CALLER"
printf 'target:  %s\n\n' "$PROVIDER_ARN"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  echo 'The provider already exists. Leaving it untouched.'
  EXISTING_AUDIENCES="$(aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "$PROVIDER_ARN" \
    --query 'ClientIDList' --output text)"
  printf 'audiences: %s\n' "$EXISTING_AUDIENCES"
  case "$EXISTING_AUDIENCES" in
  *"$AUDIENCE"*) : ;;
  *)
    # Adding the audience is additive and affects no existing consumer of the provider.
    printf '\n%s is missing; adding it.\n' "$AUDIENCE"
    aws iam add-client-id-to-open-id-connect-provider \
      --open-id-connect-provider-arn "$PROVIDER_ARN" \
      --client-id "$AUDIENCE"
    ;;
  esac
else
  echo 'Creating the provider.'
  # No thumbprint is supplied: IAM validates token.actions.githubusercontent.com against its own
  # trusted certificate authorities, so a pinned thumbprint would only be another thing to rotate.
  aws iam create-open-id-connect-provider \
    --url "$OIDC_URL" \
    --client-id-list "$AUDIENCE" \
    --tags 'Key=Application,Value=openwa' 'Key=ManagedBy,Value=bootstrap-github-oidc.sh' \
    >/dev/null
  echo 'Created.'
fi

cat <<NEXT

------------------------------------------------------------------------
Provider ARN:

  ${PROVIDER_ARN}

Next steps:

  1. Set it in deploy/aws/cdk.json so CDK imports rather than re-creates it:

       "openwa:githubOidcProviderArn": "${PROVIDER_ARN}"

  2. Create the deployment role (still needs elevated credentials, once):

       cd deploy/aws && npx cdk deploy OpenwaOidcStack

  3. Copy the DeployRoleArn output into the AWS_DEPLOY_ROLE_ARN GitHub variable.

This script created no role and granted no permission. The trust policy lives in
lib/constructs/github-oidc.ts so that who may assume what stays reviewable in git.
------------------------------------------------------------------------
NEXT
