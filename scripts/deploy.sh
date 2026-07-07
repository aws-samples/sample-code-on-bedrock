#!/usr/bin/env bash
set -euo pipefail

REQUIRED_NODE_MAJOR=20
REGION="${AWS_REGION:-eu-central-1}"

echo "=== Preflight: Node version ==="
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed or not on PATH." >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "node $(node -v)"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "ERROR: Node $REQUIRED_NODE_MAJOR+ is required (found $(node -v))." >&2; exit 1
fi

echo "=== Preflight: AWS credentials & target ==="
if ! CALLER_ID_JSON="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  echo "ERROR: Unable to resolve AWS credentials." >&2; exit 1
fi
ACCOUNT_ID="$(printf '%s' "$CALLER_ID_JSON" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).Account')"
echo "  account : $ACCOUNT_ID"
echo "  region  : $REGION"
echo "  profile : ${AWS_PROFILE:-<default credential chain>}"

echo "=== Install dependencies ==="
npm ci
(cd web && npm ci)

echo "=== Compile CDK app ==="
npm run build

echo "=== Run tests ==="
npx jest --silent
(cd web && npx vitest run --reporter=dot)

echo "=== Notification sender (SES) ==="
# Per-user budget-warning emails are sent from a verified SES identity. In the
# SES sandbox both this sender and each recipient must be verified. Leave blank
# to keep the built-in placeholder default (no-reply@amazonses.com), which will
# NOT deliver mail until replaced with a verified identity.
DEFAULT_SES_FROM_ADDRESS="no-reply@amazonses.com"
read -r -p "  SES sender email for warning notifications [default: ${DEFAULT_SES_FROM_ADDRESS}]: " SES_FROM_ADDRESS_INPUT
SES_CONTEXT_ARGS=()
if [ -n "${SES_FROM_ADDRESS_INPUT}" ]; then
  SES_SENDER="${SES_FROM_ADDRESS_INPUT}"
  SES_CONTEXT_ARGS=(-c "sesFromAddress=${SES_FROM_ADDRESS_INPUT}")
  echo "  using sender: ${SES_SENDER}"
else
  SES_SENDER="${DEFAULT_SES_FROM_ADDRESS}"
  echo "  using default sender: ${SES_SENDER} (placeholder — will not deliver until verified)"
fi

echo "=== Deploy infrastructure stacks ==="
npx cdk deploy --all --require-approval never --concurrency 4 -c homeRegion="$REGION" "${SES_CONTEXT_ARGS[@]}"

echo "=== Generate .env.production from stack outputs ==="
API_URL=$(aws cloudformation describe-stacks --stack-name ApiStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
COGNITO_DOMAIN=$(aws cloudformation describe-stacks --stack-name IdentityStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolDomainUrl`].OutputValue' --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name IdentityStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)

cat > web/.env.production <<EOF
NEXT_PUBLIC_API_URL=${API_URL}
NEXT_PUBLIC_COGNITO_DOMAIN=${COGNITO_DOMAIN}
NEXT_PUBLIC_COGNITO_CLIENT_ID=${CLIENT_ID}
EOF
echo "  wrote web/.env.production"

echo "=== Build and sync frontend ==="
"$(dirname "$0")/sync-frontend.sh"

echo "=== Sync model rates ==="
SYNC_FN=$(aws cloudformation describe-stacks --stack-name ApiStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`SyncModelRatesFunctionName`].OutputValue' --output text)
aws lambda invoke --function-name "$SYNC_FN" --region "$REGION" --payload '{}' /tmp/sync-model-rates-out.json
echo "  $(node -p 'JSON.parse(JSON.parse(require("fs").readFileSync("/tmp/sync-model-rates-out.json","utf8")).body).synced') models synced"

echo "=== SES sender verification ==="
echo "  Budget-warning emails are sent from ${SES_SENDER}."
echo "  If you haven't already verified this sender in SES, run:"
echo "    aws ses verify-email-identity --email-address ${SES_SENDER} --region ${REGION}"
echo "  (in the SES sandbox, recipients must also be verified — new users are"
echo "   auto-sent a verification link at onboarding via POST /admin/users)."

echo "=== Done ==="

WEB_URL=$(aws cloudformation describe-stacks --stack-name WebStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' --output text)

# Frame the Web UI URL in an ASCII-art box, sized to fit the URL.
WEB_UI_LABEL="Web UI available at:"
WEB_UI_LINES=("${WEB_UI_LABEL}" "${WEB_URL}")
BOX_WIDTH=0
for line in "${WEB_UI_LINES[@]}"; do
  [ "${#line}" -gt "$BOX_WIDTH" ] && BOX_WIDTH="${#line}"
done
BORDER="$(printf '%*s' "$((BOX_WIDTH + 2))" '' | tr ' ' '=')"
echo ""
echo "+${BORDER}+"
for line in "${WEB_UI_LINES[@]}"; do
  printf '| %-*s |\n' "$BOX_WIDTH" "$line"
done
echo "+${BORDER}+"
