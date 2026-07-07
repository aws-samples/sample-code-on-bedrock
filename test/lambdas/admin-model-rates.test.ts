const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  PutItemCommand: jest.fn((input: unknown) => ({ _type: 'PutItem', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
  DeleteItemCommand: jest.fn((input: unknown) => ({ _type: 'DeleteItem', input })),
}));

import { processModelRates, ModelRatesDeps } from '../../lambdas/admin-model-rates/index';

const TABLE = 'ModelRates';
const deps: ModelRatesDeps = { ddb: { send: mockSend } as any };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MODEL_RATES_TABLE = TABLE;
});

describe('Admin Model Rates Lambda', () => {
  describe('GET /admin/model-rates', () => {
    test('returns all model rates', async () => {
      mockSend.mockResolvedValue({
        Items: [
          { modelId: { S: 'anthropic.claude-3-sonnet' }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' }, displayName: { S: 'Claude 3 Sonnet' } },
          { modelId: { S: 'anthropic.claude-3-haiku' }, inputUsdPer1k: { N: '0.00025' }, outputUsdPer1k: { N: '0.00125' } },
        ],
      });

      const result = await processModelRates('GET /admin/model-rates', TABLE, {}, undefined, deps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.rates).toHaveLength(2);
      expect(body.rates[0]).toEqual({ modelId: 'anthropic.claude-3-sonnet', inputUsdPer1k: 0.003, outputUsdPer1k: 0.015, displayName: 'Claude 3 Sonnet' });
      expect(body.rates[1].displayName).toBeUndefined();
    });

    test('returns empty array when no rates exist', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const result = await processModelRates('GET /admin/model-rates', TABLE, {}, undefined, deps);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).rates).toEqual([]);
    });
  });

  describe('POST /admin/model-rates', () => {
    test('creates a model rate', async () => {
      mockSend.mockResolvedValue({});
      const { PutItemCommand } = require('@aws-sdk/client-dynamodb');

      const result = await processModelRates('POST /admin/model-rates', TABLE, {},
        JSON.stringify({ modelId: 'anthropic.claude-3-sonnet', inputUsdPer1k: 0.003, outputUsdPer1k: 0.015, displayName: 'Claude 3 Sonnet' }), deps);

      expect(result.statusCode).toBe(201);
      expect(PutItemCommand).toHaveBeenCalledWith({
        TableName: TABLE,
        Item: {
          modelId: { S: 'anthropic.claude-3-sonnet' },
          SK: { S: '-' },
          inputUsdPer1k: { N: '0.003' },
          outputUsdPer1k: { N: '0.015' },
          displayName: { S: 'Claude 3 Sonnet' },
        },
      });
    });

    test('creates without displayName', async () => {
      mockSend.mockResolvedValue({});
      const { PutItemCommand } = require('@aws-sdk/client-dynamodb');

      const result = await processModelRates('POST /admin/model-rates', TABLE, {},
        JSON.stringify({ modelId: 'model-x', inputUsdPer1k: 0.001, outputUsdPer1k: 0.002 }), deps);

      expect(result.statusCode).toBe(201);
      const call = PutItemCommand.mock.calls[PutItemCommand.mock.calls.length - 1][0];
      expect(call.Item.displayName).toBeUndefined();
    });

    test('rejects missing required fields', async () => {
      const result = await processModelRates('POST /admin/model-rates', TABLE, {},
        JSON.stringify({ modelId: 'x' }), deps);

      expect(result.statusCode).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('PUT /admin/model-rates/{modelId}', () => {
    test('updates model rate fields', async () => {
      mockSend.mockResolvedValue({});
      const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

      const result = await processModelRates('PUT /admin/model-rates/{modelId}', TABLE,
        { modelId: 'anthropic.claude-3-sonnet' },
        JSON.stringify({ inputUsdPer1k: 0.004, outputUsdPer1k: 0.02 }), deps);

      expect(result.statusCode).toBe(200);
      expect(UpdateItemCommand).toHaveBeenCalledWith(expect.objectContaining({
        TableName: TABLE,
        Key: { modelId: { S: 'anthropic.claude-3-sonnet' }, SK: { S: '-' } },
      }));
    });

    test('rejects empty update', async () => {
      const result = await processModelRates('PUT /admin/model-rates/{modelId}', TABLE,
        { modelId: 'x' }, JSON.stringify({}), deps);

      expect(result.statusCode).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /admin/model-rates/{modelId}', () => {
    test('deletes a model rate', async () => {
      mockSend.mockResolvedValue({});
      const { DeleteItemCommand } = require('@aws-sdk/client-dynamodb');

      const result = await processModelRates('DELETE /admin/model-rates/{modelId}', TABLE,
        { modelId: 'anthropic.claude-3-sonnet' }, undefined, deps);

      expect(result.statusCode).toBe(200);
      expect(DeleteItemCommand).toHaveBeenCalledWith({
        TableName: TABLE,
        Key: { modelId: { S: 'anthropic.claude-3-sonnet' }, SK: { S: '-' } },
      });
    });
  });

  describe('Admin authorization', () => {
    test('rejects non-admin users', async () => {
      const { handler } = require('../../lambdas/admin-model-rates/index');
      const event = {
        requestContext: { authorizer: { jwt: { claims: { 'cognito:groups': 'tier-standard' } } } },
        routeKey: 'GET /admin/model-rates',
        pathParameters: {},
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });
  });

  describe('Unknown route', () => {
    test('returns 400 for unknown route', async () => {
      const result = await processModelRates('PATCH /admin/model-rates', TABLE, {}, undefined, deps);
      expect(result.statusCode).toBe(400);
    });
  });
});
