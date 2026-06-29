# Requirements Document

## Introduction

This document defines the requirements for an Email Archive Solution designed to handle edge cases where Microsoft 365 Exchange Online mailboxes exceed the 1.5 TB Online Archive limit, and for organizations that require emails to be journaled to a centralized location for compliance analysis and search. The solution is hosted on AWS, deployed via AWS CDK, version-controlled in GitHub, and designed for easy deployment to any AWS account.

## Glossary

- **Email_Archive_System**: The AWS-hosted solution that ingests, stores, and provides metadata-based search capabilities for archived email from M365 Exchange Online.
- **Journal_Rule**: An Exchange Online configuration that sends a copy of all inbound and outbound emails to a designated journal mailbox or external SMTP endpoint.
- **Archive_Ingestion_Service**: The component responsible for receiving emails from M365 (via journaling or mailbox export) and storing them in the archive.
- **Archive_Store**: The AWS-based durable storage layer (e.g., S3) where archived email data is persisted.
- **Query_Service**: The component that provides metadata-based search capabilities for archived emails using AWS Glue Catalog and Amazon Athena.
- **Glue_Catalog**: The AWS Glue Data Catalog that maintains a metadata schema over archived emails stored in S3, enabling SQL-based querying via Athena.
- **Athena**: Amazon Athena, a serverless query engine that executes SQL queries against email metadata registered in the Glue Catalog.
- **Deployment_Stack**: The AWS CDK application that provisions all infrastructure resources for the Email Archive System.
- **Tenant**: An organization deploying and using the Email Archive Solution in their own AWS account.
- **Retention_Policy**: A configurable rule that determines how long archived emails are retained before eligible for deletion.

## Requirements

### Requirement 1: Email Ingestion from M365

**User Story:** As an IT administrator, I want the system to ingest emails from M365 Exchange Online via journaling, so that all organizational emails are captured in the archive regardless of mailbox size limits.

#### Acceptance Criteria

1. WHEN a journal rule is configured in Exchange Online to route emails to the Archive Ingestion Service, THE Archive_Ingestion_Service SHALL accept incoming journal emails over SMTP for emails up to 40 MB in total size including attachments.
2. WHEN an email is received by the Archive Ingestion Service, THE Archive_Ingestion_Service SHALL extract the original email message, metadata (sender, recipients, date, subject, message ID), and all attachments up to a maximum of 500 attachments per email.
3. WHEN an email is successfully ingested, THE Archive_Ingestion_Service SHALL store the email in the Archive Store such that the original message body, all metadata fields, and all attachments are retrievable with content identical to the source.
4. IF the Archive Ingestion Service fails to process an incoming email, THEN THE Archive_Ingestion_Service SHALL queue the email for retry up to a maximum of 5 attempts with exponential backoff starting at 30 seconds, and SHALL generate an alert notification to the configured administrator notification channel.
5. IF all retry attempts for a queued email are exhausted, THEN THE Archive_Ingestion_Service SHALL move the email to a dead-letter queue and SHALL generate a critical alert notification to the configured administrator notification channel indicating the message ID and failure reason.
6. THE Archive_Ingestion_Service SHALL process emails without imposing a maximum mailbox size constraint on the source mailbox.
7. IF an incoming email exceeds 40 MB in total size, THEN THE Archive_Ingestion_Service SHALL reject the email with an error indication specifying the size limit exceeded and SHALL generate an alert notification to the configured administrator notification channel.

### Requirement 2: Durable and Scalable Storage

**User Story:** As an IT administrator, I want archived emails stored durably and at scale, so that the organization can retain email data beyond M365 limits without data loss.

#### Acceptance Criteria

1. THE Archive_Store SHALL persist all ingested emails with a durability of at least 99.999999999% (11 nines).
2. THE Archive_Store SHALL support storage capacity of at least 1.5 TB per tenant while maintaining write latency below 500 ms per email and read latency below 300 ms per email at the 95th percentile.
3. WHEN an email is stored, THE Archive_Store SHALL assign a unique identifier and maintain an immutable copy of the original email content including all headers, body, and attachments.
4. WHILE a Retention Policy is active, THE Archive_Store SHALL retain all emails matching the policy criteria until the retention period expires.
5. WHEN a retention period expires for an email, THE Archive_Store SHALL mark the email as eligible for deletion according to the configured Retention Policy.
6. IF a write operation fails to persist an email, THEN THE Archive_Store SHALL retry the operation up to 3 times and, if all retries fail, SHALL report a storage failure error to the ingestion layer and preserve the email in an ingest queue for later retry.
7. IF the Archive_Store reaches 90% of its provisioned storage capacity for a tenant, THEN THE Archive_Store SHALL emit a capacity warning notification to the IT administrator and continue accepting new emails until 100% capacity is reached, at which point it SHALL reject new writes with an error indicating storage capacity exhausted.

### Requirement 3: Search and Analysis

**User Story:** As a compliance officer, I want to search archived emails by metadata criteria and export matching results, so that I can perform investigations, audits, and legal discovery efficiently.

#### Acceptance Criteria

1. THE Query_Service SHALL maintain a metadata catalog in the Glue_Catalog containing sender, recipients, date, and subject for all ingested emails.
2. WHEN a user submits a search query via the web interface, THE Query_Service SHALL accept inputs for recipient, sender (from), subject, and date range, and SHALL execute the query against email metadata using Athena.
3. THE Query_Service SHALL support filtering by date range, sender, recipient, and subject keywords, and SHALL support combining multiple filters using AND logic.
4. WHEN search results are returned, THE Query_Service SHALL display results sorted by date descending by default, paginated in groups of 25 results per page, with each result showing sender, recipient, date, and subject.
5. WHEN a user selects an email from search results, THE Query_Service SHALL display the full email content including all attachments available for download.
6. WHEN a user requests an export of search results, THE Query_Service SHALL provide a downloadable archive containing the original .eml files for all emails matching the query, packaged as a ZIP file.
7. IF a search query returns no matching results, THEN THE Query_Service SHALL display a message indicating no results were found and suggest modifying the search criteria.
8. IF the Query_Service fails to execute a query due to a system error, THEN THE Query_Service SHALL display an error message indicating the search could not be completed and SHALL preserve the user's original query input so the user can retry without re-entering criteria.
9. IF a user submits a search query that contains no filter criteria (all of recipient, sender, subject, and date range are empty), THEN THE Query_Service SHALL reject the query and display a message indicating that at least one filter must be provided.

### Requirement 4: Infrastructure as Code Deployment

**User Story:** As a DevOps engineer, I want the entire solution deployed via AWS CDK and version-controlled in GitHub, so that the solution can be reliably deployed to any AWS account with minimal effort.

#### Acceptance Criteria

1. THE Deployment_Stack SHALL define all AWS resources required by the Email Archive System using AWS CDK in TypeScript.
2. THE Deployment_Stack SHALL be deployable to any AWS account and region with only configuration parameters (account ID, region, domain) as input.
3. WHEN a deployment is initiated, THE Deployment_Stack SHALL provision all resources in a single CDK deploy command completing within 30 minutes for a fresh deployment.
4. THE Deployment_Stack SHALL be stored in a GitHub repository with infrastructure code, application code, and documentation including a README with deployment instructions.
5. IF a deployment fails, THEN THE Deployment_Stack SHALL roll back all partially created resources to avoid orphaned infrastructure, leveraging CloudFormation rollback behavior.
6. THE Deployment_Stack SHALL support updates and redeployments without data loss in the Archive Store by using stateful resource retention policies.
7. THE Deployment_Stack SHALL include a CDK context configuration file that parameterizes environment-specific values without requiring code changes.

### Requirement 5: Security and Access Control

**User Story:** As a security administrator, I want the archive system to be secure and access-controlled, so that only authorized personnel can access archived email data.

#### Acceptance Criteria

1. THE Email_Archive_System SHALL encrypt all emails at rest using AES-256 encryption.
2. THE Email_Archive_System SHALL encrypt all data in transit using TLS 1.2 or higher.
3. WHEN a user attempts to access the Query Service, THE Email_Archive_System SHALL authenticate the user before granting access.
4. IF a user fails to authenticate after 5 consecutive attempts, THEN THE Email_Archive_System SHALL lock the account for at least 15 minutes and log the lockout event.
5. THE Email_Archive_System SHALL enforce role-based access control with at minimum two roles: Administrator (full system configuration and data access) and Analyst (search and read-only access to email data).
6. WHEN an unauthenticated request or a request from a user without the required role is received, THE Email_Archive_System SHALL deny the request and log the attempt including timestamp, source identifier, and requested resource.
7. THE Email_Archive_System SHALL log all access and search operations to an audit trail, recording at minimum the user identity, timestamp, operation performed, and resources accessed.
8. THE Email_Archive_System SHALL retain audit trail records for a minimum of 365 days.
9. WHILE a user session is active, IF no activity is detected for 30 minutes, THEN THE Email_Archive_System SHALL expire the session and require re-authentication.

### Requirement 6: Multi-Tenant and Organizational Isolation

**User Story:** As a solution architect, I want each deployment to be isolated per tenant, so that one organization's data is never accessible by another.

#### Acceptance Criteria

1. WHEN the Deployment_Stack is deployed to an AWS account, THE Email_Archive_System SHALL operate with no shared storage, no shared compute resources, no shared network paths, and no shared IAM roles with any other tenant's deployment.
2. THE Email_Archive_System SHALL ensure that all data (emails, indexes, logs, and audit trails) is stored exclusively within the owning Tenant's AWS account and is not replicated or transmitted to any other AWS account.
3. THE Deployment_Stack SHALL not create cross-account IAM roles, cross-account resource policies, VPC peering connections, or any resource references that depend on or grant access to another tenant's AWS account.
4. IF the Deployment_Stack detects existing Email_Archive_System resources in the target AWS account during deployment, THEN THE Deployment_Stack SHALL halt deployment and indicate a conflict with the existing deployment.
5. THE Deployment_Stack SHALL use tenant-account-scoped resource naming such that all provisioned resources are uniquely identifiable within the Tenant's AWS account.

### Requirement 7: Monitoring and Alerting

**User Story:** As an IT administrator, I want monitoring and alerting for the archive system, so that I can detect and respond to issues with ingestion, storage, or search.

#### Acceptance Criteria

1. THE Email_Archive_System SHALL emit metrics for email ingestion rate, ingestion failures, storage utilization, and search query latency to Amazon CloudWatch at a minimum granularity of 1 minute.
2. WHEN the ingestion failure rate exceeds 5% of total ingestion attempts within a 5-minute window, THE Email_Archive_System SHALL send an alert notification via Amazon SNS to the configured administrator notification channel within 2 minutes.
3. WHEN storage utilization exceeds 80% of provisioned capacity, THE Email_Archive_System SHALL send a warning alert notification via Amazon SNS to the configured administrator notification channel.
4. THE Email_Archive_System SHALL provide a CloudWatch dashboard displaying system health, ingestion statistics (rate, success, failure counts), storage metrics (total size, utilization percentage), and search query latency (p50, p95, p99).
5. WHEN the Query_Service query latency exceeds 30 seconds at the 95th percentile over a 5-minute window, THE Email_Archive_System SHALL send an alert notification via Amazon SNS.
6. THE Email_Archive_System SHALL retain all emitted metrics for a minimum of 90 days.

### Requirement 8: Retention Policy Configuration

**User Story:** As a compliance officer, I want to configure retention policies, so that emails are retained for the required compliance period and can be purged after expiration.

#### Acceptance Criteria

1. THE Email_Archive_System SHALL allow administrators to define Retention Policies specifying a minimum retention duration between 1 and 36,500 days (inclusive), calculated from the date each email was archived.
2. WHILE an email has not exceeded its retention period, THE Archive_Store SHALL prevent deletion of that email and reject any purge request with an error indicating the email is still under retention.
3. WHERE an organization requires indefinite retention, THE Email_Archive_System SHALL support a retention policy with no expiration, ensuring covered emails are never eligible for purge.
4. WHEN an administrator modifies a Retention Policy, THE Email_Archive_System SHALL apply the updated policy to all future retention evaluations without altering emails whose retention period had already elapsed prior to the modification.
5. WHEN an email's retention period elapses and no indefinite-retention policy applies, THE Email_Archive_System SHALL mark that email as eligible for purge within 24 hours of expiration.
6. IF an administrator attempts to create or modify a Retention Policy with a duration outside the allowed range (1–36,500 days), THEN THE Email_Archive_System SHALL reject the request and display an error indicating the valid range.
