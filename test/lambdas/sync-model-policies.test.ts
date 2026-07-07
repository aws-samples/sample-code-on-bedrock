const mockIamSend = jest.fn();

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
  CreatePolicyCommand: jest.fn((input: unknown) => ({ _type: 'CreatePolicy', input })),
  DeletePolicyCommand: jest.fn((input: unknown) => ({ _type: 'DeletePolicy', input })),
  AttachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'AttachRolePolicy', input })),
  DetachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'DetachRolePolicy', input })),
  ListAttachedRolePoliciesCommand: jest.fn((input: unknown) => ({ _type: 'ListAttachedRolePolicies', input })),
  CreatePolicyVersionCommand: jest.fn((input: unknown) => ({ _type: 'CreatePolicyVersion', input })),
  ListPolicyVersionsCommand: jest.fn((input: unknown) => ({ _type: 'ListPolicyVersions', input })),
  DeletePolicyVersionCommand: jest.fn((input: unknown) => ({ _type: 'DeletePolicyVersion', input })),
  GetPolicyCommand: jest.fn((input: unknown) => ({ _type: 'GetPolicy', input })),
}));

import { syncModelPolicies } from '../../lambdas/shared/sync-model-policies';
import { IAMClient } from '@aws-sdk/client-iam';

const SUB = 'abc-123';
const ACCOUNT = '123456789012';
const INVOKE_POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/BedrockInvokeAllowed`;

function makeDeps() {
  return { iam: new IAMClient({}) };
}

function noSuchEntity() {
  const err = new Error('NoSuchEntity');
  err.name = 'NoSuchEntityException';
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no existing attached policies
  mockIamSend.mockImplementation((cmd: { _type: string; input: any }) => {
    if (cmd._type === 'ListAttachedRolePolicies') {
      return Promise.resolve({ AttachedPolicies: [] });
    }
    if (cmd._type === 'GetPolicy') {
      return Promise.reject(noSuchEntity());
    }
    if (cmd._type === 'CreatePolicy') {
      return Promise.resolve({ Policy: { Arn: cmd.input.PolicyName ? `arn:aws:iam::${ACCOUNT}:policy/${cmd.input.PolicyName}` : 'arn' } });
    }
    if (cmd._type === 'ListPolicyVersions') {
      return Promise.resolve({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
    }
    return Promise.resolve({});
  });
});

describe('syncModelPolicies', () => {
  test('empty allowedModels removes existing model policies and re-attaches BedrockInvokeAllowed', async () => {
    mockIamSend.mockImplementation((cmd: { _type: string; input: any }) => {
      if (cmd._type === 'ListAttachedRolePolicies') {
        return Promise.resolve({
          AttachedPolicies: [
            { PolicyName: `BedrockModels-${SUB}-1`, PolicyArn: `arn:aws:iam::${ACCOUNT}:policy/BedrockModels-${SUB}-1` },
          ],
        });
      }
      if (cmd._type === 'ListPolicyVersions') {
        return Promise.resolve({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
      }
      return Promise.resolve({});
    });

    await syncModelPolicies({ sub: SUB, allowedModels: [], accountId: ACCOUNT, bedrockInvokePolicyArn: INVOKE_POLICY_ARN, deps: makeDeps() });

    const calls = mockIamSend.mock.calls.map((c: any) => c[0]._type);
    expect(calls).toContain('DetachRolePolicy');
    expect(calls).toContain('DeletePolicy');
    expect(calls).toContain('AttachRolePolicy');
  });

  test('small model list creates one policy and attaches it', async () => {
    const models = ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'amazon.titan-text-express-v1'];

    await syncModelPolicies({ sub: SUB, allowedModels: models, accountId: ACCOUNT, bedrockInvokePolicyArn: INVOKE_POLICY_ARN, deps: makeDeps() });

    const { CreatePolicyCommand } = require('@aws-sdk/client-iam');
    expect(CreatePolicyCommand).toHaveBeenCalledTimes(1);
    expect(CreatePolicyCommand).toHaveBeenCalledWith(expect.objectContaining({
      PolicyName: `BedrockModels-${SUB}-1`,
    }));

    const { DetachRolePolicyCommand } = require('@aws-sdk/client-iam');
    // Should detach the broad policy
    expect(DetachRolePolicyCommand).toHaveBeenCalledWith(expect.objectContaining({
      RoleName: `BedrockUser-${SUB}`,
      PolicyArn: INVOKE_POLICY_ARN,
    }));
  });

  test('large model list splits across multiple policies', async () => {
    const models = Array.from({ length: 30 }, (_, i) => `model-${i}`);

    await syncModelPolicies({ sub: SUB, allowedModels: models, accountId: ACCOUNT, bedrockInvokePolicyArn: INVOKE_POLICY_ARN, deps: makeDeps() });

    const { CreatePolicyCommand } = require('@aws-sdk/client-iam');
    expect(CreatePolicyCommand).toHaveBeenCalledTimes(2); // 25 + 5
    expect(CreatePolicyCommand).toHaveBeenCalledWith(expect.objectContaining({ PolicyName: `BedrockModels-${SUB}-1` }));
    expect(CreatePolicyCommand).toHaveBeenCalledWith(expect.objectContaining({ PolicyName: `BedrockModels-${SUB}-2` }));
  });

  test('removes stale policies when model list shrinks', async () => {
    mockIamSend.mockImplementation((cmd: { _type: string; input: any }) => {
      if (cmd._type === 'ListAttachedRolePolicies') {
        return Promise.resolve({
          AttachedPolicies: [
            { PolicyName: `BedrockModels-${SUB}-1`, PolicyArn: `arn:aws:iam::${ACCOUNT}:policy/BedrockModels-${SUB}-1` },
            { PolicyName: `BedrockModels-${SUB}-2`, PolicyArn: `arn:aws:iam::${ACCOUNT}:policy/BedrockModels-${SUB}-2` },
          ],
        });
      }
      if (cmd._type === 'GetPolicy') return Promise.reject(noSuchEntity());
      if (cmd._type === 'CreatePolicy') return Promise.resolve({ Policy: { Arn: `arn:aws:iam::${ACCOUNT}:policy/${cmd.input.PolicyName}` } });
      if (cmd._type === 'ListPolicyVersions') return Promise.resolve({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
      return Promise.resolve({});
    });

    // Only 2 models → fits in one policy, stale -2 should be removed
    await syncModelPolicies({ sub: SUB, allowedModels: ['model-a', 'model-b'], accountId: ACCOUNT, bedrockInvokePolicyArn: INVOKE_POLICY_ARN, deps: makeDeps() });

    const detachCalls = mockIamSend.mock.calls
      .filter((c: any) => c[0]._type === 'DetachRolePolicy')
      .map((c: any) => c[0].input.PolicyArn);
    expect(detachCalls).toContain(`arn:aws:iam::${ACCOUNT}:policy/BedrockModels-${SUB}-2`);
  });

  test('handles NoSuchEntity gracefully when detaching non-existent policy', async () => {
    mockIamSend.mockImplementation((cmd: { _type: string; input: any }) => {
      if (cmd._type === 'DetachRolePolicy') return Promise.reject(noSuchEntity());
      if (cmd._type === 'ListAttachedRolePolicies') return Promise.resolve({ AttachedPolicies: [] });
      if (cmd._type === 'GetPolicy') return Promise.reject(noSuchEntity());
      if (cmd._type === 'CreatePolicy') return Promise.resolve({ Policy: { Arn: `arn:aws:iam::${ACCOUNT}:policy/${cmd.input.PolicyName}` } });
      if (cmd._type === 'ListPolicyVersions') return Promise.resolve({ Versions: [] });
      if (cmd._type === 'DeletePolicy') return Promise.reject(noSuchEntity());
      return Promise.resolve({});
    });

    // Should not throw
    await expect(
      syncModelPolicies({ sub: SUB, allowedModels: ['model-a'], accountId: ACCOUNT, bedrockInvokePolicyArn: INVOKE_POLICY_ARN, deps: makeDeps() }),
    ).resolves.toBeUndefined();
  });
});
