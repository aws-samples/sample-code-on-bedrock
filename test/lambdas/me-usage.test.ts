// ── Mocks (declared before jest.mock) ────────────────────────────

const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

import { handler } from '../../lambdas/me/usage';

// ── Helpers ──────────────────────────────────────────────────────

const SUB = 'abc-123';

function makeEvent(queryStringParameters?: Record<string, string>) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: SUB } } },
    },
    queryStringParameters,
  };
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
});

// ── Tests ────────────────────────────────────────────────────────

describe('GET /me/usage', () => {
  test('returns day and month usage for the caller', async () => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const month = today.slice(0, 7); // YYYY-MM

    mockDdbSend.mockResolvedValue({
      Items: [
        {
          PK: { S: `USER#${SUB}` },
          SK: { S: `DAY#${today}` },
          costUsd: { N: '1.50' },
          inputTokens: { N: '1000' },
          outputTokens: { N: '500' },
        },
        {
          PK: { S: `USER#${SUB}` },
          SK: { S: `MONTH#${month}` },
          costUsd: { N: '25.00' },
          inputTokens: { N: '20000' },
          outputTokens: { N: '10000' },
        },
      ],
    });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.day).toEqual({ costUsd: 1.5, inputTokens: 1000, outputTokens: 500 });
    expect(body.month).toEqual({ costUsd: 25, inputTokens: 20000, outputTokens: 10000 });
  });

  test('returns zeroes when no records exist', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.day).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(body.month).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  test('queries with correct PK and SK prefix', async () => {
    const { QueryCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValue({ Items: [] });

    await handler(makeEvent());

    expect(QueryCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UsageCounters',
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skStart AND :skEnd',
        ExpressionAttributeValues: expect.objectContaining({
          ':pk': { S: `USER#${SUB}` },
        }),
      }),
    );
  });
});

describe('GET /me/usage?breakdown=model', () => {
  test('returns per-model breakdown when breakdown=model is set', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    mockDdbSend
      .mockResolvedValueOnce({
        Items: [
          {
            PK: { S: `USER#${SUB}` },
            SK: { S: `DAY#${today}` },
            costUsd: { N: '1.50' },
            inputTokens: { N: '1000' },
            outputTokens: { N: '500' },
          },
          {
            PK: { S: `USER#${SUB}` },
            SK: { S: `MONTH#${month}` },
            costUsd: { N: '25.00' },
            inputTokens: { N: '20000' },
            outputTokens: { N: '10000' },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            PK: { S: `USER#${SUB}` },
            SK: { S: `MODEL#anthropic.claude-3-sonnet#MONTH#${month}` },
            costUsd: { N: '20.00' },
            inputTokens: { N: '15000' },
            outputTokens: { N: '8000' },
            invocations: { N: '50' },
          },
          {
            PK: { S: `USER#${SUB}` },
            SK: { S: `MODEL#amazon.titan-text-express#MONTH#${month}` },
            costUsd: { N: '5.00' },
            inputTokens: { N: '5000' },
            outputTokens: { N: '2000' },
            invocations: { N: '20' },
          },
        ],
      });

    const result = await handler(makeEvent({ breakdown: 'model' }));
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.models).toHaveLength(2);
    expect(body.models).toEqual(expect.arrayContaining([
      { modelId: 'anthropic.claude-3-sonnet', period: 'month', costUsd: 20, inputTokens: 15000, outputTokens: 8000, invocations: 50 },
      { modelId: 'amazon.titan-text-express', period: 'month', costUsd: 5, inputTokens: 5000, outputTokens: 2000, invocations: 20 },
    ]));
  });

  test('does not include models when breakdown param is absent', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.models).toBeUndefined();
  });

  test('makes second query for MODEL# range when breakdown=model', async () => {
    const { QueryCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValue({ Items: [] });

    await handler(makeEvent({ breakdown: 'model' }));

    expect(QueryCommand).toHaveBeenCalledTimes(2);
    expect(QueryCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skStart AND :skEnd',
        ExpressionAttributeValues: expect.objectContaining({
          ':skStart': { S: 'MODEL#' },
          ':skEnd': { S: 'MODEL#~' },
        }),
      }),
    );
  });
});
