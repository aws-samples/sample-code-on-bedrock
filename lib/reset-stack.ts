import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ResetStackProps extends cdk.StackProps {
  userLimitsTable: dynamodb.ITableV2;
  usageCountersTable: dynamodb.ITableV2;
  bedrockDenyPolicyArn: string;
}

export class ResetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ResetStackProps) {
    super(scope, id, props);

    // ── Monthly Reset Lambda (R-BE-5) ────────────────────────────

    const monthlyFn = new lambda.Function(this, 'MonthlyResetFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'monthly.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'reset')),
      environment: {
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
        BEDROCK_DENY_POLICY_ARN: props.bedrockDenyPolicyArn,
      },
    });

    props.userLimitsTable.grant(monthlyFn, 'dynamodb:Scan', 'dynamodb:UpdateItem');
    props.usageCountersTable.grant(monthlyFn, 'dynamodb:Query', 'dynamodb:DeleteItem');
    props.usageCountersTable.grant(monthlyFn, 'dynamodb:Query');

    monthlyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:DetachRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));

    new events.Rule(this, 'MonthlyResetRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '0', day: '1', month: '*', year: '*' }),
      targets: [new targets.LambdaFunction(monthlyFn)],
    });

    // ── Daily Reset Lambda (R-BE-6) ──────────────────────────────

    const dailyFn = new lambda.Function(this, 'DailyResetFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'daily.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'reset')),
      environment: {
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
      },
    });

    props.userLimitsTable.grant(dailyFn, 'dynamodb:Scan', 'dynamodb:UpdateItem');
    props.usageCountersTable.grant(dailyFn, 'dynamodb:Query', 'dynamodb:DeleteItem');

    new events.Rule(this, 'DailyResetRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '0', day: '*', month: '*', year: '*' }),
      targets: [new targets.LambdaFunction(dailyFn)],
    });
  }
}
