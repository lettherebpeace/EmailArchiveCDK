import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

/**
 * Post-authentication Lambda trigger for Cognito User Pool.
 *
 * Called by Cognito after a successful authentication. Resets the failed
 * authentication counter by deleting the user's record from the auth
 * attempts DynamoDB table.
 *
 * Also writes a LOGIN audit log entry for compliance tracking.
 *
 * Requirements: 5.4, 5.7, 5.8
 */

const TABLE_NAME = process.env.AUTH_ATTEMPTS_TABLE!;

const dynamodb = new DynamoDBClient({});

interface CognitoPostAuthEvent {
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
    newDeviceUsed?: boolean;
  };
  response: Record<string, unknown>;
}

export async function handler(event: CognitoPostAuthEvent): Promise<CognitoPostAuthEvent> {
  const username = event.userName;
  const sourceIp = event.request.userAttributes?.['custom:sourceIp'] || 'cognito-trigger';
  const userAgent = event.request.userAttributes?.['custom:userAgent'] || 'cognito-trigger';

  try {
    // On successful authentication, delete the auth attempts record to reset counter
    await dynamodb.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: {
        username: { S: username },
      },
    }));

    // Write LOGIN audit log entry (Requirements: 5.7, 5.8)
    console.log(JSON.stringify({
      level: 'AUDIT',
      auditId: randomUUID(),
      timestamp: new Date().toISOString(),
      userId: event.request.userAttributes?.sub || username,
      operation: 'LOGIN',
      sourceIp,
      userAgent,
    }));

    console.log(JSON.stringify({
      level: 'INFO',
      event: 'AUTH_SUCCESS_RESET',
      username,
      message: 'Failed attempt counter reset on successful authentication',
    }));
  } catch (error: unknown) {
    // Log the error but don't fail the authentication (fail-open for availability)
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'POST_AUTH_ERROR',
      username,
      error: error instanceof Error ? error.message : String(error),
      message: 'Error resetting auth attempts counter',
    }));
  }

  return event;
}
