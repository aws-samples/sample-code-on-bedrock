import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { STSClient, AssumeRoleCommand, AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import { IAMClient, GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand, UpdateAssumeRolePolicyCommand } from '@aws-sdk/client-iam';

// Actions the per-user role's trust policy must grant the credentials Lambda.
// The AssumeRole call below passes a SourceIdentity and session Tags, so the
// trust policy needs sts:SetSourceIdentity and sts:TagSession in addition to
// sts:AssumeRole. Keep in sync with the trust policy minted at role creation
// (here and in lambdas/admin-users/create.ts).
const REQUIRED_TRUST_ACTIONS = ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'];

/**
 * Returns true iff the given AssumeRolePolicyDocument already grants every
 * action in REQUIRED_TRUST_ACTIONS via an Allow statement. IAM returns the
 * document URL-encoded; unit tests may pass plain JSON, so we try both forms.
 * Any parse failure or missing action returns false → the caller reconciles.
 */
function trustPolicyGrantsRequiredActions(doc: string | undefined): boolean {
  if (!doc) return false;
  let parsed: { Statement?: unknown } | undefined;
  for (const candidate of [doc, tryDecodeURIComponent(doc)]) {
    if (candidate === undefined) continue;
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // try the next representation
    }
  }
  if (!parsed) return false;
  const statements = Array.isArray(parsed.Statement)
    ? parsed.Statement
    : parsed.Statement
      ? [parsed.Statement]
      : [];
  const granted = new Set<string>();
  for (const st of statements as Array<{ Effect?: string; Action?: unknown }>) {
    if (!st || st.Effect !== 'Allow') continue;
    const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
    for (const a of actions) if (typeof a === 'string') granted.add(a);
  }
  return REQUIRED_TRUST_ACTIONS.every((a) => granted.has(a));
}

function tryDecodeURIComponent(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

/**
 * Calls STS AssumeRole, retrying on AccessDenied only when we just created or
 * reconciled the role's trust policy (retryOnAccessDenied) — IAM trust-policy
 * changes are eventually consistent and take a few seconds to reach STS.
 *
 * Delay/attempt budget is env-tunable (and set to 0 in unit tests for speed).
 * Defaults: ~12 attempts × 1s ≈ 12s, comfortably inside the Lambda timeout and
 * API Gateway's 30s ceiling. A healthy role assumes on the first attempt.
 */
async function assumeRoleWithPropagationRetry(
  sts: STSClient,
  command: AssumeRoleCommand,
  retryOnAccessDenied: boolean,
): Promise<AssumeRoleCommandOutput> {
  const baseMs = Number(process.env.ASSUME_ROLE_RETRY_BASE_MS ?? 1000);
  const maxAttempts = retryOnAccessDenied
    ? Math.max(1, Number(process.env.ASSUME_ROLE_RETRY_MAX_ATTEMPTS ?? 12))
    : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return (await sts.send(command)) as AssumeRoleCommandOutput;
    } catch (err: unknown) {
      lastErr = err;
      const name = (err as { name?: string }).name;
      if (name !== 'AccessDenied' || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseMs));
    }
  }
  throw lastErr;
}

export interface CredentialsConfig {
  userLimitsTable: string;
  usersTable: string;
  accountId: string;
  invokePolicy: string;
  credentialsRoleArn: string;
}

export interface CredentialsDeps {
  ddb: DynamoDBClient;
  sts: STSClient;
  iam: IAMClient;
}

export async function processCredentials(
  claims: Record<string, string>,
  body: { assistant?: string },
  config: CredentialsConfig,
  deps: CredentialsDeps,
) {
  const sub = claims.sub;
  const assistant = body.assistant || 'unknown';

  // Check blocked flag
  const limitsResp = await deps.ddb.send(new GetItemCommand({
    TableName: config.userLimitsTable,
    Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
  }));

  if (limitsResp.Item?.blocked?.BOOL) {
    return {
      statusCode: 403,
      body: JSON.stringify({
        message: 'User is blocked — monthly budget exceeded',
        resetTime: 'Monthly budgets reset on the 1st at 00:00 UTC',
        adminContact: 'Contact your admin to request an unblock or budget increase',
      }),
    };
  }

  // Look up tier from Users table
  const userResp = await deps.ddb.send(new GetItemCommand({
    TableName: config.usersTable,
    Key: { PK: { S: `USER#${sub}` }, SK: { S: 'PROFILE' } },
  }));
  const tier = userResp.Item?.tier?.S || 'unknown';

  // Ensure IAM role exists
  const roleName = `BedrockUser-${sub}`;
  const roleArn = `arn:aws:iam::${config.accountId}:role/${roleName}`;

  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: config.credentialsRoleArn },
      Action: ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'],
    }],
  });

  // Ensure the per-user role exists with an up-to-date trust policy.
  //
  // The trust policy is static (it only references the fixed credentials-Lambda
  // role ARN), so in steady state it is set once at creation and never rewritten
  // on subsequent vends — an UpdateAssumeRolePolicy on every credential refresh
  // would be a no-op write that needlessly burns the low, account-global IAM
  // write-rate budget and, when throttled, fails the latency-critical
  // /credentials path.
  //
  // The one exception is drift: roles minted by an older code version only
  // granted sts:AssumeRole, which makes the AssumeRole-with-SourceIdentity call
  // below fail with AccessDenied on sts:SetSourceIdentity. When we detect such a
  // stale trust policy we reconcile it once. Because the canonical policy then
  // satisfies trustPolicyGrantsRequiredActions(), this is a one-time migration
  // per stale role, not a per-vend write.
  //
  // `freshTrustPolicy` is true when we either just created the role or just
  // reconciled a stale trust policy — i.e. STS may not yet honor the trust
  // relationship for the immediately-following AssumeRole (IAM changes are
  // eventually consistent and take seconds to propagate). We use it to retry
  // AssumeRole below rather than 500 on the request that triggers the heal.
  let freshTrustPolicy = false;
  try {
    const existing = await deps.iam.send(new GetRoleCommand({ RoleName: roleName }));
    if (!trustPolicyGrantsRequiredActions(existing.Role?.AssumeRolePolicyDocument)) {
      await deps.iam.send(new UpdateAssumeRolePolicyCommand({
        RoleName: roleName,
        PolicyDocument: trustPolicy,
      }));
      freshTrustPolicy = true;
    }
  } catch (err: unknown) {
    if ((err as { name: string }).name === 'NoSuchEntityException') {
      await deps.iam.send(new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy,
      }));
      await deps.iam.send(new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: config.invokePolicy,
      }));
      freshTrustPolicy = true;
    } else {
      throw err;
    }
  }

  // STS AssumeRole
  //
  // Region scoping is what makes metering airtight. Bedrock writes each
  // invocation's log + metrics in the **source** Region (the Region whose
  // endpoint the client calls), even when a geographic cross-Region inference
  // profile routes the actual inference to a different destination Region. So
  // we must guarantee requests can only originate from Regions that have a
  // metering stack (`ALLOWED_REGIONS` = home + configured source Regions),
  // while still allowing Bedrock's internal routing to reach the destination
  // Regions' foundation models.
  const sourceRegions: string[] = JSON.parse(process.env.ALLOWED_REGIONS || '[]');
  const invokeActions = [
    'bedrock:InvokeModel',
    'bedrock:InvokeModelWithResponseStream',
    'bedrock:Converse',
    'bedrock:ConverseStream',
  ];
  // Patterns matching any (system-defined or application) inference profile
  // whose *source* Region is one of our metered Regions.
  const sourceProfileArns = sourceRegions.map(
    (r) => `arn:aws:bedrock:${r}:${config.accountId}:inference-profile/*`,
  );
  const sessionPolicy = sourceRegions.length > 0 ? JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        // 1. Invoke inference profiles, but only those whose source Region (the
        //    Region in the profile ARN) is metered. This pins where requests
        //    can originate from — and therefore where they get logged/metered.
        Sid: 'InvokeInferenceProfilesInSourceRegions',
        Effect: 'Allow',
        Action: invokeActions,
        Resource: sourceRegions.flatMap((r) => [
          `arn:aws:bedrock:${r}:${config.accountId}:inference-profile/*`,
          `arn:aws:bedrock:${r}:${config.accountId}:application-inference-profile/*`,
        ]),
      },
      {
        // 2. Allow the foundation-model access a cross-Region inference profile
        //    needs to route to its destination Regions (any Region), but ONLY
        //    when invoked via one of our source-Region profiles. Without the
        //    InferenceProfileArn gate this would let a client invoke a model
        //    directly from an unmetered Region.
        Sid: 'InvokeRoutedFoundationModels',
        Effect: 'Allow',
        Action: invokeActions,
        Resource: 'arn:aws:bedrock:*::foundation-model/*',
        Condition: { ArnLike: { 'bedrock:InferenceProfileArn': sourceProfileArns } },
      },
      {
        // 3. Allow direct (non-profile) in-Region model invocation, but only
        //    from metered source Regions.
        Sid: 'InvokeFoundationModelsInSourceRegions',
        Effect: 'Allow',
        Action: invokeActions,
        Resource: 'arn:aws:bedrock:*::foundation-model/*',
        Condition: { StringEquals: { 'aws:RequestedRegion': sourceRegions } },
      },
      {
        // 4. Read-only discovery (listing/describing models + profiles).
        Sid: 'BedrockReadOnlyDiscovery',
        Effect: 'Allow',
        Action: [
          'bedrock:ListFoundationModels',
          'bedrock:ListInferenceProfiles',
          'bedrock:GetFoundationModel',
          'bedrock:GetInferenceProfile',
        ],
        Resource: '*',
      },
    ],
  }) : undefined;

  // Assume the per-user role. When we just created or reconciled the trust
  // policy (freshTrustPolicy), STS may still reject the assume for a few seconds
  // until the IAM change propagates — retry with bounded backoff instead of
  // failing the request that triggered the heal. Healthy roles (the steady-state
  // 99%) take attempt #1 and add no latency.
  const assumeCommand = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sub,
    SourceIdentity: sub,
    DurationSeconds: 900,
    Tags: [
      { Key: 'User', Value: sub },
      { Key: 'Tier', Value: tier },
      { Key: 'Assistant', Value: assistant },
    ],
    ...(sessionPolicy ? { Policy: sessionPolicy } : {}),
  });

  let stsResp;
  try {
    stsResp = await assumeRoleWithPropagationRetry(deps.sts, assumeCommand, freshTrustPolicy);
  } catch (err: unknown) {
    // Trust policy was just (re)provisioned but STS hasn't picked it up within
    // our budget. The role IS now correct, so a retry shortly will succeed —
    // signal that with a retryable 503 rather than a generic 500.
    if (freshTrustPolicy && (err as { name?: string }).name === 'AccessDenied') {
      return {
        statusCode: 503,
        headers: { 'Retry-After': '5' },
        body: JSON.stringify({
          message: 'Credentials role was just provisioned; retry in a few seconds.',
        }),
      };
    }
    throw err;
  }

  const creds = stsResp.Credentials!;
  return {
    statusCode: 200,
    body: JSON.stringify({
      Version: 1,
      AccessKeyId: creds.AccessKeyId,
      SecretAccessKey: creds.SecretAccessKey,
      SessionToken: creds.SessionToken,
      Expiration: creds.Expiration instanceof Date
        ? creds.Expiration.toISOString()
        : creds.Expiration,
    }),
  };
}

const ddb = new DynamoDBClient({});
const sts = new STSClient({});
const iam = new IAMClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  body?: string;
}) => {
  const config: CredentialsConfig = {
    userLimitsTable: process.env.USER_LIMITS_TABLE!,
    usersTable: process.env.USERS_TABLE!,
    accountId: process.env.ACCOUNT_ID!,
    invokePolicy: process.env.BEDROCK_INVOKE_POLICY_ARN!,
    credentialsRoleArn: process.env.CREDENTIALS_ROLE_ARN!,
  };
  const claims = event.requestContext.authorizer.jwt.claims;
  const body = event.body ? JSON.parse(event.body) : {};
  return processCredentials(claims, body, config, { ddb, sts, iam });
};
