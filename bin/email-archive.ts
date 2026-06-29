#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';
import { IngestionStack } from '../lib/ingestion-stack';
import { SearchStack } from '../lib/search-stack';
import { ExportStack } from '../lib/export-stack';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { WebStack } from '../lib/web-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();

const accountId = app.node.tryGetContext('accountId') || process.env.CDK_DEFAULT_ACCOUNT || 'REPLACE_WITH_YOUR_ACCOUNT_ID';
const region = app.node.tryGetContext('region') || 'us-east-1';
const domain = app.node.tryGetContext('domain') || 'archive.vijay.email';

const env: cdk.Environment = {
  account: accountId,
  region: region,
};

// Foundation stacks
const storageStack = new StorageStack(app, 'EmailArchive-StorageStack', {
  env,
  accountId,
  description: 'Email Archive - S3 buckets and DynamoDB tables',
});

const authStack = new AuthStack(app, 'EmailArchive-AuthStack', {
  env,
  accountId,
  description: 'Email Archive - Cognito User Pool and authorization',
});

// DNS is managed externally (GoDaddy) — no Route53 hosted zone needed.
// MX record will be created manually in GoDaddy pointing to SES inbound endpoint.

// Service stacks
const ingestionStack = new IngestionStack(app, 'EmailArchive-IngestionStack', {
  env,
  accountId,
  domain,
  rawBucket: storageStack.rawBucket,
  parsedBucket: storageStack.parsedBucket,
  metadataBucket: storageStack.metadataBucket,
  emailMetadataTable: storageStack.emailMetadataTable,
  encryptionKey: storageStack.encryptionKey,
  glueDatabaseName: 'email_archive',
  glueTableName: 'email_metadata',
  description: 'Email Archive - SES inbound email and processing pipeline',
});

const searchStack = new SearchStack(app, 'EmailArchive-SearchStack', {
  env,
  accountId,
  metadataBucket: storageStack.metadataBucket,
  athenaResultsBucket: storageStack.athenaResultsBucket,
  encryptionKey: storageStack.encryptionKey,
  description: 'Email Archive - Glue catalog, Athena workgroup, and search handler',
});

const exportStack = new ExportStack(app, 'EmailArchive-ExportStack', {
  env,
  accountId,
  rawBucket: storageStack.rawBucket,
  exportsBucket: storageStack.exportsBucket,
  metadataBucket: storageStack.metadataBucket,
  exportJobsTable: storageStack.exportJobsTable,
  emailMetadataTable: storageStack.emailMetadataTable,
  encryptionKey: storageStack.encryptionKey,
  athenaWorkgroup: searchStack.workgroupName,
  glueDatabaseName: searchStack.glueDatabaseName,
  glueTableName: searchStack.glueTableName,
  athenaResultsBucket: storageStack.athenaResultsBucket,
  description: 'Email Archive - Step Functions export workflow',
});

const apiStack = new ApiStack(app, 'EmailArchive-ApiStack', {
  env,
  accountId,
  userPool: authStack.userPool,
  emailMetadataTable: storageStack.emailMetadataTable,
  exportJobsTable: storageStack.exportJobsTable,
  parsedBucket: storageStack.parsedBucket,
  rawBucket: storageStack.rawBucket,
  encryptionKey: storageStack.encryptionKey,
  searchHandlerFn: searchStack.searchHandlerFn,
  exportStateMachine: exportStack.exportStateMachine,
  description: 'Email Archive - API Gateway REST API and Lambda handlers',
});

const webStack = new WebStack(app, 'EmailArchive-WebStack', {
  env,
  accountId,
  apiUrl: apiStack.api.url,
  userPoolId: authStack.userPool.userPoolId,
  userPoolClientId: authStack.userPoolClient.userPoolClientId,
  description: 'Email Archive - React SPA hosting (S3 + CloudFront)',
});

const monitoringStack = new MonitoringStack(app, 'EmailArchive-MonitoringStack', {
  env,
  accountId,
  ingestQueueName: ingestionStack.ingestQueue.queueName,
  deadLetterQueueName: ingestionStack.deadLetterQueue.queueName,
  emailProcessorFnName: ingestionStack.emailProcessorFn.functionName,
  searchHandlerFnName: searchStack.searchHandlerFn.functionName,
  description: 'Email Archive - CloudWatch alarms, dashboard, and SNS alerting',
});

// Stack dependencies (deployment order)
ingestionStack.addDependency(storageStack);
searchStack.addDependency(storageStack);
exportStack.addDependency(storageStack);
exportStack.addDependency(searchStack);
apiStack.addDependency(authStack);
apiStack.addDependency(storageStack);
apiStack.addDependency(searchStack);
apiStack.addDependency(exportStack);
webStack.addDependency(apiStack);
webStack.addDependency(authStack);
monitoringStack.addDependency(ingestionStack);
monitoringStack.addDependency(searchStack);

app.synth();
