import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { CodeOnBedrockStack } from '../lib/code-on-bedrock-stack';

test('CDK app synthesizes without errors', () => {
  const app = new cdk.App();
  const stack = new CodeOnBedrockStack(app, 'TestStack');
  const template = Template.fromStack(stack);
  expect(template.toJSON()).toBeDefined();
});
