import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CrosscheckStackProps extends cdk.StackProps {
  usersTable: dynamodb.ITableV2;
  usageCountersTable: dynamodb.ITableV2;
}

export class CrosscheckStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CrosscheckStackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'CrosscheckFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'crosscheck')),
      timeout: cdk.Duration.minutes(5),
      environment: {
        USERS_TABLE: props.usersTable.tableName,
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
        DIVERGENCE_THRESHOLD: '0.1',
      },
    });

    props.usersTable.grant(fn, 'dynamodb:Scan');
    props.usageCountersTable.grant(fn, 'dynamodb:Query');

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // R-ME-7: EventBridge rule rate(1 hour)
    new events.Rule(this, 'CrosscheckRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(fn)],
    });

    // R-ME-8: CloudWatch alarm on divergence metric
    new cloudwatch.Alarm(this, 'DivergenceAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'CodeOnBedrock',
        metricName: 'MeteringDivergence',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'Metering divergence between CloudWatch and DynamoDB exceeds threshold',
    });
  }
}
