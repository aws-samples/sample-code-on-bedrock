import { DynamoDBClient, UpdateItemCommand, AttributeValue } from '@aws-sdk/client-dynamodb';
import { IAMClient } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { reconcileBlockState, ReconcileConfig, ReconcileDeps } from './reconcile';
import { syncModelPolicies } from '../shared/sync-model-policies';

export interface UpdateLimitsConfig extends ReconcileConfig {
  usersTable: string;
  accountId: string;
  bedrockInvokePolicyArn: string;
}

export type UpdateLimitsDeps = ReconcileDeps & { iam: IAMClient };

export async function processUpdateLimits(
  targetSub: string,
  body: { dailyUsd?: number; monthlyUsd?: number; allowedModels?: string[] },
  config: UpdateLimitsConfig,
  deps: UpdateLimitsDeps,
) {
  const { dailyUsd, monthlyUsd, allowedModels } = body;
  const setParts: string[] = [];
  const removeParts: string[] = [];
  const values: Record<string, AttributeValue> = {};

  if (dailyUsd !== undefined) {
    setParts.push('dailyUsd = :dailyUsd');
    values[':dailyUsd'] = { N: String(dailyUsd) };
  }
  if (monthlyUsd !== undefined) {
    setParts.push('monthlyUsd = :monthlyUsd');
    values[':monthlyUsd'] = { N: String(monthlyUsd) };
  }
  if (Array.isArray(allowedModels)) {
    // Manual per-user override. A non-empty array restricts the user to those
    // models; an explicit empty array clears the restriction (unrestricted).
    if (allowedModels.length > 0) {
      setParts.push('allowedModels = :allowedModels');
      values[':allowedModels'] = { L: allowedModels.map((m) => ({ S: m })) };
    } else {
      removeParts.push('allowedModels');
    }
  }

  if (setParts.length === 0 && removeParts.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ message: 'No fields to update' }) };
  }

  const clauses: string[] = [];
  if (setParts.length > 0) clauses.push(`SET ${setParts.join(', ')}`);
  if (removeParts.length > 0) clauses.push(`REMOVE ${removeParts.join(', ')}`);

  await deps.ddb.send(new UpdateItemCommand({
    TableName: config.userLimitsTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
    UpdateExpression: clauses.join(' '),
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
  }));

  // Sync IAM model policies when allowedModels was explicitly provided
  if (Array.isArray(allowedModels)) {
    await syncModelPolicies({
      sub: targetSub,
      allowedModels,
      accountId: config.accountId,
      bedrockInvokePolicyArn: config.bedrockInvokePolicyArn,
      deps: { iam: deps.iam },
    });
  }

  let suffix = '';
  if (monthlyUsd !== undefined) {
    const state = await reconcileBlockState(targetSub, monthlyUsd, config, deps);
    if (state === 'blocked') suffix = '; user blocked (over budget)';
    else if (state === 'unblocked') suffix = '; user unblocked';
  }

  // Setting manual limits detaches the user from any tier so that subsequent
  // tier-limit edits no longer overwrite these values. The user can be put
  // back on a tier via PUT /admin/users/{sub}/tier. Done last so it does not
  // perturb the kill-switch reconciliation read sequence above.
  let detached = false;
  if (config.usersTable) {
    await deps.ddb.send(new UpdateItemCommand({
      TableName: config.usersTable,
      Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'PROFILE' } },
      UpdateExpression: 'REMOVE #tier',
      ExpressionAttributeNames: { '#tier': 'tier' },
    }));
    detached = true;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: `Limits updated${suffix}`, manual: detached }),
  };
}

const ddb = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});
const iamClient = new IAMClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  pathParameters: { sub: string };
  body?: string;
}) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  const targetSub = event.pathParameters.sub;
  const body = JSON.parse(event.body!);
  return processUpdateLimits(targetSub, body, {
    userLimitsTable: process.env.USER_LIMITS_TABLE!,
    usageCountersTable: process.env.USAGE_COUNTERS_TABLE!,
    usersTable: process.env.USERS_TABLE!,
    killswitchFn: process.env.KILLSWITCH_FUNCTION_NAME!,
    unblockFn: process.env.UNBLOCK_FUNCTION_NAME!,
    accountId: process.env.ACCOUNT_ID!,
    bedrockInvokePolicyArn: process.env.BEDROCK_INVOKE_POLICY_ARN!,
  }, { ddb, lambda: lambdaClient, iam: iamClient });
};
