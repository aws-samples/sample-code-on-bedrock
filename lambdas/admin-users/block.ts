import { IAMClient, AttachRolePolicyCommand } from '@aws-sdk/client-iam';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

export interface BlockDeps {
  iam: IAMClient;
  ddb: DynamoDBClient;
}

export async function processBlock(
  targetSub: string,
  denyPolicyArn: string,
  userLimitsTable: string,
  deps: BlockDeps,
) {
  await deps.iam.send(new AttachRolePolicyCommand({
    RoleName: `BedrockUser-${targetSub}`,
    PolicyArn: denyPolicyArn,
  }));

  await deps.ddb.send(new UpdateItemCommand({
    TableName: userLimitsTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
    UpdateExpression: 'SET blocked = :blocked',
    ExpressionAttributeValues: { ':blocked': { BOOL: true } },
  }));

  return { statusCode: 200, body: JSON.stringify({ message: 'User blocked' }) };
}

const iam = new IAMClient({});
const ddb = new DynamoDBClient({});

export const handler = async (event: {
  requestContext: { authorizer: { jwt: { claims: Record<string, string> } } };
  pathParameters: { sub: string };
}) => {
  const groups = event.requestContext.authorizer.jwt.claims['cognito:groups'];
  if (!groups || !groups.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  return processBlock(
    event.pathParameters.sub,
    process.env.BEDROCK_DENY_POLICY_ARN!,
    process.env.USER_LIMITS_TABLE!,
    { iam, ddb },
  );
};
