import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { IngestionStack } from '../lib/ingestion-stack';
import { SearchStack } from '../lib/search-stack';
import { ExportStack } from '../lib/export-stack';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { WebStack } from '../lib/web-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const testEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

describe('Email Archive CDK Stacks', () => {
  test('StorageStack synthesizes without errors', () => {
    const app = new cdk.App();
    const stack = new StorageStack(app, 'TestStorageStack', {
      env: testEnv,
      accountId: '123456789012',
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });

  test('AuthStack synthesizes without errors', () => {
    const app = new cdk.App();
    const stack = new AuthStack(app, 'TestAuthStack', {
      env: testEnv,
      accountId: '123456789012',
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });

  test('IngestionStack synthesizes without errors', () => {
    const app = new cdk.App();
    const storageStack = new StorageStack(app, 'TestStorageStackForIngestion', {
      env: testEnv,
      accountId: '123456789012',
    });
    const route53 = require('aws-cdk-lib/aws-route53');
    const dnsStack = new cdk.Stack(app, 'TestDnsStack', { env: testEnv });
    const hostedZone = new route53.HostedZone(dnsStack, 'TestZone', {
      zoneName: 'archive.example.com',
    });
    const stack = new IngestionStack(app, 'TestIngestionStack', {
      env: testEnv,
      accountId: '123456789012',
      domain: 'archive.example.com',
      rawBucket: storageStack.rawBucket,
      parsedBucket: storageStack.parsedBucket,
      metadataBucket: storageStack.metadataBucket,
      emailMetadataTable: storageStack.emailMetadataTable,
      encryptionKey: storageStack.encryptionKey,
      hostedZone,
      glueDatabaseName: 'email_archive',
      glueTableName: 'email_metadata',
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });

  test('SearchStack synthesizes without errors', () => {
    const app = new cdk.App();
    const storageStack = new StorageStack(app, 'TestStorageStackForSearch', {
      env: testEnv,
      accountId: '123456789012',
    });
    const stack = new SearchStack(app, 'TestSearchStack', {
      env: testEnv,
      accountId: '123456789012',
      metadataBucket: storageStack.metadataBucket,
      athenaResultsBucket: storageStack.athenaResultsBucket,
      encryptionKey: storageStack.encryptionKey,
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });

  test('ExportStack synthesizes without errors', () => {
    const app = new cdk.App();
    const storageStack = new StorageStack(app, 'TestStorageStackForExport', {
      env: testEnv,
      accountId: '123456789012',
    });
    const searchStack = new SearchStack(app, 'TestSearchStackForExport', {
      env: testEnv,
      accountId: '123456789012',
      metadataBucket: storageStack.metadataBucket,
      athenaResultsBucket: storageStack.athenaResultsBucket,
      encryptionKey: storageStack.encryptionKey,
    });
    const stack = new ExportStack(app, 'TestExportStack', {
      env: testEnv,
      accountId: '123456789012',
      rawBucket: storageStack.rawBucket,
      exportsBucket: storageStack.exportsBucket,
      exportJobsTable: storageStack.exportJobsTable,
      metadataBucket: storageStack.metadataBucket,
      emailMetadataTable: storageStack.emailMetadataTable,
      encryptionKey: storageStack.encryptionKey,
      athenaWorkgroup: searchStack.workgroupName,
      glueDatabaseName: searchStack.glueDatabaseName,
      glueTableName: searchStack.glueTableName,
      athenaResultsBucket: storageStack.athenaResultsBucket,
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });

  test('ApiStack synthesizes without errors', () => {
    const app = new cdk.App();
    const authStack = new AuthStack(app, 'TestAuthStackForApi', {
      env: testEnv,
      accountId: '123456789012',
    });
    const storageStack = new StorageStack(app, 'TestStorageStackForApi', {
      env: testEnv,
      accountId: '123456789012',
    });
    const searchStack = new SearchStack(app, 'TestSearchStackForApi', {
      env: testEnv,
      accountId: '123456789012',
      metadataBucket: storageStack.metadataBucket,
      athenaResultsBucket: storageStack.athenaResultsBucket,
      encryptionKey: storageStack.encryptionKey,
    });
    const exportStack = new ExportStack(app, 'TestExportStackForApi', {
      env: testEnv,
      accountId: '123456789012',
      rawBucket: storageStack.rawBucket,
      exportsBucket: storageStack.exportsBucket,
      exportJobsTable: storageStack.exportJobsTable,
      metadataBucket: storageStack.metadataBucket,
      emailMetadataTable: storageStack.emailMetadataTable,
      encryptionKey: storageStack.encryptionKey,
      athenaWorkgroup: searchStack.workgroupName,
      glueDatabaseName: searchStack.glueDatabaseName,
      glueTableName: searchStack.glueTableName,
      athenaResultsBucket: storageStack.athenaResultsBucket,
    });
    const stack = new ApiStack(app, 'TestApiStack', {
      env: testEnv,
      accountId: '123456789012',
      userPool: authStack.userPool,
      exportJobsTable: storageStack.exportJobsTable,
      parsedBucket: storageStack.parsedBucket,
      rawBucket: storageStack.rawBucket,
      encryptionKey: storageStack.encryptionKey,
      searchHandlerFn: searchStack.searchHandlerFn,
      exportStateMachine: exportStack.exportStateMachine,
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });

  test('WebStack synthesizes without errors', () => {
    const app = new cdk.App();
    const stack = new WebStack(app, 'TestWebStack', {
      env: testEnv,
      accountId: '123456789012',
      apiUrl: 'https://api.example.com',
      userPoolId: 'us-east-1_TestPool',
      userPoolClientId: 'test-client-id',
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });

  test('MonitoringStack synthesizes without errors', () => {
    const app = new cdk.App();
    const stack = new MonitoringStack(app, 'TestMonitoringStack', {
      env: testEnv,
      accountId: '123456789012',
    });
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toBeDefined();
  });
});
