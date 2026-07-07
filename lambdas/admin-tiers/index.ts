import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  ScanCommand,
  UpdateItemCommand,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface TiersDeps {
  ddb: DynamoDBClient;
  lambda?: LambdaClient;
}

/**
 * Optional configuration that enables propagating tier-limit edits to every
 * user currently attached to the tier. When provided, a PUT on a tier re-syncs
 * the limits of all tier-managed users by invoking the per-user tier Lambda.
 */
export interface TiersPropagationConfig {
  usersTable: string;
  userTierFn: string;
}

/**
 * Find every tier-managed user on `tierId` and invoke the per-user tier Lambda
 * so their UserLimits are re-synced to the (just edited) tier limits.
 */
async function propagateTierToUsers(
  tierId: string,
  propagation: TiersPropagationConfig,
  deps: TiersDeps,
): Promise<number> {
  if (!deps.lambda) return 0;

  let count = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await deps.ddb.send(new ScanCommand({
      TableName: propagation.usersTable,
      FilterExpression: 'SK = :sk AND #tier = :tier',
      ExpressionAttributeNames: { '#tier': 'tier' },
      ExpressionAttributeValues: { ':sk': { S: 'PROFILE' }, ':tier': { S: tierId } },
      ExclusiveStartKey: lastKey as Record<string, never> | undefined,
    }));
    for (const item of resp.Items ?? []) {
      const sub = item.PK?.S?.replace('USER#', '');
      if (!sub) continue;
      await deps.lambda.send(new InvokeCommand({
        FunctionName: propagation.userTierFn,
        InvocationType: 'Event',
        Payload: JSON.stringify({ internal: true, sub, tier: tierId }),
      }));
      count += 1;
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

/**
 * Decode the optional `allowedModels` DynamoDB list into a string array.
 * Returns `[]` when absent. An empty allowlist means "no per-model restriction"
 * (the user keeps the role's full Bedrock access).
 */
function decodeAllowedModels(item: Record<string, { L?: { S?: string }[] }>): string[] {
  return (item.allowedModels?.L ?? [])
    .map((m) => m.S)
    .filter((s): s is string => typeof s === 'string');
}

export async function processTiers(
  routeKey: string,
  tiersTable: string,
  pathParams: { tierId?: string },
  body: string | undefined,
  deps: TiersDeps,
  propagation?: TiersPropagationConfig,
) {
  if (routeKey === 'GET /admin/tiers') {
    const result = await deps.ddb.send(new ScanCommand({ TableName: tiersTable }));
    const tiers = (result.Items ?? []).map((item) => ({
      tierId: item.tierId?.S,
      dailyUsd: Number(item.dailyUsd?.N ?? 0),
      monthlyUsd: Number(item.monthlyUsd?.N ?? 0),
      allowedModels: decodeAllowedModels(item),
    }));
    return { statusCode: 200, body: JSON.stringify({ tiers }) };
  }

  if (routeKey === 'GET /admin/tiers/{tierId}') {
    const tierId = pathParams.tierId!;
    const result = await deps.ddb.send(new GetItemCommand({
      TableName: tiersTable,
      Key: { tierId: { S: tierId } },
    }));
    if (!result.Item) return { statusCode: 404, body: JSON.stringify({ message: 'Not found' }) };
    return {
      statusCode: 200,
      body: JSON.stringify({
        tierId: result.Item.tierId?.S,
        dailyUsd: Number(result.Item.dailyUsd?.N ?? 0),
        monthlyUsd: Number(result.Item.monthlyUsd?.N ?? 0),
        allowedModels: decodeAllowedModels(result.Item),
      }),
    };
  }

  if (routeKey === 'POST /admin/tiers') {
    const { tierId, dailyUsd, monthlyUsd, allowedModels } = JSON.parse(body!);
    const item: Record<string, AttributeValue> = {
      tierId: { S: tierId },
      dailyUsd: { N: String(dailyUsd) },
      monthlyUsd: { N: String(monthlyUsd) },
    };
    if (Array.isArray(allowedModels) && allowedModels.length > 0) {
      item.allowedModels = { L: allowedModels.map((m: string) => ({ S: m })) };
    }
    await deps.ddb.send(new PutItemCommand({
      TableName: tiersTable,
      Item: item,
    }));
    return { statusCode: 201, body: JSON.stringify({ message: 'Tier created', tierId }) };
  }

  if (routeKey === 'PUT /admin/tiers/{tierId}') {
    const tierId = pathParams.tierId!;
    const { dailyUsd, monthlyUsd, allowedModels } = JSON.parse(body!);
    const setParts: string[] = [];
    const removeParts: string[] = [];
    const values: Record<string, AttributeValue> = {};
    if (dailyUsd !== undefined) { setParts.push('dailyUsd = :d'); values[':d'] = { N: String(dailyUsd) }; }
    if (monthlyUsd !== undefined) { setParts.push('monthlyUsd = :m'); values[':m'] = { N: String(monthlyUsd) }; }
    if (Array.isArray(allowedModels)) {
      // An explicit empty array clears the restriction; a non-empty array sets it.
      if (allowedModels.length > 0) {
        setParts.push('allowedModels = :am');
        values[':am'] = { L: allowedModels.map((m: string) => ({ S: m })) };
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
      TableName: tiersTable,
      Key: { tierId: { S: tierId } },
      UpdateExpression: clauses.join(' '),
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    }));
    let synced = 0;
    if (propagation) {
      synced = await propagateTierToUsers(tierId, propagation, deps);
    }
    return { statusCode: 200, body: JSON.stringify({ message: 'Tier updated', syncedUsers: synced }) };
  }

  if (routeKey === 'DELETE /admin/tiers/{tierId}') {
    const tierId = pathParams.tierId!;
    await deps.ddb.send(new DeleteItemCommand({
      TableName: tiersTable,
      Key: { tierId: { S: tierId } },
    }));
    return { statusCode: 200, body: JSON.stringify({ message: 'Tier deleted' }) };
  }

  return { statusCode: 400, body: JSON.stringify({ message: 'Unknown route' }) };
}

interface ApiEvent {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  routeKey: string;
  pathParameters?: { tierId?: string };
  body?: string;
}

const ddb = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});

export const handler = async (event: ApiEvent) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  const usersTable = process.env.USERS_TABLE;
  const userTierFn = process.env.USER_TIER_FUNCTION_NAME;
  const propagation = usersTable && userTierFn ? { usersTable, userTierFn } : undefined;

  return processTiers(
    event.routeKey,
    process.env.TIERS_TABLE!,
    event.pathParameters ?? {},
    event.body,
    { ddb, lambda: lambdaClient },
    propagation,
  );
};
