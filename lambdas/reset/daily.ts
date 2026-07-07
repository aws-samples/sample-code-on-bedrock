import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

export interface DailyResetDeps {
  ddb: DynamoDBClient;
}

export async function processDailyReset(userLimitsTable: string, _usageCountersTable: string, deps: DailyResetDeps) {
  // Clear dailyWarnedOn for all warned users
  const result = await deps.ddb.send(new ScanCommand({
    TableName: userLimitsTable,
    FilterExpression: 'attribute_exists(dailyWarnedOn)',
  }));

  for (const item of result.Items ?? []) {
    const sub = item.PK.S!.replace('USER#', '');

    await deps.ddb.send(new UpdateItemCommand({
      TableName: userLimitsTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
      UpdateExpression: 'REMOVE dailyWarnedOn',
    }));
  }

  // DAY# records are retained for usage history indefinitely.
}

const ddb = new DynamoDBClient({});

export const handler = async () => {
  return processDailyReset(process.env.USER_LIMITS_TABLE!, process.env.USAGE_COUNTERS_TABLE!, { ddb });
};
