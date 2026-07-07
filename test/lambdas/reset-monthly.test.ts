const mockIamSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
  DetachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'DetachRolePolicy', input })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  DeleteItemCommand: jest.fn((input: unknown) => ({ _type: 'DeleteItem', input })),
}));

import { handler } from '../../lambdas/reset/monthly';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.BEDROCK_DENY_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockDenyAll';
  mockIamSend.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({ Items: [] });
});

describe('Monthly Reset Lambda (R-BE-5)', () => {
  test('scans UserLimits for blocked=true users', async () => {
    const { ScanCommand } = require('@aws-sdk/client-dynamodb');

    await handler();

    expect(ScanCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        FilterExpression: 'blocked = :blocked',
        ExpressionAttributeValues: { ':blocked': { BOOL: true } },
      }),
    );
  });

  test('detaches BedrockDenyAll and sets blocked=false for each blocked user', async () => {
    const { DetachRolePolicyCommand } = require('@aws-sdk/client-iam');
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    // scan returns blocked users
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { PK: { S: 'USER#abc-123' }, SK: { S: 'LIMITS' } },
        { PK: { S: 'USER#def-456' }, SK: { S: 'LIMITS' } },
      ],
    });

    await handler();

    expect(DetachRolePolicyCommand).toHaveBeenCalledWith({
      RoleName: 'BedrockUser-abc-123',
      PolicyArn: 'arn:aws:iam::123456789012:policy/BedrockDenyAll',
    });
    expect(DetachRolePolicyCommand).toHaveBeenCalledWith({
      RoleName: 'BedrockUser-def-456',
      PolicyArn: 'arn:aws:iam::123456789012:policy/BedrockDenyAll',
    });
    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Key: { PK: { S: 'USER#abc-123' }, SK: { S: 'LIMITS' } },
        UpdateExpression: 'SET blocked = :blocked',
        ExpressionAttributeValues: { ':blocked': { BOOL: false } },
      }),
    );
    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Key: { PK: { S: 'USER#def-456' }, SK: { S: 'LIMITS' } },
        UpdateExpression: 'SET blocked = :blocked',
        ExpressionAttributeValues: { ':blocked': { BOOL: false } },
      }),
    );
  });

  test('queries byPeriod GSI for previous month MONTH# records and deletes them', async () => {
    const { QueryCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');

    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const prevMonth = `MONTH#${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

    // scan returns no blocked users
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    // query returns previous month records
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { PK: { S: 'USER#abc-123' }, SK: { S: prevMonth } },
        { PK: { S: 'USER#def-456' }, SK: { S: prevMonth } },
      ],
    });

    await handler();

    expect(QueryCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UsageCounters',
        IndexName: 'byPeriod',
        KeyConditionExpression: 'SK = :sk',
        ExpressionAttributeValues: { ':sk': { S: prevMonth } },
      }),
    );

    expect(DeleteItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UsageCounters',
        Key: { PK: { S: 'USER#abc-123' }, SK: { S: prevMonth } },
      }),
    );
    expect(DeleteItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UsageCounters',
        Key: { PK: { S: 'USER#def-456' }, SK: { S: prevMonth } },
      }),
    );
  });

  test('no-op when no blocked users and no MONTH# records', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [] }); // scan
    mockDdbSend.mockResolvedValueOnce({ Items: [] }); // query

    await handler();

    expect(mockIamSend).not.toHaveBeenCalled();
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
  });
});
