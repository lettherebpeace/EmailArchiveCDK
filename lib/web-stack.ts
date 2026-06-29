import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { bucketName } from './constants';
import * as path from 'path';

export interface WebStackProps extends cdk.StackProps {
  readonly accountId: string;
  /** API Gateway endpoint URL passed as build-time environment variable to the React SPA. */
  readonly apiUrl: string;
  /** Cognito User Pool ID for frontend authentication configuration. */
  readonly userPoolId: string;
  /** Cognito User Pool Client ID for frontend authentication configuration. */
  readonly userPoolClientId: string;
}

export class WebStack extends cdk.Stack {
  /** The CloudFront distribution serving the SPA. */
  public readonly distribution: cloudfront.Distribution;

  /** The S3 bucket holding the SPA static assets. */
  public readonly webBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    // S3 bucket for static web assets (Requirement 5.2, 6.5)
    // SSE-S3 encryption, all public access blocked — access only via CloudFront OAC
    this.webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: bucketName('web', props.accountId),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution with Origin Access Control (OAC)
    // Serves the React SPA over HTTPS with proper SPA routing support
    this.distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Deploy frontend assets from frontend/dist to the S3 bucket
    // Invalidate index.html on deploy so users always get the latest version
    new s3deploy.BucketDeployment(this, 'WebDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'frontend', 'dist'))],
      destinationBucket: this.webBucket,
      distribution: this.distribution,
      distributionPaths: ['/index.html'],
    });

    // Export the CloudFront distribution URL
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'CloudFront distribution URL for the Email Archive web application',
      exportName: 'EmailArchive-WebDistributionUrl',
    });

    // Export the distribution ID for reference
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: 'EmailArchive-WebDistributionId',
    });

    // Export the API URL and Cognito settings passed to this stack
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: props.apiUrl,
      description: 'API Gateway endpoint URL used by the frontend',
      exportName: 'EmailArchive-WebApiUrl',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: props.userPoolId,
      description: 'Cognito User Pool ID used by the frontend',
      exportName: 'EmailArchive-WebUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: props.userPoolClientId,
      description: 'Cognito User Pool Client ID used by the frontend',
      exportName: 'EmailArchive-WebUserPoolClientId',
    });
  }
}
