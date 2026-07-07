const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

import { handler } from '../../lambdas/me/usage-history';

function makeEvent(queryStringParameters?: Record<string, string>) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: 'abc-123' } } },
    },
    queryStringParameters,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
});

describe('GET /me/usage/history', () => {
  test('returns 400 when from or to is missing', async () => {
    const result = await handler(makeEvent({ from: '2026-04-01' }));
    expect(result.statusCode).toBe(400);
  });

  test('returns daily usage records within date range', async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        { PK: { S: 'USER#abc-123' }, SK: { S: 'DAY#2026-04-01' }, costUsd: { N: '1.50' }, inputTokens: { N: '1000' }, outputTokens: { N: '500' } },
        { PK: { S: 'USER#abc-123' }, SK: { S: 'DAY#2026-04-02' }, costUsd: { N: '2.00' }, inputTokens: { N: '2000' }, outputTokens: { N: '800' } },
      ],
    });

    const result = await handler(makeEvent({ from: '2026-04-01', to: '2026-04-30' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.days).toHaveLength(2);
    expect(body.days[0]).toEqual({ date: '2026-04-01', costUsd: 1.5, inputTokens: 1000, outputTokens: 500 });
    expect(body.days[1]).toEqual({ date: '2026-04-02', costUsd: 2.0, inputTokens: 2000, outputTokens: 800 });
  });

  test('returns empty array when no records exist', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });

    const result = await handler(makeEvent({ from: '2026-04-01', to: '2026-04-30' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.days).toEqual([]);
  });

  test('queries with correct key condition', async () => {
    const { QueryCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValue({ Items: [] });

    await handler(makeEvent({ from: '2026-04-01', to: '2026-04-30' }));

    expect(QueryCommand).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'UsageCounters',
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skStart AND :skEnd',
      ExpressionAttributeValues: {
        ':pk': { S: 'USER#abc-123' },
        ':skStart': { S: 'DAY#2026-04-01' },
        ':skEnd': { S: 'DAY#2026-04-30' },
      },
    }));
  });
});
