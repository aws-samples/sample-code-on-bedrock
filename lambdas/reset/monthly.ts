import { IAMClient, DetachRolePolicyCommand } from '@aws-sdk/client-iam';
import { DynamoDBClient, ScanCommand, UpdateItemCommand, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

export interface MonthlyResetDeps {
  iam: IAMClient;
  ddb: DynamoDBClient;
}

export async function processMonthlyReset(denyPolicyArn: string, userLimitsTable: string, usageCountersTable: string, deps: MonthlyResetDeps) {
  // Unblock users
  const result = await deps.ddb.send(new ScanCommand({
    TableName: userLimitsTable,
    FilterExpression: 'blocked = :blocked',
    ExpressionAttributeValues: { ':blocked': { BOOL: true } },
  }));

  for (const item of result.Items ?? []) {
    const sub = item.PK.S!.replace('USER#', '');

    await deps.iam.send(new DetachRolePolicyCommand({
      RoleName: `BedrockUser-${sub}`,
      PolicyArn: denyPolicyArn,
    }));

    await deps.ddb.send(new UpdateItemCommand({
      TableName: userLimitsTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
      UpdateExpression: 'SET blocked = :blocked',
      ExpressionAttributeValues: { ':blocked': { BOOL: false } },
    }));
  }

  // Delete previous month's MONTH# records via byPeriod GSI
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonth = `MONTH#${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

  const queryResult = await deps.ddb.send(new QueryCommand({
    TableName: usageCountersTable,
    IndexName: 'byPeriod',
    KeyConditionExpression: 'SK = :sk',
    ExpressionAttributeValues: { ':sk': { S: prevMonth } },
  }));

  for (const item of queryResult.Items ?? []) {
    await deps.ddb.send(new DeleteItemCommand({
      TableName: usageCountersTable,
      Key: { PK: item.PK, SK: item.SK },
    }));
  }
}

const iam = new IAMClient({});
const ddb = new DynamoDBClient({});

export const handler = async () => {
  return processMonthlyReset(
    process.env.BEDROCK_DENY_POLICY_ARN!,
    process.env.USER_LIMITS_TABLE!,
    process.env.USAGE_COUNTERS_TABLE!,
    { iam, ddb },
  );
};
