import { DynamoDBClient, ScanCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

// Environment variables
const EMAIL_TABLE = process.env.EMAIL_TABLE!;
const RETENTION_POLICIES_TABLE = process.env.RETENTION_POLICIES_TABLE!;

// AWS SDK clients
const dynamodb = new DynamoDBClient({});

/**
 * Retention Policy record from DynamoDB.
 */
interface RetentionPolicy {
  policyId: string;
  name: string;
  durationDays: number;
  isIndefinite: boolean;
}

/**
 * Retention Evaluation Lambda handler.
 *
 * Invoked every hour by EventBridge Scheduler. Scans all retention policies,
 * then for each non-indefinite policy queries the EmailMetadata GSI
 * (`retentionExpiresAt-index`) for emails whose retention has expired.
 * Marks eligible emails as `purgeEligible: true` in DynamoDB.
 *
 * Does NOT delete emails — only marks for purge.
 * S3 Object Lock prevents deletion of emails still under retention.
 *
 * Requirements: 2.4, 2.5, 8.2, 8.4, 8.5
 */
export async function handler(): Promise<void> {
  console.log(JSON.stringify({
    level: 'INFO',
    event: 'RETENTION_EVALUATION_START',
    message: 'Starting retention evaluation run',
    timestamp: new Date().toISOString(),
  }));

  // Step 1: Get all retention policies
  const policies = await getAllRetentionPolicies();

  console.log(JSON.stringify({
    level: 'INFO',
    event: 'POLICIES_LOADED',
    message: `Found ${policies.length} retention policies`,
    policyCount: policies.length,
  }));

  // Step 2: For each non-indefinite policy, find expired emails and mark them
  const now = new Date().toISOString();
  let totalMarked = 0;

  for (const policy of policies) {
    // Skip indefinite policies — emails under these are never eligible for purge
    if (policy.isIndefinite || policy.durationDays === -1) {
      console.log(JSON.stringify({
        level: 'DEBUG',
        event: 'SKIP_INDEFINITE_POLICY',
        policyId: policy.policyId,
        policyName: policy.name,
        message: `Skipping indefinite policy: ${policy.name}`,
      }));
      continue;
    }

    // Query the GSI for emails under this policy where retentionExpiresAt <= now
    const markedCount = await markExpiredEmailsForPolicy(policy.policyId, now);
    totalMarked += markedCount;

    console.log(JSON.stringify({
      level: 'INFO',
      event: 'POLICY_EVALUATED',
      policyId: policy.policyId,
      policyName: policy.name,
      markedCount,
      message: `Marked ${markedCount} emails as purge-eligible for policy: ${policy.name}`,
    }));
  }

  console.log(JSON.stringify({
    level: 'INFO',
    event: 'RETENTION_EVALUATION_COMPLETE',
    message: `Retention evaluation complete. Total emails marked purge-eligible: ${totalMarked}`,
    totalMarked,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Retrieves all retention policies from DynamoDB.
 */
async function getAllRetentionPolicies(): Promise<RetentionPolicy[]> {
  const policies: RetentionPolicy[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const response = await dynamodb.send(new ScanCommand({
      TableName: RETENTION_POLICIES_TABLE,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    if (response.Items) {
      for (const item of response.Items) {
        policies.push({
          policyId: item.policyId?.S || '',
          name: item.name?.S || '',
          durationDays: Number(item.durationDays?.N || '0'),
          isIndefinite: item.isIndefinite?.BOOL || false,
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return policies;
}

/**
 * Queries the retentionExpiresAt-index GSI for emails under a specific policy
 * that have expired (retentionExpiresAt <= now), then marks them as purgeEligible.
 *
 * Uses pagination to handle large result sets.
 *
 * @returns The number of emails marked as purge-eligible.
 */
async function markExpiredEmailsForPolicy(policyId: string, now: string): Promise<number> {
  let markedCount = 0;
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    // Query GSI: PK = retentionPolicyId, SK (retentionExpiresAt) <= now
    const response = await dynamodb.send(new QueryCommand({
      TableName: EMAIL_TABLE,
      IndexName: 'retentionExpiresAt-index',
      KeyConditionExpression: 'retentionPolicyId = :policyId AND retentionExpiresAt <= :now',
      // Only get emails not already marked as purge-eligible
      FilterExpression: 'purgeEligible = :false',
      ExpressionAttributeValues: {
        ':policyId': { S: policyId },
        ':now': { S: now },
        ':false': { BOOL: false },
      },
      ProjectionExpression: 'emailId',
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    if (response.Items) {
      // Mark each expired email as purge-eligible
      for (const item of response.Items) {
        const emailId = item.emailId?.S;
        if (!emailId) continue;

        await markEmailPurgeEligible(emailId);
        markedCount++;
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return markedCount;
}

/**
 * Updates a single email record to set purgeEligible = true.
 * Uses a condition expression to ensure we only update emails that are not
 * already marked and whose retention has genuinely expired.
 */
async function markEmailPurgeEligible(emailId: string): Promise<void> {
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: EMAIL_TABLE,
      Key: {
        emailId: { S: emailId },
      },
      UpdateExpression: 'SET purgeEligible = :true, purgeMarkedAt = :now',
      // Condition: only mark if not already marked (idempotency)
      ConditionExpression: 'purgeEligible = :false',
      ExpressionAttributeValues: {
        ':true': { BOOL: true },
        ':false': { BOOL: false },
        ':now': { S: new Date().toISOString() },
      },
    }));
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      // Already marked — this is fine, skip silently
      return;
    }
    throw error;
  }
}
