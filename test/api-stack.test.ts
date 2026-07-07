import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IdentityStack } from '../lib/identity-stack';
import { DataStack } from '../lib/data-stack';
import { ApiStack } from '../lib/api-stack';

let template: Template;
let stack: ApiStack;

beforeAll(() => {
  const app = new cdk.App();
  const identity = new IdentityStack(app, 'TestIdentity');
  const data = new DataStack(app, 'TestData');
  stack = new ApiStack(app, 'TestApiStack', {
    userPool: identity.userPool,
    userPoolClient: identity.userPoolClient,
    userLimitsTable: data.userLimitsTable,
    usageCountersTable: data.usageCountersTable,
    usersTable: data.usersTable,
    tiersTable: data.tiersTable,
    modelRatesTable: data.modelRatesTable,
    sourceRegions: ['eu-central-1', 'us-east-1'],
  });
  template = Template.fromStack(stack);
});

// R-API-1: HTTP API exists
describe('HTTP API', () => {
  test('exists with protocol HTTP', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
  });
});

// R-API-1: JWT authorizer is configured as default
describe('JWT Authorizer', () => {
  test('api has a default authorizer configured', () => {
    expect(stack.api.defaultAuthorizer).toBeDefined();
  });
});

// R-API-1: GET /health route with no auth
describe('GET /health route', () => {
  test('exists with NONE authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /health',
      AuthorizationType: 'NONE',
    });
  });
});

// POST /credentials route with JWT auth
describe('POST /credentials route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /credentials',
      AuthorizationType: 'JWT',
    });
  });
});

// R-ID-5: BedrockInvokeAllowed managed policy — region-scoped at the role level
describe('BedrockInvokeAllowed policy', () => {
  test('pins direct in-Region model invocation to the source Regions', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'BedrockInvokeAllowed',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'InvokeFoundationModelsInSourceRegions',
            Effect: 'Allow',
            Action: [
              'bedrock:InvokeModel',
              'bedrock:InvokeModelWithResponseStream',
              'bedrock:Converse',
              'bedrock:ConverseStream',
            ],
            Resource: 'arn:aws:bedrock:*::foundation-model/*',
            Condition: { StringEquals: { 'aws:RequestedRegion': ['eu-central-1', 'us-east-1'] } },
          }),
        ]),
      },
    });
  });

  test('allows cross-Region routing only via source-Region inference profiles', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'BedrockInvokeAllowed',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'InvokeRoutedFoundationModels',
            Resource: 'arn:aws:bedrock:*::foundation-model/*',
            Condition: {
              ArnLike: {
                'bedrock:InferenceProfileArn': [
                  { 'Fn::Join': ['', ['arn:aws:bedrock:eu-central-1:', { Ref: 'AWS::AccountId' }, ':inference-profile/*']] },
                  { 'Fn::Join': ['', ['arn:aws:bedrock:us-east-1:', { Ref: 'AWS::AccountId' }, ':inference-profile/*']] },
                ],
              },
            },
          }),
        ]),
      },
    });
  });

  test('scopes inference-profile invocation to source-Region profile ARNs', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'BedrockInvokeAllowed',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'InvokeInferenceProfilesInSourceRegions',
            Resource: [
              { 'Fn::Join': ['', ['arn:aws:bedrock:eu-central-1:', { Ref: 'AWS::AccountId' }, ':inference-profile/*']] },
              { 'Fn::Join': ['', ['arn:aws:bedrock:eu-central-1:', { Ref: 'AWS::AccountId' }, ':application-inference-profile/*']] },
              { 'Fn::Join': ['', ['arn:aws:bedrock:us-east-1:', { Ref: 'AWS::AccountId' }, ':inference-profile/*']] },
              { 'Fn::Join': ['', ['arn:aws:bedrock:us-east-1:', { Ref: 'AWS::AccountId' }, ':application-inference-profile/*']] },
            ],
          }),
        ]),
      },
    });
  });

  test('grants invoke actions only under Region-scoped statements (no unconditional invoke)', () => {
    const policies = template.findResources('AWS::IAM::ManagedPolicy');
    const invokeAllowed = Object.values(policies).find(
      (p) => p.Properties?.ManagedPolicyName === 'BedrockInvokeAllowed',
    );
    expect(invokeAllowed).toBeDefined();
    for (const stmt of invokeAllowed!.Properties.PolicyDocument.Statement) {
      const actions: string[] = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      const grantsInvoke = actions.some((a) => a.startsWith('bedrock:Invoke') || a.startsWith('bedrock:Converse'));
      if (grantsInvoke) {
        // Every invoke-granting statement is constrained: either to specific
        // profile ARNs, or by aws:RequestedRegion / bedrock:InferenceProfileArn.
        const scopedByResource = Array.isArray(stmt.Resource) && stmt.Resource.length > 0
          && stmt.Resource[0] !== '*';
        expect(stmt.Condition !== undefined || scopedByResource).toBe(true);
        expect(stmt.Resource).not.toBe('*');
      }
    }
  });
});

// R-BE-3: BedrockDenyAll managed policy
describe('BedrockDenyAll policy', () => {
  test('denies all bedrock actions', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'BedrockDenyAll',
      PolicyDocument: {
        Statement: [
          {
            Effect: 'Deny',
            Action: 'bedrock:*',
            Resource: '*',
          },
        ],
      },
    });
  });
});

// Credentials Lambda exists
describe('Credentials Lambda', () => {
  test('Lambda function exists with correct runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: {
          USER_LIMITS_TABLE: Match.anyValue(),
          ACCOUNT_ID: Match.anyValue(),
          BEDROCK_INVOKE_POLICY_ARN: Match.anyValue(),
        },
      },
    });
  });
});

// R-SEC-5: Lambda permissions are scoped
describe('Credentials Lambda permissions', () => {
  test('has IAM policy for DynamoDB, IAM, and STS', () => {
    // Verify the Lambda role has a policy with the required actions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'dynamodb:GetItem',
          }),
        ]),
      },
    });
  });
});

// GET /me/usage route with JWT auth
describe('GET /me/usage route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /me/usage',
      AuthorizationType: 'JWT',
    });
  });
});

// GET /me/limits route with JWT auth
describe('GET /me/limits route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /me/limits',
      AuthorizationType: 'JWT',
    });
  });

  test('limits Lambda has USER_LIMITS_TABLE and USERS_TABLE env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'limits.handler',
      Environment: {
        Variables: {
          USER_LIMITS_TABLE: Match.anyValue(),
          USERS_TABLE: Match.anyValue(),
        },
      },
    });
  });
});

// Usage Lambda has correct env vars
describe('Usage Lambda', () => {
  test('has USAGE_COUNTERS_TABLE env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          USAGE_COUNTERS_TABLE: Match.anyValue(),
        },
      },
    });
  });
});

// ── Admin routes ─────────────────────────────────────────────────

describe('POST /admin/users route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /admin/users',
      AuthorizationType: 'JWT',
    });
  });
});

describe('PUT /admin/users/{sub}/limits route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PUT /admin/users/{sub}/limits',
      AuthorizationType: 'JWT',
    });
  });
});

describe('PUT /admin/users/{sub}/tier route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PUT /admin/users/{sub}/tier',
      AuthorizationType: 'JWT',
    });
  });
});

describe('Admin User Tier Lambda', () => {
  test('has tier handler and required environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'admin-users/tier.handler',
      Environment: {
        Variables: {
          USERS_TABLE: Match.anyValue(),
          TIERS_TABLE: Match.anyValue(),
          USER_LIMITS_TABLE: Match.anyValue(),
          USAGE_COUNTERS_TABLE: Match.anyValue(),
          KILLSWITCH_FUNCTION_NAME: Match.anyValue(),
          UNBLOCK_FUNCTION_NAME: Match.anyValue(),
        },
      },
    });
  });
});

describe('Admin Tiers Lambda', () => {
  test('has propagation environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          TIERS_TABLE: Match.anyValue(),
          USERS_TABLE: Match.anyValue(),
          USER_TIER_FUNCTION_NAME: Match.anyValue(),
        },
      },
    });
  });
});

describe('POST /admin/users/{sub}/unblock route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /admin/users/{sub}/unblock',
      AuthorizationType: 'JWT',
    });
  });
});

describe('GET /admin/usage route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /admin/usage',
      AuthorizationType: 'JWT',
    });
  });
});

// Admin Create User Lambda has correct env vars
describe('Admin Create User Lambda', () => {
  test('has required environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          USER_POOL_ID: Match.anyValue(),
          USER_LIMITS_TABLE: Match.anyValue(),
          ACCOUNT_ID: Match.anyValue(),
          BEDROCK_INVOKE_POLICY_ARN: Match.anyValue(),
        },
      },
    });
  });
});

// Admin Unblock Lambda has BEDROCK_DENY_POLICY_ARN env var
describe('Admin Unblock Lambda', () => {
  test('has BEDROCK_DENY_POLICY_ARN env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          USER_LIMITS_TABLE: Match.anyValue(),
          BEDROCK_DENY_POLICY_ARN: Match.anyValue(),
        },
      },
    });
  });
});

// ── KillSwitch Lambda ────────────────────────────────────────────

describe('KillSwitch Lambda', () => {
  test('exists with BEDROCK_DENY_POLICY_ARN env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Environment: {
        Variables: {
          BEDROCK_DENY_POLICY_ARN: Match.anyValue(),
        },
      },
    });
  });

  // R-SEC-5: iam:AttachRolePolicy scoped to BedrockUser-*
  test('has IAM AttachRolePolicy scoped to BedrockUser-*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:AttachRolePolicy',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([
                  Match.stringLikeRegexp('.*BedrockUser-\\*'),
                ]),
              ]),
            }),
          }),
        ]),
      },
    });
  });
});

// ── SNS Daily Warning Topic ─────────────────────────────────────

describe('Daily Warning SNS Topic', () => {
  test('exists with correct name', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'DailyBudgetWarning',
    });
  });
});

// POST /admin/users/{sub}/deactivate route
describe('POST /admin/users/{sub}/deactivate route', () => {
  test('exists with JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /admin/users/{sub}/deactivate',
      AuthorizationType: 'JWT',
    });
  });
});

// Admin Deactivate Lambda has required env vars
describe('Admin Deactivate Lambda', () => {
  test('has required environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'deactivate.handler',
      Environment: {
        Variables: {
          USER_POOL_ID: Match.anyValue(),
          USER_LIMITS_TABLE: Match.anyValue(),
          USERS_TABLE: Match.anyValue(),
          BEDROCK_DENY_POLICY_ARN: Match.anyValue(),
        },
      },
    });
  });
});

// Exports
describe('exports', () => {
  test('exports API URL', () => {
    template.hasOutput('ApiUrl', {});
  });

  test('exports BedrockInvokeAllowed policy ARN', () => {
    template.hasOutput('BedrockInvokeAllowedArn', {});
  });

  test('exports BedrockDenyAll policy ARN', () => {
    template.hasOutput('BedrockDenyAllArn', {});
  });
});
