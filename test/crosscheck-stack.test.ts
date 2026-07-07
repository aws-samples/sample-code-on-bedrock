import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { CrosscheckStack } from '../lib/crosscheck-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const data = new DataStack(app, 'TestData');
  new CrosscheckStack(app, 'TestCrosscheckStack', {
    usersTable: data.usersTable,
    usageCountersTable: data.usageCountersTable,
  });
  template = Template.fromStack(
    app.node.findChild('TestCrosscheckStack') as cdk.Stack,
  );
});

describe('Crosscheck Stack', () => {
  // R-ME-7: Crosscheck Lambda with correct env vars
  test('creates Crosscheck Lambda with correct environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Environment: {
        Variables: {
          USERS_TABLE: Match.anyValue(),
          USAGE_COUNTERS_TABLE: Match.anyValue(),
          DIVERGENCE_THRESHOLD: Match.anyValue(),
        },
      },
    });
  });

  // R-ME-7: EventBridge rule rate(1 hour)
  test('creates EventBridge rule with rate(1 hour)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 hour)',
      State: 'ENABLED',
    });
  });

  // R-ME-8: CloudWatch alarm on divergence metric
  test('creates CloudWatch alarm on MeteringDivergence metric', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'CodeOnBedrock',
      MetricName: 'MeteringDivergence',
      Statistic: 'Sum',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
      EvaluationPeriods: 1,
    });
  });

  // Lambda has CW permissions
  test('grants Lambda cloudwatch:GetMetricStatistics and cloudwatch:PutMetricData', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'cloudwatch:GetMetricStatistics',
              'cloudwatch:PutMetricData',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  // Lambda has DDB permissions
  test('grants Lambda DynamoDB Scan on Users and Query on UsageCounters', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'dynamodb:Scan',
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: 'dynamodb:Query',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
