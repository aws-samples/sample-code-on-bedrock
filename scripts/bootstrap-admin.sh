#!/usr/bin/env bash
set -euo pipefail

# Bootstrap the first admin user for Code on Bedrock.
#
# This performs the identity/authz half of post-deploy step 3: it creates a
# Cognito user and adds them to the `admin` group. It does NOT (and cannot)
# provision the per-user IAM role or seed UserLimits — that happens when the
# admin logs in via the Hosted UI and calls `POST /admin/users` with their JWT.
# Until that second step runs, `POST /credentials` will 403 for this user.
#
# Usage:
#   scripts/bootstrap-admin.sh admin@example.com
#   ADMIN_EMAIL=admin@example.com scripts/bootstrap-admin.sh
#   scripts/bootstrap-admin.sh            # prompts for the email
#
# Environment overrides:
#   AWS_REGION      home region (default eu-central-1)
#   ADMIN_EMAIL     admin email (else first positional arg, else prompt)
#   TEMP_PASSWORD   temporary password (else a compliant one is generated)
#   ADMIN_GROUP     Cognito group name (default admin)

REGION="${AWS_REGION:-eu-central-1}"
ADMIN_GROUP="${ADMIN_GROUP:-admin}"

echo "=== Preflight: AWS credentials & target ==="
if ! CALLER_ID_JSON="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  echo "ERROR: Unable to resolve AWS credentials." >&2; exit 1
fi
ACCOUNT_ID="$(printf '%s' "$CALLER_ID_JSON" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).Account')"
echo "  account : $ACCOUNT_ID"
echo "  region  : $REGION"
echo "  profile : ${AWS_PROFILE:-<default credential chain>}"

# --- Resolve the admin email --------------------------------------------------
ADMIN_EMAIL="${ADMIN_EMAIL:-${1:-}}"
if [ -z "$ADMIN_EMAIL" ]; then
  read -r -p "  Admin email to create: " ADMIN_EMAIL
fi
if [ -z "$ADMIN_EMAIL" ]; then
  echo "ERROR: no admin email provided." >&2; exit 1
fi
# Minimal sanity check (something@something.tld).
case "$ADMIN_EMAIL" in
  *@*.*) : ;;
  *) echo "ERROR: '$ADMIN_EMAIL' does not look like an email address." >&2; exit 1 ;;
esac

# --- Fetch the User Pool ID from the IdentityStack output ---------------------
echo "=== Resolve Cognito User Pool ==="
USER_POOL_ID="$(aws cloudformation describe-stacks --stack-name IdentityStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text 2>/dev/null || true)"
if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  echo "ERROR: could not read UserPoolId from IdentityStack outputs in $REGION." >&2
  echo "       Is IdentityStack deployed there? (see: cdk deploy IdentityStack)" >&2
  exit 1
fi
echo "  user pool : $USER_POOL_ID"

# --- Generate a compliant temporary password if none supplied -----------------
# Cognito's default policy requires >=8 chars with upper, lower, number, symbol.
if [ -z "${TEMP_PASSWORD:-}" ]; then
  # `tr | head` trips SIGPIPE (exit 141): head closes the pipe after 16 bytes
  # while tr keeps reading /dev/urandom. Under `set -o pipefail` that 141
  # propagates and `set -e` aborts the script. Swallow it — the read succeeded.
  RAND="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 16 || true)"
  TEMP_PASSWORD="Aa1!${RAND}"
  GENERATED_PASSWORD=1
else
  GENERATED_PASSWORD=0
fi

# --- Create the user ----------------------------------------------------------
echo "=== Create Cognito user ==="
INVITE_EMAILED=0
if aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" --region "$REGION" >/dev/null 2>&1; then
  echo "  user '$ADMIN_EMAIL' already exists — skipping creation"
  GENERATED_PASSWORD=0
else
  # --desired-delivery-mediums EMAIL makes Cognito send the invitation email
  # (username + this temporary password) via the pool's built-in email. Without
  # it the API defaults to SMS and, with no phone number, no message is sent.
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
    --temporary-password "$TEMP_PASSWORD" \
    --desired-delivery-mediums EMAIL \
    --region "$REGION" >/dev/null
  echo "  created '$ADMIN_EMAIL' — invitation email sent to $ADMIN_EMAIL"
  INVITE_EMAILED=1
fi

# --- Add to the admin group ---------------------------------------------------
echo "=== Add user to '${ADMIN_GROUP}' group ==="
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --group-name "$ADMIN_GROUP" \
  --region "$REGION"
echo "  '$ADMIN_EMAIL' is now in group '${ADMIN_GROUP}'"

# --- Next steps ---------------------------------------------------------------
DOMAIN_URL="$(aws cloudformation describe-stacks --stack-name IdentityStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolDomainUrl`].OutputValue' --output text 2>/dev/null || true)"

echo
echo "=== Done ==="
if [ "$INVITE_EMAILED" = "1" ]; then
  echo "An invitation email with the temporary password was sent to ${ADMIN_EMAIL}."
  echo "(Delivered via Cognito's built-in email — check spam if it doesn't arrive.)"
fi
if [ "$GENERATED_PASSWORD" = "1" ]; then
  echo "Temporary password (fallback, also in the email): ${TEMP_PASSWORD}"
fi
echo "Next steps:"
echo "  1. Log in via the Cognito Hosted UI and set a permanent password:"
[ -n "$DOMAIN_URL" ] && [ "$DOMAIN_URL" != "None" ] && echo "       ${DOMAIN_URL}"
echo "  2. Call POST /admin/users with the admin JWT to provision the per-user"
echo "     IAM role and seed UserLimits. Until then, POST /credentials will 403."
