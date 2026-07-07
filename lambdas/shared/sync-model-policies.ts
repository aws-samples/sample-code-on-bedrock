import {
  IAMClient,
  CreatePolicyCommand,
  DeletePolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  CreatePolicyVersionCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
  GetPolicyCommand,
} from '@aws-sdk/client-iam';

export interface SyncDeps {
  iam: IAMClient;
}

export interface SyncParams {
  sub: string;
  allowedModels: string[];
  accountId: string;
  bedrockInvokePolicyArn: string;
  deps: SyncDeps;
}

const CHUNK_SIZE = 25;
const POLICY_PREFIX = 'BedrockModels-';

function stripInferencePrefix(modelId: string): string {
  return modelId.replace(/^(us\.|eu\.|apac\.|us-gov\.)/, '');
}

function buildModelArns(modelId: string, accountId: string): string[] {
  const baseModelId = stripInferencePrefix(modelId);
  return [
    `arn:aws:bedrock:*::foundation-model/${baseModelId}`,
    `arn:aws:bedrock:*:${accountId}:inference-profile/${modelId}`,
    `arn:aws:bedrock:*::inference-profile/${modelId}`,
  ];
}

function buildPolicyDoc(modelIds: string[], accountId: string): string {
  const arns = modelIds.flatMap((m) => buildModelArns(m, accountId));
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          'bedrock:ListFoundationModels',
          'bedrock:ListInferenceProfiles',
          'bedrock:GetFoundationModel',
          'bedrock:GetInferenceProfile',
        ],
        Resource: '*',
      },
      {
        Effect: 'Allow',
        Action: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        Resource: arns,
      },
    ],
  });
}

function policyName(sub: string, n: number): string {
  return `${POLICY_PREFIX}${sub}-${n}`;
}

function policyArn(accountId: string, name: string): string {
  return `arn:aws:iam::${accountId}:policy/${name}`;
}

function isNoSuchEntity(e: unknown): boolean {
  return (e as any)?.name === 'NoSuchEntityException';
}

async function createOrUpdatePolicy(
  iam: IAMClient,
  arn: string,
  name: string,
  doc: string,
): Promise<string> {
  try {
    await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
    // Policy exists — update via new version
    const versions = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }));
    const nonDefault = (versions.Versions || [])
      .filter((v) => !v.IsDefaultVersion)
      .sort((a, b) => (a.CreateDate!.getTime() - b.CreateDate!.getTime()));
    if (nonDefault.length >= 4) {
      await iam.send(new DeletePolicyVersionCommand({
        PolicyArn: arn,
        VersionId: nonDefault[0].VersionId!,
      }));
    }
    await iam.send(new CreatePolicyVersionCommand({
      PolicyArn: arn,
      PolicyDocument: doc,
      SetAsDefault: true,
    }));
    return arn;
  } catch (e) {
    if (!isNoSuchEntity(e)) throw e;
  }
  const res = await iam.send(new CreatePolicyCommand({
    PolicyName: name,
    PolicyDocument: doc,
  }));
  return res.Policy!.Arn!;
}

async function safeDetach(iam: IAMClient, roleName: string, policyArn: string): Promise<void> {
  try {
    await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
  } catch (e) {
    if (!isNoSuchEntity(e)) throw e;
  }
}

async function deletePolicy(iam: IAMClient, arn: string): Promise<void> {
  try {
    const versions = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: arn }));
    for (const v of (versions.Versions || []).filter((v) => !v.IsDefaultVersion)) {
      await iam.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: v.VersionId! }));
    }
    await iam.send(new DeletePolicyCommand({ PolicyArn: arn }));
  } catch (e) {
    if (!isNoSuchEntity(e)) throw e;
  }
}

async function getAttachedModelPolicies(
  iam: IAMClient,
  roleName: string,
  sub: string,
): Promise<{ name: string; arn: string }[]> {
  const prefix = `${POLICY_PREFIX}${sub}-`;
  const res = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
  return (res.AttachedPolicies || [])
    .filter((p) => p.PolicyName!.startsWith(prefix))
    .map((p) => ({ name: p.PolicyName!, arn: p.PolicyArn! }));
}

export async function syncModelPolicies(params: SyncParams): Promise<void> {
  const { sub, allowedModels, accountId, bedrockInvokePolicyArn, deps } = params;
  const { iam } = deps;
  const roleName = `BedrockUser-${sub}`;

  if (allowedModels.length === 0) {
    // Remove all model policies, re-attach broad policy
    const existing = await getAttachedModelPolicies(iam, roleName, sub);
    for (const p of existing) {
      await safeDetach(iam, roleName, p.arn);
      await deletePolicy(iam, p.arn);
    }
    try {
      await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: bedrockInvokePolicyArn }));
    } catch (e) {
      // Already attached is fine
      if ((e as any)?.name !== 'LimitExceededException') {
        // AttachRolePolicy is idempotent, but handle unexpected errors
        if (!isNoSuchEntity(e)) throw e;
      }
    }
    return;
  }

  // Split models into chunks and create/update policies
  const chunks: string[][] = [];
  for (let i = 0; i < allowedModels.length; i += CHUNK_SIZE) {
    chunks.push(allowedModels.slice(i, i + CHUNK_SIZE));
  }

  const neededNames = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    const name = policyName(sub, i + 1);
    const arn = policyArn(accountId, name);
    const doc = buildPolicyDoc(chunks[i], accountId);
    neededNames.add(name);
    const resolvedArn = await createOrUpdatePolicy(iam, arn, name, doc);
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: resolvedArn }));
  }

  // Remove stale policies
  const existing = await getAttachedModelPolicies(iam, roleName, sub);
  for (const p of existing) {
    if (!neededNames.has(p.name)) {
      await safeDetach(iam, roleName, p.arn);
      await deletePolicy(iam, p.arn);
    }
  }

  // Detach the broad policy
  await safeDetach(iam, roleName, bedrockInvokePolicyArn);
}
