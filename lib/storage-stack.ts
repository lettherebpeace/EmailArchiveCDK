import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';
import { EncryptionKey } from './constructs/encryption-key';
import { bucketName } from './constants';
import * as path from 'path';

export interface StorageStackProps extends cdk.StackProps {
  readonly accountId: string;
}

export class StorageStack extends cdk.Stack {
  /** The shared KMS key for encryption across all stacks. */
  public readonly encryptionKey: kms.Key;

  /** S3 bucket for raw .eml files with Object Lock (Governance mode). */
  public readonly rawBucket: s3.Bucket;

  /** S3 bucket for parsed email bodies and attachments. */
  public readonly parsedBucket: s3.Bucket;

  /** S3 bucket for Parquet metadata files. */
  public readonly metadataBucket: s3.Bucket;

  /** S3 bucket for temporary export ZIP files. */
  public readonly exportsBucket: s3.Bucket;

  /** S3 bucket for Athena query results. */
  public readonly athenaResultsBucket: s3.Bucket;

  /** DynamoDB table for email metadata records. */
  public readonly emailMetadataTable: dynamodb.Table;

  /** DynamoDB table for retention policy definitions. */
  public readonly retentionPoliciesTable: dynamodb.Table;

  /** DynamoDB table for export job tracking. */
  public readonly exportJobsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // Shared KMS customer-managed key for encryption at rest (Requirement 5.1)
    const encryptionKeyConstruct = new EncryptionKey(this, 'EncryptionKey', {
      accountId: props.accountId,
      region: this.region,
    });
    this.encryptionKey = encryptionKeyConstruct.key;

    // Export key ARN for cross-stack references
    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.encryptionKey.keyArn,
      description: 'ARN of the shared KMS encryption key for the Email Archive Solution',
      exportName: 'EmailArchive-EncryptionKeyArn',
    });

    // -----------------------------------------------------------------------
    // S3 Buckets (Requirements 2.1, 2.3, 2.4, 5.1, 5.2, 6.5)
    // -----------------------------------------------------------------------

    // Raw email bucket with Object Lock (Governance mode) for immutable retention
    this.rawBucket = new s3.Bucket(this, 'RawBucket', {
      bucketName: bucketName('raw', props.accountId),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      objectLockEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'TransitionToIntelligentTiering',
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    // Note: Object Lock is enabled on the bucket but no default retention is set
    // because SES cannot write to S3 buckets with a default retention period.
    // Retention is applied per-object by the email processor Lambda after ingestion.

    // Grant SES permission to write to the raw bucket (must be in same stack as bucket)
    this.rawBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESPuts',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.rawBucket.arnForObjects('inbound/*')],
        conditions: {
          StringEquals: {
            'AWS:SourceAccount': props.accountId,
          },
        },
      }),
    );

    // Parsed emails bucket (bodies + attachments)
    this.parsedBucket = new s3.Bucket(this, 'ParsedBucket', {
      bucketName: bucketName('parsed', props.accountId),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'TransitionToIntelligentTiering',
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    // Metadata bucket for Parquet files (Glue/Athena search)
    this.metadataBucket = new s3.Bucket(this, 'MetadataBucket', {
      bucketName: bucketName('metadata', props.accountId),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // Exports bucket with 24-hour lifecycle expiration (temporary ZIPs)
    this.exportsBucket = new s3.Bucket(this, 'ExportsBucket', {
      bucketName: bucketName('exports', props.accountId),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'ExpireExportsAfter24Hours',
          expiration: cdk.Duration.days(1),
        },
      ],
    });

    // Athena query results bucket
    this.athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: bucketName('athena-results', props.accountId),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    // -----------------------------------------------------------------------
    // CfnOutputs for cross-stack references
    // -----------------------------------------------------------------------

    new cdk.CfnOutput(this, 'RawBucketArn', {
      value: this.rawBucket.bucketArn,
      exportName: 'EmailArchive-RawBucketArn',
    });

    new cdk.CfnOutput(this, 'ParsedBucketArn', {
      value: this.parsedBucket.bucketArn,
      exportName: 'EmailArchive-ParsedBucketArn',
    });

    new cdk.CfnOutput(this, 'MetadataBucketArn', {
      value: this.metadataBucket.bucketArn,
      exportName: 'EmailArchive-MetadataBucketArn',
    });

    new cdk.CfnOutput(this, 'ExportsBucketArn', {
      value: this.exportsBucket.bucketArn,
      exportName: 'EmailArchive-ExportsBucketArn',
    });

    new cdk.CfnOutput(this, 'AthenaResultsBucketArn', {
      value: this.athenaResultsBucket.bucketArn,
      exportName: 'EmailArchive-AthenaResultsBucketArn',
    });

    // -----------------------------------------------------------------------
    // DynamoDB Tables (Requirements 2.1, 2.3, 4.6, 8.1)
    // -----------------------------------------------------------------------

    // EmailMetadata table — stores per-email metadata records
    this.emailMetadataTable = new dynamodb.Table(this, 'EmailMetadataTable', {
      tableName: 'EmailMetadata',
      partitionKey: { name: 'emailId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI-1: sender-date-index (PK: sender, SK: date) — queries by sender within date range
    this.emailMetadataTable.addGlobalSecondaryIndex({
      indexName: 'sender-date-index',
      partitionKey: { name: 'sender', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI-2: messageId-index (PK: messageId) — deduplication lookups
    this.emailMetadataTable.addGlobalSecondaryIndex({
      indexName: 'messageId-index',
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI-3: retentionExpiresAt-index (PK: retentionPolicyId, SK: retentionExpiresAt) — retention evaluation
    this.emailMetadataTable.addGlobalSecondaryIndex({
      indexName: 'retentionExpiresAt-index',
      partitionKey: { name: 'retentionPolicyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'retentionExpiresAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // RetentionPolicies table — stores retention policy definitions
    this.retentionPoliciesTable = new dynamodb.Table(this, 'RetentionPoliciesTable', {
      tableName: 'RetentionPolicies',
      partitionKey: { name: 'policyId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ExportJobs table — tracks async export job status
    this.exportJobsTable = new dynamodb.Table(this, 'ExportJobsTable', {
      tableName: 'ExportJobs',
      partitionKey: { name: 'exportId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ExportJobs GSI: userId-createdAt-index (PK: userId, SK: createdAt) — list user's exports
    this.exportJobsTable.addGlobalSecondaryIndex({
      indexName: 'userId-createdAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // -----------------------------------------------------------------------
    // DynamoDB Table Outputs
    // -----------------------------------------------------------------------

    new cdk.CfnOutput(this, 'EmailMetadataTableName', {
      value: this.emailMetadataTable.tableName,
      description: 'Name of the EmailMetadata DynamoDB table',
      exportName: 'EmailArchive-EmailMetadataTableName',
    });

    new cdk.CfnOutput(this, 'EmailMetadataTableArn', {
      value: this.emailMetadataTable.tableArn,
      description: 'ARN of the EmailMetadata DynamoDB table',
      exportName: 'EmailArchive-EmailMetadataTableArn',
    });

    new cdk.CfnOutput(this, 'RetentionPoliciesTableName', {
      value: this.retentionPoliciesTable.tableName,
      description: 'Name of the RetentionPolicies DynamoDB table',
      exportName: 'EmailArchive-RetentionPoliciesTableName',
    });

    new cdk.CfnOutput(this, 'RetentionPoliciesTableArn', {
      value: this.retentionPoliciesTable.tableArn,
      description: 'ARN of the RetentionPolicies DynamoDB table',
      exportName: 'EmailArchive-RetentionPoliciesTableArn',
    });

    new cdk.CfnOutput(this, 'ExportJobsTableName', {
      value: this.exportJobsTable.tableName,
      description: 'Name of the ExportJobs DynamoDB table',
      exportName: 'EmailArchive-ExportJobsTableName',
    });

    new cdk.CfnOutput(this, 'ExportJobsTableArn', {
      value: this.exportJobsTable.tableArn,
      description: 'ARN of the ExportJobs DynamoDB table',
      exportName: 'EmailArchive-ExportJobsTableArn',
    });

    // -----------------------------------------------------------------------
    // Retention Evaluation Lambda + EventBridge Scheduler
    // (Requirements 2.4, 2.5, 8.2, 8.4, 8.5)
    //
    // Runs every hour to find emails whose retention has expired and marks
    // them as purgeEligible. Does NOT delete — respects S3 Object Lock.
    // -----------------------------------------------------------------------

    const retentionEvaluatorFn = new lambdaNodejs.NodejsFunction(this, 'RetentionEvaluatorFn', {
      functionName: `email-archive-retention-evaluator-${props.accountId}`,
      entry: path.join(__dirname, '..', 'lambda', 'retention-evaluator', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      environment: {
        EMAIL_TABLE: this.emailMetadataTable.tableName,
        RETENTION_POLICIES_TABLE: this.retentionPoliciesTable.tableName,
      },
      bundling: {
        forceDockerBundling: false,
        externalModules: [],
      },
    });

    // Grant Lambda read/write to EmailMetadata (query GSI + update purgeEligible)
    this.emailMetadataTable.grantReadWriteData(retentionEvaluatorFn);

    // Grant Lambda read access to RetentionPolicies table (scan policies)
    this.retentionPoliciesTable.grantReadData(retentionEvaluatorFn);

    // IAM Role for EventBridge Scheduler to invoke the Lambda
    const schedulerRole = new iam.Role(this, 'RetentionSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to invoke the retention evaluator Lambda',
    });

    retentionEvaluatorFn.grantInvoke(schedulerRole);

    // EventBridge Scheduler — runs retention evaluation every hour
    new scheduler.CfnSchedule(this, 'RetentionEvaluationSchedule', {
      name: `email-archive-retention-evaluation-${props.accountId}`,
      description: 'Invokes retention evaluator Lambda every hour to mark expired emails as purge-eligible',
      scheduleExpression: 'rate(1 hour)',
      flexibleTimeWindow: {
        mode: 'FLEXIBLE',
        maximumWindowInMinutes: 15,
      },
      target: {
        arn: retentionEvaluatorFn.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 3600,
        },
      },
      state: 'ENABLED',
    });

    new cdk.CfnOutput(this, 'RetentionEvaluatorFnArn', {
      value: retentionEvaluatorFn.functionArn,
      description: 'ARN of the Retention Evaluator Lambda function',
      exportName: 'EmailArchive-RetentionEvaluatorFnArn',
    });
  }
}
