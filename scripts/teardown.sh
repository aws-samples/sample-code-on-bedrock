#!/usr/bin/env bash
set -euo pipefail

# Teardown for Code on Bedrock.
#
# `cdk destroy` alone CANNOT tear this project down. ApiStack owns two shared
# managed policies (BedrockInvokeAllowed, BedrockDenyAll), but the per-user
# `BedrockUser-<sub>` IAM roles are created OUTSIDE CloudFormation by the
# admin-users Lambda, which attaches those policies to them. CloudFormation
# refuses to delete a managed policy that is still attached to any entity, so
# ApiStack deletion fails with "Cannot delete a policy attached to entities".
#
# This script removes that out-of-band state first — deleting every
# `BedrockUser-*` role and the orphaned `BedrockModels-*` customer-managed
# policies — and only then runs `cdk destroy --all`, so teardown succeeds on
# the first try.
#
# Usage:
#   scripts/teardown.sh                 # interactive (prompts for confirmation)
#   TEARDOWN_ASSUME_YES=1 scripts/teardown.sh   # non-interactive
#   AWS_REGION=eu-west-1 scripts/teardown.sh     # override home region

REGION="${AWS_REGION:-eu-central-1}"
ROLE_PREFIX="BedrockUser-"
MODEL_POLICY_PREFIX="BedrockModels-"

echo "=== Preflight: AWS credentials & target ==="
if ! CALLER_ID_JSON="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  echo "ERROR: Unable to resolve AWS credentials." >&2; exit 1
fi
ACCOUNT_ID="$(printf '%s' "$CALLER_ID_JSON" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).Account')"
echo "  account : $ACCOUNT_ID"
echo "  region  : $REGION"
echo "  profile : ${AWS_PROFILE:-<default credential chain>}"

# --- Discover per-user roles created out-of-band by the admin-users Lambda ----
echo "=== Discover per-user IAM roles (${ROLE_PREFIX}*) ==="
# IAM is global; roles are listed without a region. Use the AWS CLI's own JMESPath
# and text output so we don't depend on jq being installed.
# Note: macOS ships Bash 3.2, which has no `mapfile`/`readarray`, so build the
# array with a read loop for portability.
USER_ROLES=()
while IFS= read -r role_line; do
  [ -n "$role_line" ] && USER_ROLES+=("$role_line")
done < <(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, \`${ROLE_PREFIX}\`)].RoleName" \
  --output text | tr '\t' '\n' | sed '/^$/d')

if [ "${#USER_ROLES[@]}" -eq 0 ]; then
  echo "  none found"
else
  printf '  %s\n' "${USER_ROLES[@]}"
fi

# --- Confirmation gate --------------------------------------------------------
echo
echo "This will PERMANENTLY:"
echo "  * delete ${#USER_ROLES[@]} '${ROLE_PREFIX}*' IAM role(s) and their attached model policies"
echo "  * delete all orphaned '${MODEL_POLICY_PREFIX}*' customer-managed policies"
echo "  * run 'cdk destroy --all' (removes API, Cognito, web UI, metering, crons)"
echo
echo "Retained by design (NOT deleted here): DynamoDB tables (RemovalPolicy.RETAIN)."
echo "Account: ${ACCOUNT_ID}  Region: ${REGION}"
echo
if [ "${TEARDOWN_ASSUME_YES:-}" != "1" ]; then
  read -r -p "Type 'destroy' to proceed: " CONFIRM
  if [ "$CONFIRM" != "destroy" ]; then
    echo "Aborted." >&2; exit 1
  fi
fi

# --- Delete per-user roles ----------------------------------------------------
# For each role: detach all managed policies, delete all inline policies, then
# delete the role. Detaching first is required because a role with attached
# policies cannot be deleted, and (transitively) the shared managed policies
# cannot be deleted by CloudFormation while any role is still attached.
echo "=== Delete per-user IAM roles ==="
for role in "${USER_ROLES[@]:-}"; do
  [ -z "$role" ] && continue
  echo "  role: $role"

  # Detach attached (managed) policies.
  for parn in $(aws iam list-attached-role-policies --role-name "$role" \
      --query 'AttachedPolicies[].PolicyArn' --output text | tr '\t' '\n' | sed '/^$/d'); do
    echo "    detach $parn"
    aws iam detach-role-policy --role-name "$role" --policy-arn "$parn"
  done

  # Delete inline policies (defensive — the current code path uses managed only).
  for pol in $(aws iam list-role-policies --role-name "$role" \
      --query 'PolicyNames[]' --output text | tr '\t' '\n' | sed '/^$/d'); do
    echo "    delete inline policy $pol"
    aws iam delete-role-policy --role-name "$role" --policy-name "$pol"
  done

  echo "    delete role $role"
  aws iam delete-role --role-name "$role"
done

# --- Delete orphaned per-user model policies ----------------------------------
# `BedrockModels-<sub>-<n>` are customer-managed policies created out-of-band by
# sync-model-policies.ts. Now detached (roles are gone), delete them along with
# their non-default versions. These are NOT owned by CDK, so nothing else cleans
# them up.
echo "=== Delete orphaned ${MODEL_POLICY_PREFIX}* customer-managed policies ==="
for arn in $(aws iam list-policies --scope Local \
    --query "Policies[?starts_with(PolicyName, \`${MODEL_POLICY_PREFIX}\`)].Arn" \
    --output text | tr '\t' '\n' | sed '/^$/d'); do
  echo "  policy: $arn"
  # A managed policy can only be deleted once all non-default versions are gone.
  for ver in $(aws iam list-policy-versions --policy-arn "$arn" \
      --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text | tr '\t' '\n' | sed '/^$/d'); do
    echo "    delete version $ver"
    aws iam delete-policy-version --policy-arn "$arn" --version-id "$ver"
  done
  aws iam delete-policy --policy-arn "$arn"
done

# --- Destroy the CloudFormation stacks ----------------------------------------
# With the out-of-band roles/policies gone, the shared managed policies are no
# longer attached to anything and CloudFormation can delete them. Re-running
# destroy also clears any prior DELETE_FAILED state on ApiStack.
echo "=== cdk destroy --all ==="
npx cdk destroy --all --force -c homeRegion="$REGION"

echo "=== Done ==="
echo "Note: DynamoDB tables (Users, UserLimits, UsageCounters, ModelRates, Tiers)"
echo "use RemovalPolicy.RETAIN and still exist. Delete them manually if desired:"
echo "  for t in Users UserLimits UsageCounters ModelRates Tiers; do \\"
echo "    aws dynamodb delete-table --table-name \"\$t\" --region ${REGION}; done"
