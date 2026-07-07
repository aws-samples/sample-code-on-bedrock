import { CloudWatchClient, GetMetricStatisticsCommand, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient, ScanCommand, QueryCommand } from '@aws-sdk/client-dynamodb';

export interface CrosscheckConfig {
  usersTable: string;
  usageTable: string;
  threshold: number;
}

export interface CrosscheckDeps {
  cw: CloudWatchClient;
  ddb: DynamoDBClient;
}

export async function processCrosscheck(config: CrosscheckConfig, deps: CrosscheckDeps) {
  const usersResp = await deps.ddb.send(new ScanCommand({ TableName: config.usersTable }));
  const users = usersResp.Items ?? [];
  if (users.length === 0) return;

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600_000);
  const today = now.toISOString().slice(0, 10);

  for (const user of users) {
    const sub = user.PK.S!.replace('USER#', '');

    const [cwInput, cwOutput] = await Promise.all(
      ['InputTokenCount', 'OutputTokenCount'].map(metric =>
        deps.cw.send(new GetMetricStatisticsCommand({
          Namespace: 'AWS/Bedrock',
          MetricName: metric,
          StartTime: hourAgo,
          EndTime: now,
          Period: 3600,
          Statistics: ['Sum'],
          Dimensions: [{ Name: 'RoleSessionName', Value: sub }],
        })),
      ),
    );

    const cwInputTokens = cwInput.Datapoints?.[0]?.Sum ?? 0;
    const cwOutputTokens = cwOutput.Datapoints?.[0]?.Sum ?? 0;

    const ddbResp = await deps.ddb.send(new QueryCommand({
      TableName: config.usageTable,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${sub}` },
        ':sk': { S: `DAY#${today}` },
      },
    }));

    const ddbItem = ddbResp.Items?.[0];
    const ddbInputTokens = Number(ddbItem?.inputTokens?.N ?? 0);
    const ddbOutputTokens = Number(ddbItem?.outputTokens?.N ?? 0);

    const inputDiv = Math.abs(cwInputTokens - ddbInputTokens) / Math.max(cwInputTokens, ddbInputTokens, 1);
    const outputDiv = Math.abs(cwOutputTokens - ddbOutputTokens) / Math.max(cwOutputTokens, ddbOutputTokens, 1);

    if (inputDiv > config.threshold || outputDiv > config.threshold) {
      await deps.cw.send(new PutMetricDataCommand({
        Namespace: 'CodeOnBedrock',
        MetricData: [{
          MetricName: 'MeteringDivergence',
          Value: 1,
          Dimensions: [{ Name: 'User', Value: sub }],
        }],
      }));
    }
  }
}

const cw = new CloudWatchClient({});
const ddb = new DynamoDBClient({});

export const handler = async () => {
  return processCrosscheck({
    usersTable: process.env.USERS_TABLE!,
    usageTable: process.env.USAGE_COUNTERS_TABLE!,
    threshold: parseFloat(process.env.DIVERGENCE_THRESHOLD ?? '0.1'),
  }, { cw, ddb });
};
