import * as zlib from 'zlib';

// ── Mocks (declared before jest.mock) ────────────────────────────

const mockDdbSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSnsSend = jest.fn();
const mockSesSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn((input: unknown) => ({ _type: 'SendEmail', input })),
}));

jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn((input: unknown) => ({ _type: 'Publish', input })),
}));

import { handler, normalizeModelId } from '../../lambdas/metering/index';

// ── Helpers ──────────────────────────────────────────────────────

const ARN = 'arn:aws:sts::123456789012:assumed-role/BedrockUser-abc-123/abc-123';
const MODEL_ID = 'anthropic.claude-3-sonnet';

function makeLogRecord(overrides: Record<string, unknown> = {}) {
  return {
    identity: { arn: ARN },
    modelId: MODEL_ID,
    input: { inputTokenCount: 1500 },
    output: { outputTokenCount: 500 },
    ...overrides,
  };
}

function encodePayload(logRecords: unknown[]) {
  const payload = {
    messageType: 'DATA_MESSAGE',
    logEvents: logRecords.map((r, i) => ({
      id: String(i),
      timestamp: Date.now(),
      message: JSON.stringify(r),
    })),
  };
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  return { awslogs: { data: compressed.toString('base64') } };
}

function setupRatesMock() {
  mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { PK?: { S: string } } } }) => {
    if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
      return Promise.resolve({
        Item: {
          modelId: { S: MODEL_ID },
          inputUsdPer1k: { N: '0.003' },
          outputUsdPer1k: { N: '0.015' },
        },
      });
    }
    if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
      return Promise.resolve({
        Item: {
          dailyUsd: { N: '5.00' },
          monthlyUsd: { N: '50.00' },
          blocked: { BOOL: false },
        },
      });
    }
    return Promise.resolve({});
  });
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USAGE_COUNTERS_TABLE = 'UsageCounters';
  process.env.MODEL_RATES_TABLE = 'ModelRates';
  process.env.HOME_REGION = 'us-east-1';
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USERS_TABLE = 'Users';
  process.env.KILLSWITCH_FUNCTION_NAME = 'KillSwitchFunction';
  process.env.WARNING_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:DailyWarning';
  process.env.WARNING_THRESHOLD = '0.8';
  process.env.SES_FROM_ADDRESS = 'alerts@example.com';
  setupRatesMock();
  mockLambdaSend.mockResolvedValue({});
  mockSnsSend.mockResolvedValue({});
  mockSesSend.mockResolvedValue({});
});

// ── Tests ────────────────────────────────────────────────────────

// R-ME-6: Uses HOME_REGION for DDB client (must run first — client is lazily cached)
test('creates DynamoDB client with home region', async () => {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

  await handler(encodePayload([makeLogRecord()]));

  expect(DynamoDBClient).toHaveBeenCalledWith(
    expect.objectContaining({ region: 'us-east-1' }),
  );
});

describe('Metering Lambda', () => {
  // R-ME-5: Derives sub from role session name in identity.arn
  test('derives sub from ARN role session name', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord()]));

    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: expect.objectContaining({
          PK: { S: 'USER#abc-123' },
        }),
      }),
    );
  });

  // R-ME-3: Computes USD cost from token counts and model rates
  test('computes correct USD cost', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord()]));

    // 1500 * 0.003/1000 + 500 * 0.015/1000 = 0.0045 + 0.0075 = 0.012
    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ':cost': { N: '0.012' },
          ':input': { N: '1500' },
          ':output': { N: '500' },
        }),
      }),
    );
  });

  // R-ME-4: Atomically updates both DAY and MONTH counters
  test('writes to both DAY and MONTH sort keys', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord()]));

    const calls = UpdateItemCommand.mock.calls.filter(
      (c: unknown[]) => (c[0] as { TableName?: string }).TableName === 'UsageCounters',
    );
    expect(calls.length).toBe(4); // DAY + MONTH + MODEL#DAY + MODEL#MONTH

    const sks = calls.map((c: unknown[]) => (c[0] as { Key: { SK: { S: string } } }).Key.SK.S);
    expect(sks).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^DAY#\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^MONTH#\d{4}-\d{2}$/),
      ]),
    );
  });

  // Per-model records: writes MODEL#<modelId>#DAY# and MODEL#<modelId>#MONTH#
  test('writes per-model usage records with invocations counter', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord()]));

    const calls = UpdateItemCommand.mock.calls.filter(
      (c: unknown[]) => (c[0] as { TableName?: string }).TableName === 'UsageCounters',
    );
    const sks = calls.map((c: unknown[]) => (c[0] as { Key: { SK: { S: string } } }).Key.SK.S);
    expect(sks).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^MODEL#anthropic\.claude-3-sonnet#DAY#\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^MODEL#anthropic\.claude-3-sonnet#MONTH#\d{4}-\d{2}$/),
      ]),
    );

    // Verify invocations counter is included
    const modelCall = calls.find(
      (c: unknown[]) => (c[0] as { Key: { SK: { S: string } } }).Key.SK.S.startsWith('MODEL#'),
    );
    expect(modelCall).toBeDefined();
    expect((modelCall![0] as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues).toHaveProperty(':inv', { N: '1' });
  });

  // R-ME-4: Uses ADD for atomic counter updates
  test('uses ADD expression for atomic updates', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord()]));

    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        UpdateExpression: 'ADD costUsd :cost, inputTokens :input, outputTokens :output',
      }),
    );
  });

  // R-ME-2: Parses log record fields
  test('looks up model rates with correct modelId', async () => {
    const { GetItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord()]));

    expect(GetItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'ModelRates',
        Key: { modelId: { S: MODEL_ID }, SK: { S: '-' } },
      }),
    );
  });

  // Unknown model: logs warning, skips record
  test('skips record and logs warning for unknown model', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetItem') return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    await handler(encodePayload([makeLogRecord({ modelId: 'unknown-model' })]));

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-model'));
    expect(UpdateItemCommand).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // Inference-profile ARN: resolves rate via last path segment, meters the record
  test('resolves inference-profile ARN modelId and meters it', async () => {
    const { GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    const profileArn =
      'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-opus-4-8';

    // Rates exist only under the short profile id (the last path segment)
    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { modelId?: { S: string } } } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        if (cmd.input?.Key?.modelId?.S === 'eu.anthropic.claude-opus-4-8') {
          return Promise.resolve({ Item: { modelId: { S: 'eu.anthropic.claude-opus-4-8' }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } } });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({ Item: { dailyUsd: { N: '5' }, monthlyUsd: { N: '50' }, blocked: { BOOL: false } } });
      }
      return Promise.resolve({});
    });

    await handler(encodePayload([makeLogRecord({ modelId: profileArn })]));

    // Looked up rates with the normalized (last-segment) id, not the ARN
    expect(GetItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'ModelRates',
        Key: { modelId: { S: 'eu.anthropic.claude-opus-4-8' }, SK: { S: '-' } },
      }),
    );
    // Not dropped
    expect(consoleSpy).not.toHaveBeenCalled();
    // Per-model usage recorded under the resolved profile id
    const sks = UpdateItemCommand.mock.calls
      .map((c: unknown[]) => (c[0] as { Key: { SK: { S: string } } }).Key.SK.S);
    expect(sks).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^MODEL#eu\.anthropic\.claude-opus-4-8#DAY#/),
        expect.stringMatching(/^MODEL#eu\.anthropic\.claude-opus-4-8#MONTH#/),
      ]),
    );
    consoleSpy.mockRestore();
  });

  // Multiple records in a single event
  test('processes multiple log records in one event', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord(), makeLogRecord()]));

    // 2 records × 4 updates each (DAY + MONTH + MODEL#DAY + MODEL#MONTH) = 8
    const counterUpdates = UpdateItemCommand.mock.calls.filter(
      (c: unknown[]) => (c[0] as { TableName?: string }).TableName === 'UsageCounters',
    );
    expect(counterUpdates.length).toBe(8);
  });

  // Records without token counts (image models, some embeddings, errored or
  // streamed invocations) must meter as 0 — never produce a NaN cost that
  // DynamoDB would reject and that would poison the whole batch.
  test('meters a record with missing token counts as zero cost', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    await handler(encodePayload([makeLogRecord({ input: undefined, output: undefined })]));

    expect(UpdateItemCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ':cost': { N: '0' },
          ':input': { N: '0' },
          ':output': { N: '0' },
        }),
      }),
    );
  });

  // A single record that throws must not fail the whole batch — the other
  // records in the same CloudWatch Logs delivery must still be metered.
  test('one failing record does not prevent metering of the others', async () => {
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { modelId?: { S: string } } } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        // The "boom" model's rate lookup blows up; the normal model resolves.
        if (cmd.input?.Key?.modelId?.S === 'boom') {
          return Promise.reject(new Error('rate lookup failed'));
        }
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({ Item: { dailyUsd: { N: '5' }, monthlyUsd: { N: '50' }, blocked: { BOOL: false } } });
      }
      return Promise.resolve({});
    });

    await expect(
      handler(encodePayload([makeLogRecord({ modelId: 'boom' }), makeLogRecord()])),
    ).resolves.not.toThrow();

    // The good record was still metered (DAY + MONTH + MODEL#DAY + MODEL#MONTH).
    const counterUpdates = UpdateItemCommand.mock.calls.filter(
      (c: unknown[]) => (c[0] as { TableName?: string }).TableName === 'UsageCounters',
    );
    expect(counterUpdates.length).toBe(4);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── Budget enforcement threshold tests ───────────────────────────

describe('Budget enforcement', () => {
  const today = new Date().toISOString().slice(0, 10);

  function setupLimitsMock(overrides: Record<string, unknown> = {}) {
    const defaults = {
      dailyUsd: { N: '5.00' },
      monthlyUsd: { N: '50.00' },
      blocked: { BOOL: false },
    };
    const item = { ...defaults, ...overrides };

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: {
            modelId: { S: MODEL_ID },
            inputUsdPer1k: { N: '0.003' },
            outputUsdPer1k: { N: '0.015' },
          },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({ Item: item });
      }
      // UpdateItem on UsageCounters returns updated values
      if (cmd._type === 'UpdateItem' && cmd.input?.TableName === 'UsageCounters') {
        return Promise.resolve({
          Attributes: {
            costUsd: { N: '51.00' }, // over monthly budget
          },
        });
      }
      return Promise.resolve({});
    });
  }

  // R-BE-2: Monthly breach → invoke KillSwitch, set blocked=true
  test('invokes KillSwitch when monthly budget is breached and user is not blocked', async () => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    setupLimitsMock();

    await handler(encodePayload([makeLogRecord()]));

    expect(InvokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        FunctionName: 'KillSwitchFunction',
        InvocationType: 'Event',
        Payload: expect.any(String),
      }),
    );

    // Verify the payload contains the sub
    const invokeCall = InvokeCommand.mock.calls[0][0];
    expect(JSON.parse(invokeCall.Payload)).toEqual({ sub: 'abc-123' });

    // Verify blocked=true is set in UserLimits
    const limitsUpdates = UpdateItemCommand.mock.calls.filter(
      (c: unknown[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    expect(limitsUpdates.length).toBeGreaterThanOrEqual(1);
    const blockedUpdate = limitsUpdates.find(
      (c: unknown[]) => JSON.stringify(c[0]).includes('blocked'),
    );
    expect(blockedUpdate).toBeDefined();
  });

  // R-BE-2: Already blocked → do NOT invoke KillSwitch
  test('does not invoke KillSwitch when user is already blocked', async () => {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');

    setupLimitsMock({ blocked: { BOOL: true } });

    await handler(encodePayload([makeLogRecord()]));

    expect(InvokeCommand).not.toHaveBeenCalled();
  });

  // R-BE-4: Daily breach → publish SNS, set dailyWarnedOn=today
  test('publishes SNS warning when daily budget is breached and not yet warned', async () => {
    const { PublishCommand } = require('@aws-sdk/client-sns');
    const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { SK?: { S: string } } } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: {
            modelId: { S: MODEL_ID },
            inputUsdPer1k: { N: '0.003' },
            outputUsdPer1k: { N: '0.015' },
          },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: {
            dailyUsd: { N: '5.00' },
            monthlyUsd: { N: '50.00' },
            blocked: { BOOL: false },
          },
        });
      }
      if (cmd._type === 'UpdateItem' && cmd.input?.TableName === 'UsageCounters') {
        const sk = cmd.input?.Key?.SK?.S ?? '';
        if (sk.startsWith('DAY#')) {
          return Promise.resolve({ Attributes: { costUsd: { N: '6.00' } } }); // over daily
        }
        return Promise.resolve({ Attributes: { costUsd: { N: '10.00' } } }); // under monthly
      }
      return Promise.resolve({});
    });

    await handler(encodePayload([makeLogRecord()]));

    expect(PublishCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TopicArn: 'arn:aws:sns:us-east-1:123456789012:DailyWarning',
      }),
    );

    // Verify dailyWarnedOn is set
    const limitsUpdates = UpdateItemCommand.mock.calls.filter(
      (c: unknown[]) => (c[0] as { TableName?: string }).TableName === 'UserLimits',
    );
    const warnedUpdate = limitsUpdates.find(
      (c: unknown[]) => JSON.stringify(c[0]).includes('dailyWarnedOn'),
    );
    expect(warnedUpdate).toBeDefined();
  });

  // R-BE-4: Already warned today → do NOT publish SNS
  test('does not publish SNS when already warned today', async () => {
    const { PublishCommand } = require('@aws-sdk/client-sns');

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { SK?: { S: string } } } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: {
            modelId: { S: MODEL_ID },
            inputUsdPer1k: { N: '0.003' },
            outputUsdPer1k: { N: '0.015' },
          },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: {
            dailyUsd: { N: '5.00' },
            monthlyUsd: { N: '50.00' },
            blocked: { BOOL: false },
            dailyWarnedOn: { S: today },
          },
        });
      }
      if (cmd._type === 'UpdateItem' && cmd.input?.TableName === 'UsageCounters') {
        const sk = cmd.input?.Key?.SK?.S ?? '';
        if (sk.startsWith('DAY#')) {
          return Promise.resolve({ Attributes: { costUsd: { N: '6.00' } } });
        }
        return Promise.resolve({ Attributes: { costUsd: { N: '10.00' } } });
      }
      return Promise.resolve({});
    });

    await handler(encodePayload([makeLogRecord()]));

    expect(PublishCommand).not.toHaveBeenCalled();
  });
});

// ── 80% threshold SES warning tests ─────────────────────────────

describe('80% threshold warning', () => {
  const today = new Date().toISOString().slice(0, 10);

  test('sends SES email when daily spend crosses 80% threshold', async () => {
    const { SendEmailCommand } = require('@aws-sdk/client-ses');

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { SK?: { S: string } } } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: { dailyUsd: { N: '5.00' }, monthlyUsd: { N: '50.00' }, blocked: { BOOL: false } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'Users') {
        return Promise.resolve({
          Item: { PK: { S: 'USER#abc-123' }, SK: { S: 'PROFILE' }, email: { S: 'user@example.com' } },
        });
      }
      if (cmd._type === 'UpdateItem' && cmd.input?.TableName === 'UsageCounters') {
        const sk = cmd.input?.Key?.SK?.S ?? '';
        if (sk.startsWith('DAY#')) {
          return Promise.resolve({ Attributes: { costUsd: { N: '4.10' } } }); // 82% of $5
        }
        return Promise.resolve({ Attributes: { costUsd: { N: '10.00' } } });
      }
      return Promise.resolve({});
    });

    await handler(encodePayload([makeLogRecord()]));

    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Source: 'alerts@example.com',
        Destination: { ToAddresses: ['user@example.com'] },
      }),
    );
  });

  test('does not send SES email when dailyWarned80 is already set to today', async () => {
    const { SendEmailCommand } = require('@aws-sdk/client-ses');

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { SK?: { S: string } } } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: { dailyUsd: { N: '5.00' }, monthlyUsd: { N: '50.00' }, blocked: { BOOL: false }, dailyWarned80: { S: today } },
        });
      }
      if (cmd._type === 'UpdateItem' && cmd.input?.TableName === 'UsageCounters') {
        const sk = cmd.input?.Key?.SK?.S ?? '';
        if (sk.startsWith('DAY#')) {
          return Promise.resolve({ Attributes: { costUsd: { N: '4.50' } } });
        }
        return Promise.resolve({ Attributes: { costUsd: { N: '10.00' } } });
      }
      return Promise.resolve({});
    });

    await handler(encodePayload([makeLogRecord()]));

    expect(SendEmailCommand).not.toHaveBeenCalled();
  });

  test('does not send SES email when spend is below 80% threshold', async () => {
    const { SendEmailCommand } = require('@aws-sdk/client-ses');

    mockDdbSend.mockImplementation((cmd: { _type: string; input?: { TableName?: string; Key?: { SK?: { S: string } } } }) => {
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'ModelRates') {
        return Promise.resolve({
          Item: { modelId: { S: MODEL_ID }, inputUsdPer1k: { N: '0.003' }, outputUsdPer1k: { N: '0.015' } },
        });
      }
      if (cmd._type === 'GetItem' && cmd.input?.TableName === 'UserLimits') {
        return Promise.resolve({
          Item: { dailyUsd: { N: '5.00' }, monthlyUsd: { N: '50.00' }, blocked: { BOOL: false } },
        });
      }
      if (cmd._type === 'UpdateItem' && cmd.input?.TableName === 'UsageCounters') {
        const sk = cmd.input?.Key?.SK?.S ?? '';
        if (sk.startsWith('DAY#')) {
          return Promise.resolve({ Attributes: { costUsd: { N: '3.00' } } }); // 60% — below threshold
        }
        return Promise.resolve({ Attributes: { costUsd: { N: '10.00' } } });
      }
      return Promise.resolve({});
    });

    await handler(encodePayload([makeLogRecord()]));

    expect(SendEmailCommand).not.toHaveBeenCalled();
  });
});


describe('normalizeModelId', () => {
  test('extracts the id from an inference-profile ARN', () => {
    expect(
      normalizeModelId('arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-opus-4-8'),
    ).toBe('eu.anthropic.claude-opus-4-8');
  });

  test('extracts the id from an application-inference-profile ARN', () => {
    expect(
      normalizeModelId('arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123xyz'),
    ).toBe('abc123xyz');
  });

  test('leaves a short profile id unchanged', () => {
    expect(normalizeModelId('eu.anthropic.claude-opus-4-8')).toBe('eu.anthropic.claude-opus-4-8');
  });

  test('leaves a base model id unchanged', () => {
    expect(normalizeModelId('anthropic.claude-opus-4-8')).toBe('anthropic.claude-opus-4-8');
  });
});
