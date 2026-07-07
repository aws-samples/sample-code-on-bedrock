import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import { physicalName } from './naming';
import { DEFAULT_SES_FROM_ADDRESS } from './ses';

export interface RegionalMeteringStackProps extends cdk.StackProps {
  homeRegion: string;
  /**
   * Physical-name prefix (e.g. `CodeOnBedrock-us-east-1-`) for running a second
   * control plane in the same account. Empty ⇒ legacy log group name. See
   * lib/naming.ts.
   */
  namePrefix?: string;
  /**
   * Verified SES identity used as the `Source` for the per-user 80%-budget
   * warning emails (and scoped on the Lambda's `ses:SendEmail` policy). See
   * MeteringStackProps.sesFromAddress. Defaults to
   * {@link DEFAULT_SES_FROM_ADDRESS}.
   */
  sesFromAddress?: string;
  usageCountersTableName: string;
  usageCountersTableArn: string;
  modelRatesTableName: string;
  modelRatesTableArn: string;
  userLimitsTableName: string;
  userLimitsTableArn: string;
  usersTableName: string;
  usersTableArn: string;
  killSwitchFunctionArn: string;
  warningTopicArn: string;
}

export class RegionalMeteringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RegionalMeteringStackProps) {
    super(scope, id, props);

    const prefix = props.namePrefix ?? '';
    const sesFromAddress = props.sesFromAddress ?? DEFAULT_SES_FROM_ADDRESS;

    const logGroup = new logs.LogGroup(this, 'BedrockInvocationLogs', {
      logGroupName: physicalName(prefix, 'bedrock-invocation-logs', '/aws/bedrock/invocation-logs'),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM role for Bedrock to deliver invocation logs to CloudWatch in this region
    const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    logGroup.grantWrite(bedrockLoggingRole);

    // Enable Bedrock model invocation logging in THIS region. Model invocation
    // logging is a per-region configuration; without it Bedrock delivers no
    // logs to the regional log group. Each regional stack covers a source
    // Region developers call Bedrock from — where invocations are logged and
    // metered, even when a cross-Region inference profile routes the actual
    // inference elsewhere.
    const loggingConfig = {
      loggingConfig: {
        textDataDeliveryEnabled: true,
        imageDataDeliveryEnabled: false,
        embeddingDataDeliveryEnabled: false,
        cloudWatchConfig: {
          logGroupName: logGroup.logGroupName,
          roleArn: bedrockLoggingRole.roleArn,
        },
      },
    };
    new cr.AwsCustomResource(this, 'EnableBedrockLogging', {
      onCreate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: loggingConfig,
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-logging-config'),
      },
      onUpdate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: loggingConfig,
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

    const meteringFn = new lambda.Function(this, 'MeteringFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'metering')),
      environment: {
        USAGE_COUNTERS_TABLE: props.usageCountersTableName,
        MODEL_RATES_TABLE: props.modelRatesTableName,
        HOME_REGION: props.homeRegion,
        USER_LIMITS_TABLE: props.userLimitsTableName,
        USERS_TABLE: props.usersTableName,
        KILLSWITCH_FUNCTION_NAME: props.killSwitchFunctionArn,
        WARNING_TOPIC_ARN: props.warningTopicArn,
        WARNING_THRESHOLD: '0.8',
        SES_FROM_ADDRESS: sesFromAddress,
      },
    });

    // Cross-region DDB permissions on home-region tables
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [props.usageCountersTableArn],
    }));
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [props.modelRatesTableArn],
    }));
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [props.userLimitsTableArn],
    }));
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [props.usersTableArn],
    }));

    // Cross-region Lambda invoke on KillSwitch
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.killSwitchFunctionArn],
    }));

    // Cross-region SNS publish on warning topic
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      resources: [props.warningTopicArn],
    }));

    // SES SendEmail permission
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [`arn:aws:ses:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:identity/${sesFromAddress}`],
    }));

    new logs.SubscriptionFilter(this, 'MeteringSubscription', {
      logGroup,
      destination: new logsDestinations.LambdaDestination(meteringFn),
      filterPattern: logs.FilterPattern.allEvents(),
    });
  }
}
