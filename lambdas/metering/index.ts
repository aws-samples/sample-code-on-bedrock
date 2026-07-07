import * as zlib from 'zlib';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export interface MeteringConfig {
  usageCountersTable: string;
  modelRatesTable: string;
  userLimitsTable: string;
  usersTable: string;
  killswitchFn: string;
  warningTopicArn: string;
  warningThreshold: number;
  sesFromAddress: string;
}

export interface MeteringDeps {
  ddb: DynamoDBClient;
  lambda: LambdaClient;
  sns: SNSClient;
  ses: SESClient;
}

/**
 * Normalize a logged `modelId` to its `ModelRates` key. Bedrock logs the
 * `modelId` differently depending on how the model was invoked:
 *  - Direct in-region call → base id, e.g. `anthropic.claude-opus-4-8`
 *  - Cross-Region inference profile → the full ARN, e.g.
 *    `arn:aws:bedrock:eu-central-1:123:inference-profile/eu.anthropic.claude-opus-4-8`
 *  - The short profile id, e.g. `eu.anthropic.claude-opus-4-8`
 *
 * The last path segment is the model/profile id in every case, and the rate
 * sync stores both base ids and (geo-prefixed) inference-profile ids in
 * `ModelRates`, so the last segment matches a row directly.
 */
export function normalizeModelId(modelId: string): string {
  return modelId.split('/').pop() || modelId;
}

export async function processMetering(
  logEvents: Array<{ message: string }>,
  config: MeteringConfig,
  deps: MeteringDeps,
) {
  for (const logEvent of logEvents) {
    let record: any;
    try {
      record = JSON.parse(logEvent.message);
    } catch {
      continue;
    }
    if (!record.identity?.arn) continue;

    try {
      await processRecord(record, config, deps);
    } catch (err) {
      // Never let one malformed/unsupported record fail the whole batch: a
      // throw here fails the CloudWatch Logs subscription delivery, so every
      // other record in the same batch loses its metering too. Log and move on.
      console.error('Failed to process metering record — skipping', err);
    }
  }
}

/**
 * Meter a single Bedrock invocation log record: resolve its rate, accumulate
 * day/month + per-model usage counters, and run budget enforcement (monthly
 * kill switch, daily SNS warning, 80% SES warning). Returns early (without
 * throwing) for records that can't be metered.
 */
async function processRecord(
  record: any,
  config: MeteringConfig,
  deps: MeteringDeps,
) {
  const arn: string = record.identity.arn;
  const modelId: string = record.modelId;
  if (!modelId) {
    console.warn('Metering record missing modelId — skipping');
    return;
  }
  // Token counts are absent on some records (image models, certain embeddings,
  // errored or streamed invocations). Default to 0 so a missing field never
  // produces a NaN cost — DynamoDB rejects { N: "NaN" }, which would otherwise
  // throw and (before the per-record guard above) poison the entire batch.
  const inputTokens: number = record.input?.inputTokenCount ?? 0;
  const outputTokens: number = record.output?.outputTokenCount ?? 0;

  const sub = arn.split('/').pop()!;

  // Resolve the logged modelId (which may be an inference-profile ARN or a
  // geo-prefixed profile id) to its ModelRates key via the last path segment.
  const resolvedModelId = normalizeModelId(modelId);
  const ratesResp = await deps.ddb.send(new GetItemCommand({
    TableName: config.modelRatesTable,
    Key: { modelId: { S: resolvedModelId }, SK: { S: '-' } },
  }));

  if (!ratesResp.Item) {
    console.warn(`Unknown model: ${modelId} (resolved ${resolvedModelId}) — skipping record`);
    return;
  }

  const inputPer1k = parseFloat(ratesResp.Item.inputUsdPer1k.N!);
  const outputPer1k = parseFloat(ratesResp.Item.outputUsdPer1k.N!);
  const cost = (inputTokens * inputPer1k / 1000) + (outputTokens * outputPer1k / 1000);

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);

  const updatedCosts: Record<string, number> = {};
  for (const sk of [`DAY#${day}`, `MONTH#${month}`]) {
    const resp = await deps.ddb.send(new UpdateItemCommand({
      TableName: config.usageCountersTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: sk } },
      UpdateExpression: 'ADD costUsd :cost, inputTokens :input, outputTokens :output',
      ExpressionAttributeValues: {
        ':cost': { N: String(cost) },
        ':input': { N: String(inputTokens) },
        ':output': { N: String(outputTokens) },
      },
      ReturnValues: 'ALL_NEW',
    }));
    updatedCosts[sk] = parseFloat(resp.Attributes?.costUsd?.N ?? '0');
  }

  // Per-model usage records
  for (const sk of [`MODEL#${resolvedModelId}#DAY#${day}`, `MODEL#${resolvedModelId}#MONTH#${month}`]) {
    await deps.ddb.send(new UpdateItemCommand({
      TableName: config.usageCountersTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: sk } },
      UpdateExpression: 'ADD costUsd :cost, inputTokens :input, outputTokens :output, invocations :inv',
      ExpressionAttributeValues: {
        ':cost': { N: String(cost) },
        ':input': { N: String(inputTokens) },
        ':output': { N: String(outputTokens) },
        ':inv': { N: '1' },
      },
    }));
  }

  const limitsResp = await deps.ddb.send(new GetItemCommand({
    TableName: config.userLimitsTable,
    Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
  }));
  if (!limitsResp.Item) return;

  const monthlyUsd = parseFloat(limitsResp.Item.monthlyUsd?.N ?? '0');
  const dailyUsd = parseFloat(limitsResp.Item.dailyUsd?.N ?? '0');
  const blocked = limitsResp.Item.blocked?.BOOL ?? false;
  const dailyWarnedOn = limitsResp.Item.dailyWarnedOn?.S;

  if (updatedCosts[`MONTH#${month}`] >= monthlyUsd && !blocked) {
    await deps.lambda.send(new InvokeCommand({
      FunctionName: config.killswitchFn,
      InvocationType: 'Event',
      Payload: JSON.stringify({ sub }),
    }));
    await deps.ddb.send(new UpdateItemCommand({
      TableName: config.userLimitsTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
      UpdateExpression: 'SET blocked = :blocked',
      ExpressionAttributeValues: { ':blocked': { BOOL: true } },
    }));
  }

  if (updatedCosts[`DAY#${day}`] >= dailyUsd && dailyWarnedOn !== day) {
    await deps.sns.send(new PublishCommand({
      TopicArn: config.warningTopicArn,
      Subject: `Daily budget warning for ${sub}`,
      Message: `User ${sub} has exceeded their daily budget of $${dailyUsd}. Current spend: $${updatedCosts[`DAY#${day}`]}.`,
    }));
    await deps.ddb.send(new UpdateItemCommand({
      TableName: config.userLimitsTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
      UpdateExpression: 'SET dailyWarnedOn = :today',
      ExpressionAttributeValues: { ':today': { S: day } },
    }));
  }

  // 80% threshold warning via SES directly to user
  const dailyWarned80 = limitsResp.Item.dailyWarned80?.S;
  const threshold = config.warningThreshold;
  if (updatedCosts[`DAY#${day}`] >= dailyUsd * threshold && dailyWarned80 !== day) {
    const userResp = await deps.ddb.send(new GetItemCommand({
      TableName: config.usersTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: 'PROFILE' } },
    }));
    const email = userResp.Item?.email?.S;
    if (email) {
      const pct = Math.round(threshold * 100);
      await deps.ses.send(new SendEmailCommand({
        Source: config.sesFromAddress,
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: `You've reached ${pct}% of your daily budget` },
          Body: { Text: { Data: `Your daily spend is $${updatedCosts[`DAY#${day}`].toFixed(2)}, which is ${pct}% of your $${dailyUsd.toFixed(2)} daily limit. Consider slowing down usage to avoid being blocked.` } },
        },
      }));
    }
    await deps.ddb.send(new UpdateItemCommand({
      TableName: config.userLimitsTable,
      Key: { PK: { S: `USER#${sub}` }, SK: { S: 'LIMITS' } },
      UpdateExpression: 'SET dailyWarned80 = :today',
      ExpressionAttributeValues: { ':today': { S: day } },
    }));
  }
}

let ddb: DynamoDBClient;
let lambdaClient: LambdaClient;
let snsClient: SNSClient;
let sesClient: SESClient;

export const handler = async (event: { awslogs: { data: string } }) => {
  const HOME_REGION = process.env.HOME_REGION!;
  if (!ddb) ddb = new DynamoDBClient({ region: HOME_REGION });
  if (!lambdaClient) lambdaClient = new LambdaClient({ region: HOME_REGION });
  if (!snsClient) snsClient = new SNSClient({ region: HOME_REGION });
  if (!sesClient) sesClient = new SESClient({ region: HOME_REGION });

  const buf = Buffer.from(event.awslogs.data, 'base64');
  const decompressed = zlib.gunzipSync(buf).toString();

  let payload: any;
  try {
    payload = JSON.parse(decompressed);
  } catch {
    // Control messages (e.g. "Permissions are correctly set...") are not JSON
    console.log('Skipping non-JSON payload (control message)');
    return;
  }

  if (payload.messageType === 'CONTROL_MESSAGE') {
    console.log('Skipping CONTROL_MESSAGE');
    return;
  }

  return processMetering(payload.logEvents, {
    usageCountersTable: process.env.USAGE_COUNTERS_TABLE!,
    modelRatesTable: process.env.MODEL_RATES_TABLE!,
    userLimitsTable: process.env.USER_LIMITS_TABLE!,
    usersTable: process.env.USERS_TABLE!,
    killswitchFn: process.env.KILLSWITCH_FUNCTION_NAME!,
    warningTopicArn: process.env.WARNING_TOPIC_ARN!,
    warningThreshold: parseFloat(process.env.WARNING_THRESHOLD || '0.8'),
    sesFromAddress: process.env.SES_FROM_ADDRESS || 'noreply@example.com',
  }, { ddb, lambda: lambdaClient, sns: snsClient, ses: sesClient });
};
