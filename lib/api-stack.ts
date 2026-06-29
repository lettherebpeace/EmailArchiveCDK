import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ApiStackProps extends cdk.StackProps {
  readonly accountId: string;
  readonly userPool?: cognito.IUserPool;
  readonly emailMetadataTable?: dynamodb.ITable;
  readonly exportJobsTable?: dynamodb.ITable;
  readonly parsedBucket?: s3.IBucket;
  readonly rawBucket?: s3.IBucket;
  readonly encryptionKey?: kms.IKey;
  readonly searchHandlerFn?: lambda.IFunction;
  readonly exportStateMachine?: sfn.IStateMachine;
}

export class ApiStack extends cdk.Stack {
  /** The API Gateway REST API. */
  public readonly api: apigateway.RestApi;

  /** The API handler Lambda function. */
  public readonly apiHandlerFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const {
      accountId,
      userPool,
      emailMetadataTable,
      exportJobsTable,
      parsedBucket,
      rawBucket,
      encryptionKey,
      searchHandlerFn,
      exportStateMachine,
    } = props;

    // -------------------------------------------------------------------
    // API Handler Lambda Function
    // Single Lambda that routes based on HTTP method + path
    // Requirements: 3.2, 3.5, 3.6, 5.7
    // -------------------------------------------------------------------

    this.apiHandlerFn = new lambdaNodejs.NodejsFunction(this, 'ApiHandlerFn', {
      functionName: `email-archive-api-handler-${accountId}`,
      entry: path.join(__dirname, '..', 'lambda', 'api-handler', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        EMAIL_TABLE: emailMetadataTable?.tableName || 'EmailMetadata',
        PARSED_BUCKET: parsedBucket?.bucketName || '',
        RAW_BUCKET: rawBucket?.bucketName || '',
        EXPORT_JOBS_TABLE: exportJobsTable?.tableName || 'ExportJobs',
        EXPORT_STATE_MACHINE_ARN: exportStateMachine?.stateMachineArn || '',
        SEARCH_FUNCTION_NAME: searchHandlerFn?.functionName || '',
        RETENTION_POLICIES_TABLE: 'RetentionPolicies',
      },
      logRetention: logs.RetentionDays.ONE_YEAR,
      bundling: {
        forceDockerBundling: false,
        externalModules: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/client-s3',
          '@aws-sdk/s3-request-presigner',
          '@aws-sdk/client-lambda',
          '@aws-sdk/client-sfn',
        ],
      },
    });

    // -------------------------------------------------------------------
    // IAM Permissions for API Handler Lambda
    // -------------------------------------------------------------------

    // DynamoDB: read EmailMetadata table
    if (emailMetadataTable) {
      emailMetadataTable.grantReadData(this.apiHandlerFn);
    }

    // DynamoDB: read/write ExportJobs table (create + read export jobs)
    if (exportJobsTable) {
      exportJobsTable.grantReadWriteData(this.apiHandlerFn);
    }

    // S3: read from parsed bucket (email bodies + attachments)
    if (parsedBucket) {
      parsedBucket.grantRead(this.apiHandlerFn);
    }

    // S3: read from raw bucket (for presigned URLs if needed)
    if (rawBucket) {
      rawBucket.grantRead(this.apiHandlerFn);
    }

    // KMS: decrypt for S3 and DynamoDB operations
    if (encryptionKey) {
      encryptionKey.grantDecrypt(this.apiHandlerFn);
    }

    // Lambda: invoke search handler function
    if (searchHandlerFn) {
      searchHandlerFn.grantInvoke(this.apiHandlerFn);
    }

    // Step Functions: start execution for export workflow
    if (exportStateMachine) {
      exportStateMachine.grantStartExecution(this.apiHandlerFn);
    }

    // -------------------------------------------------------------------
    // API Gateway REST API with Cognito Authorizer
    // Requirements: 5.3, 5.5, 5.6
    // -------------------------------------------------------------------

    this.api = new apigateway.RestApi(this, 'EmailArchiveApi', {
      restApiName: `email-archive-api-${accountId}`,
      description: 'Email Archive REST API',
      deployOptions: {
        stageName: 'v1',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Cognito Authorizer
    let authorizer: apigateway.CognitoUserPoolsAuthorizer | undefined;
    if (userPool) {
      authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
        cognitoUserPools: [userPool],
        authorizerName: 'EmailArchiveCognitoAuth',
        identitySource: 'method.request.header.Authorization',
      });
    }

    // Lambda integration (proxy)
    const lambdaIntegration = new apigateway.LambdaIntegration(this.apiHandlerFn, {
      proxy: true,
    });

    const authorizationConfig = authorizer ? {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    } : {};

    // --- Resource definitions ---

    // GET /health (no auth required)
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', lambdaIntegration);

    // POST /search (auth required)
    const searchResource = this.api.root.addResource('search');
    searchResource.addMethod('POST', lambdaIntegration, authorizationConfig);

    // /emails/{emailId}
    const emailsResource = this.api.root.addResource('emails');
    const emailIdResource = emailsResource.addResource('{emailId}');
    emailIdResource.addMethod('GET', lambdaIntegration, authorizationConfig);

    // /emails/{emailId}/attachments/{attachmentId}
    const attachmentsResource = emailIdResource.addResource('attachments');
    const attachmentIdResource = attachmentsResource.addResource('{attachmentId}');
    attachmentIdResource.addMethod('GET', lambdaIntegration, authorizationConfig);

    // /exports
    const exportsResource = this.api.root.addResource('exports');
    exportsResource.addMethod('POST', lambdaIntegration, authorizationConfig);

    // /exports/{exportId}
    const exportIdResource = exportsResource.addResource('{exportId}');
    exportIdResource.addMethod('GET', lambdaIntegration, authorizationConfig);

    // /auth/logout (auth required)
    const authResource = this.api.root.addResource('auth');
    const logoutResource = authResource.addResource('logout');
    logoutResource.addMethod('POST', lambdaIntegration, authorizationConfig);

    // /retention-policies (auth required, admin-only enforced in Lambda)
    const retentionPoliciesResource = this.api.root.addResource('retention-policies');
    retentionPoliciesResource.addMethod('GET', lambdaIntegration, authorizationConfig);
    retentionPoliciesResource.addMethod('POST', lambdaIntegration, authorizationConfig);

    // /retention-policies/{id}
    const retentionPolicyIdResource = retentionPoliciesResource.addResource('{id}');
    retentionPolicyIdResource.addMethod('PUT', lambdaIntegration, authorizationConfig);

    // -------------------------------------------------------------------
    // CfnOutputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.api.url,
      description: 'Email Archive API Gateway endpoint URL',
      exportName: 'EmailArchive-ApiEndpoint',
    });

    new cdk.CfnOutput(this, 'ApiHandlerFnArn', {
      value: this.apiHandlerFn.functionArn,
      description: 'ARN of the API handler Lambda function',
      exportName: 'EmailArchive-ApiHandlerFnArn',
    });
  }
}
