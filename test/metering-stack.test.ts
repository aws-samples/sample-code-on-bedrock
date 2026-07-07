import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { IdentityStack } from '../lib/identity-stack';
import { ApiStack } from '../lib/api-stack';
import { MeteringStack } from '../lib/metering-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const data = new DataStack(app, 'TestData');
  const identity = new IdentityStack(app, 'TestIdentity');
  const api = new ApiStack(app, 'TestApi', {
    userPool: identity.userPool,
    userPoolClient: identity.userPoolClient,
    userLimitsTable: data.userLimitsTable,
    usageCountersTable: data.usageCountersTable,
    usersTable: data.usersTable,
    tiersTable: data.tiersTable,
    modelRatesTable: data.modelRatesTable,
    sourceRegions: ['eu-central-1'],
  });
  new MeteringStack(app, 'TestMeteringStack', {
    usageCountersTable: data.usageCountersTable,
    modelRatesTable: data.modelRatesTable,
    userLimitsTable: data.userLimitsTable,
    usersTable: data.usersTable,
    killSwitchFunction: api.killSwitchFunction,
    warningTopic: api.warningTopic,
  });
  template = Template.fromStack(
    app.node.findChild('TestMeteringStack') as cdk.Stack,
  );
});

describe('Metering Stack', () => {
  // Log group for Bedrock invocation logs
  test('creates a CloudWatch log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: Match.anyValue(),
    });
  });

  // Metering Lambda exists with correct env vars
  test('creates Metering Lambda with correct environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: {
          USAGE_COUNTERS_TABLE: Match.anyValue(),
          MODEL_RATES_TABLE: Match.anyValue(),
          HOME_REGION: Match.anyValue(),
          USER_LIMITS_TABLE: Match.anyValue(),
          KILLSWITCH_FUNCTION_NAME: Match.anyValue(),
          WARNING_TOPIC_ARN: Match.anyValue(),
        },
      },
    });
  });

  // Subscription filter connects log group to Lambda
  test('creates a subscription filter', () => {
    template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
      FilterPattern: '',
    });
  });

  // Lambda has DDB permissions
  test('grants Lambda DynamoDB permissions on UsageCounters, ModelRates, and UserLimits', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'dynamodb:UpdateItem',
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: 'dynamodb:GetItem',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  // Lambda has SNS publish permission
  test('grants Lambda SNS publish permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
