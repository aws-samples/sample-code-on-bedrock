import { DynamoDBClient, GetItemCommand, UpdateItemCommand, AttributeValue } from '@aws-sdk/client-dynamodb';
import { IAMClient } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { reconcileBlockState, ReconcileConfig, ReconcileDeps } from './reconcile';
import { syncModelPolicies } from '../shared/sync-model-policies';

export interface SetTierConfig extends ReconcileConfig {
  usersTable: string;
  tiersTable: string;
  accountId: string;
  bedrockInvokePolicyArn: string;
}

export type SetTierDeps = ReconcileDeps & { iam: IAMClient };

/**
 * Put a user onto a tier: record the tier on their profile, copy the tier's
 * limits into UserLimits, and reconcile their blocked state against the new
 * monthly limit. After this the user is "tier-managed" — edits to the tier
 * propagate back to them via PUT /admin/tiers/{tierId}.
 */
export async function processSetTier(
  targetSub: string,
  tier: string,
  config: SetTierConfig,
  deps: SetTierDeps,
) {
  if (!tier) {
    return { statusCode: 400, body: JSON.stringify({ message: 'tier is required' }) };
  }

  const tierResp = await deps.ddb.send(new GetItemCommand({
    TableName: config.tiersTable,
    Key: { tierId: { S: tier } },
  }));
  if (!tierResp.Item) {
    return { statusCode: 400, body: JSON.stringify({ message: 'unknown tier' }) };
  }

  const dailyUsd = Number(tierResp.Item.dailyUsd?.N ?? 0);
  const monthlyUsd = Number(tierResp.Item.monthlyUsd?.N ?? 0);
  const tierAllowedModels = tierResp.Item.allowedModels?.L ?? [];

  // Record the tier on the user's profile.
  await deps.ddb.send(new UpdateItemCommand({
    TableName: config.usersTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'PROFILE' } },
    UpdateExpression: 'SET #tier = :tier',
    ExpressionAttributeNames: { '#tier': 'tier' },
    ExpressionAttributeValues: { ':tier': { S: tier } },
  }));

  // Sync the effective limits used by metering/enforcement, and the model
  // allowlist used by the credentials Lambda. When the tier has no allowlist we
  // REMOVE any previously-synced allowlist so the user reverts to unrestricted.
  const setValues: Record<string, AttributeValue> = {
    ':d': { N: String(dailyUsd) },
    ':m': { N: String(monthlyUsd) },
  };
  const clauses: string[] = [];
  if (tierAllowedModels.length > 0) {
    clauses.push('SET dailyUsd = :d, monthlyUsd = :m, allowedModels = :am');
    setValues[':am'] = { L: tierAllowedModels };
  } else {
    clauses.push('SET dailyUsd = :d, monthlyUsd = :m');
    clauses.push('REMOVE allowedModels');
  }
  await deps.ddb.send(new UpdateItemCommand({
    TableName: config.userLimitsTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
    UpdateExpression: clauses.join(' '),
    ExpressionAttributeValues: setValues,
  }));

  // Sync IAM model policies to match the new allowedModels
  const effectiveModels = tierAllowedModels.map((m) => m.S!).filter(Boolean);
  await syncModelPolicies({
    sub: targetSub,
    allowedModels: effectiveModels,
    accountId: config.accountId,
    bedrockInvokePolicyArn: config.bedrockInvokePolicyArn,
    deps: { iam: deps.iam },
  });

  const state = await reconcileBlockState(targetSub, monthlyUsd, config, deps);
  let suffix = '';
  if (state === 'blocked') suffix = '; user blocked (over budget)';
  else if (state === 'unblocked') suffix = '; user unblocked';

  return {
    statusCode: 200,
    body: JSON.stringify({ message: `Tier set to ${tier}${suffix}`, tier, dailyUsd, monthlyUsd }),
  };
}

const ddb = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});
const iamClient = new IAMClient({});

function configFromEnv(): SetTierConfig {
  return {
    usersTable: process.env.USERS_TABLE!,
    tiersTable: process.env.TIERS_TABLE!,
    userLimitsTable: process.env.USER_LIMITS_TABLE!,
    usageCountersTable: process.env.USAGE_COUNTERS_TABLE!,
    killswitchFn: process.env.KILLSWITCH_FUNCTION_NAME!,
    unblockFn: process.env.UNBLOCK_FUNCTION_NAME!,
    accountId: process.env.ACCOUNT_ID!,
    bedrockInvokePolicyArn: process.env.BEDROCK_INVOKE_POLICY_ARN!,
  };
}

interface HttpEvent {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  pathParameters: { sub: string };
  body?: string;
}

interface InternalEvent {
  internal: true;
  sub: string;
  tier: string;
}

export const handler = async (event: HttpEvent | InternalEvent) => {
  // Internal invocation from the tiers-propagation path (admin-tiers). This is
  // only reachable via a direct, IAM-scoped Lambda invoke within the account,
  // so it bypasses the JWT admin-group check.
  if ((event as InternalEvent).internal === true) {
    const { sub, tier } = event as InternalEvent;
    return processSetTier(sub, tier, configFromEnv(), { ddb, lambda: lambdaClient, iam: iamClient });
  }

  const httpEvent = event as HttpEvent;
  const groups = httpEvent.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  const targetSub = httpEvent.pathParameters.sub;
  const { tier } = JSON.parse(httpEvent.body!);
  return processSetTier(targetSub, tier, configFromEnv(), { ddb, lambda: lambdaClient, iam: iamClient });
};
