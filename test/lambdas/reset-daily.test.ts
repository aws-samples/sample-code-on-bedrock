const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
}));

import { handler } from '../../lambdas/reset/daily';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  mockDdbSend.mockResolvedValue({ Items: [] });
});

describe('Daily Reset Lambda (R-BE-6)', () => {
  test('scans UserLimits for users with dailyWarnedOn set', async () => {
    const { ScanCommand } = require('@aws-sdk/client-dynamodb');

    await handler();

    expect(ScanCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        FilterExpression: 'attribute_exists(dailyWarnedOn)',
      }),
    );
  });

  test('clears dailyWarnedOn for each warned user', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { PK: { S: 'USER#abc-123' }, SK: { S: 'LIMITS' } },
        { PK: { S: 'USER#def-456' }, SK: { S: 'LIMITS' } },
      ],
    });

    await handler();

    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Key: { PK: { S: 'USER#abc-123' }, SK: { S: 'LIMITS' } },
        UpdateExpression: 'REMOVE dailyWarnedOn',
      }),
    );
    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'UserLimits',
        Key: { PK: { S: 'USER#def-456' }, SK: { S: 'LIMITS' } },
        UpdateExpression: 'REMOVE dailyWarnedOn',
      }),
    );
  });

  test('does not delete DAY# records (kept forever for history)', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [] }); // scan

    await handler();

    // Only the scan call, no query or delete
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });
});
