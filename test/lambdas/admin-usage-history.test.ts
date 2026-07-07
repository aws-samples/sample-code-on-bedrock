const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

import { handler } from '../../lambdas/admin-users/usage-history';

function makeEvent(groups: string, queryStringParameters?: Record<string, string>) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: 'admin-sub', 'cognito:groups': groups } } },
    },
    queryStringParameters,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
});

describe('GET /admin/usage/history', () => {
  test('returns 403 for non-admin users', async () => {
    const result = await handler(makeEvent('tier-standard', { sub: 'abc-123', from: '2026-04-01', to: '2026-04-30' }));
    expect(result.statusCode).toBe(403);
  });

  test('returns 400 when required params are missing', async () => {
    const result = await handler(makeEvent('admin', { from: '2026-04-01', to: '2026-04-30' }));
    expect(result.statusCode).toBe(400);
  });

  test('returns daily usage for specified user', async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        { PK: { S: 'USER#abc-123' }, SK: { S: 'DAY#2026-04-01' }, costUsd: { N: '3.00' }, inputTokens: { N: '5000' }, outputTokens: { N: '2000' } },
      ],
    });

    const result = await handler(makeEvent('admin', { sub: 'abc-123', from: '2026-04-01', to: '2026-04-30' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.sub).toBe('abc-123');
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toEqual({ date: '2026-04-01', costUsd: 3.0, inputTokens: 5000, outputTokens: 2000 });
  });

  test('queries with correct key condition for target user', async () => {
    const { QueryCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValue({ Items: [] });

    await handler(makeEvent('admin', { sub: 'target-user', from: '2026-04-01', to: '2026-04-15' }));

    expect(QueryCommand).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'UsageCounters',
      ExpressionAttributeValues: {
        ':pk': { S: 'USER#target-user' },
        ':skStart': { S: 'DAY#2026-04-01' },
        ':skEnd': { S: 'DAY#2026-04-15' },
      },
    }));
  });
});
