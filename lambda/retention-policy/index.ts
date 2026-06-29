import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, ScanCommand, PutItemCommand, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

/**
 * Retention Policy CRUD Lambda handler.
 *
 * Routes:
 *   GET  /retention-policies       - List all retention policies
 *   POST /retention-policies       - Create a new retention policy
 *   PUT  /retention-policies/{id}  - Update an existing retention policy
 *
 * Access is restricted to the Administrator role via Cognito group membership
 * validated in the request context (API Gateway Cognito Authorizer).
 *
 * Requirements: 8.1, 8.3, 8.6
 */

const TABLE_NAME = process.env.RETENTION_POLICIES_TABLE!;
const RETENTION_MIN_DAYS = 1;
const RETENTION_MAX_DAYS = 36_500;
const INDEFINITE_DURATION = -1;

const dynamodb = new DynamoDBClient({});

/** Request body for creating/updating a retention policy. */
interface RetentionPolicyInput {
  name?: string;
  durationDays?: number;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Verify Administrator role
    const groups = extractCognitoGroups(event);
    if (!groups.includes('Administrator')) {
      return response(403, { error: 'Access denied. Administrator role required.' });
    }

    const method = event.httpMethod;
    const pathId = event.pathParameters?.id;
    const userId = extractUserId(event);
    const sourceIp = event.requestContext?.identity?.sourceIp || 'unknown';
    const userAgent = event.requestContext?.identity?.userAgent || 'unknown';

    if (method === 'GET' && !pathId) {
      return await listPolicies();
    }

    if (method === 'POST' && !pathId) {
      const result = await createPolicy(event.body, userId);
      writeAuditLog({
        userId,
        operation: 'CREATE_POLICY',
        sourceIp,
        userAgent,
        resourceId: result.statusCode === 201 ? JSON.parse(result.body).policyId : undefined,
      });
      return result;
    }

    if (method === 'PUT' && pathId) {
      writeAuditLog({
        userId,
        operation: 'UPDATE_POLICY',
        resourceId: pathId,
        sourceIp,
        userAgent,
      });
      return await updatePolicy(pathId, event.body);
    }

    return response(405, { error: 'Method not allowed' });
  } catch (error: unknown) {
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'RETENTION_POLICY_ERROR',
      error: error instanceof Error ? error.message : String(error),
    }));
    return response(500, { error: 'Internal server error' });
  }
}

/**
 * GET /retention-policies
 * Lists all retention policies from DynamoDB.
 */
async function listPolicies(): Promise<APIGatewayProxyResult> {
  const result = await dynamodb.send(new ScanCommand({
    TableName: TABLE_NAME,
  }));

  const policies = (result.Items || []).map(item => ({
    policyId: item.policyId?.S || '',
    name: item.name?.S || '',
    durationDays: parseInt(item.durationDays?.N || '0', 10),
    isIndefinite: item.isIndefinite?.BOOL || false,
    createdAt: item.createdAt?.S || '',
    updatedAt: item.updatedAt?.S || '',
    createdBy: item.createdBy?.S || '',
    emailCount: item.emailCount?.N ? parseInt(item.emailCount.N, 10) : undefined,
  }));

  return response(200, { policies });
}

/**
 * POST /retention-policies
 * Creates a new retention policy. Validates duration is 1-36500 or -1 (indefinite).
 */
async function createPolicy(body: string | null, userId: string): Promise<APIGatewayProxyResult> {
  if (!body) {
    return response(400, { error: 'Request body is required' });
  }

  let input: RetentionPolicyInput;
  try {
    input = JSON.parse(body);
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  // Validate required fields
  if (!input.name || input.name.trim().length === 0) {
    return response(400, { error: 'Policy name is required' });
  }

  if (input.durationDays === undefined || input.durationDays === null) {
    return response(400, { error: 'durationDays is required' });
  }

  // Validate duration
  const validationError = validateDuration(input.durationDays);
  if (validationError) {
    return response(400, { error: validationError });
  }

  const now = new Date().toISOString();
  const policyId = randomUUID();
  const isIndefinite = input.durationDays === INDEFINITE_DURATION;

  await dynamodb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      policyId: { S: policyId },
      name: { S: input.name.trim() },
      durationDays: { N: String(input.durationDays) },
      isIndefinite: { BOOL: isIndefinite },
      createdAt: { S: now },
      updatedAt: { S: now },
      createdBy: { S: userId },
    },
  }));

  return response(201, {
    policyId,
    name: input.name.trim(),
    durationDays: input.durationDays,
    isIndefinite,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  });
}

/**
 * PUT /retention-policies/{id}
 * Updates an existing retention policy. Validates duration is 1-36500 or -1 (indefinite).
 */
async function updatePolicy(policyId: string, body: string | null): Promise<APIGatewayProxyResult> {
  if (!body) {
    return response(400, { error: 'Request body is required' });
  }

  let input: RetentionPolicyInput;
  try {
    input = JSON.parse(body);
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  // Verify policy exists
  const existing = await dynamodb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { policyId: { S: policyId } },
  }));

  if (!existing.Item) {
    return response(404, { error: 'Retention policy not found' });
  }

  // Build update expression dynamically based on provided fields
  const expressionParts: string[] = [];
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, any> = {};

  if (input.name !== undefined && input.name.trim().length > 0) {
    expressionParts.push('#name = :name');
    expressionNames['#name'] = 'name';
    expressionValues[':name'] = { S: input.name.trim() };
  }

  if (input.durationDays !== undefined && input.durationDays !== null) {
    const validationError = validateDuration(input.durationDays);
    if (validationError) {
      return response(400, { error: validationError });
    }
    expressionParts.push('durationDays = :duration');
    expressionValues[':duration'] = { N: String(input.durationDays) };
    expressionParts.push('isIndefinite = :isIndefinite');
    expressionValues[':isIndefinite'] = { BOOL: input.durationDays === INDEFINITE_DURATION };
  }

  if (expressionParts.length === 0) {
    return response(400, { error: 'At least one field (name or durationDays) must be provided for update' });
  }

  // Always update the updatedAt timestamp
  expressionParts.push('updatedAt = :updatedAt');
  expressionValues[':updatedAt'] = { S: new Date().toISOString() };

  await dynamodb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { policyId: { S: policyId } },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ...(Object.keys(expressionNames).length > 0 && { ExpressionAttributeNames: expressionNames }),
    ExpressionAttributeValues: expressionValues,
    ReturnValues: 'ALL_NEW',
  }));

  // Fetch the updated item
  const updated = await dynamodb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { policyId: { S: policyId } },
  }));

  const item = updated.Item!;
  return response(200, {
    policyId: item.policyId?.S || '',
    name: item.name?.S || '',
    durationDays: parseInt(item.durationDays?.N || '0', 10),
    isIndefinite: item.isIndefinite?.BOOL || false,
    createdAt: item.createdAt?.S || '',
    updatedAt: item.updatedAt?.S || '',
    createdBy: item.createdBy?.S || '',
  });
}

/**
 * Validates the duration value for a retention policy.
 * Valid values: -1 (indefinite) or 1-36500 (inclusive).
 * Returns an error message if invalid, undefined if valid.
 */
export function validateDuration(durationDays: number): string | undefined {
  if (!Number.isInteger(durationDays)) {
    return `durationDays must be an integer. Valid range: ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS} days, or ${INDEFINITE_DURATION} for indefinite retention.`;
  }

  if (durationDays === INDEFINITE_DURATION) {
    return undefined; // Valid: indefinite retention
  }

  if (durationDays < RETENTION_MIN_DAYS || durationDays > RETENTION_MAX_DAYS) {
    return `durationDays must be between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} (inclusive), or ${INDEFINITE_DURATION} for indefinite retention.`;
  }

  return undefined;
}

/**
 * Extracts Cognito groups from the API Gateway event request context.
 * The groups are available in the authorizer claims when using a Cognito User Pool Authorizer.
 */
function extractCognitoGroups(event: APIGatewayProxyEvent): string[] {
  const claims = event.requestContext?.authorizer?.claims;
  if (!claims) {
    return [];
  }

  // Cognito groups are in the 'cognito:groups' claim as a comma-separated string
  const groupsClaim = claims['cognito:groups'];
  if (!groupsClaim || typeof groupsClaim !== 'string') {
    return [];
  }

  return groupsClaim.split(',').map(g => g.trim());
}

/**
 * Extracts the authenticated user's ID from the API Gateway event request context.
 */
function extractUserId(event: APIGatewayProxyEvent): string {
  const claims = event.requestContext?.authorizer?.claims;
  return claims?.sub || claims?.['cognito:username'] || 'unknown';
}

/**
 * Writes a structured audit log entry to CloudWatch Logs.
 * Requirements: 5.7, 5.8
 */
function writeAuditLog(entry: {
  userId: string;
  operation: string;
  resourceId?: string;
  sourceIp: string;
  userAgent: string;
}): void {
  console.log(JSON.stringify({
    level: 'AUDIT',
    auditId: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  }));
}

/**
 * Builds a standardized API Gateway proxy response with CORS headers.
 */
function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}
