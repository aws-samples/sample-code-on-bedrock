// ── Mocks (declared before jest.mock) ────────────────────────────

const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
  PutItemCommand: jest.fn((input: unknown) => ({ _type: 'PutItem', input })),
}));

import { handler } from '../../lambdas/me/limits';

// ── Helpers ──────────────────────────────────────────────────────

const SUB = 'abc-123';

function makeEvent() {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: SUB } } },
    },
  };
}

interface CommandArg {
  _type: string;
  input: { Key?: { SK?: { S?: string } } };
}

/**
 * Route GetItem sends by their SK so the LIMITS lookup and the PROFILE (tier)
 * lookup can return distinct items. PutItem (defaults seeding) resolves empty.
 */
function routeSends(limitsItem: unknown, profileItem: unknown) {
  mockDdbSend.mockImplementation((cmd: CommandArg) => {
    if (cmd._type === 'GetItem') {
      const sk = cmd.input.Key?.SK?.S;
      if (sk === 'PROFILE') return Promise.resolve({ Item: profileItem });
      return Promise.resolve(limitsItem ? { Item: limitsItem } : {});
    }
    return Promise.resolve({});
  });
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USERS_TABLE = 'Users';
});

// ── Tests ────────────────────────────────────────────────────────

describe('GET /me/limits', () => {
  test('returns dailyUsd, monthlyUsd, blocked, allowedModels, and tier', async () => {
    routeSends(
      {
        PK: { S: `USER#${SUB}` },
        SK: { S: 'LIMITS' },
        dailyUsd: { N: '5.00' },
        monthlyUsd: { N: '50.00' },
        blocked: { BOOL: false },
      },
      { PK: { S: `USER#${SUB}` }, SK: { S: 'PROFILE' }, tier: { S: 'tier-power' } },
    );

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body).toEqual({
      dailyUsd: 5,
      monthlyUsd: 50,
      blocked: false,
      allowedModels: [],
      tier: 'tier-power',
    });
  });

  test('returns tier null when the user has no tier on their profile', async () => {
    routeSends(
      {
        PK: { S: `USER#${SUB}` },
        SK: { S: 'LIMITS' },
        dailyUsd: { N: '5' },
        monthlyUsd: { N: '50' },
        blocked: { BOOL: false },
      },
      { PK: { S: `USER#${SUB}` }, SK: { S: 'PROFILE' } },
    );

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(body.tier).toBeNull();
  });

  test('surfaces a non-empty allowedModels allowlist', async () => {
    routeSends(
      {
        PK: { S: `USER#${SUB}` },
        SK: { S: 'LIMITS' },
        dailyUsd: { N: '5' },
        monthlyUsd: { N: '50' },
        blocked: { BOOL: false },
        allowedModels: { L: [{ S: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }, { S: 'amazon.titan-text-express-v1' }] },
      },
      { tier: { S: 'tier-power' } },
    );

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.allowedModels).toEqual([
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'amazon.titan-text-express-v1',
    ]);
  });

  test('queries with correct key', async () => {
    const { GetItemCommand } = require('@aws-sdk/client-dynamodb');
    routeSends(
      { dailyUsd: { N: '5' }, monthlyUsd: { N: '50' }, blocked: { BOOL: false } },
      { tier: { S: 'tier-basic' } },
    );

    await handler(makeEvent());

    expect(GetItemCommand).toHaveBeenCalledWith({
      TableName: 'UserLimits',
      Key: { PK: { S: `USER#${SUB}` }, SK: { S: 'LIMITS' } },
    });
    expect(GetItemCommand).toHaveBeenCalledWith({
      TableName: 'Users',
      Key: { PK: { S: `USER#${SUB}` }, SK: { S: 'PROFILE' } },
    });
  });

  test('returns defaults (with tier) when no limits record exists', async () => {
    routeSends(null, { tier: { S: 'tier-basic' } });

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toEqual({ dailyUsd: 5, monthlyUsd: 50, blocked: false, allowedModels: [], tier: 'tier-basic' });
  });
});
