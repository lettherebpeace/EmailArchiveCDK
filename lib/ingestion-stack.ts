import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface IngestionStackProps extends cdk.StackProps {
  readonly accountId: string;
  readonly domain: string;
  readonly rawBucket: s3.IBucket;
  readonly parsedBucket: s3.IBucket;
  readonly metadataBucket: s3.IBucket;
  readonly emailMetadataTable: dynamodb.ITable;
  readonly encryptionKey: kms.IKey;
  readonly hostedZone?: route53.IHostedZone;
  readonly glueDatabaseName: string;
  readonly glueTableName: string;
}

export class IngestionStack extends cdk.Stack {
  /** SQS queue that receives notifications when new emails arrive in S3. */
  public readonly ingestQueue: sqs.Queue;

  /** SQS dead-letter queue for failed processing attempts. */
  public readonly deadLetterQueue: sqs.Queue;

  /** Email processor Lambda function. */
  public readonly emailProcessorFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    const { accountId, domain, rawBucket, parsedBucket, metadataBucket, emailMetadataTable, encryptionKey, hostedZone, glueDatabaseName, glueTableName } = props;

    // -------------------------------------------------------------------
    // SES Domain Identity Verification (Required for inbound email)
    // After deployment, add a TXT record in your DNS provider:
    //   Host: _amazonses.{domain}
    //   Value: <VerificationToken from SES>
    // -------------------------------------------------------------------

    new ses.CfnEmailIdentity(this, 'DomainIdentity', {
      emailIdentity: domain,
    });

    // -------------------------------------------------------------------
    // SQS Queues (created here so SES Receipt Rule can reference the queue)
    // -------------------------------------------------------------------

    // Dead-letter queue for messages that fail processing after max retries
    // (Requirements 1.4, 1.5) — messages land here after 5 failed attempts
    this.deadLetterQueue = new sqs.Queue(this, 'IngestDeadLetterQueue', {
      queueName: `email-archive-ingest-dlq-${accountId}`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    // Main ingest queue — SES sends S3 object key here when a new email arrives
    // Visibility timeout = 6x Lambda timeout (5 min * 6 = 30 min = 1800 seconds)
    this.ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      queueName: `email-archive-ingest-${accountId}`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      visibilityTimeout: cdk.Duration.seconds(1800), // 6x Lambda timeout (300s)
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 5, // Requirement 1.4: retry up to 5 attempts
      },
    });

    // -------------------------------------------------------------------
    // S3 Event Notification → SQS
    // Instead of SES → SNS → SQS (which has a 256KB SNS message limit),
    // we use S3 event notifications. Due to cross-stack circular dependency
    // (bucket in StorageStack, queue here), the notification is configured
    // post-deployment via CLI:
    //   aws s3api put-bucket-notification-configuration --bucket <raw-bucket> \
    //     --notification-configuration '{"QueueConfigurations":[...]}'
    //
    // The SQS queue policy below grants S3 permission to send messages.
    // -------------------------------------------------------------------

    // Grant S3 permission to send messages to SQS
    this.ingestQueue.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [this.ingestQueue.queueArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': rawBucket.bucketArn },
        StringEquals: { 'aws:SourceAccount': accountId },
      },
    }));

    // -------------------------------------------------------------------
    // Grant SES permission to use the KMS key for encrypting objects
    // (Bucket policy for S3 PutObject is in StorageStack where the bucket lives)
    // -------------------------------------------------------------------
    encryptionKey.grant(
      new iam.ServicePrincipal('ses.amazonaws.com'),
      'kms:GenerateDataKey*',
      'kms:Decrypt',
    );

    // -------------------------------------------------------------------
    // SES Receipt Rule Set and Rule (Requirements 1.1, 1.6, 1.7)
    // -------------------------------------------------------------------

    // Create SES Receipt Rule Set
    // Note: Rule set must be activated via CLI after first deploy:
    //   aws ses set-active-receipt-rule-set --rule-set-name EmailArchiveInboundRules
    const receiptRuleSet = new ses.ReceiptRuleSet(this, 'ReceiptRuleSet', {
      receiptRuleSetName: 'EmailArchiveInboundRules',
    });

    // Create Receipt Rule — S3 action only (no SNS action)
    // The S3 bucket event notification handles triggering the processing pipeline
    receiptRuleSet.addRule('StoreAndProcessRule', {
      receiptRuleName: 'StoreAndProcess',
      recipients: [`journal@${domain}`],
      enabled: true,
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        new sesActions.S3({
          bucket: rawBucket,
          objectKeyPrefix: 'inbound/',
        }),
      ],
    });

    // -------------------------------------------------------------------
    // Route53 MX Record (points to SES inbound SMTP endpoint)
    // Only created if a hosted zone is provided. If DNS is managed externally
    // (e.g., GoDaddy), add the MX record manually:
    //   Type: MX, Host: @, Value: 10 inbound-smtp.us-east-1.amazonaws.com
    // -------------------------------------------------------------------

    if (hostedZone) {
      new route53.MxRecord(this, 'MxRecord', {
        zone: hostedZone,
        values: [
          {
            priority: 10,
            hostName: `inbound-smtp.${this.region}.amazonaws.com`,
          },
        ],
        ttl: cdk.Duration.minutes(5),
        comment: 'MX record for SES inbound email reception',
      });
    }

    // -------------------------------------------------------------------
    // Email Processor Lambda (Requirements 1.2, 1.3, 2.3, 3.1, 7.1)
    // -------------------------------------------------------------------

    this.emailProcessorFn = new lambdaNodejs.NodejsFunction(this, 'EmailProcessorFn', {
      functionName: `email-archive-processor-${accountId}`,
      entry: path.join(__dirname, '..', 'lambda', 'email-processor', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        PARSED_BUCKET: parsedBucket.bucketName,
        METADATA_BUCKET: metadataBucket.bucketName,
        EMAIL_TABLE: emailMetadataTable.tableName,
        GLUE_DATABASE: glueDatabaseName,
        GLUE_TABLE: glueTableName,
        METRICS_NAMESPACE: 'EmailArchive',
      },
      bundling: {
        forceDockerBundling: false,
        externalModules: [],
      },
    });

    // Grant Lambda permissions to read from raw bucket
    rawBucket.grantRead(this.emailProcessorFn);

    // Grant Lambda permissions to write to parsed bucket
    parsedBucket.grantReadWrite(this.emailProcessorFn);

    // Grant Lambda permissions to write to metadata bucket
    metadataBucket.grantReadWrite(this.emailProcessorFn);

    // Grant Lambda permissions to read/write DynamoDB EmailMetadata table
    emailMetadataTable.grantReadWriteData(this.emailProcessorFn);

    // Grant Lambda permissions to use the KMS key
    encryptionKey.grantEncryptDecrypt(this.emailProcessorFn);

    // Grant Lambda permissions to put CloudWatch metrics
    this.emailProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'EmailArchive',
        },
      },
    }));

    // Grant Lambda permissions to call Glue BatchCreatePartition
    this.emailProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:BatchCreatePartition',
        'glue:GetPartition',
        'glue:GetPartitions',
      ],
      resources: [
        `arn:aws:glue:${this.region}:${accountId}:catalog`,
        `arn:aws:glue:${this.region}:${accountId}:database/${glueDatabaseName}`,
        `arn:aws:glue:${this.region}:${accountId}:table/${glueDatabaseName}/${glueTableName}`,
      ],
    }));

    // Add SQS event source to trigger the Lambda from the ingest queue
    this.emailProcessorFn.addEventSource(new lambdaEventSources.SqsEventSource(this.ingestQueue, {
      batchSize: 1, // Process one email at a time for reliability
      maxBatchingWindow: cdk.Duration.seconds(0),
      reportBatchItemFailures: true,
    }));

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'IngestQueueArn', {
      value: this.ingestQueue.queueArn,
      description: 'ARN of the SQS ingest queue',
      exportName: 'EmailArchive-IngestQueueArn',
    });

    new cdk.CfnOutput(this, 'IngestQueueUrl', {
      value: this.ingestQueue.queueUrl,
      description: 'URL of the SQS ingest queue',
      exportName: 'EmailArchive-IngestQueueUrl',
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueArn', {
      value: this.deadLetterQueue.queueArn,
      description: 'ARN of the SQS dead-letter queue',
      exportName: 'EmailArchive-DeadLetterQueueArn',
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'URL of the SQS dead-letter queue',
      exportName: 'EmailArchive-DeadLetterQueueUrl',
    });

    new cdk.CfnOutput(this, 'ReceiptRuleSetName', {
      value: 'EmailArchiveInboundRules',
      description: 'Name of the SES Receipt Rule Set',
      exportName: 'EmailArchive-ReceiptRuleSetName',
    });

    new cdk.CfnOutput(this, 'EmailProcessorFnArn', {
      value: this.emailProcessorFn.functionArn,
      description: 'ARN of the Email Processor Lambda function',
      exportName: 'EmailArchive-EmailProcessorFnArn',
    });
  }
}
