# Code on Bedrock

Author: Svetozar Miucin

Serverless control plane that vends short-lived AWS credentials to developers using
Bedrock-backed coding assistants (goose, opencode, any SigV4 Bedrock client),
meters their usage, and enforces daily warnings + monthly kill-switches.

See [DESIGN.md](./DESIGN.md) for architecture and [TODO.md](./TODO.md) for
implementation status.

---

## Quickstart

```bash
# 1. Install root deps (so the pinned CDK is available for bootstrap)
npm ci

# 2. Bootstrap CDK in every region you deploy to (home + any additional Bedrock regions)
export CDK_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://$CDK_ACCOUNT/eu-central-1
# npx cdk bootstrap aws://$CDK_ACCOUNT/eu-west-1   # if you add additionalRegions

# 3. Build, test, and deploy everything.
#    deploy.sh installs deps, builds the static web UI, compiles the CDK app,
#    runs tests, deploys all stacks, then syncs the frontend + model rates.
#    It prompts for the SES sender address; the home Region defaults to
#    eu-central-1 (override with AWS_REGION).
AWS_REGION=eu-central-1 ./scripts/deploy.sh
```

After deploy, note these CloudFormation outputs:

| Stack         | Output               | Use it for                                |
|---------------|----------------------|-------------------------------------------|
| IdentityStack | `UserPoolId`         | creating users, CLI login config          |
| IdentityStack | `UserPoolClientId`   | CLI login, web UI                         |
| IdentityStack | `UserPoolDomainUrl`  | Cognito Hosted UI login URL               |
| ApiStack      | `ApiUrl`             | CLI and web UI API base URL               |
| WebStack      | `CloudFrontUrl`      | public URL of the web UI                  |

Then complete the [post-deploy steps](#post-deploy-steps).

---

## Prerequisites

- **AWS account** with Bedrock model access enabled in every region you plan
  to deploy a regional metering stack to (set via the required `homeRegion`
  context — examples use `eu-central-1`; add more via `additionalRegions`).
- **AWS credentials** in your environment with permission to deploy CDK
  (`AdministratorAccess` is easiest during initial bootstrap).
- **Node.js 20+** and **npm**.
- **Go 1.21+** (only if you want to build the `codeonbedrock` CLI locally).
- **AWS CDK** — installed transitively via `npm ci` as `aws-cdk@2.1119.0`;
  use `npx cdk ...` from the repo root.

---

## What gets deployed

Eight CDK stacks by default, all in a single AWS account (nine if you
configure `additionalRegions`):

| Stack                        | Region         | Purpose                                                |
|------------------------------|----------------|--------------------------------------------------------|
| `CodeOnBedrockStack`           | home           | placeholder / top-level stack                          |
| `DataStack`                  | home           | DynamoDB: Users, UserLimits, UsageCounters, ModelRates, Tiers |
| `IdentityStack`              | home           | Cognito User Pool, Hosted UI, groups                   |
| `ApiStack`                   | home           | HTTP API, all Lambdas, kill-switch, SNS warning topic  |
| `MeteringStack`              | home           | Bedrock log group + Metering Lambda (home region)      |
| `ResetStack`                 | home           | EventBridge crons for daily + monthly resets           |
| `CrosscheckStack`            | home           | hourly CW-metrics-vs-DDB divergence check              |
| `MeteringStack-<region>`     | each extra     | regional Bedrock log group + Metering Lambda           |
| `WebStack`                   | home           | S3 + CloudFront static site for the web UI             |

The home Region is a required CDK context input (`-c homeRegion=...`; examples
use `eu-central-1`). Additional regions default to `[]`
(none) and are configurable via CDK context (see
[Configuration](#configuration)).

---

## Features

### For developers
- **Credential vending** — `POST /credentials` returns 15-minute STS sessions
  compatible with the AWS `credential_process` protocol.
- **Model allowlists** — per-tier or per-user model restrictions enforced via
  STS inline session policies at credential vend time.
- **Usage visibility** — view current day/month spend, limits, and historical
  usage via API or web UI.
- **Web credential vending** — get temporary Bedrock credentials directly from
  the web UI (Credentials tab).

### For admins
- **Tier management** — CRUD tiers with budget limits and allowed model lists;
  changes propagate to all users on the tier.
- **User management** — create, list, edit limits/tier, block, unblock,
  deactivate users.
- **Dashboard** — aggregated stats (total spend, active users, blocked count).
- **Model rates** — CRUD for pricing rates, plus automated sync from the AWS
  Pricing API (runs twice daily).
- **Kill switch** — automatic monthly budget enforcement; manual block/unblock.

---

## API Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Health check |
| POST | `/credentials` | user | Vend STS creds |
| GET | `/me/usage` | user | Day + month usage |
| GET | `/me/usage/history` | user | Historical usage with date range |
| GET | `/me/limits` | user | Read limits + tier info |
| POST | `/admin/users` | admin | Create user, provision IAM role, seed limits |
| GET | `/admin/users` | admin | List all users with limits |
| PUT | `/admin/users/{sub}/limits` | admin | Update daily/monthly USD + allowedModels |
| PUT | `/admin/users/{sub}/tier` | admin | Assign tier to user |
| POST | `/admin/users/{sub}/unblock` | admin | Manual unblock |
| POST | `/admin/users/{sub}/block` | admin | Manual block |
| POST | `/admin/users/{sub}/deactivate` | admin | Disable Cognito user + block |
| GET | `/admin/usage` | admin | All users, current month |
| GET | `/admin/usage/history` | admin | Historical usage for a user |
| GET | `/admin/dashboard` | admin | Aggregated stats |
| GET | `/admin/tiers` | admin | List all tiers |
| POST | `/admin/tiers` | admin | Create tier |
| GET | `/admin/tiers/{tierId}` | admin | Get tier |
| PUT | `/admin/tiers/{tierId}` | admin | Update tier (propagates to users) |
| DELETE | `/admin/tiers/{tierId}` | admin | Delete tier |
| GET | `/admin/model-rates` | admin | List all model rates |
| POST | `/admin/model-rates` | admin | Create/upsert model rate |
| PUT | `/admin/model-rates/{modelId}` | admin | Update model rate |
| DELETE | `/admin/model-rates/{modelId}` | admin | Delete model rate |
| POST | `/admin/sync-model-rates` | admin | Trigger model rate sync from AWS Pricing API |

---

## Detailed deploy

**The recommended path is `./scripts/deploy.sh`** — it runs steps 1, 2, 3, 5,
and 6 below in order (install deps, build the web UI, compile the CDK app,
deploy all stacks, capture outputs), plus runs the test suite, generates
`web/.env.production`, syncs the frontend to S3/CloudFront, and triggers the
initial model-rate sync. It prompts for the SES sender address and honours
`AWS_REGION` as the home Region (default `eu-central-1`):

```bash
AWS_REGION=eu-central-1 ./scripts/deploy.sh
```

The only step it does **not** do is `cdk bootstrap` (step 4) — that's a
one-time-per-account/region action you run yourself first.

The manual steps below are documented for granular control, CI pipelines, or
deploying individual stacks.

### 1. Install dependencies

```bash
npm ci                    # CDK, Lambdas, test tooling
(cd web && npm ci)        # Next.js web UI
(cd cli && go mod download)   # optional: Go CLI deps
```

### 2. Build the web UI

`WebStack` uploads `web/out/` to S3 via `s3-deployment.BucketDeployment`. That
directory only exists after the Next.js static export runs, so this step must
happen **before** `cdk synth` / `cdk deploy`:

```bash
(cd web && npm run build)
```

The web package is configured for `output: 'export'`, which writes static
HTML/JS to `web/out/`.

### 3. Compile the CDK app

```bash
npm run build             # tsc -> compiles bin/ lib/ lambdas/ test/
```

### 4. Bootstrap CDK

CDK needs a bootstrap stack in every account/region combo you deploy to. For
the default config:

```bash
export CDK_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://$CDK_ACCOUNT/eu-central-1
```

If you set `additionalRegions` to include other regions, bootstrap those too.

### 5. Deploy

`homeRegion` is a required context input on every `cdk` command. The examples
below assume you've set `"homeRegion"` under `"context"` in `cdk.json` (so you
don't have to repeat `-c homeRegion=...`); otherwise append it to each command.

Deploy everything:

```bash
npx cdk deploy --all --require-approval never -c homeRegion=eu-central-1
```

Or deploy stacks individually in dependency order:

```bash
npx cdk deploy CodeOnBedrockStack DataStack IdentityStack
npx cdk deploy ApiStack
npx cdk deploy MeteringStack ResetStack CrosscheckStack
npx cdk deploy 'MeteringStack-*'   # regional metering
npx cdk deploy WebStack
```

### 6. Capture outputs

```bash
aws cloudformation describe-stacks \
  --stack-name IdentityStack \
  --query 'Stacks[0].Outputs' --output table

aws cloudformation describe-stacks \
  --stack-name ApiStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text

aws cloudformation describe-stacks \
  --stack-name WebStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' --output text
```

---

## Configuration

### Regional metering coverage (source Regions)

Bedrock writes each invocation's **model-invocation log and CloudWatch
metrics in the source Region** — the Region whose endpoint the client calls —
*not* the destination Region that a geographic cross-Region inference profile
may route the request to. Re-routing is recorded only via the `inferenceRegion`
field *inside* the log record, which still lands in the source Region. (This is
documented for both [geographic](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)
and global cross-Region inference, and is confirmed by inspecting the
account's own invocation logs.)

Consequently, metering only needs to run in the Regions developers actually
**call Bedrock from**, regardless of where cross-Region inference profiles
route the work. The home Region always runs the primary `MeteringStack`; each
additional source Region you enable gets its own `MeteringStack-<region>`.

With the default home Region `eu-central-1` and no extra config, that's a
single metering stack:

```
MeteringStack            # eu-central-1 (home, the only source Region)
```

A developer using the `eu.*` geographic inference profile from `eu-central-1`
is fully metered here even when Bedrock routes the actual inference to
`eu-west-1`, `eu-west-3`, etc. — the log/metric is emitted back in
`eu-central-1`.

### Enabling additional source Regions

If you let developers call Bedrock from Regions other than the home Region,
list those Regions explicitly in the `additionalRegions` CDK context. Each one
gets its own regional metering stack **and** is added to the STS session policy
as an allowed source Region (see below). `additionalRegions` is optional and
defaults to `[]`. Entries must be **concrete Region codes** — there is no
wildcard expansion.

```bash
# Also allow (and meter) eu-west-1 and eu-west-3 as source Regions:
npx cdk deploy --all -c homeRegion=eu-central-1 -c additionalRegions='["eu-west-1","eu-west-3"]'
```

Or persist in `cdk.json` under `"context"`:

```json
"context": {
  "additionalRegions": ["eu-west-1", "eu-west-3"]
}
```

| Context key         | Default | Purpose                                                                 |
|---------------------|---------|-------------------------------------------------------------------------|
| `additionalRegions` | `[]`    | Extra **source Regions** developers may call from; each gets a metering stack |
| `sesFromAddress`    | `no-reply@amazonses.com` | Verified SES identity used as the sender (`Source`) for per-user budget-warning emails. The placeholder default will **not** deliver mail until replaced with an identity verified in SES for the deployment account/Region. `scripts/deploy.sh` prompts for this; leave the prompt blank to keep the default. |

| Entry              | Effect                                                          |
|--------------------|-----------------------------------------------------------------|
| `eu-west-1`        | adds `eu-west-1` as a metered source Region                      |

Each entry must be a concrete Region code; the home Region is always included
(and de-duplicated out of the additional set). Every entry is validated against
the **home Region's partition** using the Region database bundled with
`aws-cdk-lib` (no AWS credentials or network needed at synth time), so a typo or
a Region outside the home partition (e.g. an isolated/GovCloud Region, or a
brand-new Region missing from the bundled database) **fails fast at synth
time** rather than silently expanding or being passed through. To deploy to a
brand-new Region not yet in the bundled database, upgrade `aws-cdk-lib`.

> **You must `cdk bootstrap` every additional source Region** before deploying,
> e.g. `npx cdk bootstrap aws://$CDK_ACCOUNT/eu-west-1`.

### How source Regions are enforced

Region scoping lives on the per-user role's **identity policy**
(`BedrockInvokeAllowed`) — so the role itself is Region-limited, not just the
ephemeral vend-time session policy (which mirrors the same rules as
defense-in-depth). Either way, the **source** Region of every request is pinned
to the metered set, so usage can't escape metering by pointing a client at an
un-metered Region:

- Inference-profile invocation is scoped to profiles whose ARN Region is a
  metered source Region.
- The foundation-model access a cross-Region profile needs to reach its
  **destination** Regions is allowed across all Regions, but only when invoked
  *through* one of those source-Region profiles (gated on
  `bedrock:InferenceProfileArn`) — so it can't be used to call a model directly
  from an un-metered Region.
- Direct (non-profile) in-Region model invocation is restricted via
  `aws:RequestedRegion` to the metered source Regions.

The allowed source-Region set is resolved once (home Region +
`additionalRegions`) and drives both the metering stacks and this policy, so
every source Region a request can originate from has a metering stack.

> **Note:** global cross-Region inference profiles also emit their monitoring
> in the source Region, so they're covered by the source Region's metering
> stack just like geographic profiles.

The home Region is a **required** CDK context input — pass `-c
homeRegion=<region>` on every `cdk` command, or set `"homeRegion"` under
`"context"` in `cdk.json` so you don't have to repeat it. There is no default:
`cdk synth`/`deploy` fails fast if `homeRegion` is omitted, and also if the
value isn't a Region known to the bundled `aws-cdk-lib` Region database.

---

## Post-deploy steps

These are one-time manual steps after `cdk deploy --all` succeeds. They
follow [DESIGN.md §Manual post-deploy steps](./DESIGN.md#manual-post-deploy-steps).

### 1. Verify SES sender (sandbox)

Per-user budget-warning emails are sent from a single SES sender identity,
configured via the `sesFromAddress` CDK context (`scripts/deploy.sh` prompts for
it; blank keeps the placeholder default `no-reply@amazonses.com`, which will not
deliver until replaced). SES starts in **sandbox** mode, so you must verify the
sender identity before any mail is delivered:

```bash
aws ses verify-email-identity --email-address alerts@example.com
```

If you set a custom `sesFromAddress`, verify that exact address (the metering
Lambda's `ses:SendEmail` policy is scoped to it). Verification is **per-Region**
— verify in each Region that runs a metering stack (the home Region plus any
`additionalRegions`).

**Recipients in the sandbox.** While SES is sandboxed, every *recipient* must
also be a verified identity. The `POST /admin/users` Lambda **automatically
initiates recipient verification** (`ses:VerifyEmailIdentity`) for each new
user's email at onboarding, so AWS sends them a confirmation link — the user
just clicks it (link valid 24h). This is best-effort: a SES failure never blocks
user creation, and it's a no-op once SES is out of the sandbox. Two caveats:

- It triggers verification but can't complete it — the user must click the link.
- It runs in the **home Region** only. If you enable `additionalRegions`,
  recipients still need verifying in those Regions (or move SES to production).

To remove per-recipient verification entirely, request **SES production access**
for the account/Region; then only the sender identity needs verifying (ideally a
domain via DKIM) and any address can be emailed.

The admin/ops daily-warning **SNS** topic is separate: subscribe recipients to
it directly (topic ARN is in `ApiStack` outputs or visible in the console);
each subscriber confirms their subscription via the SNS email link.

### 2. Trigger initial model rate sync

Model rates are automatically synced from the AWS Pricing API twice daily
(03:00 and 15:00 UTC). To populate rates immediately after first deploy:

```bash
# Via the API (requires admin JWT):
curl -X POST "$API_URL/admin/sync-model-rates" -H "Authorization: Bearer $TOKEN"

# Or manually seed a rate:
aws dynamodb put-item --table-name ModelRates --item '{
  "modelId": {"S": "anthropic.claude-3-5-sonnet-20241022-v2:0"},
  "SK":      {"S": "-"},
  "inputUsdPer1k":  {"N": "0.003"},
  "outputUsdPer1k": {"N": "0.015"}
}'
```

### 3. Bootstrap the first admin

Create a Cognito user, add them to the `admin` group, then use `POST
/admin/users` to provision their per-user IAM role and DDB limits entry:

```bash
USER_POOL_ID=<from IdentityStack output>

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --temporary-password 'TempPass!123'

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username admin@example.com \
  --group-name admin
```

The admin logs in via the Cognito Hosted UI once, sets a permanent password,
then calls `POST /admin/users` to onboard the rest of the team (that endpoint
provisions the IAM role and seeds `UserLimits`).

### 4. Create tiers

Create your initial tiers via the API or web UI:

```bash
curl -X POST "$API_URL/admin/tiers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tierId":"tier-standard","dailyUsd":5,"monthlyUsd":50,"allowedModels":["anthropic.claude-3-5-sonnet-20241022-v2:0"]}'

curl -X POST "$API_URL/admin/tiers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tierId":"tier-power","dailyUsd":20,"monthlyUsd":200,"allowedModels":[]}'
```

### 5. Confirm Bedrock model invocation logging

CDK enables model invocation logging per region, but the account must already
have model access granted. Request access in the Bedrock console → "Model
access" for each region you deployed a regional metering stack to.

---

## Using Code on Bedrock as a developer

Once deployed and onboarded, end users install the CLI and point their AWS
tooling at it.

```bash
# Build the CLI (or download from release)
(cd cli && CGO_ENABLED=0 go build -o codeonbedrock .)

# First-time setup (prompts for API URL, Cognito domain, client ID)
./codeonbedrock init

# One-time browser login
./codeonbedrock login   # opens Cognito Hosted UI

# Then in any shell that runs goose / opencode / any SigV4 Bedrock client:
export AWS_PROFILE=codeonbedrock
```

The CLI writes a `[profile codeonbedrock]` block to `~/.aws/config` using
`credential_process`. The AWS SDK then calls `codeonbedrock creds` on every
credential refresh, which in turn calls `POST /credentials` on the API and
returns 15-minute STS credentials for that user's per-user IAM role.

Check status at any time:

```bash
./codeonbedrock status    # current day + month usage, limits, blocked flag
./codeonbedrock logout    # wipes local tokens
```

---

## Web UI

The web UI is accessible at the CloudFront URL from the `WebStack` output.

**User views:**
- **My Usage** — shows current day and month spend, per-model breakdown, and
  budget limits with progress bars.
- **Credentials** — generate temporary Bedrock credentials directly in the
  browser (useful for testing or one-off use).

**Admin views** (visible only to users in the `admin` Cognito group):
- **Overview** — dashboard with total spend, active user count, blocked users,
  plus a usage overview table.
- **Users** — list all users; click to edit tier assignment, budget limits,
  or block/unblock/deactivate.
- **Tiers** — create, edit, delete tier configurations (budget limits +
  allowed model lists).
- **Model Rates** — view and manage per-model pricing rates used for cost
  computation.

---

## Development

### Run tests

```bash
./scripts/test.sh               # CDK + Lambda unit tests (Jest) + web + CLI
# Or individually:
npm test                        # CDK + Lambda unit tests (Jest)
(cd web && npm test)            # Web UI component tests (Vitest)
(cd cli && go test ./...)       # CLI tests (Go)
```

### Deploy

```bash
./scripts/deploy.sh             # Build + deploy all stacks
```

### Synth only (no deploy)

```bash
npm run build && npx cdk synth -c homeRegion=eu-central-1
```

### Diff against deployed

```bash
npx cdk diff --all -c homeRegion=eu-central-1
```

### Watch-mode compile

```bash
npm run watch
```

---

## Teardown

**Use `./scripts/teardown.sh`.** A plain `cdk destroy` will **fail** on
`ApiStack`: it owns the shared `BedrockInvokeAllowed` / `BedrockDenyAll` managed
policies, but the per-user `BedrockUser-<sub>` IAM roles are created outside
CloudFormation by the `POST /admin/users` Lambda and have those policies
attached. CloudFormation refuses to delete a managed policy that is still
attached to any entity ("Cannot delete a policy attached to entities").

`teardown.sh` removes that out-of-band state first — deleting every
`BedrockUser-*` role and the orphaned `BedrockModels-*` customer-managed
policies — and only then runs `cdk destroy --all`, so teardown succeeds on the
first try:

```bash
./scripts/teardown.sh                       # interactive: type 'destroy' to confirm
TEARDOWN_ASSUME_YES=1 ./scripts/teardown.sh  # non-interactive (CI)
AWS_REGION=eu-west-1 ./scripts/teardown.sh   # override home Region
```

It prints the manual DynamoDB cleanup command at the end (tables are retained —
see below).

### Manual teardown

If you prefer to run the steps yourself, first delete the per-user roles and
their orphaned model policies (otherwise `ApiStack` destroy fails):

```bash
# Detach policies from and delete every per-user role
aws iam list-roles --query 'Roles[?starts_with(RoleName,`BedrockUser-`)].RoleName' --output text \
  | xargs -n1 -I{} sh -c 'aws iam list-attached-role-policies --role-name {} --query "AttachedPolicies[].PolicyArn" --output text \
    | xargs -n1 aws iam detach-role-policy --role-name {} --policy-arn; aws iam delete-role --role-name {}'

# Delete orphaned per-user model policies
aws iam list-policies --scope Local --query 'Policies[?starts_with(PolicyName,`BedrockModels-`)].Arn' --output text \
  | xargs -n1 aws iam delete-policy --policy-arn
```

Then destroy the stacks (in dependency order):

```bash
# UI and regional stacks first (they have no dependents)
npx cdk destroy WebStack 'MeteringStack-*'

# Then middle-tier stacks
npx cdk destroy CrosscheckStack ResetStack MeteringStack ApiStack

# Then foundations
npx cdk destroy IdentityStack DataStack CodeOnBedrockStack
```

Note: `DataStack` DynamoDB tables use `RemovalPolicy.RETAIN`. After destroy
they remain in the account and must be deleted manually if you want them
gone:

```bash
for t in Users UserLimits UsageCounters ModelRates Tiers; do
  aws dynamodb delete-table --table-name "$t"
done
```

---

## Troubleshooting

- **`cdk deploy` fails on `WebStack` with "cannot find asset web/out"** —
  you skipped step 2. Run `(cd web && npm run build)` first.
- **Metering Lambda logs "unknown model, skipping"** — the model's rates
  are not in the `ModelRates` table. Trigger a sync via
  `POST /admin/sync-model-rates` or add the rate manually.
- **`POST /credentials` returns 403 for a freshly-created user** — make sure
  you called `POST /admin/users` after `admin-create-user`. That endpoint
  creates the per-user IAM role and seeds `UserLimits`; without it the role
  doesn't exist and the STS AssumeRole fails.
- **Bedrock invocation logs not appearing** — confirm model access is enabled
  in that region, and that the user is actually invoking via the vended STS
  credentials (not long-lived IAM user keys, which bypass the role).
- **`cdk bootstrap` required in additional regions** — you must bootstrap
  every region listed in `additionalRegions`, not just the home region.
- **User can invoke models outside their allowlist** — model allowlists are
  enforced via STS session policy at credential vend time. Existing cached
  credentials (up to 15 min old) may still have the previous allowlist.
  The restriction applies on next `codeonbedrock creds` call.
- **Tier changes not reflected for a user** — `PUT /admin/tiers/{tierId}`
  propagates limits to all users on that tier. If a user has a per-user
  override (set via `PUT /admin/users/{sub}/limits`), tier propagation
  does not overwrite it.
