import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RegionalMeteringStack } from '../lib/regional-metering-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new RegionalMeteringStack(app, 'TestRegionalMetering', {
    env: { region: 'eu-west-1' },
    homeRegion: 'us-east-1',
    usageCountersTableName: 'UsageCounters',
    usageCountersTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UsageCounters',
    modelRatesTableName: 'ModelRates',
    modelRatesTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/ModelRates',
    userLimitsTableName: 'UserLimits',
    userLimitsTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserLimits',
    usersTableName: 'Users',
    usersTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/Users',
    killSwitchFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:KillSwitch',
    warningTopicArn: 'arn:aws:sns:us-east-1:123456789012:DailyWarning',
  });
  template = Template.fromStack(stack);
});

describe('Regional Metering Stack', () => {
  test('creates a CloudWatch log group for Bedrock invocation logs', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/bedrock/invocation-logs',
      RetentionInDays: Match.anyValue(),
    });
  });

  test('creates Metering Lambda with home-region env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: {
          USAGE_COUNTERS_TABLE: 'UsageCounters',
          MODEL_RATES_TABLE: 'ModelRates',
          HOME_REGION: 'us-east-1',
          USER_LIMITS_TABLE: 'UserLimits',
          KILLSWITCH_FUNCTION_NAME: Match.anyValue(),
          WARNING_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:DailyWarning',
        },
      },
    });
  });

  test('creates a subscription filter', () => {
    template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
      FilterPattern: '',
    });
  });

  test('creates a Bedrock logging role assumable by the Bedrock service', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'bedrock.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  test('enables Bedrock model invocation logging in-region via a custom resource', () => {
    // The AwsCustomResource is granted the Bedrock logging-config permissions.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'bedrock:PutModelInvocationLoggingConfiguration',
              'bedrock:DeleteModelInvocationLoggingConfiguration',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
    // And a custom resource is synthesized to invoke it.
    template.resourceCountIs('Custom::AWS', 1);
  });

  test('does not create any DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
  });

  test('grants Lambda cross-region DynamoDB permissions on home-region tables', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'dynamodb:UpdateItem',
            Effect: 'Allow',
            Resource: 'arn:aws:dynamodb:us-east-1:123456789012:table/UsageCounters',
          }),
          Match.objectLike({
            Action: 'dynamodb:GetItem',
            Effect: 'Allow',
            Resource: 'arn:aws:dynamodb:us-east-1:123456789012:table/ModelRates',
          }),
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:UpdateItem']),
            Effect: 'Allow',
            Resource: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserLimits',
          }),
        ]),
      },
    });
  });

  test('grants Lambda invoke permission on home-region KillSwitch', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
  });

  test('grants Lambda SNS publish permission on home-region warning topic', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Effect: 'Allow',
            Resource: 'arn:aws:sns:us-east-1:123456789012:DailyWarning',
          }),
        ]),
      },
    });
  });
});
