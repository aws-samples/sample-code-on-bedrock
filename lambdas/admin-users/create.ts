import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, CreateRoleCommand, AttachRolePolicyCommand } from '@aws-sdk/client-iam';
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses';
import { syncModelPolicies } from '../shared/sync-model-policies';

export interface CreateUserConfig {
  userPoolId: string;
  userLimitsTable: string;
  usersTable: string;
  tiersTable: string;
  accountId: string;
  invokePolicy: string;
  credentialsLambdaRoleArn: string;
}

export interface CreateUserDeps {
  cognito: CognitoIdentityProviderClient;
  iam: IAMClient;
  ddb: DynamoDBClient;
  ses: SESClient;
}

export async function processCreateUser(
  email: string,
  tier: string,
  config: CreateUserConfig,
  deps: CreateUserDeps,
) {
  // Look up tier limits
  const tierResp = await deps.ddb.send(new GetItemCommand({
    TableName: config.tiersTable,
    Key: { tierId: { S: tier } },
  }));
  if (!tierResp.Item) {
    return { statusCode: 400, body: JSON.stringify({ message: 'unknown tier' }) };
  }
  const dailyUsd = tierResp.Item.dailyUsd.N!;
  const monthlyUsd = tierResp.Item.monthlyUsd.N!;
  const tierAllowedModels = tierResp.Item.allowedModels?.L ?? [];

  const createResp = await deps.cognito.send(new AdminCreateUserCommand({
    UserPoolId: config.userPoolId,
    Username: email,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ],
  }));

  const sub = createResp.User!.Username!;

  const roleName = `BedrockUser-${sub}`;
  await deps.iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { AWS: config.credentialsLambdaRoleArn },
        // The credentials Lambda assumes this role with a SourceIdentity (the
        // user's sub, for log/CloudTrail attribution) and session Tags, so the
        // trust policy must allow sts:SetSourceIdentity and sts:TagSession in
        // addition to sts:AssumeRole. Keep this in sync with the trust policy
        // minted by the credentials Lambda's lazy-create path
        // (lambdas/credentials/index.ts); a mismatch causes AssumeRole to fail
        // with AccessDenied on sts:SetSourceIdentity.
        Action: ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'],
      }],
    }),
  }));

  await deps.iam.send(new AttachRolePolicyCommand({
    RoleName: roleName,
    PolicyArn: config.invokePolicy,
  }));

  await deps.ddb.send(new PutItemCommand({
    TableName: config.userLimitsTable,
    Item: {
      PK: { S: `USER#${sub}` },
      SK: { S: 'LIMITS' },
      dailyUsd: { N: dailyUsd },
      monthlyUsd: { N: monthlyUsd },
      blocked: { BOOL: false },
      // Denormalize the tier's model allowlist so the credentials Lambda can
      // enforce it without reading the Tiers table. Omitted when the tier has
      // no allowlist (unrestricted).
      ...(tierAllowedModels.length > 0 ? { allowedModels: { L: tierAllowedModels } } : {}),
    },
  }));

  await deps.ddb.send(new PutItemCommand({
    TableName: config.usersTable,
    Item: {
      PK: { S: `USER#${sub}` },
      SK: { S: 'PROFILE' },
      email: { S: email },
      tier: { S: tier },
      createdAt: { S: new Date().toISOString() },
    },
  }));

  // Sync IAM model policies if tier has an allowlist
  const effectiveModels = tierAllowedModels.map((m) => m.S!).filter(Boolean);
  if (effectiveModels.length > 0) {
    await syncModelPolicies({
      sub,
      allowedModels: effectiveModels,
      accountId: config.accountId,
      bedrockInvokePolicyArn: config.invokePolicy,
      deps: { iam: deps.iam },
    });
  }

  // Kick off SES recipient verification so budget-warning emails can reach this
  // user while SES is in the sandbox (where every recipient must be a verified
  // identity). SES emails the address a confirmation link they must click — we
  // can't complete it for them, only trigger it. Best-effort: a SES failure
  // here must NOT fail user provisioning (the Cognito user, IAM role and limits
  // above are the critical path), and if SES is already out of the sandbox this
  // is simply unnecessary. Verification is per-Region; this runs in the home
  // Region only, so additional source Regions still need their own verification.
  try {
    await deps.ses.send(new VerifyEmailIdentityCommand({ EmailAddress: email }));
  } catch (err) {
    console.error('SES recipient verification could not be initiated — continuing', err);
  }

  return { statusCode: 201, body: JSON.stringify({ sub }) };
}

const cognito = new CognitoIdentityProviderClient({});
const iam = new IAMClient({});
const ddb = new DynamoDBClient({});
const ses = new SESClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  body?: string;
}) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  try {
    const { email, tier } = JSON.parse(event.body!);
    return await processCreateUser(email, tier, {
      userPoolId: process.env.USER_POOL_ID!,
      userLimitsTable: process.env.USER_LIMITS_TABLE!,
      usersTable: process.env.USERS_TABLE!,
      tiersTable: process.env.TIERS_TABLE!,
      accountId: process.env.ACCOUNT_ID!,
      invokePolicy: process.env.BEDROCK_INVOKE_POLICY_ARN!,
      credentialsLambdaRoleArn: process.env.CREDENTIALS_LAMBDA_ROLE_ARN!,
    }, { cognito, iam, ddb, ses });
  } catch (err: any) {
    console.error('CreateUser error', err);
    return { statusCode: 500, body: JSON.stringify({ message: err.message || 'Internal error' }) };
  }
};
