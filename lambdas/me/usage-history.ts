import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

export interface UsageHistoryDeps {
  ddb: DynamoDBClient;
}

export async function processGetUsageHistory(
  sub: string,
  table: string,
  from: string,
  to: string,
  deps: UsageHistoryDeps,
) {
  const resp = await deps.ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skStart AND :skEnd',
    ExpressionAttributeValues: {
      ':pk': { S: `USER#${sub}` },
      ':skStart': { S: `DAY#${from}` },
      ':skEnd': { S: `DAY#${to}` },
    },
  }));

  const days = (resp.Items ?? []).map(item => ({
    date: item.SK.S!.replace('DAY#', ''),
    costUsd: Number(item.costUsd?.N ?? 0),
    inputTokens: Number(item.inputTokens?.N ?? 0),
    outputTokens: Number(item.outputTokens?.N ?? 0),
  }));

  return { statusCode: 200, body: JSON.stringify({ days }) };
}

const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  queryStringParameters?: Record<string, string>;
}) => {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  const params = event.queryStringParameters ?? {};
  const from = params.from;
  const to = params.to;

  if (!from || !to) {
    return { statusCode: 400, body: JSON.stringify({ message: 'from and to query parameters are required' }) };
  }

  return processGetUsageHistory(sub, process.env.USAGE_COUNTERS_TABLE!, from, to, { ddb });
};
