import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

export interface UsageDeps {
  ddb: DynamoDBClient;
}

const ZERO = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

export async function processGetUsage(sub: string, table: string, deps: UsageDeps, breakdown?: string) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const resp = await deps.ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skStart AND :skEnd',
    ExpressionAttributeValues: {
      ':pk': { S: `USER#${sub}` },
      ':skStart': { S: `DAY#${today}` },
      ':skEnd': { S: `MONTH#${month}~` },
    },
  }));

  let day = { ...ZERO };
  let monthUsage = { ...ZERO };

  for (const item of resp.Items ?? []) {
    const sk = item.SK.S!;
    const parsed = {
      costUsd: Number(item.costUsd?.N ?? 0),
      inputTokens: Number(item.inputTokens?.N ?? 0),
      outputTokens: Number(item.outputTokens?.N ?? 0),
    };
    if (sk.startsWith('DAY#')) day = parsed;
    else if (sk.startsWith('MONTH#')) monthUsage = parsed;
  }

  const result: any = { day, month: monthUsage };

  if (breakdown === 'model') {
    const modelResp = await deps.ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skStart AND :skEnd',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${sub}` },
        ':skStart': { S: `MODEL#` },
        ':skEnd': { S: `MODEL#~` },
      },
    }));

    const models: Array<{ modelId: string; period: string; costUsd: number; inputTokens: number; outputTokens: number; invocations: number }> = [];
    for (const item of modelResp.Items ?? []) {
      const sk = item.SK.S!;
      // SK format: MODEL#<modelId>#MONTH#<month> or MODEL#<modelId>#DAY#<date>
      const parts = sk.split('#');
      // parts: ['MODEL', modelId, 'DAY'|'MONTH', dateValue]
      const modelId = parts[1];
      const period = parts[2] === 'MONTH' ? 'month' : 'day';
      models.push({
        modelId,
        period,
        costUsd: Number(item.costUsd?.N ?? 0),
        inputTokens: Number(item.inputTokens?.N ?? 0),
        outputTokens: Number(item.outputTokens?.N ?? 0),
        invocations: Number(item.invocations?.N ?? 0),
      });
    }
    result.models = models;
  }

  return { statusCode: 200, body: JSON.stringify(result) };
}

const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  queryStringParameters?: Record<string, string>;
}) => {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  const breakdown = event.queryStringParameters?.breakdown;
  return processGetUsage(sub, process.env.USAGE_COUNTERS_TABLE!, { ddb }, breakdown);
};
