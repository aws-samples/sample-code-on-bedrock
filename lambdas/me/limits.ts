import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

export interface LimitsDeps {
  ddb: DynamoDBClient;
}

/**
 * Look up the user's tier from their Users-table PROFILE item. The `tier`
 * attribute holds the tierId, which doubles as the tier's display name. Returns
 * null when the user has no tier (unmanaged) or the profile doesn't exist.
 */
async function getTier(sub: string, usersTable: string | undefined, deps: LimitsDeps): Promise<string | null> {
  if (!usersTable) return null;
  const resp = await deps.ddb.send(new GetItemCommand({
    TableName: usersTable,
    Key: { PK: { S: `USER#${sub}` }, SK: { S: 'PROFILE' } },
  }));
  return resp.Item?.tier?.S ?? null;
}

export async function processGetLimits(
  sub: string,
  table: string,
  deps: LimitsDeps,
  usersTable?: string,
) {
  const [resp, tier] = await Promise.all([
    deps.ddb.send(new GetItemCommand({
      TableName: table,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
    })),
    getTier(sub, usersTable, deps),
  ]);

  const defaults = { dailyUsd: 5, monthlyUsd: 50, blocked: false, allowedModels: [] as string[] };

  if (!resp.Item) {
    await deps.ddb.send(new PutItemCommand({
      TableName: table,
      Item: {
        PK: { S: `USER#${sub}` },
        SK: { S: 'LIMITS' },
        dailyUsd: { N: String(defaults.dailyUsd) },
        monthlyUsd: { N: String(defaults.monthlyUsd) },
        blocked: { BOOL: defaults.blocked },
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    })).catch(() => {});

    return { statusCode: 200, body: JSON.stringify({ ...defaults, tier }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      dailyUsd: Number(resp.Item.dailyUsd?.N ?? 0),
      monthlyUsd: Number(resp.Item.monthlyUsd?.N ?? 0),
      blocked: resp.Item.blocked?.BOOL ?? false,
      allowedModels: (resp.Item.allowedModels?.L ?? [])
        .map((m) => m.S)
        .filter((s): s is string => typeof s === 'string'),
      tier,
    }),
  };
}

const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
}) => {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  return processGetLimits(sub, process.env.USER_LIMITS_TABLE!, { ddb }, process.env.USERS_TABLE);
};
