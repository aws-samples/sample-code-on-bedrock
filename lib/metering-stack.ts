import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import * as path from 'path';
import { physicalName } from './naming';
import { DEFAULT_SES_FROM_ADDRESS } from './ses';

export interface MeteringStackProps extends cdk.StackProps {
  usageCountersTable: dynamodb.ITableV2;
  modelRatesTable: dynamodb.ITableV2;
  userLimitsTable: dynamodb.ITableV2;
  usersTable: dynamodb.ITableV2;
  killSwitchFunction: lambda.IFunction;
  warningTopic: sns.ITopic;
  /**
   * Verified SES identity used as the `Source` for the per-user 80%-budget
   * warning emails (and scoped on the Lambda's `ses:SendEmail` policy). Must be
   * an address (or domain) verified in SES for this account/Region — in the SES
   * sandbox both this sender and every recipient must be verified. Defaults to
   * {@link DEFAULT_SES_FROM_ADDRESS}.
   */
  sesFromAddress?: string;
  /**
   * Physical-name prefix (e.g. `CodeOnBedrock-us-east-1-`) for running a second
   * control plane in the same account. Empty ⇒ legacy log group name. See
   * lib/naming.ts.
   */
  namePrefix?: string;
}

export class MeteringStack extends cdk.Stack {
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: MeteringStackProps) {
    super(scope, id, props);

    const prefix = props.namePrefix ?? '';
    const sesFromAddress = props.sesFromAddress ?? DEFAULT_SES_FROM_ADDRESS;

    // Bedrock invocation log group
    this.logGroup = new logs.LogGroup(this, 'BedrockInvocationLogs', {
      logGroupName: physicalName(prefix, 'bedrock-invocation-logs', '/aws/bedrock/invocation-logs'),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM role for Bedrock to deliver logs to CloudWatch
    const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    this.logGroup.grantWrite(bedrockLoggingRole);

    // Enable Bedrock model invocation logging via custom resource
    new cr.AwsCustomResource(this, 'EnableBedrockLogging', {
      onCreate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            cloudWatchConfig: {
              logGroupName: this.logGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-logging-config'),
      },
      onUpdate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            cloudWatchConfig: {
              logGroupName: this.logGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-logging-config'),
      },
      onDelete: {
        service: 'Bedrock',
        action: 'deleteModelInvocationLoggingConfiguration',
        parameters: {},
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [bedrockLoggingRole.roleArn],
        }),
      ]),
    });

    // Metering Lambda
    const meteringFn = new lambda.Function(this, 'MeteringFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'metering')),
      environment: {
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
        MODEL_RATES_TABLE: props.modelRatesTable.tableName,
        HOME_REGION: cdk.Aws.REGION,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        KILLSWITCH_FUNCTION_NAME: props.killSwitchFunction.functionName,
        WARNING_TOPIC_ARN: props.warningTopic.topicArn,
        WARNING_THRESHOLD: '0.8',
        SES_FROM_ADDRESS: sesFromAddress,
      },
    });

    // DDB permissions
    props.usageCountersTable.grant(meteringFn, 'dynamodb:UpdateItem');
    props.modelRatesTable.grant(meteringFn, 'dynamodb:GetItem');
    props.userLimitsTable.grant(meteringFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    props.usersTable.grant(meteringFn, 'dynamodb:GetItem');

    // Lambda invoke permission on KillSwitch
    props.killSwitchFunction.grantInvoke(meteringFn);

    // SNS publish permission
    props.warningTopic.grantPublish(meteringFn);

    // SES SendEmail permission
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [`arn:aws:ses:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:identity/${sesFromAddress}`],
    }));

    // Subscription filter: all log events → Lambda
    new logs.SubscriptionFilter(this, 'MeteringSubscription', {
      logGroup: this.logGroup,
      destination: new logsDestinations.LambdaDestination(meteringFn),
      filterPattern: logs.FilterPattern.allEvents(),
    });
  }
}
