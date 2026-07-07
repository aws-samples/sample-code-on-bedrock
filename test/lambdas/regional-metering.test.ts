import * as zlib from 'zlib';

// ── Mocks ────────────────────────────────────────────────────────

const mockDdbSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSnsSend = jest.fn();

let capturedDdbRegion: string | undefined;
let capturedLambdaRegion: string | undefined;
let capturedSnsRegion: string | undefined;

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn((opts: { region?: string }) => {
    capturedDdbRegion = opts?.region;
    return { send: mockDdbSend };
  }),
  GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn((opts: { region?: string }) => {
    capturedLambdaRegion = opts?.region;
    return { send: mockLambdaSend };
  }),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn((opts: { region?: string }) => {
    capturedSnsRegion = opts?.region;
    return { send: mockSnsSend };
  }),
  PublishCommand: jest.fn((input: unknown) => ({ _type: 'Publish', input })),
}));

// ── Helpers ──────────────────────────────────────────────────────

const HOME_REGION = 'us-east-1';
const SECONDARY_REGION = 'eu-west-1';
const ARN = 'arn:aws:sts::123456789012:assumed-role/BedrockUser-abc-123/abc-123';
const MODEL_ID = 'anthropic.claude-3-sonnet';

function encodePayload(logRecords: unknown[]) {
  const payload = {
    messageType: 'DATA_MESSAGE',
    logEvents: logRecords.map((r, i) => ({
      id: String(i),
      timestamp: Date.now(),
      message: JSON.stringify(r),
    })),
  };
  return { awslogs: { data: zlib.gzipSync(JSON.stringify(payload)).toString('base64') } };
}

function makeLogRecord() {
  return {
    identity: { arn: ARN },
    modelId: MODEL_ID,
    input: { inputTokenCount: 1000 },
    output: { outputTokenCount: 200 },
  };
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  capturedDdbRegion = undefined;
  capturedLambdaRegion = undefined;
  capturedSnsRegion = undefined;

  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.MODEL_RATES_TABLE = 'ModelRates';
  process.env.HOME_REGION = HOME_REGION;
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.KILLSWITCH_FUNCTION_NAME = 'arn:aws:lambda:us-east-1:123456789012:function:KillSwitch';
  process.env.WARNING_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:DailyWarning';
  // Simulate Lambda running in secondary region
  process.env.AWS_REGION = SECONDARY_REGION;

  mockLambdaSend.mockResolvedValue({});
  mockSnsSend.mockResolvedValue({});
});

// ── Tests ────────────────────────────────────────────────────────

describe('Cross-region metering (R-ME-6, R-MR-2)', () => {
  test('SDK clients target home region, not the Lambda execution region', async () => {
    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: { dailyUsd: { N: '100' }, monthlyUsd: { N: '500' }, blocked: { BOOL: false } },
        });
      }
      return Promise.resolve({ Attributes: { costUsd: { N: '1.00' } } });
    });

    const { handler } = require('../../lambdas/metering/index');
    await handler(encodePayload([makeLogRecord()]));

    expect(capturedDdbRegion).toBe(HOME_REGION);
    expect(capturedLambdaRegion).toBe(HOME_REGION);
    expect(capturedSnsRegion).toBe(HOME_REGION);
  });

  test('writes usage counters to home-region DDB tables', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: { dailyUsd: { N: '100' }, monthlyUsd: { N: '500' }, blocked: { BOOL: false } },
        });
      }
      return Promise.resolve({ Attributes: { costUsd: { N: '1.00' } } });
    });

    const { handler } = require('../../lambdas/metering/index');
    await handler(encodePayload([makeLogRecord()]));

    // Verify DAY, MONTH, and per-model updates target UsageCounters
    const updates = UpdateItemCommand.mock.calls.filter(
      (c: unknown[]) => (c[0] as { TableName?: string }).TableName === 'UsageCounters',
    );
    expect(updates).toHaveLength(4); // DAY + MONTH + MODEL#DAY + MODEL#MONTH
    const sks = updates.map((c: unknown[]) => (c[0] as { Key: { SK: { S: string } } }).Key.SK.S);
    expect(sks).toEqual(expect.arrayContaining([
      expect.stringMatching(/^DAY#/),
      expect.stringMatching(/^MONTH#/),
    ]));
  });
});

describe('Global kill switch from secondary region (R-MR-3)', () => {
  test('monthly breach in secondary region invokes home-region KillSwitch', async () => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: { dailyUsd: { N: '100' }, monthlyUsd: { N: '10' }, blocked: { BOOL: false } },
        });
      }
      // Return cost exceeding monthly budget
      return Promise.resolve({ Attributes: { costUsd: { N: '11.00' } } });
    });

    const { handler } = require('../../lambdas/metering/index');
    await handler(encodePayload([makeLogRecord()]));

    // KillSwitch invoked via home-region Lambda client
    expect(InvokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        FunctionName: 'arn:aws:lambda:us-east-1:123456789012:function:KillSwitch',
        InvocationType: 'Event',
        Payload: JSON.stringify({ sub: 'abc-123' }),
      }),
    );
    expect(capturedLambdaRegion).toBe(HOME_REGION);
  });

  test('blocked flag set in home-region UserLimits from secondary region', async () => {
    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: { dailyUsd: { N: '100' }, monthlyUsd: { N: '10' }, blocked: { BOOL: false } },
        });
      }
      return Promise.resolve({ Attributes: { costUsd: { N: '11.00' } } });
    });

    const { handler } = require('../../lambdas/metering/index');
    await handler(encodePayload([makeLogRecord()]));

    // Verify blocked=true written to UserLimits via mockDdbSend calls
    const updateCalls = mockDdbSend.mock.calls
      .map((c: unknown[]) => c[0] as { _type: string; input?: Record<string, unknown> })
      .filter((cmd) => cmd._type === 'UpdateItem' && (cmd.input as { TableName?: string })?.TableName === 'UserLimits');
    const blockedUpdate = updateCalls.find(
      (cmd) => JSON.stringify(cmd.input).includes('blocked'),
    );
    expect(blockedUpdate).toBeDefined();
    expect((blockedUpdate!.input as { ExpressionAttributeValues: { ':blocked': { BOOL: boolean } } })
      .ExpressionAttributeValues[':blocked']).toEqual({ BOOL: true });
  });
});
