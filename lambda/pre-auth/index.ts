import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

/**
 * Pre-authentication Lambda trigger for Cognito User Pool.
 *
 * Checks DynamoDB for the user's failed authentication attempt record and blocks
 * authentication if the user has >= LOCKOUT_THRESHOLD consecutive failures
 * within the LOCKOUT_DURATION_MINUTES window.
 *
 * Flow:
 * 1. Check if user is currently locked out (>= 5 failures AND < 15 min since last failure)
 * 2. If locked out: throw error to block authentication, log lockout event to CloudWatch
 * 3. If lockout expired: reset the counter, allow authentication to proceed
 * 4. If not locked out: increment attempt counter pre-emptively
 * 5. On successful auth, the post-authentication trigger resets the counter
 *
 * DynamoDB Record Schema:
 *   username (PK): string
 *   failedAttempts: number
 *   lastFailedAt: string (ISO 8601)
 *   ttl: number (Unix epoch seconds, auto-expiry for cleanup)
 *
 * Requirements: 5.4, 5.6
 */

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MINUTES = 15;

/** TTL for auth attempt records: 1 hour after lockout would expire */
const TTL_BUFFER_SECONDS = 60 * 60;

const TABLE_NAME = process.env.AUTH_ATTEMPTS_TABLE!;

const dynamodb = new DynamoDBClient({});

interface CognitoPreAuthEvent {
  version: string;
  triggerSource: string;
  region: string;
  userPoolId: string;
  userName: string;
  callerContext: {
    awsSdkVersion: string;
    clientId: string;
  };
  request: {
    userAttributes: Record<string, string>;
    validationData?: Record<string, string>;
    userNotFound?: boolean;
  };
  response: Record<string, unknown>;
}

/**
 * Determines if the account is currently locked based on failure count and elapsed time.
 */
export function isAccountLocked(
  failedAttempts: number,
  lastFailedAt: string | undefined,
  now: number
): { locked: boolean; elapsedMinutes: number } {
  if (failedAttempts < LOCKOUT_THRESHOLD || !lastFailedAt) {
    return { locked: false, elapsedMinutes: 0 };
  }

  const lastFailedTime = new Date(lastFailedAt).getTime();
  const elapsedMinutes = (now - lastFailedTime) / (1000 * 60);

  return {
    locked: elapsedMinutes < LOCKOUT_DURATION_MINUTES,
    elapsedMinutes,
  };
}

export async function handler(event: CognitoPreAuthEvent): Promise<CognitoPreAuthEvent> {
  const username = event.userName;

  try {
    // Step 1: Retrieve current auth attempt record for this user
    const getResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        username: { S: username },
      },
    }));

    if (getResult.Item) {
      const failedAttempts = parseInt(getResult.Item.failedAttempts?.N || '0', 10);
      const lastFailedAt = getResult.Item.lastFailedAt?.S;
      const now = Date.now();

      const lockStatus = isAccountLocked(failedAttempts, lastFailedAt, now);

      // Step 2: If locked, block authentication and log event
      if (lockStatus.locked) {
        const lockoutRemainingMinutes = LOCKOUT_DURATION_MINUTES - lockStatus.elapsedMinutes;

        console.log(JSON.stringify({
          level: 'WARN',
          event: 'ACCOUNT_LOCKOUT_BLOCKED',
          username,
          failedAttempts,
          lastFailedAt,
          elapsedMinutes: Math.round(lockStatus.elapsedMinutes * 100) / 100,
          lockoutRemainingMinutes: Math.round(lockoutRemainingMinutes * 100) / 100,
          message: `Authentication blocked: account locked with ${failedAttempts} consecutive failures`,
        }));

        throw new Error('Account is temporarily locked due to multiple failed login attempts. Please try again later.');
      }

      // Step 3: Lockout period has elapsed — reset the counter
      if (failedAttempts >= LOCKOUT_THRESHOLD) {
        console.log(JSON.stringify({
          level: 'INFO',
          event: 'LOCKOUT_EXPIRED',
          username,
          failedAttempts,
          elapsedMinutes: Math.round(lockStatus.elapsedMinutes * 100) / 100,
          message: 'Lockout period expired, resetting counter',
        }));

        await dynamodb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: {
            username: { S: username },
          },
          UpdateExpression: 'SET failedAttempts = :zero REMOVE lastFailedAt',
          ExpressionAttributeValues: {
            ':zero': { N: '0' },
          },
        }));
      }
    }

    // Step 4: Increment attempt counter pre-emptively.
    // If login succeeds, post-auth trigger will delete the record.
    // If login fails, the counter stays incremented.
    const ttlEpoch = Math.floor(Date.now() / 1000) + (LOCKOUT_DURATION_MINUTES * 60) + TTL_BUFFER_SECONDS;

    await dynamodb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        username: { S: username },
      },
      UpdateExpression: 'SET failedAttempts = if_not_exists(failedAttempts, :zero) + :one, lastFailedAt = :now, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':zero': { N: '0' },
        ':one': { N: '1' },
        ':now': { S: new Date().toISOString() },
        ':ttl': { N: String(ttlEpoch) },
      },
    }));
  } catch (error: unknown) {
    // Re-throw lockout errors to block authentication
    if (error instanceof Error && error.message.includes('Account is temporarily locked')) {
      throw error;
    }
    // Log unexpected errors but allow authentication to proceed (fail-open for availability)
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'PRE_AUTH_ERROR',
      username,
      error: error instanceof Error ? error.message : String(error),
      message: 'Error checking lockout status, allowing authentication to proceed',
    }));
  }

  // Allow authentication to proceed
  return event;
}
