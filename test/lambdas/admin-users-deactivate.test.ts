const mockCognitoSend = jest.fn();
const mockIamSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminDisableUserCommand: jest.fn((input: unknown) => ({ _type: 'AdminDisableUser', input })),
}));

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
  AttachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'AttachRolePolicy', input })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
}));

import { handler } from '../../lambdas/admin-users/deactivate';

const TARGET_SUB = 'abc-123';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: 'admin-001', 'cognito:groups': 'admin' } },
      },
    },
    pathParameters: { sub: TARGET_SUB },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_POOL_ID = 'us-east-1_TestPool';
  process.env.BEDROCK_DENY_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockDenyAll';
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USERS_TABLE = 'Users';
  mockCognitoSend.mockResolvedValue({});
  mockIamSend.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});
});

describe('POST /admin/users/{sub}/deactivate', () => {
  test('returns 403 when caller is not admin', async () => {
    const event = makeEvent({
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'user-1', 'cognito:groups': 'tier-standard' } } },
      },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  test('disables the Cognito user', async () => {
    const { AdminDisableUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
    await handler(makeEvent());
    expect(AdminDisableUserCommand).toHaveBeenCalledWith({
      UserPoolId: 'us-east-1_TestPool',
      Username: TARGET_SUB,
    });
  });

  test('attaches BedrockDenyAll to the IAM role', async () => {
    const { AttachRolePolicyCommand } = require('@aws-sdk/client-iam');
    await handler(makeEvent());
    expect(AttachRolePolicyCommand).toHaveBeenCalledWith({
      RoleName: `BedrockUser-${TARGET_SUB}`,
      PolicyArn: 'arn:aws:iam::123456789012:policy/BedrockDenyAll',
    });
  });

  test('sets blocked=true and deactivated=true in UserLimits', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    await handler(makeEvent());
    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Key: { PK: { S: `USER#${TARGET_SUB}` }, SK: { S: 'LIMITS' } },
        UpdateExpression: 'SET blocked = :blocked, deactivated = :deactivated',
        ExpressionAttributeValues: {
          ':blocked': { BOOL: true },
          ':deactivated': { BOOL: true },
        },
      }),
    );
  });

  test('sets deactivatedAt in Users table', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    await handler(makeEvent());
    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'Users',
        Key: { PK: { S: `USER#${TARGET_SUB}` }, SK: { S: 'PROFILE' } },
        UpdateExpression: 'SET deactivatedAt = :ts',
      }),
    );
  });

  test('returns 200 on success', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: 'User deactivated' });
  });
});
