const mockCwSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCwSend })),
  GetMetricStatisticsCommand: jest.fn((input: unknown) => ({ _type: 'GetMetricStatistics', input })),
  PutMetricDataCommand: jest.fn((input: unknown) => ({ _type: 'PutMetricData', input })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

import { handler } from '../../lambdas/crosscheck/index';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USERS_TABLE = 'Users';
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.DIVERGENCE_THRESHOLD = '0.1';
});

const makeUsersResponse = (subs: string[]) => ({
  Items: subs.map(s => ({ PK: { S: `USER#${s}` }, SK: { S: 'PROFILE' } })),
});

describe('Cross-check Lambda (R-ME-7, R-ME-8)', () => {
  // R-ME-7: Compares CW metrics against DDB counters
  test('queries CW metrics and DDB counters for each user', async () => {
    const { GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
    const { ScanCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend
      .mockResolvedValueOnce(makeUsersResponse(['abc-123'])) // scan Users
      .mockResolvedValueOnce({ Items: [{ inputTokens: { N: '1000' }, outputTokens: { N: '500' } }] }); // query UsageCounters

    mockCwSend
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 1000 }] }) // InputTokenCount
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 500 }] }); // OutputTokenCount

    await handler();

    expect(ScanCommand).toHaveBeenCalledWith(expect.objectContaining({ TableName: 'Users' }));
    expect(GetMetricStatisticsCommand).toHaveBeenCalledTimes(2);
    expect(QueryCommand).toHaveBeenCalledWith(expect.objectContaining({ TableName: 'UsageCounters' }));
  });

  // R-ME-8: Within threshold → no alarm metric published
  test('does not publish metric when divergence is within threshold', async () => {
    const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

    mockDdbSend
      .mockResolvedValueOnce(makeUsersResponse(['abc-123']))
      .mockResolvedValueOnce({ Items: [{ inputTokens: { N: '1000' }, outputTokens: { N: '500' } }] });

    mockCwSend
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 1000 }] })
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 500 }] });

    await handler();

    expect(PutMetricDataCommand).not.toHaveBeenCalled();
  });

  // R-ME-8: Exceeds threshold → publishes custom metric
  test('publishes divergence metric when threshold exceeded', async () => {
    const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

    mockDdbSend
      .mockResolvedValueOnce(makeUsersResponse(['abc-123']))
      .mockResolvedValueOnce({ Items: [{ inputTokens: { N: '1000' }, outputTokens: { N: '500' } }] });

    // CW reports significantly different values
    mockCwSend
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 2000 }] }) // InputTokenCount diverges
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 500 }] });

    await handler();

    expect(PutMetricDataCommand).toHaveBeenCalledWith(expect.objectContaining({
      Namespace: 'CodeOnBedrock',
      MetricData: expect.arrayContaining([expect.objectContaining({
        MetricName: 'MeteringDivergence',
        Value: 1,
      })]),
    }));
    expect(mockCwSend).toHaveBeenCalledTimes(3); // 2 GetMetric + 1 PutMetric
  });

  // Handles missing CW data gracefully (no datapoints)
  test('handles missing CW data gracefully', async () => {
    mockDdbSend
      .mockResolvedValueOnce(makeUsersResponse(['abc-123']))
      .mockResolvedValueOnce({ Items: [{ inputTokens: { N: '100' }, outputTokens: { N: '50' } }] });

    mockCwSend
      .mockResolvedValueOnce({ Datapoints: [] }) // no CW data
      .mockResolvedValueOnce({ Datapoints: [] });

    await handler();

    // Should not throw — treats missing CW data as 0
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
  });

  // No users → no-op
  test('no-op when no users exist', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [] });

    await handler();

    expect(mockCwSend).not.toHaveBeenCalled();
    expect(mockDdbSend).toHaveBeenCalledTimes(1); // only the scan
  });

  // Multiple users — checks each
  test('processes multiple users', async () => {
    const { GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');

    mockDdbSend
      .mockResolvedValueOnce(makeUsersResponse(['abc-123', 'def-456']))
      .mockResolvedValueOnce({ Items: [{ inputTokens: { N: '100' }, outputTokens: { N: '50' } }] })
      .mockResolvedValueOnce({ Items: [{ inputTokens: { N: '200' }, outputTokens: { N: '100' } }] });

    mockCwSend
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 100 }] })
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 50 }] })
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 200 }] })
      .mockResolvedValueOnce({ Datapoints: [{ Sum: 100 }] });

    await handler();

    expect(GetMetricStatisticsCommand).toHaveBeenCalledTimes(4); // 2 per user
  });
});
