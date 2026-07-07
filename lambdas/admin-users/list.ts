import { DynamoDBClient, ScanCommand, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';

export async function processListUsers(
  config: { usersTable: string; userLimitsTable: string },
  deps: { ddb: DynamoDBClient },
  tierFilter?: string,
) {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const resp = await deps.ddb.send(new ScanCommand({
      TableName: config.usersTable,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': { S: 'PROFILE' } },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(resp.Items ?? []));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  let users = items.map(item => ({
    sub: item.PK.S!.replace('USER#', ''),
    email: item.email?.S ?? '',
    tier: item.tier?.S ?? '',
    createdAt: item.createdAt?.S ?? '',
  }));

  if (tierFilter) {
    users = users.filter(u => u.tier === tierFilter);
  }

  // Enrich with limits
  const limitsMap: Record<string, { dailyUsd: number; monthlyUsd: number; blocked: boolean; allowedModels: string[] }> = {};
  for (let i = 0; i < users.length; i += 100) {
    const batch = users.slice(i, i + 100);
    const resp = await deps.ddb.send(new BatchGetItemCommand({
      RequestItems: {
        [config.userLimitsTable]: {
          Keys: batch.map(u => ({ PK: { S: `USER#${u.sub}` }, SK: { S: 'LIMITS' } })),
          ProjectionExpression: 'PK, dailyUsd, monthlyUsd, blocked, allowedModels',
        },
      },
    }));
    for (const item of resp.Responses?.[config.userLimitsTable] ?? []) {
      const sub = item.PK.S!.replace('USER#', '');
      limitsMap[sub] = {
        dailyUsd: Number(item.dailyUsd?.N ?? 0),
        monthlyUsd: Number(item.monthlyUsd?.N ?? 0),
        blocked: item.blocked?.BOOL ?? false,
        allowedModels: (item.allowedModels?.L ?? [])
          .map((m: { S?: string }) => m.S)
          .filter((s: string | undefined): s is string => typeof s === 'string'),
      };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      users: users.map(u => ({
        ...u,
        dailyUsd: limitsMap[u.sub]?.dailyUsd ?? 0,
        monthlyUsd: limitsMap[u.sub]?.monthlyUsd ?? 0,
        blocked: limitsMap[u.sub]?.blocked ?? false,
        allowedModels: limitsMap[u.sub]?.allowedModels ?? [],
      })),
    }),
  };
}

const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  queryStringParameters?: Record<string, string>;
}) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  const tierFilter = event.queryStringParameters?.tier;

  return processListUsers(
    {
      usersTable: process.env.USERS_TABLE!,
      userLimitsTable: process.env.USER_LIMITS_TABLE!,
    },
    { ddb },
    tierFilter,
  );
};
