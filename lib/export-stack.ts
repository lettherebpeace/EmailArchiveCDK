import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import * as path from 'path';

import { MAX_EXPORT_FILES } from './constants';

export interface ExportStackProps extends cdk.StackProps {
  readonly accountId: string;
  readonly rawBucket: s3.IBucket;
  readonly exportsBucket: s3.IBucket;
  readonly metadataBucket: s3.IBucket;
  readonly exportJobsTable: dynamodb.ITable;
  readonly emailMetadataTable: dynamodb.ITable;
  readonly encryptionKey: kms.IKey;
  readonly athenaWorkgroup: string;
  readonly glueDatabaseName: string;
  readonly glueTableName: string;
  readonly athenaResultsBucket: s3.IBucket;
}

export class ExportStack extends cdk.Stack {
  /** The Step Functions state machine for the export workflow. */
  public readonly exportStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ExportStackProps) {
    super(scope, id, props);

    const {
      accountId,
      rawBucket,
      exportsBucket,
      exportJobsTable,
      encryptionKey,
      athenaWorkgroup,
      glueDatabaseName,
      glueTableName,
      athenaResultsBucket,
    } = props;

    // -------------------------------------------------------------------
    // Lambda: ValidateRequest
    // Validates the export request payload (exportId, userId, searchQuery)
    // -------------------------------------------------------------------

    const validateFn = new lambdaNodejs.NodejsFunction(this, 'ExportValidateFn', {
      functionName: `email-archive-export-validate-${accountId}`,
      entry: path.join(__dirname, '..', 'lambda', 'export-validate', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_YEAR,
      bundling: {
        forceDockerBundling: false,
        externalModules: [],
      },
    });

    // -------------------------------------------------------------------
    // Lambda: QueryMatchingEmails
    // Runs an Athena query to find email IDs matching search criteria
    // -------------------------------------------------------------------

    const queryFn = new lambdaNodejs.NodejsFunction(this, 'ExportQueryFn', {
      functionName: `email-archive-export-query-${accountId}`,
      entry: path.join(__dirname, '..', 'lambda', 'export-query', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        GLUE_DATABASE_NAME: glueDatabaseName,
        GLUE_TABLE_NAME: glueTableName,
        ATHENA_WORKGROUP: athenaWorkgroup,
      },
      logRetention: logs.RetentionDays.ONE_YEAR,
      bundling: {
        forceDockerBundling: false,
        externalModules: ['@aws-sdk/client-athena'],
      },
    });

    // Grant Athena query permissions
    queryFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:StopQueryExecution',
        ],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:workgroup/${athenaWorkgroup}`,
        ],
      })
    );

    // Grant Glue catalog read access
    queryFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:GetDatabase',
          'glue:GetTable',
          'glue:GetPartitions',
          'glue:GetPartition',
        ],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/${glueDatabaseName}`,
          `arn:aws:glue:${this.region}:${this.account}:table/${glueDatabaseName}/${glueTableName}`,
        ],
      })
    );

    // Grant access to S3 metadata bucket (Athena reads from here) and results bucket
    props.metadataBucket.grantRead(queryFn);
    athenaResultsBucket.grantReadWrite(queryFn);
    encryptionKey.grantEncryptDecrypt(queryFn);

    // -------------------------------------------------------------------
    // Lambda: BuildZip + GeneratePresignedUrl
    // Reads .eml files from raw bucket, packages into ZIP, generates URL
    // -------------------------------------------------------------------

    const buildZipFn = new lambdaNodejs.NodejsFunction(this, 'ExportBuildZipFn', {
      functionName: `email-archive-export-build-${accountId}`,
      entry: path.join(__dirname, '..', 'lambda', 'export-builder', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        EXPORT_JOBS_TABLE: exportJobsTable.tableName,
        EMAIL_TABLE: 'EmailMetadata',
      },
      logRetention: logs.RetentionDays.ONE_YEAR,
      bundling: {
        forceDockerBundling: false,
        externalModules: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', '@aws-sdk/client-dynamodb'],
      },
    });

    // Grant S3 permissions
    rawBucket.grantRead(buildZipFn);
    exportsBucket.grantReadWrite(buildZipFn);
    encryptionKey.grantEncryptDecrypt(buildZipFn);

    // Grant DynamoDB permissions for updating export job status
    exportJobsTable.grantReadWriteData(buildZipFn);

    // Grant read access to EmailMetadata table for looking up S3 keys
    props.emailMetadataTable.grantReadData(buildZipFn);

    // -------------------------------------------------------------------
    // Step Functions State Machine: Export Workflow
    // Flow: ValidateRequest → QueryMatchingEmails → CheckSize →
    //       BuildZip (+ GeneratePresignedUrl) | RejectTooLarge
    // -------------------------------------------------------------------

    // Step 1: ValidateRequest — Lambda task
    const validateRequestTask = new tasks.LambdaInvoke(this, 'ValidateRequest', {
      lambdaFunction: validateFn,
      outputPath: '$.Payload',
      comment: 'Validate the export request payload',
    });

    // Step 2: QueryMatchingEmails — Lambda task
    const queryMatchingEmailsTask = new tasks.LambdaInvoke(this, 'QueryMatchingEmails', {
      lambdaFunction: queryFn,
      outputPath: '$.Payload',
      comment: 'Run Athena query to find matching email IDs',
    });

    // Step 4a: BuildZip (includes GeneratePresignedUrl) — Lambda task
    const buildZipTask = new tasks.LambdaInvoke(this, 'BuildZip', {
      lambdaFunction: buildZipFn,
      outputPath: '$.Payload',
      comment: 'Package .eml files into ZIP and generate presigned URL',
    });

    // Step 4b: RejectTooLarge — Fail state
    const rejectTooLargeState = new sfn.Fail(this, 'RejectTooLarge', {
      error: 'ExportTooLarge',
      cause: `Export request exceeds the maximum file count of ${MAX_EXPORT_FILES}. Please refine your search criteria to reduce the number of matching emails.`,
    });

    // Step 5: NotifyUser — Succeed state (output contains presigned URL)
    const notifyUserState = new sfn.Succeed(this, 'NotifyUser', {
      comment: 'Export completed successfully. Presigned URL available in output.',
    });

    // Step 3: CheckSize — Choice state
    const checkSizeChoice = new sfn.Choice(this, 'CheckSize', {
      comment: 'Check if file count is within the allowed limit',
    });

    checkSizeChoice
      .when(
        sfn.Condition.numberGreaterThan('$.fileCount', MAX_EXPORT_FILES),
        rejectTooLargeState
      )
      .otherwise(buildZipTask);

    // Wire the build zip task to the success state
    buildZipTask.next(notifyUserState);

    // Chain the workflow
    const definition = validateRequestTask
      .next(queryMatchingEmailsTask)
      .next(checkSizeChoice);

    // Create the state machine (Standard type — exports may take >5 minutes)
    this.exportStateMachine = new sfn.StateMachine(this, 'ExportStateMachine', {
      stateMachineName: `EmailArchiveExportWorkflow-${accountId}`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(30),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'ExportStateMachineLogGroup', {
          logGroupName: `/aws/stepfunctions/EmailArchiveExport-${accountId}`,
          retention: logs.RetentionDays.ONE_YEAR,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // -------------------------------------------------------------------
    // CfnOutputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'ExportStateMachineArn', {
      value: this.exportStateMachine.stateMachineArn,
      description: 'ARN of the export workflow Step Functions state machine',
      exportName: 'EmailArchive-ExportStateMachineArn',
    });
  }
}
