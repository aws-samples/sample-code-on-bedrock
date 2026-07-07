// ── Mocks (declared before jest.mock) ────────────────────────────

const mockIamSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
  DetachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'DetachRolePolicy', input })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
}));

import { handler } from '../../lambdas/admin-users/unblock';

// ── Helpers ──────────────────────────────────────────────────────

const ADMIN_SUB = 'admin-001';
const TARGET_SUB = 'abc-123';

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
    pathParameters: { sub: TARGET_SUB },
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.BEDROCK_DENY_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockDenyAll';
  mockIamSend.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});
});

// ── Tests ────────────────────────────────────────────────────────

describe('POST /admin/users/{sub}/unblock', () => {
  test('returns 403 when caller is not admin', async () => {
    const event = makeEvent({
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'user-1', 'cognito:groups': 'tier-standard' } } },
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  test('detaches BedrockDenyAll from BedrockUser-<sub>', async () => {
    const { DetachRolePolicyCommand } = require('@aws-sdk/client-iam');

    await handler(makeEvent());

    expect(DetachRolePolicyCommand).toHaveBeenCalledWith({
      RoleName: `BedrockUser-${TARGET_SUB}`,
      PolicyArn: 'arn:aws:iam::123456789012:policy/BedrockDenyAll',
    });
  });

  test('sets blocked=false in UserLimits', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(makeEvent());

    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Key: { PK: { S: `USER#${TARGET_SUB}` }, SK: { S: 'LIMITS' } },
        UpdateExpression: 'SET blocked = :blocked',
        ExpressionAttributeValues: { ':blocked': { BOOL: false } },
      }),
    );
  });

  test('returns 200 on success', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
  });
});
