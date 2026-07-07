import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, DetachRolePolicyCommand, DeleteRoleCommand, ListAttachedRolePoliciesCommand } from '@aws-sdk/client-iam';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

export interface DeleteUserDeps {
  cognito: CognitoIdentityProviderClient;
  iam: IAMClient;
  ddb: DynamoDBClient;
}

export async function processDeleteUser(
  targetSub: string,
  userPoolId: string,
  userLimitsTable: string,
  usersTable: string,
  deps: DeleteUserDeps,
) {
  // Delete Cognito user
  await deps.cognito.send(new AdminDeleteUserCommand({
    UserPoolId: userPoolId,
    Username: targetSub,
  }));

  // Detach all policies from the IAM role then delete it
  const roleName = `BedrockUser-${targetSub}`;
  const attached = await deps.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
  for (const p of attached.AttachedPolicies ?? []) {
    await deps.iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: p.PolicyArn! }));
  }
  await deps.iam.send(new DeleteRoleCommand({ RoleName: roleName }));

  // Delete DynamoDB records
  await deps.ddb.send(new DeleteItemCommand({
    TableName: userLimitsTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'LIMITS' } },
  }));
  await deps.ddb.send(new DeleteItemCommand({
    TableName: usersTable,
    Key: { PK: { S: `USER#${targetSub}` }, SK: { S: 'PROFILE' } },
  }));

  return { statusCode: 200, body: JSON.stringify({ message: 'User deleted' }) };
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

  try {
    return await processDeleteUser(
      event.pathParameters.sub,
      process.env.USER_POOL_ID!,
      process.env.USER_LIMITS_TABLE!,
      process.env.USERS_TABLE!,
      { cognito, iam, ddb },
    );
  } catch (err: any) {
    console.error('DeleteUser error', err);
    return { statusCode: 500, body: JSON.stringify({ message: err.message || 'Internal error' }) };
  }
};
