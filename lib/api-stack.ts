import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';
import { physicalName } from './naming';

export interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  userLimitsTable: dynamodb.ITableV2;
  usageCountersTable: dynamodb.ITableV2;
  usersTable: dynamodb.ITableV2;
  tiersTable: dynamodb.ITableV2;
  modelRatesTable: dynamodb.ITableV2;
  /**
   * Regions developers may call Bedrock from — the home Region plus any
   * additional enabled source Regions. Each of these has a metering stack
   * (the home `MeteringStack` / a `MeteringStack-<region>`), so pinning every
   * request's source Region to this set guarantees usage is metered. Resolved
   * once in `bin/app.ts` and shared with the metering-stack wiring so the two
   * can't drift.
   */
  sourceRegions: string[];
  /**
   * Physical-name prefix (e.g. `CodeOnBedrock-us-east-1-`) for running a second
   * control plane in the same account. Empty ⇒ legacy names. Applies to the
   * account-global BedrockInvokeAllowed / BedrockDenyAll managed policies (the
   * resources that actually collide cross-Region) plus the KillSwitch function
   * and warning topic. See lib/naming.ts.
   */
  namePrefix?: string;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigwv2.HttpApi;
  public readonly killSwitchFunction: lambda.Function;
  public readonly warningTopic: sns.Topic;
  public readonly bedrockDenyPolicyArn: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const prefix = props.namePrefix ?? '';

    const issuerUrl = `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${props.userPool.userPoolId}`;

    const jwtAuthorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuerUrl, {
      jwtAudience: [props.userPoolClient.userPoolClientId],
    });

    this.api = new apigwv2.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
      defaultAuthorizer: jwtAuthorizer,
    });

    // ── Health endpoint ──────────────────────────────────────────

    const healthFn = new lambda.Function(this, 'HealthFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'health')),
    });

    this.api.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', healthFn),
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    });

    // ── Managed policies ─────────────────────────────────────────

    // Source Regions developers may call Bedrock from = the home Region plus
    // any additional enabled source Regions. This set is fixed at deploy time,
    // identical for every user, and (because it is the same list that drives
    // the metering stacks in bin/app.ts) every Region here has a metering
    // stack. The Region restriction therefore lives on the role's identity
    // policy below — making the role itself Region-limited, not just the
    // vend-time session policy.
    const sourceRegions = props.sourceRegions;
    const bedrockInvokeActions = [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'bedrock:Converse',
      'bedrock:ConverseStream',
    ];
    // Inference-profile ARN patterns whose *source* Region is metered.
    const sourceProfileArns = sourceRegions.map(
      (r) => `arn:aws:bedrock:${r}:${cdk.Aws.ACCOUNT_ID}:inference-profile/*`,
    );

    // R-ID-5: BedrockInvokeAllowed — pins the source Region of every Bedrock
    // request to the metered set (so usage can't escape metering) while still
    // allowing cross-Region inference profiles to route to their destination
    // Regions. Mirrors the vend-time STS session policy as a durable,
    // role-level control.
    const bedrockInvokeAllowed = new iam.ManagedPolicy(this, 'BedrockInvokeAllowed', {
      managedPolicyName: physicalName(prefix, 'BedrockInvokeAllowed'),
      document: new iam.PolicyDocument({
        statements: [
          // 1. Invoke inference profiles only from metered source Regions
          //    (the Region is encoded in the profile ARN).
          new iam.PolicyStatement({
            sid: 'InvokeInferenceProfilesInSourceRegions',
            effect: iam.Effect.ALLOW,
            actions: bedrockInvokeActions,
            resources: sourceRegions.flatMap((r) => [
              `arn:aws:bedrock:${r}:${cdk.Aws.ACCOUNT_ID}:inference-profile/*`,
              `arn:aws:bedrock:${r}:${cdk.Aws.ACCOUNT_ID}:application-inference-profile/*`,
            ]),
          }),
          // 2. Foundation-model access for cross-Region routing targets (any
          //    Region), gated so it's only usable via one of our source-Region
          //    profiles — never to invoke a model directly from an unmetered
          //    Region.
          new iam.PolicyStatement({
            sid: 'InvokeRoutedFoundationModels',
            effect: iam.Effect.ALLOW,
            actions: bedrockInvokeActions,
            resources: ['arn:aws:bedrock:*::foundation-model/*'],
            conditions: { ArnLike: { 'bedrock:InferenceProfileArn': sourceProfileArns } },
          }),
          // 3. Direct (non-profile) in-Region model invocation, only from
          //    metered source Regions.
          new iam.PolicyStatement({
            sid: 'InvokeFoundationModelsInSourceRegions',
            effect: iam.Effect.ALLOW,
            actions: bedrockInvokeActions,
            resources: ['arn:aws:bedrock:*::foundation-model/*'],
            conditions: { StringEquals: { 'aws:RequestedRegion': sourceRegions } },
          }),
          // 4. Read-only discovery (Region-agnostic, low risk).
          new iam.PolicyStatement({
            sid: 'BedrockReadOnlyDiscovery',
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock:ListFoundationModels',
              'bedrock:ListInferenceProfiles',
              'bedrock:GetFoundationModel',
              'bedrock:GetInferenceProfile',
            ],
            resources: ['*'],
          }),
        ],
      }),
    });

    // R-BE-3: BedrockDenyAll
    const bedrockDenyAll = new iam.ManagedPolicy(this, 'BedrockDenyAll', {
      managedPolicyName: physicalName(prefix, 'BedrockDenyAll'),
      document: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['bedrock:*'],
          resources: ['*'],
        })],
      }),
    });

    this.bedrockDenyPolicyArn = bedrockDenyAll.managedPolicyArn;

    // ── KillSwitch Lambda (R-BE-3) ─────────────────────────────────

    this.killSwitchFunction = new lambda.Function(this, 'KillSwitchFunction', {
      functionName: physicalName(prefix, 'KillSwitch', 'CodeOnBedrock-KillSwitch'),
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'killswitch')),
      environment: {
        BEDROCK_DENY_POLICY_ARN: bedrockDenyAll.managedPolicyArn,
      },
    });

    // R-SEC-5: scoped to BedrockUser-*
    this.killSwitchFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:AttachRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));

    // ── SNS topic for daily budget warnings (R-BE-4) ─────────────

    this.warningTopic = new sns.Topic(this, 'DailyWarningTopic', {
      topicName: physicalName(prefix, 'DailyBudgetWarning'),
    });

    // ── Credentials Lambda ───────────────────────────────────────

    const credentialsFn = new lambda.Function(this, 'CredentialsFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'credentials')),
      // Default is 3s. A first vend that lazily creates/reconciles a BedrockUser
      // role must wait out IAM trust-policy propagation before AssumeRole
      // succeeds (assumeRoleWithPropagationRetry), so allow headroom under API
      // Gateway's 30s integration ceiling. Healthy roles still return in ~1s.
      timeout: cdk.Duration.seconds(20),
      environment: {
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        BEDROCK_INVOKE_POLICY_ARN: bedrockInvokeAllowed.managedPolicyArn,
        // Source Regions developers may call Bedrock from. Drives the STS
        // session policy that pins the inference-profile source Region (so all
        // usage is logged/metered in a Region that has a metering stack) while
        // still permitting cross-Region routing to destination Regions.
        ALLOWED_REGIONS: JSON.stringify(sourceRegions),
      },
    });

    // Allow the Lambda execution role to set source identity (required by STS for SourceIdentity propagation)
    (credentialsFn.role! as iam.Role).assumeRolePolicy!.addStatements(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      actions: ['sts:SetSourceIdentity'],
    }));

    // Pass the execution role ARN so the Lambda can set it as trust principal on BedrockUser-* roles
    credentialsFn.addEnvironment('CREDENTIALS_ROLE_ARN', credentialsFn.role!.roleArn);

    // DynamoDB GetItem on UserLimits and Users
    props.userLimitsTable.grant(credentialsFn, 'dynamodb:GetItem');
    props.usersTable.grant(credentialsFn, 'dynamodb:GetItem');

    // IAM permissions scoped to BedrockUser-* (R-SEC-5).
    // iam:UpdateAssumeRolePolicy lets the lazy-create path repair the trust
    // policy of roles minted by an older code version (drift reconciliation).
    credentialsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:GetRole', 'iam:CreateRole', 'iam:AttachRolePolicy', 'iam:UpdateAssumeRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));

    // STS AssumeRole on BedrockUser-*
    credentialsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'],
      resources: [
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`,
        credentialsFn.role!.roleArn,
      ],
    }));

    // iam:PassRole for the invoke policy
    credentialsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));

    // POST /credentials route with JWT auth
    this.api.addRoutes({
      path: '/credentials',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('CredentialsIntegration', credentialsFn),
    });

    // ── GET /me/usage Lambda ─────────────────────────────────────

    const usageFn = new lambda.Function(this, 'UsageFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'usage.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'me')),
      environment: {
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
      },
    });

    props.usageCountersTable.grant(usageFn, 'dynamodb:Query');

    this.api.addRoutes({
      path: '/me/usage',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('UsageIntegration', usageFn),
    });

    // ── GET /me/usage/history Lambda ─────────────────────────────

    const usageHistoryFn = new lambda.Function(this, 'UsageHistoryFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'usage-history.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'me')),
      environment: {
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
      },
    });

    props.usageCountersTable.grant(usageHistoryFn, 'dynamodb:Query');

    this.api.addRoutes({
      path: '/me/usage/history',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('UsageHistoryIntegration', usageHistoryFn),
    });

    // ── GET /me/limits Lambda ────────────────────────────────────

    const limitsFn = new lambda.Function(this, 'LimitsFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'limits.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'me')),
      environment: {
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
      },
    });

    props.userLimitsTable.grant(limitsFn, 'dynamodb:GetItem', 'dynamodb:PutItem');
    props.usersTable.grant(limitsFn, 'dynamodb:GetItem');

    this.api.addRoutes({
      path: '/me/limits',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('LimitsIntegration', limitsFn),
    });

    // ── POST /admin/users Lambda ────────────────────────────────

    const adminCreateFn = new lambda.Function(this, 'AdminCreateFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'admin-users/create.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        TIERS_TABLE: props.tiersTable.tableName,
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        BEDROCK_INVOKE_POLICY_ARN: bedrockInvokeAllowed.managedPolicyArn,
        CREDENTIALS_LAMBDA_ROLE_ARN: credentialsFn.role!.roleArn,
      },
    });

    adminCreateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser'],
      resources: [props.userPool.userPoolArn],
    }));
    adminCreateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:CreateRole', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:ListAttachedRolePolicies'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));
    adminCreateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:CreatePolicy', 'iam:DeletePolicy', 'iam:GetPolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:ListPolicyVersions'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:policy/BedrockModels-*`],
    }));
    // Initiate SES recipient verification for newly created users so budget
    // warning emails can reach them while SES is in the sandbox. VerifyEmailIdentity
    // does not support resource-level permissions, so the resource must be "*".
    adminCreateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:VerifyEmailIdentity'],
      resources: ['*'],
    }));
    props.userLimitsTable.grant(adminCreateFn, 'dynamodb:PutItem');
    props.usersTable.grant(adminCreateFn, 'dynamodb:PutItem');
    props.tiersTable.grant(adminCreateFn, 'dynamodb:GetItem');

    this.api.addRoutes({
      path: '/admin/users',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('AdminCreateIntegration', adminCreateFn),
    });

    // ── GET /admin/users Lambda ─────────────────────────────────

    const adminListUsersFn = new lambda.Function(this, 'AdminListUsersFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'list.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      environment: {
        USERS_TABLE: props.usersTable.tableName,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
      },
    });

    props.usersTable.grant(adminListUsersFn, 'dynamodb:Scan');
    props.userLimitsTable.grant(adminListUsersFn, 'dynamodb:BatchGetItem');

    this.api.addRoutes({
      path: '/admin/users',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('AdminListUsersIntegration', adminListUsersFn),
    });

    // ── POST /admin/users/{sub}/unblock Lambda ───────────────────

    const adminUnblockFn = new lambda.Function(this, 'AdminUnblockFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'unblock.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      environment: {
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        BEDROCK_DENY_POLICY_ARN: bedrockDenyAll.managedPolicyArn,
      },
    });

    adminUnblockFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:DetachRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));
    props.userLimitsTable.grant(adminUnblockFn, 'dynamodb:UpdateItem');

    this.api.addRoutes({
      path: '/admin/users/{sub}/unblock',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('AdminUnblockIntegration', adminUnblockFn),
    });

    // ── PUT /admin/users/{sub}/limits Lambda ─────────────────────

    const adminLimitsFn = new lambda.Function(this, 'AdminLimitsFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'admin-users/limits.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas')),
      environment: {
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        KILLSWITCH_FUNCTION_NAME: this.killSwitchFunction.functionName,
        UNBLOCK_FUNCTION_NAME: adminUnblockFn.functionName,
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        BEDROCK_INVOKE_POLICY_ARN: bedrockInvokeAllowed.managedPolicyArn,
      },
    });

    props.userLimitsTable.grant(adminLimitsFn, 'dynamodb:UpdateItem', 'dynamodb:GetItem');
    props.usageCountersTable.grant(adminLimitsFn, 'dynamodb:GetItem');
    props.usersTable.grant(adminLimitsFn, 'dynamodb:UpdateItem');
    this.killSwitchFunction.grantInvoke(adminLimitsFn);
    adminUnblockFn.grantInvoke(adminLimitsFn);
    adminLimitsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:CreatePolicy', 'iam:DeletePolicy', 'iam:GetPolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:ListPolicyVersions'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:policy/BedrockModels-*`],
    }));
    adminLimitsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:ListAttachedRolePolicies'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));

    this.api.addRoutes({
      path: '/admin/users/{sub}/limits',
      methods: [apigwv2.HttpMethod.PUT],
      integration: new HttpLambdaIntegration('AdminLimitsIntegration', adminLimitsFn),
    });

    // ── PUT /admin/users/{sub}/tier Lambda ───────────────────────

    const adminUserTierFn = new lambda.Function(this, 'AdminUserTierFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'admin-users/tier.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas')),
      environment: {
        USERS_TABLE: props.usersTable.tableName,
        TIERS_TABLE: props.tiersTable.tableName,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
        KILLSWITCH_FUNCTION_NAME: this.killSwitchFunction.functionName,
        UNBLOCK_FUNCTION_NAME: adminUnblockFn.functionName,
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        BEDROCK_INVOKE_POLICY_ARN: bedrockInvokeAllowed.managedPolicyArn,
      },
    });

    props.usersTable.grant(adminUserTierFn, 'dynamodb:UpdateItem');
    props.tiersTable.grant(adminUserTierFn, 'dynamodb:GetItem');
    props.userLimitsTable.grant(adminUserTierFn, 'dynamodb:UpdateItem', 'dynamodb:GetItem');
    props.usageCountersTable.grant(adminUserTierFn, 'dynamodb:GetItem');
    this.killSwitchFunction.grantInvoke(adminUserTierFn);
    adminUnblockFn.grantInvoke(adminUserTierFn);
    adminUserTierFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:CreatePolicy', 'iam:DeletePolicy', 'iam:GetPolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:ListPolicyVersions'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:policy/BedrockModels-*`],
    }));
    adminUserTierFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:ListAttachedRolePolicies'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));

    this.api.addRoutes({
      path: '/admin/users/{sub}/tier',
      methods: [apigwv2.HttpMethod.PUT],
      integration: new HttpLambdaIntegration('AdminUserTierIntegration', adminUserTierFn),
    });

    // ── POST /admin/users/{sub}/block Lambda ─────────────────────

    const adminBlockFn = new lambda.Function(this, 'AdminBlockFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'block.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      environment: {
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        BEDROCK_DENY_POLICY_ARN: bedrockDenyAll.managedPolicyArn,
      },
    });

    adminBlockFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:AttachRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));
    props.userLimitsTable.grant(adminBlockFn, 'dynamodb:UpdateItem');

    this.api.addRoutes({
      path: '/admin/users/{sub}/block',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('AdminBlockIntegration', adminBlockFn),
    });

    // ── POST /admin/users/{sub}/deactivate Lambda ──────────────────

    const adminDeactivateFn = new lambda.Function(this, 'AdminDeactivateFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'deactivate.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        BEDROCK_DENY_POLICY_ARN: bedrockDenyAll.managedPolicyArn,
      },
    });

    adminDeactivateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminDisableUser'],
      resources: [props.userPool.userPoolArn],
    }));
    adminDeactivateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:AttachRolePolicy'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));
    props.userLimitsTable.grant(adminDeactivateFn, 'dynamodb:UpdateItem');
    props.usersTable.grant(adminDeactivateFn, 'dynamodb:UpdateItem');

    this.api.addRoutes({
      path: '/admin/users/{sub}/deactivate',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('AdminDeactivateIntegration', adminDeactivateFn),
    });

    // ── DELETE /admin/users/{sub} Lambda ──────────────────────────

    const adminDeleteFn = new lambda.Function(this, 'AdminDeleteFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'delete.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
      },
    });

    adminDeleteFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminDeleteUser'],
      resources: [props.userPool.userPoolArn],
    }));
    adminDeleteFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:DetachRolePolicy', 'iam:DeleteRole', 'iam:ListAttachedRolePolicies'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/BedrockUser-*`],
    }));
    props.userLimitsTable.grant(adminDeleteFn, 'dynamodb:DeleteItem');
    props.usersTable.grant(adminDeleteFn, 'dynamodb:DeleteItem');

    this.api.addRoutes({
      path: '/admin/users/{sub}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('AdminDeleteIntegration', adminDeleteFn),
    });

    // ── GET /admin/usage Lambda ──────────────────────────────────

    const adminUsageFn = new lambda.Function(this, 'AdminUsageFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'usage.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      environment: {
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
      },
    });

    props.usageCountersTable.grant(adminUsageFn, 'dynamodb:Query');
    props.usersTable.grant(adminUsageFn, 'dynamodb:BatchGetItem');
    props.userLimitsTable.grant(adminUsageFn, 'dynamodb:BatchGetItem');

    this.api.addRoutes({
      path: '/admin/usage',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('AdminUsageIntegration', adminUsageFn),
    });

    // ── GET /admin/dashboard Lambda ─────────────────────────────

    const adminDashboardFn = new lambda.Function(this, 'AdminDashboardFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'dashboard.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      environment: {
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        USER_LIMITS_TABLE: props.userLimitsTable.tableName,
      },
    });

    props.usageCountersTable.grant(adminDashboardFn, 'dynamodb:Query');
    props.userLimitsTable.grant(adminDashboardFn, 'dynamodb:Scan');
    props.usersTable.grant(adminDashboardFn, 'dynamodb:BatchGetItem');

    this.api.addRoutes({
      path: '/admin/dashboard',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('AdminDashboardIntegration', adminDashboardFn),
    });

    // ── GET /admin/usage/history Lambda ──────────────────────────

    const adminUsageHistoryFn = new lambda.Function(this, 'AdminUsageHistoryFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'usage-history.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-users')),
      environment: {
        USAGE_COUNTERS_TABLE: props.usageCountersTable.tableName,
      },
    });

    props.usageCountersTable.grant(adminUsageHistoryFn, 'dynamodb:Query');

    this.api.addRoutes({
      path: '/admin/usage/history',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('AdminUsageHistoryIntegration', adminUsageHistoryFn),
    });

    // ── Admin Tiers CRUD Lambda ────────────────────────────────────

    const adminTiersFn = new lambda.Function(this, 'AdminTiersFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-tiers')),
      environment: {
        TIERS_TABLE: props.tiersTable.tableName,
        USERS_TABLE: props.usersTable.tableName,
        USER_TIER_FUNCTION_NAME: adminUserTierFn.functionName,
      },
    });

    props.tiersTable.grant(adminTiersFn, 'dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem');
    // Propagation: find users on a tier and re-sync their limits via the tier Lambda.
    props.usersTable.grant(adminTiersFn, 'dynamodb:Scan');
    adminUserTierFn.grantInvoke(adminTiersFn);

    this.api.addRoutes({
      path: '/admin/tiers',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('AdminTiersIntegration', adminTiersFn),
    });

    this.api.addRoutes({
      path: '/admin/tiers/{tierId}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('AdminTiersByIdIntegration', adminTiersFn),
    });

    // ── Admin Model Rates CRUD Lambda ──────────────────────────────

    const adminModelRatesFn = new lambda.Function(this, 'AdminModelRatesFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'admin-model-rates')),
      environment: {
        MODEL_RATES_TABLE: props.modelRatesTable.tableName,
      },
    });

    props.modelRatesTable.grant(adminModelRatesFn, 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem');

    this.api.addRoutes({
      path: '/admin/model-rates',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('AdminModelRatesIntegration', adminModelRatesFn),
    });

    this.api.addRoutes({
      path: '/admin/model-rates/{modelId}',
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('AdminModelRatesByIdIntegration', adminModelRatesFn),
    });

    // ── Sync Model Rates Lambda ────────────────────────────────────

    const syncModelRatesFn = new lambda.Function(this, 'SyncModelRatesFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'sync-model-rates')),
      timeout: cdk.Duration.minutes(5),
      environment: {
        MODEL_RATES_TABLE: props.modelRatesTable.tableName,
      },
    });

    props.modelRatesTable.grant(syncModelRatesFn, 'dynamodb:PutItem');
    syncModelRatesFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['pricing:GetProducts'],
      resources: ['*'],
    }));
    syncModelRatesFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles'],
      resources: ['*'],
    }));

    // Run twice daily at 03:00 and 15:00 UTC
    new events.Rule(this, 'SyncModelRatesSchedule', {
      schedule: events.Schedule.cron({ hour: '3,15', minute: '0' }),
      targets: [new targets.LambdaFunction(syncModelRatesFn)],
    });

    // Admin endpoint to trigger manually
    this.api.addRoutes({
      path: '/admin/sync-model-rates',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('SyncModelRatesIntegration', syncModelRatesFn),
    });

    // ── Outputs ──────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url ?? '',
    });

    // ── GET /config Lambda ─────────────────────────────────────────

    const configFn = new lambda.Function(this, 'ConfigFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'config')),
    });

    configFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [
        `arn:aws:cloudformation:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stack/ApiStack/*`,
        `arn:aws:cloudformation:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stack/IdentityStack/*`,
      ],
    }));

    this.api.addRoutes({
      path: '/config',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('ConfigIntegration', configFn),
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    });

    new cdk.CfnOutput(this, 'BedrockInvokeAllowedArn', {
      value: bedrockInvokeAllowed.managedPolicyArn,
    });

    new cdk.CfnOutput(this, 'BedrockDenyAllArn', {
      value: bedrockDenyAll.managedPolicyArn,
    });

    new cdk.CfnOutput(this, 'SyncModelRatesFunctionName', {
      value: syncModelRatesFn.functionName,
    });
  }
}
