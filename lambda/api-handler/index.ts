import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';

/**
 * API Lambda Handler — single Lambda that routes based on HTTP method + path.
 * Deployed behind API Gateway as a proxy integration.
 *
 * Routes:
 *   POST   /search                                  → invoke search handler Lambda
 *   GET    /emails/{emailId}                        → retrieve email from DynamoDB + S3
 *   GET    /emails/{emailId}/attachments/{attachmentId} → presigned URL for attachment
 *   POST   /exports                                 → start Step Functions export workflow
 *   GET    /exports/{exportId}                      → return export job status
 *   GET    /health                                  → 200 with service status
 *
 * Requirements: 3.2, 3.5, 3.6, 5.7
 */

// Environment variables
const EMAIL_TABLE = process.env.EMAIL_TABLE!;
const PARSED_BUCKET = process.env.PARSED_BUCKET!;
const RAW_BUCKET = process.env.RAW_BUCKET!;
const EXPORT_JOBS_TABLE = process.env.EXPORT_JOBS_TABLE!;
const EXPORT_STATE_MACHINE_ARN = process.env.EXPORT_STATE_MACHINE_ARN!;
const SEARCH_FUNCTION_NAME = process.env.SEARCH_FUNCTION_NAME!;
const RETENTION_POLICIES_TABLE = process.env.RETENTION_POLICIES_TABLE || 'RetentionPolicies';

// AWS SDK clients
const dynamodb = new DynamoDBClient({});
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});
const sfnClient = new SFNClient({});

// Constants
const PRESIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

// --- Main Handler ---

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  // Extract user context for audit logging
  const userId = extractUserId(event);
  const userRole = extractUserRole(event);
  const sourceIp = event.requestContext?.identity?.sourceIp || 'unknown';
  const userAgent = event.requestContext?.identity?.userAgent || 'unknown';

  try {
    // Route: GET /health
    if (method === 'GET' && path === '/health') {
      writeAuditLog({
        userId,
        userRole,
        operation: 'HEALTH_CHECK',
        sourceIp,
        userAgent,
      });
      return handleHealth();
    }

    // Route: POST /search
    if (method === 'POST' && path === '/search') {
      writeAuditLog({
        userId,
        userRole,
        operation: 'SEARCH',
        sourceIp,
        userAgent,
        requestDetails: { body: event.body ? JSON.parse(event.body) : {} },
      });
      return await handleSearch(event);
    }

    // Route: POST /auth/logout
    if (method === 'POST' && path === '/auth/logout') {
      writeAuditLog({
        userId,
        userRole,
        operation: 'LOGOUT',
        sourceIp,
        userAgent,
      });
      return response(200, { message: 'Logged out successfully' });
    }

    // Route: GET /emails/{emailId}/attachments/{attachmentId}
    if (method === 'GET' && path.match(/^\/emails\/[^/]+\/attachments\/[^/]+$/)) {
      const emailId = event.pathParameters?.emailId || '';
      const attachmentId = event.pathParameters?.attachmentId || '';
      writeAuditLog({
        userId,
        userRole,
        operation: 'DOWNLOAD_ATTACHMENT',
        resourceId: `${emailId}/attachments/${attachmentId}`,
        sourceIp,
        userAgent,
      });
      return await handleGetAttachment(emailId, attachmentId);
    }

    // Route: GET /emails/{emailId}
    if (method === 'GET' && path.match(/^\/emails\/[^/]+$/) && !path.includes('/attachments/')) {
      const emailId = event.pathParameters?.emailId || '';
      writeAuditLog({
        userId,
        userRole,
        operation: 'VIEW_EMAIL',
        resourceId: emailId,
        sourceIp,
        userAgent,
      });
      return await handleGetEmail(emailId);
    }

    // Route: POST /exports
    if (method === 'POST' && path === '/exports') {
      writeAuditLog({
        userId,
        userRole,
        operation: 'CREATE_EXPORT',
        sourceIp,
        userAgent,
        requestDetails: { body: event.body ? JSON.parse(event.body) : {} },
      });
      return await handleCreateExport(event, userId);
    }

    // Route: GET /exports/{exportId}
    if (method === 'GET' && path.match(/^\/exports\/[^/]+$/)) {
      const exportId = event.pathParameters?.exportId || '';
      writeAuditLog({
        userId,
        userRole,
        operation: 'VIEW_EXPORT',
        resourceId: exportId,
        sourceIp,
        userAgent,
      });
      return await handleGetExport(exportId);
    }

    // Route: GET /retention-policies
    if (method === 'GET' && path === '/retention-policies') {
      return await handleListRetentionPolicies(event, userId, userRole);
    }

    // Route: POST /retention-policies
    if (method === 'POST' && path === '/retention-policies') {
      return await handleCreateRetentionPolicy(event, userId, userRole, sourceIp, userAgent);
    }

    // Route: PUT /retention-policies/{id}
    if (method === 'PUT' && path.match(/^\/retention-policies\/[^/]+$/)) {
      const policyId = event.pathParameters?.id || '';
      return await handleUpdateRetentionPolicy(policyId, event, userId, userRole, sourceIp, userAgent);
    }

    // No matching route
    return response(404, { error: 'Not found' });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'API_HANDLER_ERROR',
      method,
      path,
      userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));

    return response(500, { error: 'Internal server error' });
  }
}

// --- Route Handlers ---

/**
 * GET /health — returns 200 with service status.
 */
function handleHealth(): APIGatewayProxyResult {
  return response(200, {
    status: 'healthy',
    service: 'email-archive-api',
    timestamp: new Date().toISOString(),
  });
}

/**
 * POST /search — invokes the search handler Lambda synchronously and returns results.
 * Requirement: 3.2
 */
async function handleSearch(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return response(400, { error: 'Request body is required' });
  }

  let searchQuery: Record<string, unknown>;
  try {
    searchQuery = JSON.parse(event.body);
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  // Invoke search handler Lambda synchronously
  const invokeResult = await lambdaClient.send(new InvokeCommand({
    FunctionName: SEARCH_FUNCTION_NAME,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(searchQuery)),
  }));

  if (invokeResult.FunctionError) {
    const errorPayload = invokeResult.Payload
      ? JSON.parse(Buffer.from(invokeResult.Payload).toString())
      : { error: 'Search function failed' };
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'SEARCH_INVOCATION_ERROR',
      functionError: invokeResult.FunctionError,
      errorPayload,
    }));
    return response(500, { error: 'Search query failed. Please try again.' });
  }

  // The search Lambda returns { statusCode, body, headers }
  if (invokeResult.Payload) {
    const searchResponse = JSON.parse(Buffer.from(invokeResult.Payload).toString());
    return {
      statusCode: searchResponse.statusCode || 200,
      headers: { ...CORS_HEADERS, ...(searchResponse.headers || {}) },
      body: searchResponse.body || JSON.stringify(searchResponse),
    };
  }

  return response(500, { error: 'No response from search service' });
}

/**
 * GET /emails/{emailId} — retrieves full email from DynamoDB + S3 parsed bucket.
 * Requirement: 3.5
 */
async function handleGetEmail(emailId: string): Promise<APIGatewayProxyResult> {
  if (!emailId) {
    return response(400, { error: 'emailId is required' });
  }

  // Fetch email metadata from DynamoDB
  const getResult = await dynamodb.send(new GetItemCommand({
    TableName: EMAIL_TABLE,
    Key: { emailId: { S: emailId } },
  }));

  if (!getResult.Item) {
    return response(404, { error: 'Email not found' });
  }

  const item = getResult.Item;

  // Parse attachments from DynamoDB format
  const attachments = (item.attachments?.L || []).map(att => {
    const m = att.M || {};
    return {
      attachmentId: m.attachmentId?.S || '',
      fileName: m.fileName?.S || '',
      fileType: m.fileType?.S || '',
      sizeBytes: parseInt(m.sizeBytes?.N || '0', 10),
      s3Key: m.s3Key?.S || '',
      contentHash: m.contentHash?.S || '',
    };
  });

  // Fetch email body from S3
  const bodyS3Key = item.bodyS3Key?.S;
  let bodyText: string | undefined;
  if (bodyS3Key) {
    try {
      bodyText = await getS3Object(PARSED_BUCKET, bodyS3Key);
    } catch (err) {
      console.warn(`Failed to fetch email body from S3: ${bodyS3Key}`, err);
    }
  }

  // Fetch HTML body if available
  const bodyHtmlS3Key = item.bodyHtmlS3Key?.S;
  let bodyHtml: string | undefined;
  if (bodyHtmlS3Key) {
    try {
      bodyHtml = await getS3Object(PARSED_BUCKET, bodyHtmlS3Key);
    } catch (err) {
      console.warn(`Failed to fetch HTML body from S3: ${bodyHtmlS3Key}`, err);
    }
  }

  // Build response
  const emailResponse = {
    emailId: item.emailId?.S || '',
    messageId: item.messageId?.S || '',
    sender: item.sender?.S || '',
    recipients: (item.recipients?.L || []).map(r => r.S || ''),
    ccRecipients: (item.ccRecipients?.L || []).map(r => r.S || ''),
    bccRecipients: (item.bccRecipients?.L || []).map(r => r.S || ''),
    subject: item.subject?.S || '',
    date: item.date?.S || '',
    archivedAt: item.archivedAt?.S || '',
    totalSizeBytes: parseInt(item.totalSizeBytes?.N || '0', 10),
    attachmentCount: parseInt(item.attachmentCount?.N || '0', 10),
    attachments,
    bodyText,
    bodyHtml,
  };

  return response(200, emailResponse);
}

/**
 * GET /emails/{emailId}/attachments/{attachmentId} — generates presigned URL for download.
 * Requirement: 3.5
 */
async function handleGetAttachment(emailId: string, attachmentId: string): Promise<APIGatewayProxyResult> {
  if (!emailId || !attachmentId) {
    return response(400, { error: 'emailId and attachmentId are required' });
  }

  // Special case: "_raw" means download the original .eml file
  if (attachmentId === '_raw') {
    const getResult = await dynamodb.send(new GetItemCommand({
      TableName: EMAIL_TABLE,
      Key: { emailId: { S: emailId } },
    }));
    if (!getResult.Item) return response(404, { error: 'Email not found' });
    const rawS3Key = getResult.Item.rawS3Key?.S;
    if (!rawS3Key) return response(500, { error: 'Raw email key not found' });

    const command = new GetObjectCommand({
      Bucket: RAW_BUCKET,
      Key: rawS3Key,
      ResponseContentDisposition: `attachment; filename="${emailId}.eml"`,
      ResponseContentType: 'message/rfc822',
    });
    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    return response(200, { attachmentId: '_raw', fileName: `${emailId}.eml`, fileType: 'message/rfc822', presignedUrl, expiresIn: 900 });
  }

  // Fetch email metadata from DynamoDB to find the attachment S3 key
  const getResult = await dynamodb.send(new GetItemCommand({
    TableName: EMAIL_TABLE,
    Key: { emailId: { S: emailId } },
  }));

  if (!getResult.Item) {
    return response(404, { error: 'Email not found' });
  }

  const attachments = getResult.Item.attachments?.L || [];
  const attachment = attachments.find(att => {
    const m = att.M || {};
    return m.attachmentId?.S === attachmentId;
  });

  if (!attachment) {
    return response(404, { error: 'Attachment not found' });
  }

  const attMap = attachment.M || {};
  const s3Key = attMap.s3Key?.S;
  const fileName = attMap.fileName?.S || 'attachment';
  const fileType = attMap.fileType?.S || 'application/octet-stream';

  if (!s3Key) {
    return response(500, { error: 'Attachment storage key not found' });
  }

  // Generate presigned URL for the attachment in the parsed bucket
  const command = new GetObjectCommand({
    Bucket: PARSED_BUCKET,
    Key: s3Key,
    ResponseContentDisposition: `attachment; filename="${fileName}"`,
    ResponseContentType: fileType,
  });

  const presignedUrl = await getSignedUrl(s3, command, {
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return response(200, {
    attachmentId,
    fileName,
    fileType,
    presignedUrl,
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });
}

/**
 * POST /exports — creates ExportJob record, starts Step Functions execution.
 * Requirement: 3.6
 */
async function handleCreateExport(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return response(400, { error: 'Request body is required' });
  }

  let body: { searchQuery?: Record<string, unknown> };
  try {
    body = JSON.parse(event.body);
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  if (!body.searchQuery) {
    return response(400, { error: 'searchQuery is required in request body' });
  }

  const exportId = randomUUID();
  const now = new Date().toISOString();

  // Create ExportJob record in DynamoDB with status PENDING
  await dynamodb.send(new PutItemCommand({
    TableName: EXPORT_JOBS_TABLE,
    Item: {
      exportId: { S: exportId },
      userId: { S: userId },
      status: { S: 'PENDING' },
      searchQuery: { S: JSON.stringify(body.searchQuery) },
      fileCount: { N: '0' },
      totalSizeBytes: { N: '0' },
      createdAt: { S: now },
    },
  }));

  // Start Step Functions execution
  await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: EXPORT_STATE_MACHINE_ARN,
    name: `export-${exportId}`,
    input: JSON.stringify({
      exportId,
      userId,
      searchQuery: body.searchQuery,
    }),
  }));

  return response(202, {
    exportId,
    status: 'PENDING',
    createdAt: now,
    message: 'Export job started. Use GET /exports/{exportId} to check status.',
  });
}

/**
 * GET /exports/{exportId} — returns export job status and presigned URL if completed.
 * Requirement: 3.6
 */
async function handleGetExport(exportId: string): Promise<APIGatewayProxyResult> {
  if (!exportId) {
    return response(400, { error: 'exportId is required' });
  }

  const getResult = await dynamodb.send(new GetItemCommand({
    TableName: EXPORT_JOBS_TABLE,
    Key: { exportId: { S: exportId } },
  }));

  if (!getResult.Item) {
    return response(404, { error: 'Export job not found' });
  }

  const item = getResult.Item;

  const exportResponse: Record<string, unknown> = {
    exportId: item.exportId?.S || '',
    userId: item.userId?.S || '',
    status: item.status?.S || '',
    fileCount: parseInt(item.fileCount?.N || '0', 10),
    totalSizeBytes: parseInt(item.totalSizeBytes?.N || '0', 10),
    createdAt: item.createdAt?.S || '',
  };

  // Include optional fields if present
  if (item.s3Key?.S) {
    exportResponse.s3Key = item.s3Key.S;
  }
  if (item.presignedUrl?.S) {
    exportResponse.presignedUrl = item.presignedUrl.S;
  }
  if (item.expiresAt?.S) {
    exportResponse.expiresAt = item.expiresAt.S;
  }
  if (item.completedAt?.S) {
    exportResponse.completedAt = item.completedAt.S;
  }
  if (item.errorMessage?.S) {
    exportResponse.errorMessage = item.errorMessage.S;
  }

  return response(200, exportResponse);
}

// --- Retention Policy Handlers ---

const RETENTION_MIN_DAYS = 1;
const RETENTION_MAX_DAYS = 36_500;
const INDEFINITE_DURATION = -1;

/**
 * GET /retention-policies — lists all retention policies.
 * Restricted to Administrator role.
 * Requirement: 8.1
 */
async function handleListRetentionPolicies(
  event: APIGatewayProxyEvent,
  userId: string,
  userRole: string,
): Promise<APIGatewayProxyResult> {
  if (userRole !== 'Administrator') {
    return response(403, { error: 'Access denied. Administrator role required.' });
  }

  const result = await dynamodb.send(new ScanCommand({
    TableName: RETENTION_POLICIES_TABLE,
  }));

  const policies = (result.Items || []).map(item => ({
    policyId: item.policyId?.S || '',
    name: item.name?.S || '',
    durationDays: parseInt(item.durationDays?.N || '0', 10),
    isIndefinite: item.isIndefinite?.BOOL || false,
    createdAt: item.createdAt?.S || '',
    updatedAt: item.updatedAt?.S || '',
    createdBy: item.createdBy?.S || '',
  }));

  return response(200, { policies });
}

/**
 * POST /retention-policies — creates a new retention policy.
 * Restricted to Administrator role.
 * Requirement: 8.1, 8.6
 */
async function handleCreateRetentionPolicy(
  event: APIGatewayProxyEvent,
  userId: string,
  userRole: string,
  sourceIp: string,
  userAgent: string,
): Promise<APIGatewayProxyResult> {
  if (userRole !== 'Administrator') {
    return response(403, { error: 'Access denied. Administrator role required.' });
  }

  if (!event.body) {
    return response(400, { error: 'Request body is required' });
  }

  let input: { name?: string; durationDays?: number };
  try {
    input = JSON.parse(event.body);
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  if (!input.name || input.name.trim().length === 0) {
    return response(400, { error: 'Policy name is required' });
  }

  if (input.durationDays === undefined || input.durationDays === null) {
    return response(400, { error: 'durationDays is required' });
  }

  const validationError = validateRetentionDuration(input.durationDays);
  if (validationError) {
    return response(400, { error: validationError });
  }

  const policyId = randomUUID();
  const now = new Date().toISOString();
  const isIndefinite = input.durationDays === INDEFINITE_DURATION;

  await dynamodb.send(new PutItemCommand({
    TableName: RETENTION_POLICIES_TABLE,
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

  writeAuditLog({
    userId,
    userRole,
    operation: 'CREATE_POLICY',
    resourceId: policyId,
    sourceIp,
    userAgent,
  });

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
 * PUT /retention-policies/{id} — updates an existing retention policy.
 * Restricted to Administrator role.
 * Requirement: 8.1, 8.6
 */
async function handleUpdateRetentionPolicy(
  policyId: string,
  event: APIGatewayProxyEvent,
  userId: string,
  userRole: string,
  sourceIp: string,
  userAgent: string,
): Promise<APIGatewayProxyResult> {
  if (userRole !== 'Administrator') {
    return response(403, { error: 'Access denied. Administrator role required.' });
  }

  if (!event.body) {
    return response(400, { error: 'Request body is required' });
  }

  let input: { name?: string; durationDays?: number };
  try {
    input = JSON.parse(event.body);
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  // Verify policy exists
  const existing = await dynamodb.send(new GetItemCommand({
    TableName: RETENTION_POLICIES_TABLE,
    Key: { policyId: { S: policyId } },
  }));

  if (!existing.Item) {
    return response(404, { error: 'Retention policy not found' });
  }

  const expressionParts: string[] = [];
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, any> = {};

  if (input.name !== undefined && input.name.trim().length > 0) {
    expressionParts.push('#name = :name');
    expressionNames['#name'] = 'name';
    expressionValues[':name'] = { S: input.name.trim() };
  }

  if (input.durationDays !== undefined && input.durationDays !== null) {
    const validationError = validateRetentionDuration(input.durationDays);
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

  expressionParts.push('updatedAt = :updatedAt');
  expressionValues[':updatedAt'] = { S: new Date().toISOString() };

  await dynamodb.send(new UpdateItemCommand({
    TableName: RETENTION_POLICIES_TABLE,
    Key: { policyId: { S: policyId } },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ...(Object.keys(expressionNames).length > 0 && { ExpressionAttributeNames: expressionNames }),
    ExpressionAttributeValues: expressionValues,
  }));

  writeAuditLog({
    userId,
    userRole,
    operation: 'UPDATE_POLICY',
    resourceId: policyId,
    sourceIp,
    userAgent,
  });

  // Fetch updated item
  const updated = await dynamodb.send(new GetItemCommand({
    TableName: RETENTION_POLICIES_TABLE,
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
 */
function validateRetentionDuration(durationDays: number): string | undefined {
  if (!Number.isInteger(durationDays)) {
    return `durationDays must be an integer. Valid range: ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS} days, or ${INDEFINITE_DURATION} for indefinite retention.`;
  }
  if (durationDays === INDEFINITE_DURATION) {
    return undefined;
  }
  if (durationDays < RETENTION_MIN_DAYS || durationDays > RETENTION_MAX_DAYS) {
    return `durationDays must be between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} (inclusive), or ${INDEFINITE_DURATION} for indefinite retention.`;
  }
  return undefined;
}

// --- Helpers ---

/**
 * Fetches a text object from S3.
 */
async function getS3Object(bucket: string, key: string): Promise<string> {
  const result = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));

  const stream = result.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Extracts the authenticated user ID from the Cognito authorizer claims.
 */
function extractUserId(event: APIGatewayProxyEvent): string {
  const claims = event.requestContext?.authorizer?.claims;
  if (claims) {
    return claims.sub || claims['cognito:username'] || 'unknown';
  }
  return 'anonymous';
}

/**
 * Extracts the user's role from Cognito group claims.
 */
function extractUserRole(event: APIGatewayProxyEvent): string {
  const claims = event.requestContext?.authorizer?.claims;
  if (!claims) return 'unknown';

  const groupsClaim = claims['cognito:groups'];
  if (!groupsClaim || typeof groupsClaim !== 'string') return 'unknown';

  const groups = groupsClaim.split(',').map(g => g.trim());
  if (groups.includes('Administrator')) return 'Administrator';
  if (groups.includes('Analyst')) return 'Analyst';
  return groups[0] || 'unknown';
}

/**
 * Writes a structured audit log entry to CloudWatch Logs.
 * Requirement: 5.7
 */
function writeAuditLog(entry: {
  userId: string;
  userRole: string;
  operation: string;
  resourceId?: string;
  sourceIp: string;
  userAgent: string;
  requestDetails?: Record<string, unknown>;
}): void {
  const auditEntry = {
    auditId: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  console.log(JSON.stringify({
    level: 'AUDIT',
    ...auditEntry,
  }));
}

/**
 * Builds a standardized API Gateway proxy response with CORS headers.
 */
function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
