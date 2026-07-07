import { DynamoDBClient, QueryCommand, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';

export interface AdminUsageConfig {
  usageCountersTable: string;
  usersTable: string;
  userLimitsTable: string;
}

export interface AdminUsageDeps {
  ddb: DynamoDBClient;
}

export async function processAdminUsage(config: AdminUsageConfig, deps: AdminUsageDeps) {
  const month = new Date().toISOString().slice(0, 7);

  const resp = await deps.ddb.send(new QueryCommand({
    TableName: config.usageCountersTable,
    IndexName: 'byPeriod',
    KeyConditionExpression: 'SK = :sk',
    ExpressionAttributeValues: { ':sk': { S: `MONTH#${month}` } },
  }));

  const items = resp.Items ?? [];
  const subs = items.map(item => item.PK.S!.replace('USER#', ''));

  const emailMap: Record<string, string> = {};
  const blockedMap: Record<string, boolean> = {};
  const dailyUsdMap: Record<string, number> = {};
  const monthlyUsdMap: Record<string, number> = {};
  if (subs.length > 0) {
    for (let i = 0; i < subs.length; i += 100) {
      const batch = subs.slice(i, i + 100);
      const batchResp = await deps.ddb.send(new BatchGetItemCommand({
        RequestItems: {
          [config.usersTable]: {
            Keys: batch.map(sub => ({ PK: { S: `USER#${sub}` }, SK: { S: 'PROFILE' } })),
            ProjectionExpression: 'PK, email',
          },
          [config.userLimitsTable]: {
            Keys: batch.map(sub => ({ PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } })),
            ProjectionExpression: 'PK, blocked, dailyUsd, monthlyUsd',
          },
        },
      }));
      for (const item of batchResp.Responses?.[config.usersTable] ?? []) {
        const sub = item.PK.S!.replace('USER#', '');
        emailMap[sub] = item.email?.S ?? '';
      }
      for (const item of batchResp.Responses?.[config.userLimitsTable] ?? []) {
        const sub = item.PK.S!.replace('USER#', '');
        blockedMap[sub] = item.blocked?.BOOL ?? false;
        dailyUsdMap[sub] = Number(item.dailyUsd?.N ?? 0);
        monthlyUsdMap[sub] = Number(item.monthlyUsd?.N ?? 0);
      }
    }
  }

  // Fetch per-model breakdown for each user
  const modelsByUser: Record<string, Array<{ modelId: string; costUsd: number; inputTokens: number; outputTokens: number; invocations: number }>> = {};
  for (const sub of subs) {
    const modelResp = await deps.ddb.send(new QueryCommand({
      TableName: config.usageCountersTable,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skStart AND :skEnd',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${sub}` },
        ':skStart': { S: `MODEL#` },
        ':skEnd': { S: `MODEL#~` },
      },
    }));
    const models: typeof modelsByUser[string] = [];
    for (const item of modelResp.Items ?? []) {
      const sk = item.SK.S!;
      // Only include monthly records for the current month
      if (!sk.includes(`#MONTH#${month}`)) continue;
      const modelId = sk.split('#')[1];
      models.push({
        modelId,
        costUsd: Number(item.costUsd?.N ?? 0),
        inputTokens: Number(item.inputTokens?.N ?? 0),
        outputTokens: Number(item.outputTokens?.N ?? 0),
        invocations: Number(item.invocations?.N ?? 0),
      });
    }
    if (models.length > 0) modelsByUser[sub] = models;
  }

  const users = items.map(item => {
    const sub = item.PK.S!.replace('USER#', '');
    return {
      sub,
      email: emailMap[sub] ?? sub,
      costUsd: Number(item.costUsd?.N ?? 0),
      inputTokens: Number(item.inputTokens?.N ?? 0),
      outputTokens: Number(item.outputTokens?.N ?? 0),
      blocked: blockedMap[sub] ?? false,
      dailyUsd: dailyUsdMap[sub] ?? 0,
      monthlyUsd: monthlyUsdMap[sub] ?? 0,
      models: modelsByUser[sub] ?? [],
    };
  });

  return { statusCode: 200, body: JSON.stringify({ users }) };
}

const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
}) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  return processAdminUsage({
    usageCountersTable: process.env.USAGE_COUNTERS_TABLE!,
    usersTable: process.env.USERS_TABLE!,
    userLimitsTable: process.env.USER_LIMITS_TABLE!,
  }, { ddb });
};
