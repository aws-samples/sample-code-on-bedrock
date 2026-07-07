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

import { handler, processSetTier } from '../../lambdas/admin-users/tier';

// ── Helpers ──────────────────────────────────────────────────────

const ADMIN_SUB = 'admin-001';
const TARGET_SUB = 'abc-123';

function makeEvent(body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: ADMIN_SUB, 'cognito:groups': 'admin' } } },
    },
    pathParameters: { sub: TARGET_SUB },
    body: JSON.stringify(body),
    ...overrides,
  };
}

const config = {
  usersTable: 'Users',
  tiersTable: 'Tiers',
  userLimitsTable: 'UserLimits',
  usageCountersTable: 'UsageCounters',
  killswitchFn: 'KillSwitchFn',
  unblockFn: 'UnblockFn',
  accountId: '123456789012',
  bedrockInvokePolicyArn: 'arn:aws:iam::123456789012:policy/BedrockInvokeAllowed',
};

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USERS_TABLE = 'Users';
  process.env.TIERS_TABLE = 'Tiers';
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.KILLSWITCH_FUNCTION_NAME = 'KillSwitchFn';
  process.env.UNBLOCK_FUNCTION_NAME = 'UnblockFn';
  process.env.ACCOUNT_ID = '123456789012';
  process.env.BEDROCK_INVOKE_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockInvokeAllowed';
  mockDdbSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
});

// ── Tests ────────────────────────────────────────────────────────

describe('PUT /admin/users/{sub}/tier', () => {
  test('returns 403 when caller is not admin', async () => {
    const event = makeEvent({ tier: 'tier-standard' }, {
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'user-1', 'cognito:groups': 'tier-standard' } } },
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('returns 400 for an unknown tier', async () => {
    mockDdbSend.mockResolvedValueOnce({}); // GetItem tier -> no Item

    const result = await processSetTier(TARGET_SUB, 'nope', config, {
      ddb: { send: mockDdbSend } as never,
      lambda: { send: mockLambdaSend } as never,
      iam: { send: mockIamSend } as never,
    });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).message).toBe('unknown tier');
  });

  test('records tier on profile and syncs UserLimits to tier limits', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend
      .mockResolvedValueOnce({ Item: { tierId: { S: 'tier-power' }, dailyUsd: { N: '10' }, monthlyUsd: { N: '100' } } }) // GetItem tier
      .mockResolvedValueOnce({}) // UpdateItem profile.tier
      .mockResolvedValueOnce({}) // UpdateItem limits
      .mockResolvedValueOnce({ Item: { costUsd: { N: '0' } } }) // reconcile getUsage
      .mockResolvedValueOnce({ Item: { blocked: { BOOL: false } } }); // reconcile getLimits

    const result = await processSetTier(TARGET_SUB, 'tier-power', config, {
      ddb: { send: mockDdbSend } as never,
      lambda: { send: mockLambdaSend } as never,
      iam: { send: mockIamSend } as never,
    });

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed).toMatchObject({ tier: 'tier-power', dailyUsd: 10, monthlyUsd: 100 });

    const profileCall = UpdateItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'Users',
    );
    expect(profileCall[0]).toEqual(
      expect.objectContaining({
        TableName: 'Users',
        Key: { PK: { S: `USER#${TARGET_SUB}` }, SK: { S: 'PROFILE' } },
        UpdateExpression: 'SET #tier = :tier',
        ExpressionAttributeNames: { '#tier': 'tier' },
        ExpressionAttributeValues: { ':tier': { S: 'tier-power' } },
      }),
    );

    const limitsCall = UpdateItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsCall[0].ExpressionAttributeValues).toEqual({
      ':d': { N: '10' },
      ':m': { N: '100' },
    });
  });

  test('unblocks an over-budget user when moved to a higher tier', async () => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');

    mockDdbSend
      .mockResolvedValueOnce({ Item: { tierId: { S: 'tier-power' }, dailyUsd: { N: '10' }, monthlyUsd: { N: '100' } } }) // GetItem tier
      .mockResolvedValueOnce({}) // UpdateItem profile.tier
      .mockResolvedValueOnce({}) // UpdateItem limits
      .mockResolvedValueOnce({ Item: { costUsd: { N: '40' } } }) // reconcile getUsage (40 < 100)
      .mockResolvedValueOnce({ Item: { blocked: { BOOL: true } } }); // reconcile getLimits (currently blocked)

    const result = await processSetTier(TARGET_SUB, 'tier-power', config, {
      ddb: { send: mockDdbSend } as never,
      lambda: { send: mockLambdaSend } as never,
      iam: { send: mockIamSend } as never,
    });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toContain('user unblocked');
    expect(InvokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ FunctionName: 'UnblockFn' }),
    );
  });

  test('internal invocation bypasses the admin check (used by tier propagation)', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { tierId: { S: 'tier-standard' }, dailyUsd: { N: '5' }, monthlyUsd: { N: '50' } } }) // GetItem tier
      .mockResolvedValueOnce({}) // UpdateItem profile.tier
      .mockResolvedValueOnce({}) // UpdateItem limits
      .mockResolvedValueOnce({ Item: { costUsd: { N: '0' } } }) // reconcile getUsage
      .mockResolvedValueOnce({ Item: { blocked: { BOOL: false } } }); // reconcile getLimits

    const result = await handler({ internal: true, sub: TARGET_SUB, tier: 'tier-standard' });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).tier).toBe('tier-standard');
  });

  test('copies the tier allowlist into UserLimits when the tier has one', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend
      .mockResolvedValueOnce({ Item: { tierId: { S: 'tier-power' }, dailyUsd: { N: '10' }, monthlyUsd: { N: '100' }, allowedModels: { L: [{ S: 'm1' }, { S: 'm2' }] } } })
      .mockResolvedValueOnce({}) // UpdateItem profile.tier
      .mockResolvedValueOnce({}) // UpdateItem limits
      .mockResolvedValueOnce({ Item: { costUsd: { N: '0' } } })
      .mockResolvedValueOnce({ Item: { blocked: { BOOL: false } } });

    await processSetTier(TARGET_SUB, 'tier-power', config, {
      ddb: { send: mockDdbSend } as never,
      lambda: { send: mockLambdaSend } as never,
      iam: { send: mockIamSend } as never,
    });

    const limitsCall = UpdateItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsCall[0].UpdateExpression).toContain('allowedModels = :am');
    expect(limitsCall[0].ExpressionAttributeValues[':am']).toEqual({ L: [{ S: 'm1' }, { S: 'm2' }] });
  });

  test('removes any prior allowlist when the new tier has none', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend
      .mockResolvedValueOnce({ Item: { tierId: { S: 'tier-open' }, dailyUsd: { N: '10' }, monthlyUsd: { N: '100' } } })
      .mockResolvedValueOnce({}) // UpdateItem profile.tier
      .mockResolvedValueOnce({}) // UpdateItem limits
      .mockResolvedValueOnce({ Item: { costUsd: { N: '0' } } })
      .mockResolvedValueOnce({ Item: { blocked: { BOOL: false } } });

    await processSetTier(TARGET_SUB, 'tier-open', config, {
      ddb: { send: mockDdbSend } as never,
      lambda: { send: mockLambdaSend } as never,
      iam: { send: mockIamSend } as never,
    });

    const limitsCall = UpdateItemCommand.mock.calls.find(
      (c: { TableName?: string }[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsCall[0].UpdateExpression).toContain('REMOVE allowedModels');
  });
});
