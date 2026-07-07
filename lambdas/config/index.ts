import { CloudFormationClient, DescribeStacksCommand, DescribeStacksOutput } from '@aws-sdk/client-cloudformation';

const cfn = new CloudFormationClient({});

export const handler = async () => {
  const [apiOut, idOut] = await Promise.all([
    cfn.send(new DescribeStacksCommand({ StackName: 'ApiStack' })),
    cfn.send(new DescribeStacksCommand({ StackName: 'IdentityStack' })),
  ]);

  const getOutput = (stack: DescribeStacksOutput, key: string) =>
    stack.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue ?? '';

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_url: getOutput(apiOut, 'ApiUrl'),
      cognito_domain: getOutput(idOut, 'UserPoolDomainUrl'),
      client_id: getOutput(idOut, 'UserPoolClientId'),
    }),
  };
};
