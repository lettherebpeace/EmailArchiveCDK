# Freedom to Innovate: Building an Email Archive Solution in with Kiro

*How an AI-native development environment turned a complex enterprise requirement into a deployed, serverless solution — from spec to deployment in hours, not months.*

---

## The Moment It Clicked

At the AWS Summit in New York City (June 2026), the keynote centered on a thesis that resonated deeply: **removing the constraints that slow builders down**. AI-native development tools that eliminate the bottlenecks between writing code and shipping it. Agents that compound value over time.

As a Systems and Development Engineer who has spent years in Enterprise Infrastructure Services — troubleshooting client devices, supporting enterprise applications, deploying and managing servers in data centers, designing and deploying services in AWS, integrating Microsoft 365 services, and now building with AI — every phase of my career added depth but also exposed a recurring friction: the gap between what I could envision and what I could realistically deliver within timelines, budgets, and available skillsets.

In the past, solving a problem like enterprise email archival meant assembling a team with expertise in SMTP protocols, AWS CDK, React development, DynamoDB data modeling, and compliance workflows. Finding all of that in one team — or one person — was the bottleneck. The idea was never the problem. Execution was.

Today, that constraint is gone. Tools like Kiro let me bring my architectural experience — the understanding of *what* needs to be built and *why* — while the AI handles the *how*. I'm no longer limited by what I can code in a sprint. I'm limited only by what I can design. And that changes everything.

---

## The Problem

Organizations running Microsoft 365 Exchange Online face a hard ceiling. Standard mailboxes cap at 100 GB. Online Archive extends that to 1.5 TB. Microsoft Purview enables compliance features at the tenant level, but doesn't address scenarios where multiple organizations — or individual business units — need independent email analysis for their own operational needs.

These organizations need:
- A place to journal all email for their specific business requirements
- The ability to search across millions of messages by metadata
- Export capabilities for investigation and discovery
- Security, encryption, and audit trails
- A solution they can deploy to their own AWS account without vendor lock-in

This isn't a weekend project. It spans SES, S3, DynamoDB, Glue, Athena, Step Functions, Cognito, API Gateway, CloudFront, and a React frontend. Traditional estimation: 3–6 months with a dedicated team. Infrastructure as Code, security reviews, integration testing — the list goes on.

I built it in a single session with Kiro.

---

## The Process: Spec-Driven Development

### Starting with Requirements, Not Code

Kiro's spec-driven workflow changed how I approached the problem. Instead of jumping to code, I started with a conversation about what the system needed to do. Kiro helped me articulate eight formal requirements covering:

1. **Email ingestion** from M365 via SMTP journaling
2. **Durable storage** exceeding 1.5 TB with 11-nines durability
3. **Metadata search** via Athena with export capability
4. **Infrastructure as Code** deployable to any AWS account
5. **Security** with encryption at rest/in transit, RBAC, audit trails
6. **Tenant isolation** per AWS account
7. **Monitoring and alerting** via CloudWatch
8. **Configurable retention policies** for compliance

Each requirement has testable acceptance criteria written in EARS format (Event-driven, Action-Response, State-driven). This isn't documentation for documentation's sake — it's the contract that guided every design decision and implementation task.

### Iterating on Design Decisions

The design phase is where Kiro shines as a collaborator, not just a code generator. We had real architectural conversations:

**"Would using SES be simpler if 40 MB is acceptable?"** — We started with a custom SMTP server on ECS Fargate (to handle 150 MB emails), then realized SES at 40 MB eliminated containers entirely. One question, and the architecture simplified dramatically.

**"How expensive is OpenSearch vs. Glue + Athena?"** — OpenSearch Serverless costs $700/month minimum. For metadata-only search (sender, recipient, subject, date range), Glue + Athena costs $5/TB scanned. We chose Athena and saved hundreds per month with zero ongoing maintenance.

**"Do we need GitHub for deployment?"** — The original design used GitHub Actions with OIDC federation. When I mentioned I didn't want a GitHub dependency, we switched to IAM Identity Center (SSO) with local deployment. `aws sso login`, then `cdk deploy`. Done.

Each decision was evaluated on cost, complexity, and operational overhead. The design evolved through conversation, not a waterfall process.

### 48 Tasks, Executed in Parallel Waves

The implementation plan decomposed into 17 top-level tasks with 48 sub-tasks, organized into 15 parallel waves using a dependency graph. Kiro dispatched multiple tasks concurrently — building the storage layer, auth layer, and ingestion pipeline in parallel where dependencies allowed.

The entire CDK project — 9 CloudFormation stacks, 7 Lambda functions, a Step Functions workflow, a React SPA (~8,000 lines of TypeScript) — was generated, compiled, tested, and synthesized without manual intervention.

---

## The Architecture: Serverless, Secure, Scalable

```
M365 Journal Rule
       ↓ (SMTP/TLS)
    AWS SES (Inbound)
       ↓
    S3 (Raw Emails) → S3 Event → SQS → Lambda (Processor)
       ↓                                      ↓
    DynamoDB (Metadata)               S3 (Parsed + JSON)
       ↓                                      ↓
    API Gateway ← Lambda              Glue Catalog ← Athena
       ↓
    React SPA (CloudFront + S3)
       ↓
    Cognito (Auth + RBAC)
```

**Key characteristics:**
- **Zero always-on compute** — No EC2, no ECS, no containers. Everything is event-driven.
- **Pay-per-use** — SES, Lambda, Athena, DynamoDB on-demand. Idle cost approaches zero.
- **Encryption everywhere** — KMS at rest, TLS in transit, S3 Object Lock for immutability.
- **Single-command deployment** — `npx cdk deploy --all --profile email-archive`

---

## The Deployment: From Code to Production

Deployment revealed real-world issues that no amount of unit testing catches:

- **SES can't write to S3 buckets with Object Lock default retention** — An undocumented AWS limitation. Kiro identified the issue from the error message, searched AWS documentation, found the answer, and applied the fix.

- **SES client-side encryption (CSE-KMS) makes emails unreadable** — When you specify a KMS key on the SES S3 action, it uses client-side encryption that standard `GetObject` can't decrypt. The fix: rely on bucket-level SSE-KMS instead.

- **SNS has a 256 KB message size limit** — The original SES → SNS → SQS pipeline bounced emails larger than 256 KB. The fix: switch to S3 event notifications that send only the object key (tiny payload), not the email content.

- **Athena doesn't support OFFSET for pagination** — A Presto/Trino limitation. The search handler was refactored to use client-side pagination.

- **M365 journal reports wrap emails in a message/rfc822 envelope** — The processor was enhanced to detect journal reports, unwrap the nested MIME attachment, and extract the actual email body for display.

Each issue was diagnosed, researched, fixed, and redeployed — often in under two minutes per cycle.

---

## Security by Default, Not by Afterthought

Every component was built with security as a first-class concern:

| Layer | Security Control |
|-------|-----------------|
| Data at rest | AES-256 via KMS customer-managed key |
| Data in transit | TLS 1.2+ enforced on all endpoints |
| Authentication | Cognito User Pool with MFA, account lockout (5 failures → 15 min) |
| Authorization | Role-based access (Administrator, Analyst) |
| Session management | 30-minute idle timeout, tokens in memory (not localStorage) |
| Audit | Structured JSON logs with 365-day retention |
| Deployment | IAM Identity Center — no stored credentials, 12-hour temporary sessions |
| Network | CloudFront OAC, S3 block public access, enforce-SSL bucket policies |

This isn't a checklist applied after development. These controls were in the requirements from the start, specified in the design, and validated in CDK infrastructure tests.

---

## What This Means for Builders

My career spans the full spectrum of infrastructure — from troubleshooting client devices and managing servers in data centers to designing cloud-native solutions on AWS, from Microsoft 365 tenant integrations to building AI-powered applications with Amazon Bedrock.

Each of those experiences is a dot. Kiro connects them.

As a systems architect, my value isn't writing boilerplate CloudFormation templates or debugging CORS headers. It's understanding what customers need and designing systems that deliver it — securely, at scale, with operational excellence. Kiro lets me operate at the level of architecture and design while it handles the implementation mechanics.

**The freedom to innovate isn't about working faster. It's about working at the right level of abstraction.**

When a customer says "we need to archive email beyond what M365 supports," I don't think about Sprint planning, developer availability, or whether we have someone who knows Athena. I think about the solution, validate the approach through conversation, and ship it.

---

## Why Not Just Use Microsoft Purview?

Microsoft Purview (formerly Compliance Center) is a centralized compliance solution — and that's precisely the limitation for many organizations. Purview is owned and managed by a central IT or compliance team. When individual business units, legal teams, or partner organizations need to run their own email analysis:

- They can't get direct access to Purview without going through centralized governance
- Purview data can't (and shouldn't) be shared across organizational boundaries
- Investigation timelines are dictated by the central team's capacity and priorities

This Email Archive Solution gives teams **ownership of their own analysis pipeline**. Deploy it to your AWS account, point your journal rule at it, and your team has independent, searchable access to email data — without dependencies on a central compliance team or shared tooling that crosses organizational boundaries.

---

## Architecture Decisions Explained

**Why server-side encryption only (not client-side)?**

SES uses client-side encryption (CSE-KMS) when you specify a KMS key on the S3 action. This means the raw email is encrypted with a data key before it reaches S3, and standard `GetObject` calls can't decrypt it — you need the S3 Encryption Client. We chose server-side encryption (SSE-KMS via bucket default) because it's transparent to all AWS services that read the data (Lambda, Athena, etc.) while still providing AES-256 encryption at rest with customer-managed key rotation.

**Why DynamoDB when we have Glue/Athena?**

They serve different purposes:
- **DynamoDB** — Real-time, single-item lookups. When a user clicks an email in the UI, we fetch it by `emailId` in milliseconds. DynamoDB also powers retention evaluation (GSI queries) and export job tracking.
- **Glue/Athena** — Analytical queries across the entire dataset. Search by sender, date range, subject across millions of records. Athena scans JSON files in S3 — ideal for ad-hoc queries but too slow for single-record lookups.

They're complementary, not redundant.

---

## Known Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| **40 MB email size limit** | M365 supports emails up to 150 MB. SES inbound caps at 40 MB. Emails exceeding 40 MB will bounce. | For most organizations, <1% of emails exceed 40 MB. Those that do typically have large attachments that can be handled via alternative archival (e.g., OneDrive links). A future enhancement could use a custom SMTP relay on ECS Fargate for the >40 MB path. |
| **No full-text body search** | Search is limited to metadata (sender, recipient, subject, date). Email body content is not indexed. | Body text can be added to the Glue table for Athena LIKE queries. For production-scale body search, OpenSearch Serverless provides sub-second full-text capability at ~$700/month. |
| **Athena query latency (3–30s)** | Searches are not instant. Athena is a batch query engine, not a real-time search index. | Acceptable for compliance/investigation workflows where precision matters more than speed. Partition pruning by date keeps most queries under 10 seconds. |
| **Single-region deployment** | Data is stored in one AWS region. No cross-region replication. | Suitable for most compliance requirements. Multi-region can be added via S3 Cross-Region Replication if needed. |
| **Export limit: 1000 emails per ZIP** | Large exports are rejected to prevent Lambda timeout. | Users can narrow their search criteria. A future enhancement could use AWS Batch for larger exports. |

---

## Cost

**Current infrastructure cost (idle):** ~$0.05/day ($1.50/month)

This covers KMS key, S3 storage (minimal), DynamoDB on-demand (no reads), and CloudFront distribution. At scale with millions of emails, costs grow linearly with storage ($0.023/GB/month for S3) and query volume ($5/TB scanned for Athena).

---

## Try It Yourself

The entire solution is deployable to any AWS account:

```bash
# Prerequisites: Node.js, AWS CLI, CDK
aws sso login --profile your-profile
cd frontend && npm run build && cd ..
npx cdk deploy --all --profile your-profile
```

Nine stacks. Fully serverless. Production-ready security. Costs under $10/month at idle, scales to millions of emails without architecture changes.

---

*Vijay Amirtharaj is a systems architect with experience spanning client devices, data centers, AWS, Microsoft 365, and AI services including Amazon Bedrock. These are dots that finally connected to form a full circle — benefiting the customers he serves.*

*Built with [Kiro](https://kiro.dev) — the AI-native development environment from AWS.*
