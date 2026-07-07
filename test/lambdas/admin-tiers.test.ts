// ── Mocks (declared before jest.mock) ────────────────────────────

const mockDdbSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  PutItemCommand: jest.fn((input: unknown) => ({ _type: 'PutItem', input })),
  GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
  DeleteItemCommand: jest.fn((input: unknown) => ({ _type: 'DeleteItem', input })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

import { processTiers } from '../../lambdas/admin-tiers/index';

const deps = () => ({ ddb: { send: mockDdbSend } as never, lambda: { send: mockLambdaSend } as never });
const propagation = { usersTable: 'Users', userTierFn: 'UserTierFn' };

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
});

describe('PUT /admin/tiers/{tierId} propagation', () => {
  test('updates the tier then re-syncs every attached user', async () => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');

    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateItem tier
      .mockResolvedValueOnce({
        Items: [
          { PK: { S: 'USER#u1' }, tier: { S: 'tier-power' } },
          { PK: { S: 'USER#u2' }, tier: { S: 'tier-power' } },
        ],
      }); // Scan users on tier

    const result = await processTiers(
      'PUT /admin/tiers/{tierId}',
      'Tiers',
      { tierId: 'tier-power' },
      JSON.stringify({ dailyUsd: 20, monthlyUsd: 200 }),
      deps(),
      propagation,
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).syncedUsers).toBe(2);

    expect(InvokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        FunctionName: 'UserTierFn',
        InvocationType: 'Event',
        Payload: JSON.stringify({ internal: true, sub: 'u1', tier: 'tier-power' }),
      }),
    );
    expect(InvokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        FunctionName: 'UserTierFn',
        Payload: JSON.stringify({ internal: true, sub: 'u2', tier: 'tier-power' }),
      }),
    );
  });

  test('does not propagate when no propagation config is supplied', async () => {
    mockDdbSend.mockResolvedValueOnce({}); // UpdateItem tier

    const result = await processTiers(
      'PUT /admin/tiers/{tierId}',
      'Tiers',
      { tierId: 'tier-power' },
      JSON.stringify({ monthlyUsd: 200 }),
      deps(),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).syncedUsers).toBe(0);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('reports zero synced users when none are attached to the tier', async () => {
    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateItem tier
      .mockResolvedValueOnce({ Items: [] }); // Scan users

    const result = await processTiers(
      'PUT /admin/tiers/{tierId}',
      'Tiers',
      { tierId: 'tier-empty' },
      JSON.stringify({ dailyUsd: 1, monthlyUsd: 10 }),
      deps(),
      propagation,
    );

    expect(JSON.parse(result.body).syncedUsers).toBe(0);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('allowedModels (model allowlist)', () => {
  test('POST stores allowedModels as a DynamoDB list', async () => {
    const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValueOnce({});

    const result = await processTiers(
      'POST /admin/tiers',
      'Tiers',
      {},
      JSON.stringify({ tierId: 'tier-x', dailyUsd: 5, monthlyUsd: 50, allowedModels: ['m1', 'm2'] }),
      deps(),
    );

    expect(result.statusCode).toBe(201);
    const item = PutItemCommand.mock.calls[0][0].Item;
    expect(item.allowedModels).toEqual({ L: [{ S: 'm1' }, { S: 'm2' }] });
  });

  test('POST omits allowedModels when none given (unrestricted)', async () => {
    const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValueOnce({});

    await processTiers(
      'POST /admin/tiers',
      'Tiers',
      {},
      JSON.stringify({ tierId: 'tier-x', dailyUsd: 5, monthlyUsd: 50 }),
      deps(),
    );

    const item = PutItemCommand.mock.calls[0][0].Item;
    expect(item.allowedModels).toBeUndefined();
  });

  test('PUT sets allowedModels via SET', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValueOnce({});

    await processTiers(
      'PUT /admin/tiers/{tierId}',
      'Tiers',
      { tierId: 'tier-x' },
      JSON.stringify({ allowedModels: ['m1'] }),
      deps(),
    );

    const call = UpdateItemCommand.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('SET allowedModels = :am');
    expect(call.ExpressionAttributeValues[':am']).toEqual({ L: [{ S: 'm1' }] });
  });

  test('PUT clears allowedModels via REMOVE on empty array', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    mockDdbSend.mockResolvedValueOnce({});

    await processTiers(
      'PUT /admin/tiers/{tierId}',
      'Tiers',
      { tierId: 'tier-x' },
      JSON.stringify({ allowedModels: [] }),
      deps(),
    );

    const call = UpdateItemCommand.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('REMOVE allowedModels');
  });

  test('GET list returns allowedModels', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { tierId: { S: 'tier-x' }, dailyUsd: { N: '5' }, monthlyUsd: { N: '50' }, allowedModels: { L: [{ S: 'm1' }] } },
        { tierId: { S: 'tier-y' }, dailyUsd: { N: '1' }, monthlyUsd: { N: '10' } },
      ],
    });

    const result = await processTiers('GET /admin/tiers', 'Tiers', {}, undefined, deps());
    const tiers = JSON.parse(result.body).tiers;
    expect(tiers[0].allowedModels).toEqual(['m1']);
    expect(tiers[1].allowedModels).toEqual([]);
  });

  test('GET by id returns allowedModels', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: { tierId: { S: 'tier-x' }, dailyUsd: { N: '5' }, monthlyUsd: { N: '50' }, allowedModels: { L: [{ S: 'm1' }, { S: 'm2' }] } },
    });

    const result = await processTiers('GET /admin/tiers/{tierId}', 'Tiers', { tierId: 'tier-x' }, undefined, deps());
    expect(JSON.parse(result.body).allowedModels).toEqual(['m1', 'm2']);
  });
});
