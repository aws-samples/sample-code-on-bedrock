// ── Mocks (declared before jest.mock) ────────────────────────────

const mockDdbSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockIamSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
  GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
}));

jest.mock('../../lambdas/shared/sync-model-policies', () => ({
  syncModelPolicies: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from '../../lambdas/admin-users/limits';

// ── Helpers ──────────────────────────────────────────────────────

const ADMIN_SUB = 'admin-001';
const TARGET_SUB = 'abc-123';

function makeEvent(body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
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
    pathParameters: { sub: TARGET_SUB },
    body: JSON.stringify(body),
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.USERS_TABLE = 'Users';
  process.env.KILLSWITCH_FUNCTION_NAME = 'KillSwitchFn';
  process.env.UNBLOCK_FUNCTION_NAME = 'UnblockFn';
  process.env.ACCOUNT_ID = '123456789012';
  process.env.BEDROCK_INVOKE_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockInvokeAllowed';
  mockDdbSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
});

// ── Tests ────────────────────────────────────────────────────────

describe('PUT /admin/users/{sub}/limits', () => {
  test('returns 403 when caller is not admin', async () => {
    const event = makeEvent({ dailyUsd: 10 }, {
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'user-1', 'cognito:groups': 'tier-standard' } } },
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('updates both dailyUsd and monthlyUsd', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(makeEvent({ dailyUsd: 10, monthlyUsd: 100 }));

    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Key: { PK: { S: `USER#${TARGET_SUB}` }, SK: { S: 'LIMITS' } },
      }),
    );
    const call = UpdateItemCommand.mock.calls[0][0];
    expect(call.ExpressionAttributeValues[':dailyUsd']).toEqual({ N: '10' });
    expect(call.ExpressionAttributeValues[':monthlyUsd']).toEqual({ N: '100' });
  });

  test('partial update — only monthlyUsd leaves dailyUsd unchanged', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(makeEvent({ monthlyUsd: 75 }));

    const call = UpdateItemCommand.mock.calls[0][0];
    expect(call.ExpressionAttributeValues[':monthlyUsd']).toEqual({ N: '75' });
    expect(call.ExpressionAttributeValues[':dailyUsd']).toBeUndefined();
  });

  test('returns 200 on success', async () => {
    const result = await handler(makeEvent({ dailyUsd: 10, monthlyUsd: 100 }));
    expect(result.statusCode).toBe(200);
  });

  test('invokes unblock Lambda when user is blocked and new monthlyUsd > costUsd', async () => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');

    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateItemCommand (set limits)
      .mockResolvedValueOnce({ Item: { costUsd: { N: '30' } } }) // GetItem usage
      .mockResolvedValueOnce({ Item: { blocked: { BOOL: true } } }); // GetItem limits

    const result = await handler(makeEvent({ monthlyUsd: 100 }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toBe('Limits updated; user unblocked');
    expect(InvokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ FunctionName: 'UnblockFn' }),
    );
  });

  test('does not invoke unblock when user is not blocked', async () => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');

    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateItemCommand (set limits)
      .mockResolvedValueOnce({ Item: { costUsd: { N: '30' } } }) // GetItem usage
      .mockResolvedValueOnce({ Item: { blocked: { BOOL: false } } }); // GetItem limits

    const result = await handler(makeEvent({ monthlyUsd: 100 }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toBe('Limits updated');
    expect(InvokeCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ FunctionName: 'UnblockFn' }),
    );
  });

  test('detaches the user from their tier (manual mode) by removing tier from profile', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    const result = await handler(makeEvent({ dailyUsd: 10, monthlyUsd: 100 }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).manual).toBe(true);

    const tierRemoveCall = UpdateItemCommand.mock.calls.find(
      (c: { 0: { TableName?: string; UpdateExpression?: string } }[]) =>
        (c[0] as { TableName?: string }).TableName === 'Users',
    );
    expect(tierRemoveCall).toBeDefined();
    expect(tierRemoveCall[0]).toEqual(
      expect.objectContaining({
        TableName: 'Users',
        Key: { PK: { S: `USER#${TARGET_SUB}` }, SK: { S: 'PROFILE' } },
        UpdateExpression: 'REMOVE #tier',
        ExpressionAttributeNames: { '#tier': 'tier' },
      }),
    );
  });

  test('sets a manual allowedModels override on UserLimits', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    const result = await handler(makeEvent({ allowedModels: ['m1', 'm2'] }));

    expect(result.statusCode).toBe(200);
    const limitsCall = UpdateItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsCall[0].UpdateExpression).toContain('SET allowedModels = :allowedModels');
    expect(limitsCall[0].ExpressionAttributeValues[':allowedModels']).toEqual({ L: [{ S: 'm1' }, { S: 'm2' }] });
  });

  test('allows an allowedModels-only update (no USD fields)', async () => {
    const result = await handler(makeEvent({ allowedModels: ['m1'] }));
    expect(result.statusCode).toBe(200);
  });

  test('clears the allowlist via REMOVE on an empty array', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    const result = await handler(makeEvent({ allowedModels: [] }));

    expect(result.statusCode).toBe(200);
    const limitsCall = UpdateItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsCall[0].UpdateExpression).toContain('REMOVE allowedModels');
  });

  test('returns 400 when no fields at all are supplied', async () => {
    const result = await handler(makeEvent({}));
    expect(result.statusCode).toBe(400);
  });
});
