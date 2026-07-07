const mockIamSend = jest.fn();

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn(() => ({ send: mockIamSend })),
  AttachRolePolicyCommand: jest.fn((input: unknown) => ({ _type: 'AttachRolePolicy', input })),
}));

import { handler } from '../../lambdas/killswitch/index';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BEDROCK_DENY_POLICY_ARN = 'arn:aws:iam::123456789012:policy/BedrockDenyAll';
  mockIamSend.mockResolvedValue({});
});

describe('KillSwitch Lambda', () => {
  // R-BE-3: Attaches BedrockDenyAll to BedrockUser-<sub>
  test('attaches BedrockDenyAll policy to BedrockUser-<sub>', async () => {
    const { AttachRolePolicyCommand } = require('@aws-sdk/client-iam');

    await handler({ sub: 'abc-123' });

    expect(AttachRolePolicyCommand).toHaveBeenCalledWith({
      RoleName: 'BedrockUser-abc-123',
      PolicyArn: 'arn:aws:iam::123456789012:policy/BedrockDenyAll',
    });
    expect(mockIamSend).toHaveBeenCalledTimes(1);
  });

  // Idempotent: no error if already attached
  test('succeeds when policy is already attached', async () => {
    mockIamSend.mockResolvedValue({});

    await expect(handler({ sub: 'abc-123' })).resolves.not.toThrow();
  });
});
