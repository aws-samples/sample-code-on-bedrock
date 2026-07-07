import { CognitoIdentityProviderClient, AdminDisableUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, AttachRolePolicyCommand } from '@aws-sdk/client-iam';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

export interface DeactivateDeps {
  cognito: CognitoIdentityProviderClient;
  iam: IAMClient;
  ddb: DynamoDBClient;
}

export async function processDeactivate(
  targetSub: string,
  userPoolId: string,
  denyPolicyArn: string,
  userLimitsTable: string,
  usersTable: string,
  deps: DeactivateDeps,
) {
  await deps.cognito.send(new AdminDisableUserCommand({
    UserPoolId: userPoolId,
    Username: targetSub,
  }));

  await deps.iam.send(new AttachRolePolicyCommand({
    RoleName: `BedrockUser-${targetSub}`,
    PolicyArn: denyPolicyArn,
  }));

  await deps.ddb.send(new UpdateItemCommand({
    TableName: userLimitsTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
    UpdateExpression: 'SET blocked = :blocked, deactivated = :deactivated',
    ExpressionAttributeValues: {
      ':blocked': { BOOL: true },
      ':deactivated': { BOOL: true },
    },
  }));

  await deps.ddb.send(new UpdateItemCommand({
    TableName: usersTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'PROFILE' } },
    UpdateExpression: 'SET deactivatedAt = :ts',
    ExpressionAttributeValues: { ':ts': { S: new Date().toISOString() } },
  }));

  return { statusCode: 200, body: JSON.stringify({ message: 'User deactivated' }) };
}

const cognito = new CognitoIdentityProviderClient({});
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

  return processDeactivate(
    event.pathParameters.sub,
    process.env.USER_POOL_ID!,
    process.env.BEDROCK_DENY_POLICY_ARN!,
    process.env.USER_LIMITS_TABLE!,
    process.env.USERS_TABLE!,
    { cognito, iam, ddb },
  );
};
