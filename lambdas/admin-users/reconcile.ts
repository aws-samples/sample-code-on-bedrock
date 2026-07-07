import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface ReconcileConfig {
  userLimitsTable: string;
  usageCountersTable: string;
  killswitchFn: string;
  unblockFn: string;
}

export interface ReconcileDeps {
  ddb: DynamoDBClient;
  lambda: LambdaClient;
}

export type ReconcileResult = 'blocked' | 'unblocked' | 'none';

/**
 * Reconcile a user's blocked state against their current month spend and the
 * given (possibly just-updated) monthly limit.
 *
 * - If spend has reached the monthly limit, invoke the kill switch and mark the
 *   user blocked.
 * - If the user is currently blocked but spend is now below the monthly limit
 *   (for example because the limit was raised, or they moved to a higher tier),
 *   unblock them. Note the metering pipeline only ever *blocks*; it never
 *   unblocks, so raising a limit must reconcile here explicitly.
 *
 * This mirrors the semantics that previously lived inline in limits.ts so that
 * manual-limit, tier-assignment, and tier-propagation flows all behave the same.
 */
export async function reconcileBlockState(
  targetSub: string,
  monthlyUsd: number,
  config: ReconcileConfig,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const month = new Date().toISOString().slice(0, 7);
  const [usage, limitsItem] = await Promise.all([
    deps.ddb.send(new GetItemCommand({
      TableName: config.usageCountersTable,
      Key: { PK: { S: `USER#${targetSub}` }, SK: { S: `MONTH#${month}` } },
    })),
    deps.ddb.send(new GetItemCommand({
      TableName: config.userLimitsTable,
      Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
    })),
  ]);
  const costUsd = Number(usage.Item?.costUsd?.N ?? 0);
  const isBlocked = limitsItem.Item?.blocked?.BOOL === true;

  if (costUsd >= monthlyUsd) {
    await deps.lambda.send(new InvokeCommand({
      FunctionName: config.killswitchFn,
      InvocationType: 'Event',
      Payload: JSON.stringify({ sub: targetSub }),
    }));
    await deps.ddb.send(new UpdateItemCommand({
      TableName: config.userLimitsTable,
      Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
      UpdateExpression: 'SET blocked = :t',
      ExpressionAttributeValues: { ':t': { BOOL: true } },
    }));
    return 'blocked';
  }

  if (isBlocked && costUsd < monthlyUsd) {
    await deps.ddb.send(new UpdateItemCommand({
      TableName: config.userLimitsTable,
      Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
      UpdateExpression: 'SET blocked = :f',
      ExpressionAttributeValues: { ':f': { BOOL: false } },
    }));
    await deps.lambda.send(new InvokeCommand({
      FunctionName: config.unblockFn,
      InvocationType: 'Event',
      Payload: JSON.stringify({ sub: targetSub }),
    }));
    return 'unblocked';
  }

  return 'none';
}
