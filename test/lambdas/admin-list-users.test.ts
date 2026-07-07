const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  BatchGetItemCommand: jest.fn((input: unknown) => ({ _type: 'BatchGetItem', input })),
}));

import { handler } from '../../lambdas/admin-users/list';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: 'admin-001', 'cognito:groups': 'admin' } } },
    },
    queryStringParameters: undefined as Record<string, string> | undefined,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USERS_TABLE = 'Users';
  process.env.USER_LIMITS_TABLE = 'UserLimits';
});

describe('GET /admin/users', () => {
  test('returns 403 when caller is not admin', async () => {
    const event = makeEvent({
      requestContext: { authorizer: { jwt: { claims: { sub: 'u1', 'cognito:groups': 'tier-standard' } } } },
    });
    const result = await handler(event as any);
    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('returns all users with limits enrichment', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [
          { PK: { S: 'USER#abc-123' }, SK: { S: 'PROFILE' }, email: { S: 'alice@example.com' }, tier: { S: 'tier-standard' }, createdAt: { S: '2026-01-01' } },
          { PK: { S: 'USER#def-456' }, SK: { S: 'PROFILE' }, email: { S: 'bob@example.com' }, tier: { S: 'tier-power' }, createdAt: { S: '2026-02-01' } },
        ],
        LastEvaluatedKey: undefined,
      })
      .mockResolvedValueOnce({
        Responses: {
          UserLimits: [
            { PK: { S: 'USER#abc-123' }, dailyUsd: { N: '5' }, monthlyUsd: { N: '50' }, blocked: { BOOL: false } },
            { PK: { S: 'USER#def-456' }, dailyUsd: { N: '10' }, monthlyUsd: { N: '100' }, blocked: { BOOL: true } },
          ],
        },
      });

    const result = await handler(makeEvent() as any);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.users).toHaveLength(2);
    expect(body.users).toEqual(expect.arrayContaining([
      { sub: 'abc-123', email: 'alice@example.com', tier: 'tier-standard', createdAt: '2026-01-01', dailyUsd: 5, monthlyUsd: 50, blocked: false, allowedModels: [] },
      { sub: 'def-456', email: 'bob@example.com', tier: 'tier-power', createdAt: '2026-02-01', dailyUsd: 10, monthlyUsd: 100, blocked: true, allowedModels: [] },
    ]));
  });

  test('filters by tier query param', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [
          { PK: { S: 'USER#abc-123' }, SK: { S: 'PROFILE' }, email: { S: 'alice@example.com' }, tier: { S: 'tier-standard' }, createdAt: { S: '2026-01-01' } },
          { PK: { S: 'USER#def-456' }, SK: { S: 'PROFILE' }, email: { S: 'bob@example.com' }, tier: { S: 'tier-power' }, createdAt: { S: '2026-02-01' } },
        ],
        LastEvaluatedKey: undefined,
      })
      .mockResolvedValueOnce({
        Responses: { UserLimits: [{ PK: { S: 'USER#def-456' }, dailyUsd: { N: '10' }, monthlyUsd: { N: '100' }, blocked: { BOOL: false } }] },
      });

    const event = makeEvent({ queryStringParameters: { tier: 'tier-power' } });
    const result = await handler(event as any);
    const body = JSON.parse(result.body);

    expect(body.users).toHaveLength(1);
    expect(body.users[0].sub).toBe('def-456');
  });

  test('returns empty array when no users exist', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    const result = await handler(makeEvent() as any);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.users).toEqual([]);
  });

  test('users with no UserLimits record get default values', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [{ PK: { S: 'USER#new-user' }, SK: { S: 'PROFILE' }, email: { S: 'new@example.com' }, tier: { S: 'tier-standard' }, createdAt: { S: '2026-05-01' } }],
        LastEvaluatedKey: undefined,
      })
      .mockResolvedValueOnce({ Responses: { UserLimits: [] } });

    const result = await handler(makeEvent() as any);
    const body = JSON.parse(result.body);

    expect(body.users[0]).toEqual({
      sub: 'new-user', email: 'new@example.com', tier: 'tier-standard', createdAt: '2026-05-01',
      dailyUsd: 0, monthlyUsd: 0, blocked: false, allowedModels: [],
    });
  });
});
