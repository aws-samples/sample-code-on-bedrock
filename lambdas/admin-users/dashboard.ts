import { DynamoDBClient, QueryCommand, ScanCommand, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';

export interface DashboardConfig {
  usageCountersTable: string;
  usersTable: string;
  userLimitsTable: string;
}

export interface DashboardDeps {
  ddb: DynamoDBClient;
}

export async function processAdminDashboard(config: DashboardConfig, deps: DashboardDeps) {
  const month = new Date().toISOString().slice(0, 7);

  // Query byPeriod GSI for all users' monthly usage
  const usageResp = await deps.ddb.send(new QueryCommand({
    TableName: config.usageCountersTable,
    IndexName: 'byPeriod',
    KeyConditionExpression: 'SK = :sk',
    ExpressionAttributeValues: { ':sk': { S: `MONTH#${month}` } },
  }));
  const usageItems = usageResp.Items ?? [];

  // Scan UserLimits for blocked count
  const limitsItems: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const resp = await deps.ddb.send(new ScanCommand({
      TableName: config.userLimitsTable,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': { S: 'LIMITS' } },
      ExclusiveStartKey: lastKey,
    }));
    limitsItems.push(...(resp.Items ?? []));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  const blockedUsers = limitsItems.filter(i => i.blocked?.BOOL === true).length;

  // Get tier info from Users table for subs that have usage
  const subs = usageItems.map(i => i.PK.S!.replace('USER#', ''));
  const tierMap: Record<string, string> = {};
  if (subs.length > 0) {
    for (let i = 0; i < subs.length; i += 100) {
      const batch = subs.slice(i, i + 100);
      const resp = await deps.ddb.send(new BatchGetItemCommand({
        RequestItems: {
          [config.usersTable]: {
            Keys: batch.map(sub => ({ PK: { S: `USER#${sub}` }, SK: { S: 'PROFILE' } })),
            ProjectionExpression: 'PK, email, tier',
          },
        },
      }));
      for (const item of resp.Responses?.[config.usersTable] ?? []) {
        const sub = item.PK.S!.replace('USER#', '');
        tierMap[sub] = item.tier?.S ?? 'unknown';
      }
    }
  }

  // Compute aggregates
  let totalMonthCostUsd = 0;
  const tierAgg: Record<string, { totalCostUsd: number; users: Set<string> }> = {};
  const userCosts: Array<{ sub: string; costUsd: number }> = [];

  for (const item of usageItems) {
    const sub = item.PK.S!.replace('USER#', '');
    const cost = Number(item.costUsd?.N ?? 0);
    totalMonthCostUsd += cost;
    userCosts.push({ sub, costUsd: cost });

    const tier = tierMap[sub] ?? 'unknown';
    if (!tierAgg[tier]) tierAgg[tier] = { totalCostUsd: 0, users: new Set() };
    tierAgg[tier].totalCostUsd += cost;
    tierAgg[tier].users.add(sub);
  }

  const byTier = Object.entries(tierAgg).map(([tier, agg]) => ({
    tier,
    totalCostUsd: agg.totalCostUsd,
    userCount: agg.users.size,
  }));

  const topUsers = userCosts
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5);

  return {
    statusCode: 200,
    body: JSON.stringify({
      totalMonthCostUsd,
      byTier,
      topUsers,
      activeUsers: subs.length,
      blockedUsers,
    }),
  };
}

const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
}) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  return processAdminDashboard({
    usageCountersTable: process.env.USAGE_COUNTERS_TABLE!,
    usersTable: process.env.USERS_TABLE!,
    userLimitsTable: process.env.USER_LIMITS_TABLE!,
  }, { ddb });
};
