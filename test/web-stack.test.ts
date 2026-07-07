import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WebStack } from '../lib/web-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const webStack = new WebStack(app, 'TestWebStack');
  template = Template.fromStack(webStack);
});

// R-UI-1: S3 bucket for static assets
describe('S3 Bucket', () => {
  test('private bucket exists with block public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

// R-UI-1: CloudFront distribution
describe('CloudFront Distribution', () => {
  test('distribution exists with S3 origin', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        Origins: Match.arrayWith([
          Match.objectLike({
            S3OriginConfig: Match.anyValue(),
          }),
        ]),
      },
    });
  });

  test('distribution has SPA error page redirect', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      },
    });
  });
});

// R-UI-1: OAC for S3 access
describe('Origin Access Control', () => {
  test('OAC exists for S3', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
  });
});

// Exports
describe('Exports', () => {
  test('exports CloudFront URL', () => {
    template.hasOutput('CloudFrontUrl', {});
  });

  test('exports WebBucketName', () => {
    template.hasOutput('WebBucketName', {});
  });

  test('exports DistributionId', () => {
    template.hasOutput('DistributionId', {});
  });
});
