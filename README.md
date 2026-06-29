# Email Archive Solution

AWS CDK application for archiving, searching, and managing email from Microsoft 365 Exchange Online.

## Architecture

Multi-stack CDK deployment with the following stacks:

- **StorageStack** — S3 buckets (raw, parsed, metadata, exports, Athena results) and DynamoDB tables
- **AuthStack** — Cognito User Pool with Administrator/Analyst roles
- **IngestionStack** — SES inbound email, SQS queues, and email processor Lambda
- **SearchStack** — Glue Data Catalog, Athena workgroup, and search handler Lambda
- **ExportStack** — Step Functions export workflow and builder Lambda
- **ApiStack** — API Gateway REST API with Lambda handlers
- **WebStack** — React SPA hosting via S3 + CloudFront
- **MonitoringStack** — CloudWatch alarms, dashboard, and SNS alerting

## Prerequisites

- Node.js >= 20.x
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS IAM Identity Center (SSO) configured for account `123456789012`

## Deployment

```bash
# Install dependencies
npm install

# Authenticate via SSO
aws sso login --profile email-archive

# Deploy all stacks
npx cdk deploy --all --profile email-archive
```

## Development

```bash
# Build
npm run build

# Run tests
npm test

# Synthesize CloudFormation templates
npx cdk synth

# Compare deployed stack with current state
npx cdk diff --all --profile email-archive
```

## Configuration

Environment-specific values are configured in `cdk.json` context:

- `accountId` — Target AWS account ID
- `region` — Target AWS region
- `domain` — Domain for SES inbound email (e.g., `archive.example.com`)
