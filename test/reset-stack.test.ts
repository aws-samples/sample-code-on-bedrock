import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { ResetStack } from '../lib/reset-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const data = new DataStack(app, 'TestData');
  new ResetStack(app, 'TestResetStack', {
    userLimitsTable: data.userLimitsTable,
    usageCountersTable: data.usageCountersTable,
    bedrockDenyPolicyArn: 'arn:aws:iam::123456789012:policy/BedrockDenyAll',
  });
  template = Template.fromStack(
    app.node.findChild('TestResetStack') as cdk.Stack,
  );
});

describe('Reset Stack', () => {
  // R-BE-5: Monthly reset Lambda with correct env vars
  test('creates Monthly Reset Lambda with correct environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'monthly.handler',
      Environment: {
        Variables: {
          USER_LIMITS_TABLE: Match.anyValue(),
          USAGE_COUNTERS_TABLE: Match.anyValue(),
          BEDROCK_DENY_POLICY_ARN: Match.anyValue(),
        },
      },
    });
  });

  // R-BE-6: Daily reset Lambda with correct env vars
  test('creates Daily Reset Lambda with correct environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'daily.handler',
      Environment: {
        Variables: {
          USER_LIMITS_TABLE: Match.anyValue(),
          USAGE_COUNTERS_TABLE: Match.anyValue(),
        },
      },
    });
  });

  // R-BE-5: Monthly cron fires on 1st of month at midnight UTC
  test('creates EventBridge rule for monthly reset cron(0 0 1 * ? *)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 0 1 * ? *)',
      State: 'ENABLED',
    });
  });

  // R-BE-6: Daily cron fires at midnight UTC
  test('creates EventBridge rule for daily reset cron(0 0 * * ? *)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 0 * * ? *)',
      State: 'ENABLED',
    });
  });

  // R-SEC-5: Monthly Lambda has iam:DetachRolePolicy scoped to BedrockUser-*
  test('grants monthly Lambda iam:DetachRolePolicy scoped to BedrockUser-*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:DetachRolePolicy',
            Effect: 'Allow',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([
                  Match.stringLikeRegexp(':role/BedrockUser-\\*'),
                ]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  // Both Lambdas have DDB scan/update permissions
  test('grants Lambdas DynamoDB Scan and UpdateItem permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:Scan', 'dynamodb:UpdateItem']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
