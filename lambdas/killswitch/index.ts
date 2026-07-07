import { IAMClient, AttachRolePolicyCommand } from '@aws-sdk/client-iam';

export interface KillswitchDeps {
  iam: IAMClient;
}

export async function processKillswitch(sub: string, denyPolicyArn: string, deps: KillswitchDeps) {
  await deps.iam.send(new AttachRolePolicyCommand({
    RoleName: `BedrockUser-${sub}`,
    PolicyArn: denyPolicyArn,
  }));
}

const iam = new IAMClient({});

export const handler = async (event: { sub: string }) => {
  return processKillswitch(event.sub, process.env.BEDROCK_DENY_POLICY_ARN!, { iam });
};
