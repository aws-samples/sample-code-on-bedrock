// ── Mocks (declared before jest.mock) ────────────────────────────

const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  BatchGetItemCommand: jest.fn((input: unknown) => ({ _type: 'BatchGetItem', input })),
}));

import { handler } from '../../lambdas/admin-users/usage';

// ── Helpers ──────────────────────────────────────────────────────

const ADMIN_SUB = 'admin-001';

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
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.USERS_TABLE = 'Users';
  process.env.USER_LIMITS_TABLE = 'UserLimits';
});

// ── Tests ────────────────────────────────────────────────────────

describe('GET /admin/usage', () => {
  test('returns 403 when caller is not admin', async () => {
    const event = makeEvent({
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'user-1', 'cognito:groups': 'tier-standard' } } },
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('queries byPeriod GSI with current month', async () => {
    const { QueryCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValue({ Items: [] });

    await handler(makeEvent());

    const month = new Date().toISOString().slice(0, 7);
    expect(QueryCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UsageCounters',
        IndexName: 'byPeriod',
        KeyConditionExpression: 'SK = :sk',
        ExpressionAttributeValues: { ':sk': { S: `MONTH#${month}` } },
      }),
    );
  });

  test('returns usage for all users with per-model breakdown', async () => {
    const month = new Date().toISOString().slice(0, 7);

    mockDdbSend
      .mockResolvedValueOnce({
        Items: [
          {
            PK: { S: 'USER#abc-123' },
            SK: { S: `MONTH#${month}` },
            costUsd: { N: '25.00' },
            inputTokens: { N: '20000' },
            outputTokens: { N: '10000' },
          },
          {
            PK: { S: 'USER#def-456' },
            SK: { S: `MONTH#${month}` },
            costUsd: { N: '10.00' },
            inputTokens: { N: '8000' },
            outputTokens: { N: '4000' },
          },
        ],
      })
      .mockResolvedValueOnce({
        Responses: {
          Users: [
            { PK: { S: 'USER#abc-123' }, email: { S: 'alice@example.com' } },
            { PK: { S: 'USER#def-456' }, email: { S: 'bob@example.com' } },
          ],
          UserLimits: [
            { PK: { S: 'USER#abc-123' }, blocked: { BOOL: false } },
            { PK: { S: 'USER#def-456' }, blocked: { BOOL: false } },
          ],
        },
      })
      // Per-model queries for each user
      .mockResolvedValueOnce({
        Items: [
          {
            PK: { S: 'USER#abc-123' },
            SK: { S: `MODEL#anthropic.claude-3-sonnet#MONTH#${month}` },
            costUsd: { N: '25.00' },
            inputTokens: { N: '20000' },
            outputTokens: { N: '10000' },
            invocations: { N: '100' },
          },
        ],
      })
      .mockResolvedValueOnce({ Items: [] });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.users).toHaveLength(2);

    const alice = body.users.find((u: { sub: string }) => u.sub === 'abc-123');
    expect(alice.models).toEqual([
      { modelId: 'anthropic.claude-3-sonnet', costUsd: 25, inputTokens: 20000, outputTokens: 10000, invocations: 100 },
    ]);

    const bob = body.users.find((u: { sub: string }) => u.sub === 'def-456');
    expect(bob.models).toEqual([]);
  });

  test('returns empty array when no usage exists', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.users).toEqual([]);
  });
});
