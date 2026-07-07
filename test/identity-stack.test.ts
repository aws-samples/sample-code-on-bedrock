import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IdentityStack } from '../lib/identity-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new IdentityStack(app, 'TestIdentityStack');
  template = Template.fromStack(stack);
});

// R-ID-1: User Pool with AllowAdminCreateUserOnly
describe('User Pool', () => {
  test('exists with AdminCreateUserOnly sign-up policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });
});

// R-ID-1: User Pool Domain (Hosted UI)
describe('User Pool Domain', () => {
  test('Cognito domain exists', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });
});

// R-ID-1 / R-CV-3: App Client with authorization code grant, no secret (PKCE)
describe('App Client', () => {
  test('uses authorization code and implicit grant with no client secret', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows: Match.arrayWith(['implicit', 'code']),
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
      GenerateSecret: false,
      CallbackURLs: Match.arrayWith(['http://localhost:8787/callback']),
    });
  });
});

// R-ID-2: Cognito groups — only admin for UI access control
describe('Cognito groups', () => {
  test('admin group exists', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'admin',
    });
  });

  test('exactly one group is created', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);
  });
});

// Exports
describe('exports', () => {
  test('exports User Pool ID, Client ID, and Domain URL', () => {
    template.hasOutput('UserPoolId', {});
    template.hasOutput('UserPoolClientId', {});
    template.hasOutput('UserPoolDomainUrl', {});
  });
});

// Web UI callback wiring: the CloudFront origin must be an allowed
// callback + logout URL or the Hosted UI rejects the web app's redirect_uri.
describe('web callback URL wiring', () => {
  test('adds <webCallbackUrl>/ to callback and logout URLs when provided', () => {
    const app = new cdk.App();
    const stack = new IdentityStack(app, 'WithWebCallback', {
      webCallbackUrl: 'https://d2l1khrir8xnug.cloudfront.net',
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['https://d2l1khrir8xnug.cloudfront.net/']),
      LogoutURLs: Match.arrayWith(['https://d2l1khrir8xnug.cloudfront.net/']),
    });
  });

  test('trailing slashes on webCallbackUrl are normalized (no double slash)', () => {
    const app = new cdk.App();
    const stack = new IdentityStack(app, 'WithTrailingSlash', {
      webCallbackUrl: 'https://example.cloudfront.net/',
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['https://example.cloudfront.net/']),
    });
  });
});
