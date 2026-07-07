const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  BatchGetItemCommand: jest.fn((input: unknown) => ({ _type: 'BatchGetItem', input })),
}));

import { handler } from '../../lambdas/admin-users/dashboard';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: 'admin-001', 'cognito:groups': 'admin' } },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.USERS_TABLE = 'Users';
  process.env.USER_LIMITS_TABLE = 'UserLimits';
});

describe('GET /admin/dashboard', () => {
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

  test('returns aggregated dashboard data', async () => {
    const month = new Date().toISOString().slice(0, 7);

    mockDdbSend
      // Query byPeriod GSI
      .mockResolvedValueOnce({
        Items: [
          { PK: { S: 'USER#abc-123' }, SK: { S: `MONTH#${month}` }, costUsd: { N: '30.00' }, inputTokens: { N: '20000' }, outputTokens: { N: '10000' } },
          { PK: { S: 'USER#def-456' }, SK: { S: `MONTH#${month}` }, costUsd: { N: '10.00' }, inputTokens: { N: '8000' }, outputTokens: { N: '4000' } },
        ],
      })
      // Scan UserLimits
      .mockResolvedValueOnce({
        Items: [
          { PK: { S: 'USER#abc-123' }, SK: { S: 'LIMITS' }, blocked: { BOOL: false } },
          { PK: { S: 'USER#def-456' }, SK: { S: 'LIMITS' }, blocked: { BOOL: true } },
          { PK: { S: 'USER#ghi-789' }, SK: { S: 'LIMITS' }, blocked: { BOOL: true } },
        ],
      })
      // BatchGetItem Users
      .mockResolvedValueOnce({
        Responses: {
          Users: [
            { PK: { S: 'USER#abc-123' }, email: { S: 'alice@example.com' }, tier: { S: 'tier-power' } },
            { PK: { S: 'USER#def-456' }, email: { S: 'bob@example.com' }, tier: { S: 'tier-standard' } },
          ],
        },
      });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.totalMonthCostUsd).toBe(40);
    expect(body.activeUsers).toBe(2);
    expect(body.blockedUsers).toBe(2);
    expect(body.byTier).toEqual(expect.arrayContaining([
      { tier: 'tier-power', totalCostUsd: 30, userCount: 1 },
      { tier: 'tier-standard', totalCostUsd: 10, userCount: 1 },
    ]));
    expect(body.topUsers).toEqual([
      { sub: 'abc-123', costUsd: 30 },
      { sub: 'def-456', costUsd: 10 },
    ]);
  });

  test('returns zeros when no usage exists', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [] }) // Query
      .mockResolvedValueOnce({ Items: [] }); // Scan

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.totalMonthCostUsd).toBe(0);
    expect(body.activeUsers).toBe(0);
    expect(body.blockedUsers).toBe(0);
    expect(body.byTier).toEqual([]);
    expect(body.topUsers).toEqual([]);
  });

  test('topUsers limited to 5', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const items = Array.from({ length: 7 }, (_, i) => ({
      PK: { S: `USER#user-${i}` },
      SK: { S: `MONTH#${month}` },
      costUsd: { N: `${(7 - i) * 10}` },
    }));

    mockDdbSend
      .mockResolvedValueOnce({ Items: items })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Responses: {
          Users: items.map(i => ({
            PK: i.PK,
            email: { S: `${i.PK.S!.replace('USER#', '')}@example.com` },
            tier: { S: 'tier-standard' },
          })),
        },
      });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(body.topUsers).toHaveLength(5);
    expect(body.topUsers[0].costUsd).toBe(70);
    expect(body.topUsers[4].costUsd).toBe(30);
  });
});
