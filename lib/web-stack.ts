import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export interface WebStackProps extends cdk.StackProps {
  /**
   * Physical-name prefix (e.g. `CodeOnBedrock-us-east-1-`) for running a second
   * control plane in the same account. Empty ⇒ CDK auto-named OAC (legacy).
   * The CloudFront Origin Access Control is account-global, so two deployments
   * must not share its name. See lib/naming.ts.
   */
  namePrefix?: string;
}

export class WebStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: WebStackProps) {
    super(scope, id, props);

    const prefix = props?.namePrefix ?? '';

    this.bucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // The Origin Access Control is an account-global CloudFront resource; CDK
    // auto-names it deterministically from the construct path, so two control
    // planes would collide. Give it a Region-prefixed explicit name when
    // prefixing is active; otherwise leave it auto-named (legacy unchanged).
    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'WebOAC', {
      originAccessControlName: prefix ? `${prefix}WebOAC` : undefined,
    });

    this.distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, { originAccessControl }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });

    new cdk.CfnOutput(this, 'WebBucketName', {
      value: this.bucket.bucketName,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
    });
  }
}
