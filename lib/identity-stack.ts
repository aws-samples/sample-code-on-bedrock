import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { physicalName } from './naming';

export interface IdentityStackProps extends cdk.StackProps {
  /** CloudFront URL for the web UI (e.g. https://d111111abcdef8.cloudfront.net) */
  webCallbackUrl?: string;
  /**
   * Physical-name prefix (e.g. `CodeOnBedrock-us-east-1-`) for running a second
   * control plane in the same account. Empty ⇒ legacy names. See lib/naming.ts.
   */
  namePrefix?: string;
}

export class IdentityStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: IdentityStackProps) {
    super(scope, id, props);

    const prefix = props?.namePrefix ?? '';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: physicalName(prefix, 'UserPool', 'CodeOnBedrockUserPool'),
      selfSignUpEnabled: false,
      signInAliases: { email: true },
    });

    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `codeonbedrock-${cdk.Aws.ACCOUNT_ID}` },
    });

    const callbackUrls = ['http://localhost:8787/callback'];
    const logoutUrls = ['http://localhost:8787/logout'];
    if (props?.webCallbackUrl) {
      const base = props.webCallbackUrl.replace(/\/+$/, '');
      callbackUrls.push(`${base}/`);
      logoutUrls.push(`${base}/`);
    }

    this.userPoolClient = this.userPool.addClient('AppClient', {
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(24),
      idTokenValidity: cdk.Duration.hours(24),
      refreshTokenValidity: cdk.Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls,
      },
    });

    new cognito.CfnUserPoolGroup(this, 'Group-admin', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'UserPoolDomainUrl', {
      value: `https://${this.userPoolDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
    });
  }
}
