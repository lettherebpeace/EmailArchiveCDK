import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'path';

import { ATHENA_BYTES_SCAN_LIMIT } from './constants';

export interface SearchStackProps extends cdk.StackProps {
  readonly accountId: string;
  readonly metadataBucket: s3.IBucket;
  readonly athenaResultsBucket: s3.IBucket;
  readonly encryptionKey: kms.IKey;
}

export class SearchStack extends cdk.Stack {
  /** The Glue Data Catalog database name. */
  public readonly glueDatabaseName: string;

  /** The Glue Data Catalog table name. */
  public readonly glueTableName: string;

  /** The Athena workgroup name for search queries. */
  public readonly workgroupName: string;

  /** The search handler Lambda function. */
  public readonly searchHandlerFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: SearchStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // Glue Data Catalog Database (Requirement 3.1)
    // -----------------------------------------------------------------------

    const databaseName = 'email_archive';
    const tableName = 'email_metadata';

    const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: databaseName,
        description: 'Email Archive metadata catalog for Athena-based search',
      },
    });

    // -----------------------------------------------------------------------
    // Glue Data Catalog Table (Requirement 3.1)
    // Uses JSON SerDe for initial simplicity — the Lambda processor writes
    // plain JSON metadata files. Can be switched to Parquet later as an
    // optimization. Partitioned by year/month/day for efficient date-range
    // queries.
    // -----------------------------------------------------------------------

    const storageLocation = `s3://${props.metadataBucket.bucketName}/metadata/`;

    const glueTable = new glue.CfnTable(this, 'GlueTable', {
      catalogId: this.account,
      databaseName: databaseName,
      tableInput: {
        name: tableName,
        description: 'Email metadata records partitioned by date for Athena search',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'classification': 'json',
        },
        storageDescriptor: {
          location: storageLocation,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            parameters: {
              'serialization.format': '1',
            },
          },
          columns: [
            { name: 'emailId', type: 'string', comment: 'UUID v4 unique email identifier' },
            { name: 'messageId', type: 'string', comment: 'RFC 5322 Message-ID' },
            { name: 'sender', type: 'string', comment: 'Envelope sender address' },
            { name: 'recipients', type: 'array<string>', comment: 'Envelope recipients' },
            { name: 'ccRecipients', type: 'array<string>', comment: 'CC recipients' },
            { name: 'bccRecipients', type: 'array<string>', comment: 'BCC recipients' },
            { name: 'subject', type: 'string', comment: 'Email subject line' },
            { name: 'date', type: 'string', comment: 'Original email date (ISO 8601)' },
            { name: 'archivedAt', type: 'string', comment: 'Archive timestamp (ISO 8601)' },
            { name: 'hasAttachments', type: 'boolean', comment: 'Whether email has attachments' },
            { name: 'attachmentCount', type: 'int', comment: 'Number of attachments' },
            { name: 'totalSizeBytes', type: 'bigint', comment: 'Total email size in bytes' },
          ],
        },
        partitionKeys: [
          { name: 'year', type: 'string', comment: 'Partition key: year (YYYY)' },
          { name: 'month', type: 'string', comment: 'Partition key: month (MM)' },
          { name: 'day', type: 'string', comment: 'Partition key: day (DD)' },
        ],
      },
    });

    // Ensure table is created after database
    glueTable.addDependency(glueDatabase);

    // Expose names as public properties
    this.glueDatabaseName = databaseName;
    this.glueTableName = tableName;

    // -----------------------------------------------------------------------
    // Athena Workgroup (Requirements 3.2, 3.3)
    // Workgroup: email-archive-search
    // - Result output to Athena results bucket
    // - Bytes-scanned limit: 10 GB (prevents runaway queries)
    // - Enforce workgroup settings (override client-side settings)
    // - Result encryption: SSE_KMS with shared encryption key
    // - Publish CloudWatch metrics enabled
    // -----------------------------------------------------------------------

    const athenaWorkgroupName = 'email-archive-search';

    const athenaWorkgroup = new athena.CfnWorkGroup(this, 'AthenaWorkGroup', {
      name: athenaWorkgroupName,
      description: 'Email Archive search workgroup with query limits and encryption',
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: ATHENA_BYTES_SCAN_LIMIT,
        resultConfiguration: {
          outputLocation: `s3://${props.athenaResultsBucket.bucketName}/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_KMS',
            kmsKey: props.encryptionKey.keyArn,
          },
        },
      },
    });

    this.workgroupName = athenaWorkgroupName;

    // -----------------------------------------------------------------------
    // Search Handler Lambda (Requirements 3.2, 3.3, 3.4, 3.7, 3.8, 3.9)
    // Accepts SearchQuery, builds parameterized Athena SQL, polls for results,
    // and returns paginated SearchResult.
    // -----------------------------------------------------------------------

    this.searchHandlerFn = new lambdaNodejs.NodejsFunction(this, 'SearchHandlerFn', {
      functionName: `email-archive-search-handler`,
      entry: path.join(__dirname, '..', 'lambda', 'search-handler', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(35),
      environment: {
        ATHENA_WORKGROUP: athenaWorkgroupName,
        GLUE_DATABASE: databaseName,
        GLUE_TABLE: tableName,
        ATHENA_RESULTS_BUCKET: props.athenaResultsBucket.bucketName,
      },
      bundling: {
        forceDockerBundling: false,
        externalModules: [],
      },
    });

    // Grant Lambda read/write on Athena results bucket
    props.athenaResultsBucket.grantReadWrite(this.searchHandlerFn);

    // Grant Lambda read access on metadata bucket (Athena reads from here)
    props.metadataBucket.grantRead(this.searchHandlerFn);

    // Grant Lambda permissions to use Athena
    this.searchHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'athena:StopQueryExecution',
      ],
      resources: [
        `arn:aws:athena:${this.region}:${this.account}:workgroup/${athenaWorkgroupName}`,
      ],
    }));

    // Grant Lambda permissions to read Glue Data Catalog
    this.searchHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:GetTable',
        'glue:GetPartitions',
        'glue:GetDatabase',
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/${databaseName}`,
        `arn:aws:glue:${this.region}:${this.account}:table/${databaseName}/${tableName}`,
      ],
    }));

    // Grant Lambda permissions to use the encryption key
    props.encryptionKey.grantEncryptDecrypt(this.searchHandlerFn);

    // -----------------------------------------------------------------------
    // CfnOutputs
    // -----------------------------------------------------------------------

    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: databaseName,
      description: 'Name of the Glue Data Catalog database',
      exportName: 'EmailArchive-GlueDatabaseName',
    });

    new cdk.CfnOutput(this, 'GlueTableName', {
      value: tableName,
      description: 'Name of the Glue Data Catalog table',
      exportName: 'EmailArchive-GlueTableName',
    });

    new cdk.CfnOutput(this, 'AthenaWorkGroupName', {
      value: athenaWorkgroupName,
      description: 'Name of the Athena workgroup for email search queries',
      exportName: 'EmailArchive-AthenaWorkGroupName',
    });
  }
}
