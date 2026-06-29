import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface EncryptionKeyProps {
  /**
   * The AWS account ID for this deployment.
   */
  readonly accountId: string;

  /**
   * The AWS region for this deployment.
   */
  readonly region: string;
}

/**
 * Shared KMS customer-managed key construct used by all stacks in the
 * Email Archive Solution. Encrypts data at rest across S3, DynamoDB,
 * SQS, and Lambda.
 *
 * Requirement 5.1: All emails encrypted at rest using AES-256 encryption.
 */
export class EncryptionKey extends Construct {
  /**
   * The KMS key used for encryption across the solution.
   */
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: EncryptionKeyProps) {
    super(scope, id);

    this.key = new kms.Key(this, 'EmailArchiveKey', {
      alias: 'alias/email-archive-key',
      description: 'Customer-managed KMS key for Email Archive Solution encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
    });

    // Allow S3 service to use this key for bucket encryption
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowS3ServiceAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
          'kms:GenerateDataKey*',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.accountId,
          },
        },
      })
    );

    // Allow DynamoDB service to use this key for table encryption
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowDynamoDBServiceAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('dynamodb.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
          'kms:DescribeKey',
          'kms:CreateGrant',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.accountId,
          },
        },
      })
    );

    // Allow SQS service to use this key for queue encryption
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSQSServiceAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('sqs.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.accountId,
          },
        },
      })
    );

    // Allow Lambda service to use this key for environment variable encryption
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLambdaServiceAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.accountId,
          },
        },
      })
    );

    // Allow SES service to use this key for storing encrypted emails
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESServiceAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
          'kms:GenerateDataKey*',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.accountId,
          },
        },
      })
    );

    // Allow Glue and Athena services to read encrypted data
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowGlueAthenaServiceAccess',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal('glue.amazonaws.com'),
          new iam.ServicePrincipal('athena.amazonaws.com'),
        ],
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.accountId,
          },
        },
      })
    );
  }
}
