// ── Mocks (declared before jest.mock) ────────────────────────────

const mockCognitoSend = jest.fn();
const mockIamSend = jest.fn();
const mockDdbSend = jest.fn();
const mockSesSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminCreateUserCommand: jest.fn((input: unknown) => ({ _type: 'AdminCreateUser', input })),
}));

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
  CreateRoleCommand: jest.fn((input: unknown) => ({ _type: 'CreateRole', input })),
  AttachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'AttachRolePolicy', input })),
}));

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn(() => ({ send: mockSesSend })),
  VerifyEmailIdentityCommand: jest.fn((input: unknown) => ({ _type: 'VerifyEmailIdentity', input })),
}));

jest.mock('../../lambdas/shared/sync-model-policies', () => ({
  syncModelPolicies: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  PutItemCommand: jest.fn((input: unknown) => ({ _type: 'PutItem', input })),
  GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
}));

import { handler } from '../../lambdas/admin-users/create';

// ── Helpers ──────────────────────────────────────────────────────

const ADMIN_SUB = 'admin-001';
const NEW_SUB = 'new-user-sub-123';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            sub: ADMIN_SUB,
            'cognito:groups': 'admin',
          },
        },
      },
    },
    body: JSON.stringify({ email: 'dev@example.com', tier: 'tier-standard' }),
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_POOL_ID = 'us-east-1_TestPool';
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USERS_TABLE = 'Users';
  process.env.TIERS_TABLE = 'Tiers';
  process.env.ACCOUNT_ID = '123456789012';
  process.env.BEDROCK_INVOKE_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockInvokeAllowed';
  process.env.CREDENTIALS_LAMBDA_ROLE_ARN = 'arn:aws:iam::123456789012:role/CredentialsLambdaRole';

  // Default: Cognito creates user and returns sub
  mockCognitoSend.mockResolvedValue({
    User: { Username: NEW_SUB, Attributes: [{ Name: 'sub', Value: NEW_SUB }] },
  });
  mockIamSend.mockResolvedValue({});
  mockSesSend.mockResolvedValue({});
  // Default: DDB GetItem returns tier-standard limits, PutItem succeeds
  mockDdbSend.mockImplementation((cmd: { _type: string }) => {
    if (cmd._type === 'GetItem') {
      return Promise.resolve({
        Item: {
          tierId: { S: 'tier-standard' },
          dailyUsd: { N: '5' },
          monthlyUsd: { N: '50' },
        },
      });
    }
    return Promise.resolve({});
  });
});

// ── Tests ────────────────────────────────────────────────────────

describe('POST /admin/users', () => {
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

  test('creates Cognito user with correct email', async () => {
    const { AdminCreateUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

    await handler(makeEvent());

    expect(AdminCreateUserCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        UserPoolId: 'us-east-1_TestPool',
        Username: 'dev@example.com',
        UserAttributes: expect.arrayContaining([
          { Name: 'email', Value: 'dev@example.com' },
          { Name: 'email_verified', Value: 'true' },
        ]),
      }),
    );
  });

  test('creates IAM role BedrockUser-<sub>', async () => {
    const { CreateRoleCommand } = require('@aws-sdk/client-iam');

    await handler(makeEvent());

    expect(CreateRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleName: `BedrockUser-${NEW_SUB}`,
      }),
    );
  });

  test('trust policy restricts AssumeRole to credentials Lambda role only', async () => {
    const { CreateRoleCommand } = require('@aws-sdk/client-iam');

    await handler(makeEvent());

    const call = CreateRoleCommand.mock.calls[0][0];
    const trust = JSON.parse(call.AssumeRolePolicyDocument);
    expect(trust.Statement[0].Principal.AWS).toBe('arn:aws:iam::123456789012:role/CredentialsLambdaRole');
  });

  test('trust policy allows SetSourceIdentity and TagSession for the credentials Lambda', async () => {
    const { CreateRoleCommand } = require('@aws-sdk/client-iam');

    await handler(makeEvent());

    const call = CreateRoleCommand.mock.calls[0][0];
    const trust = JSON.parse(call.AssumeRolePolicyDocument);
    // The credentials Lambda assumes this role with SourceIdentity + Tags, so
    // the trust policy must permit those STS actions in addition to AssumeRole.
    expect(trust.Statement[0].Action).toEqual(
      expect.arrayContaining(['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession']),
    );
  });

  test('attaches BedrockInvokeAllowed policy to the role', async () => {
    const { AttachRolePolicyCommand } = require('@aws-sdk/client-iam');

    await handler(makeEvent());

    expect(AttachRolePolicyCommand).toHaveBeenCalledWith({
      RoleName: `BedrockUser-${NEW_SUB}`,
      PolicyArn: 'arn:aws:iam::123456789012:policy/BedrockInvokeAllowed',
    });
  });

  test('seeds UserLimits with limits from Tiers table', async () => {
    const { PutItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(makeEvent());

    expect(PutItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Item: expect.objectContaining({
          PK: { S: `USER#${NEW_SUB}` },
          SK: { S: 'LIMITS' },
          dailyUsd: { N: '5' },
          monthlyUsd: { N: '50' },
          blocked: { BOOL: false },
        }),
      }),
    );
  });

  test('uses tier-power limits when tier is tier-power', async () => {
    const { PutItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({
          Item: {
            tierId: { S: 'tier-power' },
            dailyUsd: { N: '20' },
            monthlyUsd: { N: '200' },
          },
        });
      }
      return Promise.resolve({});
    });

    const event = makeEvent({
      body: JSON.stringify({ email: 'power@example.com', tier: 'tier-power' }),
    });
    await handler(event);

    expect(PutItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Item: expect.objectContaining({
          dailyUsd: { N: '20' },
          monthlyUsd: { N: '200' },
        }),
      }),
    );
  });

  test('returns 400 when tier does not exist', async () => {
    mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });

    const event = makeEvent({
      body: JSON.stringify({ email: 'bad@example.com', tier: 'tier-nonexistent' }),
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).message).toBe('unknown tier');
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  test('returns 201 with the new user sub', async () => {
    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(201);
    expect(body.sub).toBe(NEW_SUB);
  });

  test('copies the tier allowlist into the new UserLimits item', async () => {
    const { PutItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({
          Item: {
            tierId: { S: 'tier-standard' },
            dailyUsd: { N: '5' },
            monthlyUsd: { N: '50' },
            allowedModels: { L: [{ S: 'm1' }, { S: 'm2' }] },
          },
        });
      }
      return Promise.resolve({});
    });

    await handler(makeEvent());

    const limitsPut = PutItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsPut[0].Item.allowedModels).toEqual({ L: [{ S: 'm1' }, { S: 'm2' }] });
  });

  test('omits allowedModels from UserLimits when the tier is unrestricted', async () => {
    const { PutItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(makeEvent());

    const limitsPut = PutItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsPut[0].Item.allowedModels).toBeUndefined();
  });

  test('initiates SES recipient verification for the new user email', async () => {
    const { VerifyEmailIdentityCommand } = require('@aws-sdk/client-ses');

    await handler(makeEvent());

    expect(VerifyEmailIdentityCommand).toHaveBeenCalledWith({ EmailAddress: 'dev@example.com' });
    expect(mockSesSend).toHaveBeenCalled();
  });

  test('still returns 201 when SES verification fails (best-effort)', async () => {
    mockSesSend.mockRejectedValueOnce(new Error('SES throttled'));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body).sub).toBe(NEW_SUB);
  });
});
