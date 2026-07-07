import { IAMClient, DetachRolePolicyCommand } from '@aws-sdk/client-iam';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

export interface UnblockDeps {
  iam: IAMClient;
  ddb: DynamoDBClient;
}

export async function processUnblock(
  targetSub: string,
  denyPolicyArn: string,
  userLimitsTable: string,
  deps: UnblockDeps,
) {
  await deps.iam.send(new DetachRolePolicyCommand({
    RoleName: `BedrockUser-${targetSub}`,
    PolicyArn: denyPolicyArn,
  }));

  await deps.ddb.send(new UpdateItemCommand({
    TableName: userLimitsTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
    UpdateExpression: 'SET blocked = :blocked',
    ExpressionAttributeValues: { ':blocked': { BOOL: false } },
  }));

  return { statusCode: 200, body: JSON.stringify({ message: 'User unblocked' }) };
}

const iam = new IAMClient({});
const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext?: { authorizer: { jwt: { claims: Record<string, string> } } };
  pathParameters?: { sub: string };
  sub?: string;
}) => {
  // Direct invocation from another Lambda (e.g., limits Lambda)
  if (event.sub && !event.requestContext) {
    return processUnblock(
      event.sub,
      process.env.BEDROCK_DENY_POLICY_ARN!,
      process.env.USER_LIMITS_TABLE!,
      { iam, ddb },
    );
  }

  const groups = event.requestContext!.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  return processUnblock(
    event.pathParameters!.sub,
    process.env.BEDROCK_DENY_POLICY_ARN!,
    process.env.USER_LIMITS_TABLE!,
    { iam, ddb },
  );
};
