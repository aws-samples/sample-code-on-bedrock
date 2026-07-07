// ── Mocks (must be declared before jest.mock factories) ──────────

const mockDdbSend = jest.fn();
const mockStsSend = jest.fn();
const mockIamSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
    GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
  };
});

jest.mock('@aws-sdk/client-sts', () => {
  return {
    STSClient: jest.fn(() => ({ send: mockStsSend })),
    AssumeRoleCommand: jest.fn((input: unknown) => ({ _type: 'AssumeRole', input })),
  };
});

jest.mock('@aws-sdk/client-iam', () => {
  return {
    IAMClient: jest.fn(() => ({ send: mockIamSend })),
    GetRoleCommand: jest.fn((input: unknown) => ({ _type: 'GetRole', input })),
    CreateRoleCommand: jest.fn((input: unknown) => ({ _type: 'CreateRole', input })),
    AttachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'AttachRolePolicy', input })),
    UpdateAssumeRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'UpdateAssumeRolePolicy', input })),
  };
});

import { handler } from '../../lambdas/credentials/index';

// ── Helpers ──────────────────────────────────────────────────────

const SUB = 'abc-123';
const TIER = 'tier-standard';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            sub: SUB,
            'cognito:groups': 'admin',
          },
        },
      },
    },
    body: JSON.stringify({ assistant: 'goose' }),
    ...overrides,
  };
}

const FAKE_CREDS = {
  Credentials: {
    AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SessionToken: 'FwoGZXIvYXdzEBY...',
    Expiration: new Date('2026-04-29T12:00:00Z'),
  },
};

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_LIMITS_TABLE = 'UserLimits';
  process.env.USERS_TABLE = 'Users';
  process.env.ACCOUNT_ID = '123456789012';
  process.env.BEDROCK_INVOKE_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockInvokeAllowed';
  process.env.ALLOWED_REGIONS = JSON.stringify(['eu-central-1']);
  // Make propagation-retry backoff instant in unit tests.
  process.env.ASSUME_ROLE_RETRY_BASE_MS = '0';

  // Default: first call = UserLimits (not blocked), second call = Users (tier)
  mockDdbSend
    .mockResolvedValueOnce({
      Item: {
        PK: { S: `USER#${SUB}` },
        SK: { S: 'LIMITS' },
        blocked: { BOOL: false },
      },
    })
    .mockResolvedValueOnce({
      Item: {
        PK: { S: `USER#${SUB}` },
        SK: { S: 'PROFILE' },
        tier: { S: TIER },
      },
    });

  // Default: role already exists with an up-to-date trust policy, so the
  // lazy-create path neither re-creates nor reconciles it.
  mockIamSend.mockResolvedValue({
    Role: {
      Arn: `arn:aws:iam::123456789012:role/BedrockUser-${SUB}`,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: 'arn:aws:iam::123456789012:role/CredentialsRole' },
          Action: ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'],
        }],
      }),
    },
  });

  // Default: STS returns creds
  mockStsSend.mockResolvedValue(FAKE_CREDS);
});

// ── Tests ────────────────────────────────────────────────────────

describe('POST /credentials', () => {
  // R-CV-2: Blocked user → 403, STS never called
  test('returns 403 when user is blocked', async () => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        PK: { S: `USER#${SUB}` },
        SK: { S: 'LIMITS' },
        blocked: { BOOL: true },
      },
    });

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body);
    expect(body.message).toMatch(/blocked/i);
    expect(body.resetTime).toBeDefined();
    expect(body.adminContact).toBeDefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  // R-CV-3: STS AssumeRole parameters
  test('calls STS AssumeRole with correct parameters', async () => {
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');

    await handler(makeEvent());

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleArn: `arn:aws:iam::123456789012:role/BedrockUser-${SUB}`,
        RoleSessionName: SUB,
        DurationSeconds: 900,
        Tags: expect.arrayContaining([
          { Key: 'User', Value: SUB },
          { Key: 'Tier', Value: TIER },
          { Key: 'Assistant', Value: 'goose' },
        ]),
      }),
    );
  });

  // R-SEC-2: SourceIdentity
  test('sets SourceIdentity to sub', async () => {
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');

    await handler(makeEvent());

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ SourceIdentity: SUB }),
    );
  });

  // R-CV-4: credential_process response format
  test('returns credential_process-compatible JSON', async () => {
    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.Version).toBe(1);
    expect(body.AccessKeyId).toBe(FAKE_CREDS.Credentials.AccessKeyId);
    expect(body.SecretAccessKey).toBe(FAKE_CREDS.Credentials.SecretAccessKey);
    expect(body.SessionToken).toBe(FAKE_CREDS.Credentials.SessionToken);
    expect(body.Expiration).toBe(FAKE_CREDS.Credentials.Expiration.toISOString());
  });

  // R-ID-3: Ensures IAM role exists (idempotent create)
  test('creates IAM role if it does not exist', async () => {
    const { CreateRoleCommand, AttachRolePolicyCommand } = require('@aws-sdk/client-iam');

    const noSuchEntity = new Error('NoSuchEntity');
    noSuchEntity.name = 'NoSuchEntityException';

    // First call: GetRole throws, second: CreateRole, third: AttachRolePolicy
    mockIamSend
      .mockRejectedValueOnce(noSuchEntity)
      .mockResolvedValueOnce({ Role: { Arn: `arn:aws:iam::123456789012:role/BedrockUser-${SUB}` } })
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(CreateRoleCommand).toHaveBeenCalled();
    expect(AttachRolePolicyCommand).toHaveBeenCalled();
  });

  test('skips role creation if role already exists', async () => {
    const { CreateRoleCommand, UpdateAssumeRolePolicyCommand } = require('@aws-sdk/client-iam');

    await handler(makeEvent());
    expect(CreateRoleCommand).not.toHaveBeenCalled();
    // The trust policy is static and, once up to date, must not be rewritten on
    // every vend (would needlessly burn the IAM write-rate budget).
    expect(UpdateAssumeRolePolicyCommand).not.toHaveBeenCalled();
  });

  // Drift reconciliation: a role minted by an older code version only granted
  // sts:AssumeRole, so AssumeRole-with-SourceIdentity fails with AccessDenied on
  // sts:SetSourceIdentity. The lazy-create path must repair such roles in place
  // (one-time UpdateAssumeRolePolicy), without re-creating them.
  test('reconciles a stale trust policy missing sts:SetSourceIdentity', async () => {
    const { CreateRoleCommand, UpdateAssumeRolePolicyCommand } = require('@aws-sdk/client-iam');

    mockIamSend.mockReset();
    mockIamSend
      .mockResolvedValueOnce({
        Role: {
          Arn: `arn:aws:iam::123456789012:role/BedrockUser-${SUB}`,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::123456789012:role/CredentialsRole' },
              Action: 'sts:AssumeRole',
            }],
          }),
        },
      })
      .mockResolvedValueOnce({}); // UpdateAssumeRolePolicy

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(CreateRoleCommand).not.toHaveBeenCalled();
    expect(UpdateAssumeRolePolicyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleName: `BedrockUser-${SUB}`,
        PolicyDocument: expect.stringContaining('sts:SetSourceIdentity'),
      }),
    );
    // Reconciled policy must carry the full required action set.
    const { UpdateAssumeRolePolicyCommand: UpdCmd } = require('@aws-sdk/client-iam');
    const doc = JSON.parse(UpdCmd.mock.calls[0][0].PolicyDocument);
    expect(doc.Statement[0].Action).toEqual(
      expect.arrayContaining(['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession']),
    );
  });

  // IAM returns AssumeRolePolicyDocument URL-encoded; an already-complete policy
  // in that form must be recognized as up to date (no needless rewrite).
  test('treats a URL-encoded, complete trust policy as up to date', async () => {
    const { UpdateAssumeRolePolicyCommand } = require('@aws-sdk/client-iam');

    const encoded = encodeURIComponent(JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::123456789012:role/CredentialsRole' },
        Action: ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'],
      }],
    }));

    mockIamSend.mockReset();
    mockIamSend.mockResolvedValueOnce({
      Role: {
        Arn: `arn:aws:iam::123456789012:role/BedrockUser-${SUB}`,
        AssumeRolePolicyDocument: encoded,
      },
    });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(UpdateAssumeRolePolicyCommand).not.toHaveBeenCalled();
  });

  // After reconciling a stale role, STS may briefly reject AssumeRole until the
  // IAM trust-policy change propagates. The vend that triggered the heal must
  // ride that out rather than 500.
  test('retries AssumeRole after reconcile until STS propagation catches up', async () => {
    mockIamSend.mockReset();
    mockIamSend
      .mockResolvedValueOnce({
        Role: {
          Arn: `arn:aws:iam::123456789012:role/BedrockUser-${SUB}`,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::123456789012:role/CredentialsRole' },
              Action: 'sts:AssumeRole',
            }],
          }),
        },
      })
      .mockResolvedValueOnce({}); // UpdateAssumeRolePolicy

    const accessDenied = new Error('not yet propagated');
    accessDenied.name = 'AccessDenied';
    mockStsSend.mockReset();
    mockStsSend
      .mockRejectedValueOnce(accessDenied) // propagation lag
      .mockResolvedValueOnce(FAKE_CREDS);  // succeeds on retry

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  // If propagation outlasts the retry budget, return a retryable 503 (the role
  // is now correct, so the client's next attempt succeeds) — never a bare 500.
  test('returns retryable 503 when STS still denies after the reconcile retry budget', async () => {
    process.env.ASSUME_ROLE_RETRY_MAX_ATTEMPTS = '3';

    mockIamSend.mockReset();
    mockIamSend
      .mockResolvedValueOnce({
        Role: {
          Arn: `arn:aws:iam::123456789012:role/BedrockUser-${SUB}`,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::123456789012:role/CredentialsRole' },
              Action: 'sts:AssumeRole',
            }],
          }),
        },
      })
      .mockResolvedValueOnce({}); // UpdateAssumeRolePolicy

    const accessDenied = new Error('still not propagated');
    accessDenied.name = 'AccessDenied';
    mockStsSend.mockReset();
    mockStsSend.mockRejectedValue(accessDenied);

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(503);
    expect(result.headers?.['Retry-After']).toBe('5');
    expect(mockStsSend).toHaveBeenCalledTimes(3);

    delete process.env.ASSUME_ROLE_RETRY_MAX_ATTEMPTS;
  });

  // A healthy role that gets AccessDenied is a genuine error, not propagation
  // lag — it must surface immediately without burning the retry budget.
  test('does not retry AssumeRole for a healthy (already-correct) role', async () => {
    const accessDenied = new Error('genuine denial');
    accessDenied.name = 'AccessDenied';
    mockStsSend.mockReset();
    mockStsSend.mockRejectedValue(accessDenied);
    // Default IAM mock returns an up-to-date trust policy → no reconcile.

    await expect(handler(makeEvent())).rejects.toThrow('genuine denial');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });
});

// Region restriction is enforced via an inline STS session policy that pins
// the *source* Region (where Bedrock logs/meters the request) while still
// permitting cross-Region routing to destination Regions.
describe('POST /credentials — source-Region session policy', () => {
  const INVOKE_ACTIONS = [
    'bedrock:InvokeModel',
    'bedrock:InvokeModelWithResponseStream',
    'bedrock:Converse',
    'bedrock:ConverseStream',
  ];

  test('pins inference-profile invocation to metered source Regions', async () => {
    process.env.ALLOWED_REGIONS = JSON.stringify(['eu-central-1', 'us-east-1']);
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');

    await handler(makeEvent());

    const call = AssumeRoleCommand.mock.calls[0][0];
    const policy = JSON.parse(call.Policy);
    const byId = Object.fromEntries(policy.Statement.map((s: { Sid: string }) => [s.Sid, s]));

    // 1. Profile invocation scoped to source-Region profile ARNs only.
    const profileStmt = byId['InvokeInferenceProfilesInSourceRegions'];
    expect(profileStmt.Action).toEqual(INVOKE_ACTIONS);
    expect(profileStmt.Resource).toEqual([
      'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/*',
      'arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/*',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/*',
      'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/*',
    ]);
  });

  test('allows cross-Region routing to destination foundation models, gated on source-Region profiles', async () => {
    process.env.ALLOWED_REGIONS = JSON.stringify(['eu-central-1', 'us-east-1']);
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');

    await handler(makeEvent());

    const policy = JSON.parse(AssumeRoleCommand.mock.calls[0][0].Policy);
    const byId = Object.fromEntries(policy.Statement.map((s: { Sid: string }) => [s.Sid, s]));

    const routed = byId['InvokeRoutedFoundationModels'];
    expect(routed.Action).toEqual(INVOKE_ACTIONS);
    expect(routed.Resource).toBe('arn:aws:bedrock:*::foundation-model/*');
    // Destination FM access is only usable via one of our source-Region profiles.
    expect(routed.Condition.ArnLike['bedrock:InferenceProfileArn']).toEqual([
      'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/*',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/*',
    ]);
  });

  test('restricts direct in-Region model invocation to metered source Regions', async () => {
    process.env.ALLOWED_REGIONS = JSON.stringify(['eu-central-1', 'us-east-1']);
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');

    await handler(makeEvent());

    const policy = JSON.parse(AssumeRoleCommand.mock.calls[0][0].Policy);
    const byId = Object.fromEntries(policy.Statement.map((s: { Sid: string }) => [s.Sid, s]));

    const direct = byId['InvokeFoundationModelsInSourceRegions'];
    expect(direct.Action).toEqual(INVOKE_ACTIONS);
    expect(direct.Resource).toBe('arn:aws:bedrock:*::foundation-model/*');
    expect(direct.Condition.StringEquals['aws:RequestedRegion']).toEqual(['eu-central-1', 'us-east-1']);
  });

  test('grants only read-only discovery actions broadly', async () => {
    process.env.ALLOWED_REGIONS = JSON.stringify(['eu-central-1']);
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');

    await handler(makeEvent());

    const policy = JSON.parse(AssumeRoleCommand.mock.calls[0][0].Policy);
    const byId = Object.fromEntries(policy.Statement.map((s: { Sid: string }) => [s.Sid, s]));

    const readOnly = byId['BedrockReadOnlyDiscovery'];
    expect(readOnly.Resource).toBe('*');
    expect(readOnly.Action).toEqual([
      'bedrock:ListFoundationModels',
      'bedrock:ListInferenceProfiles',
      'bedrock:GetFoundationModel',
      'bedrock:GetInferenceProfile',
    ]);
    // No wildcard invoke permission leaks into the read-only statement.
    expect(readOnly.Action).not.toContain('bedrock:InvokeModel');
  });

  test('omits session Policy when ALLOWED_REGIONS is empty', async () => {
    process.env.ALLOWED_REGIONS = JSON.stringify([]);
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');

    await handler(makeEvent());

    const call = AssumeRoleCommand.mock.calls[0][0];
    expect(call.Policy).toBeUndefined();
  });
});
