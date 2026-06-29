import { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GlueClient, BatchCreatePartitionCommand } from '@aws-sdk/client-glue';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { simpleParser, ParsedMail, Attachment } from 'mailparser';
import { randomUUID, createHash } from 'crypto';
import { Readable } from 'stream';

// Environment variables
const RAW_BUCKET = process.env.RAW_BUCKET!;
const PARSED_BUCKET = process.env.PARSED_BUCKET!;
const METADATA_BUCKET = process.env.METADATA_BUCKET!;
const EMAIL_TABLE = process.env.EMAIL_TABLE!;
const GLUE_DATABASE = process.env.GLUE_DATABASE!;
const GLUE_TABLE = process.env.GLUE_TABLE!;
const METRICS_NAMESPACE = process.env.METRICS_NAMESPACE || 'EmailArchive';

// AWS SDK clients
const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});
const glue = new GlueClient({});
const cloudwatch = new CloudWatchClient({});

/**
 * Email Processor Lambda handler.
 *
 * Triggered by SQS messages containing S3 object keys for raw emails.
 * Processes each email: parses MIME, stores parsed content, writes metadata
 * to DynamoDB, writes JSON metadata to S3 (partitioned by date), registers
 * Glue partition, and emits CloudWatch metrics.
 *
 * Requirements: 1.2, 1.3, 2.3, 3.1, 7.1
 */
export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const startTime = Date.now();
    try {
      await processRecord(record);
      const latency = Date.now() - startTime;
      await emitMetrics({ success: true, latencyMs: latency });
    } catch (error) {
      console.error('Failed to process email record:', error);
      const latency = Date.now() - startTime;
      await emitMetrics({ success: false, latencyMs: latency });
      // Re-throw to let SQS handle retry via visibility timeout
      throw error;
    }
  }
}


/**
 * Processes a single SQS record containing an S3 object key for a raw email.
 */
async function processRecord(record: SQSRecord): Promise<void> {
  // The SQS message body contains the S3 object key (delivered via SNS raw message)
  const s3Key = extractS3Key(record.body);

  console.log(JSON.stringify({
    level: 'INFO',
    event: 'PROCESSING_EMAIL',
    s3Key,
    message: `Processing raw email from s3://${RAW_BUCKET}/${s3Key}`,
  }));

  // Step 1: Retrieve raw email from S3
  const rawEmail = await getRawEmail(s3Key);

  // Step 2: Parse MIME email
  let parsed = await simpleParser(rawEmail);

  // Step 2b: Handle journal/forwarded email wrappers
  // M365 journaling wraps the original email as a message/rfc822 attachment.
  // Detect journal reports by header or by presence of message/rfc822 attachment
  // with minimal/no HTML body.
  const isJournalReport = parsed.headers?.get('x-ms-journal-report');
  const nestedMessage = parsed.attachments?.find(
    att => att.contentType === 'message/rfc822'
  );
  
  if (nestedMessage && (isJournalReport || !parsed.html)) {
    console.log(JSON.stringify({
      level: 'INFO',
      event: 'NESTED_MESSAGE_DETECTED',
      isJournalReport: !!isJournalReport,
      message: 'Detected journal/forwarded email wrapper, parsing nested message',
    }));
    const nestedParsed = await simpleParser(nestedMessage.content);
    // Use the nested message's body content
    if (nestedParsed.html || nestedParsed.text) {
      // Preserve envelope metadata but use nested body
      const envelopeFrom = parsed.from;
      const envelopeTo = parsed.to;
      const envelopeDate = parsed.date;
      parsed = nestedParsed;
      // If nested has no from/to, fall back to envelope
      if (!parsed.from && envelopeFrom) (parsed as any).from = envelopeFrom;
      if (!parsed.to && envelopeTo) (parsed as any).to = envelopeTo;
      if (!parsed.date && envelopeDate) (parsed as any).date = envelopeDate;
    }
  }

  // Step 3: Generate unique IDs and extract metadata
  const emailId = randomUUID();
  const archivedAt = new Date().toISOString();
  const emailDate = parsed.date || new Date();
  const dateIso = emailDate.toISOString();

  // Step 4: Store parsed body to S3
  const bodyS3Key = await storeBody(emailId, parsed);

  // Step 5: Store HTML body if present (try parsed.html, then textAsHtml as fallback)
  let bodyHtmlS3Key: string | undefined;
  const htmlContent = parsed.html || (parsed as any).textAsHtml;
  if (htmlContent) {
    bodyHtmlS3Key = `emails/${emailId}/body.html`;
    await s3.send(new PutObjectCommand({
      Bucket: PARSED_BUCKET,
      Key: bodyHtmlS3Key,
      Body: htmlContent,
      ContentType: 'text/html',
    }));
  }

  // Step 6: Store attachments individually
  const attachments = await storeAttachments(emailId, parsed.attachments || []);

  // Step 7: Build metadata record
  const metadata = buildMetadata({
    emailId,
    parsed,
    s3Key,
    bodyS3Key,
    bodyHtmlS3Key,
    attachments,
    archivedAt,
    dateIso,
    rawEmailSize: rawEmail.length,
  });

  // Step 8: Write metadata to DynamoDB
  await writeToDynamoDB(metadata);

  // Step 9: Write JSON metadata to S3 (partitioned by date)
  const partitionKeys = await writeMetadataToS3(metadata, emailDate);

  // Step 10: Register Glue partition
  await registerGluePartition(partitionKeys, emailDate);

  console.log(JSON.stringify({
    level: 'INFO',
    event: 'EMAIL_PROCESSED',
    emailId,
    messageId: metadata.messageId,
    sender: metadata.sender,
    attachmentCount: attachments.length,
    message: `Successfully processed email ${emailId}`,
  }));
}

/**
 * Extracts the S3 object key from the SQS message body.
 * The message comes from SNS with raw message delivery, containing the S3 key
 * from the SES receipt rule action.
 */
function extractS3Key(messageBody: string): string {
  try {
    // Try parsing as JSON (SNS notification format)
    const parsed = JSON.parse(messageBody);

    // SNS wraps the message - check for S3 notification format
    if (parsed.Records && parsed.Records[0]?.s3?.object?.key) {
      return decodeURIComponent(parsed.Records[0].s3.object.key.replace(/\+/g, ' '));
    }

    // Raw message delivery from SNS — the message body itself is the content
    if (parsed.receipt && parsed.mail) {
      // SES notification format (contains mail object with S3 info)
      return parsed.mail.messageId ? `inbound/${parsed.mail.messageId}` : messageBody;
    }

    // If it has an 'action' field with an objectKey, use that
    if (parsed.action?.objectKey) {
      return parsed.action.objectKey;
    }

    // Fallback: if it's a simple JSON with a key field
    if (parsed.key) {
      return parsed.key;
    }

    // If the parsed object is a string (raw message delivery from SNS)
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // Not JSON — treat the message body as the S3 key directly
  }

  return messageBody.trim();
}

/**
 * Retrieves the raw email content from S3.
 */
async function getRawEmail(s3Key: string): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({
    Bucket: RAW_BUCKET,
    Key: s3Key,
  }));

  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Stores the parsed email text body to S3.
 */
async function storeBody(emailId: string, parsed: ParsedMail): Promise<string> {
  // Use text body if available and meaningful (>50 chars suggests real content)
  // Fall back to a text representation of HTML if text is just headers/empty
  let bodyContent = parsed.text || '';
  
  // If text body is very short (likely just forwarding headers), try to extract from HTML
  if (bodyContent.length < 50 && parsed.html) {
    // Strip HTML tags for a basic text representation
    bodyContent = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const bodyS3Key = `emails/${emailId}/body.txt`;

  await s3.send(new PutObjectCommand({
    Bucket: PARSED_BUCKET,
    Key: bodyS3Key,
    Body: bodyContent || '(No text body available)',
    ContentType: 'text/plain',
  }));

  return bodyS3Key;
}

interface StoredAttachment {
  attachmentId: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  s3Key: string;
  contentHash: string;
}

/**
 * Stores each attachment individually to S3 and returns metadata.
 */
async function storeAttachments(
  emailId: string,
  attachments: Attachment[],
): Promise<StoredAttachment[]> {
  const results: StoredAttachment[] = [];

  for (const attachment of attachments) {
    const attachmentId = randomUUID();
    const fileName = attachment.filename || `attachment-${attachmentId}`;
    const fileType = attachment.contentType || 'application/octet-stream';
    const content = attachment.content;
    const s3Key = `emails/${emailId}/attachments/${attachmentId}/${fileName}`;

    await s3.send(new PutObjectCommand({
      Bucket: PARSED_BUCKET,
      Key: s3Key,
      Body: content,
      ContentType: fileType,
    }));

    // Compute SHA-256 hash for integrity
    const contentHash = createHash('sha256').update(content).digest('hex');

    results.push({
      attachmentId,
      fileName,
      fileType,
      sizeBytes: content.length,
      s3Key,
      contentHash,
    });
  }

  return results;
}


interface BuildMetadataInput {
  emailId: string;
  parsed: ParsedMail;
  s3Key: string;
  bodyS3Key: string;
  bodyHtmlS3Key?: string;
  attachments: StoredAttachment[];
  archivedAt: string;
  dateIso: string;
  rawEmailSize: number;
}

/**
 * Builds the email metadata record from parsed email data.
 */
function buildMetadata(input: BuildMetadataInput) {
  const { emailId, parsed, s3Key, bodyS3Key, bodyHtmlS3Key, attachments, archivedAt, dateIso, rawEmailSize } = input;

  const sender = parsed.from?.value?.[0]?.address || parsed.from?.text || `unknown-${emailId}`;
  const recipients = (parsed.to
    ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
        .flatMap(addr => addr.value.map(v => v.address || ''))
    : []).filter(Boolean);
  const ccRecipients = (parsed.cc
    ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
        .flatMap(addr => addr.value.map(v => v.address || ''))
    : []).filter(Boolean);
  const bccRecipients = (parsed.bcc
    ? (Array.isArray(parsed.bcc) ? parsed.bcc : [parsed.bcc])
        .flatMap(addr => addr.value.map(v => v.address || ''))
    : []).filter(Boolean);

  const subject = parsed.subject || '(No Subject)';
  const messageId = parsed.messageId || `generated-${emailId}`;

  return {
    emailId,
    messageId,
    sender,
    recipients,
    ccRecipients,
    bccRecipients,
    subject,
    date: dateIso,
    archivedAt,
    rawS3Key: s3Key,
    bodyS3Key,
    bodyHtmlS3Key,
    attachments,
    totalSizeBytes: rawEmailSize,
    attachmentCount: attachments.length,
    retentionPolicyId: 'default',
    purgeEligible: false,
  };
}

/**
 * Writes the email metadata record to DynamoDB.
 */
async function writeToDynamoDB(metadata: ReturnType<typeof buildMetadata>): Promise<void> {
  const item: Record<string, any> = {
    emailId: { S: metadata.emailId },
    messageId: { S: metadata.messageId },
    sender: { S: metadata.sender },
    recipients: { L: metadata.recipients.map(r => ({ S: r })) },
    ccRecipients: { L: metadata.ccRecipients.map(r => ({ S: r })) },
    bccRecipients: { L: metadata.bccRecipients.map(r => ({ S: r })) },
    subject: { S: metadata.subject },
    date: { S: metadata.date },
    archivedAt: { S: metadata.archivedAt },
    rawS3Key: { S: metadata.rawS3Key },
    bodyS3Key: { S: metadata.bodyS3Key },
    totalSizeBytes: { N: String(metadata.totalSizeBytes) },
    attachmentCount: { N: String(metadata.attachmentCount) },
    retentionPolicyId: { S: metadata.retentionPolicyId },
    purgeEligible: { BOOL: metadata.purgeEligible },
    attachments: {
      L: metadata.attachments.map(att => ({
        M: {
          attachmentId: { S: att.attachmentId },
          fileName: { S: att.fileName },
          fileType: { S: att.fileType },
          sizeBytes: { N: String(att.sizeBytes) },
          s3Key: { S: att.s3Key },
          contentHash: { S: att.contentHash },
        },
      })),
    },
  };

  if (metadata.bodyHtmlS3Key) {
    item.bodyHtmlS3Key = { S: metadata.bodyHtmlS3Key };
  }

  await dynamodb.send(new PutItemCommand({
    TableName: EMAIL_TABLE,
    Item: item,
  }));
}

interface PartitionKeys {
  year: string;
  month: string;
  day: string;
}

/**
 * Writes JSON metadata to S3 partitioned by year/month/day.
 * Uses JSON format (compatible with Glue JSON SerDe) for simplicity.
 */
async function writeMetadataToS3(
  metadata: ReturnType<typeof buildMetadata>,
  emailDate: Date,
): Promise<PartitionKeys> {
  const year = String(emailDate.getUTCFullYear());
  const month = String(emailDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(emailDate.getUTCDate()).padStart(2, '0');

  const partitionPath = `metadata/year=${year}/month=${month}/day=${day}`;
  const s3Key = `${partitionPath}/${metadata.emailId}.json`;

  // Write metadata in a format compatible with Glue JSON SerDe
  const metadataRecord = {
    emailId: metadata.emailId,
    messageId: metadata.messageId,
    sender: metadata.sender,
    recipients: metadata.recipients,
    ccRecipients: metadata.ccRecipients,
    bccRecipients: metadata.bccRecipients,
    subject: metadata.subject,
    date: metadata.date,
    archivedAt: metadata.archivedAt,
    hasAttachments: metadata.attachmentCount > 0,
    attachmentCount: metadata.attachmentCount,
    totalSizeBytes: metadata.totalSizeBytes,
  };

  await s3.send(new PutObjectCommand({
    Bucket: METADATA_BUCKET,
    Key: s3Key,
    Body: JSON.stringify(metadataRecord),
    ContentType: 'application/json',
  }));

  return { year, month, day };
}

/**
 * Registers a new Glue partition if it doesn't already exist.
 * Uses BatchCreatePartition to add the year/month/day partition.
 */
async function registerGluePartition(
  partitionKeys: PartitionKeys,
  emailDate: Date,
): Promise<void> {
  const { year, month, day } = partitionKeys;
  const partitionLocation = `s3://${METADATA_BUCKET}/metadata/year=${year}/month=${month}/day=${day}/`;

  try {
    await glue.send(new BatchCreatePartitionCommand({
      DatabaseName: GLUE_DATABASE,
      TableName: GLUE_TABLE,
      PartitionInputList: [
        {
          Values: [year, month, day],
          StorageDescriptor: {
            Location: partitionLocation,
            InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
            OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
            SerdeInfo: {
              SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            },
            Columns: [
              { Name: 'emailId', Type: 'string' },
              { Name: 'messageId', Type: 'string' },
              { Name: 'sender', Type: 'string' },
              { Name: 'recipients', Type: 'array<string>' },
              { Name: 'ccRecipients', Type: 'array<string>' },
              { Name: 'bccRecipients', Type: 'array<string>' },
              { Name: 'subject', Type: 'string' },
              { Name: 'date', Type: 'string' },
              { Name: 'archivedAt', Type: 'string' },
              { Name: 'hasAttachments', Type: 'boolean' },
              { Name: 'attachmentCount', Type: 'int' },
              { Name: 'totalSizeBytes', Type: 'bigint' },
            ],
          },
        },
      ],
    }));
  } catch (error: unknown) {
    // AlreadyExistsException is expected for existing partitions — ignore it
    if (error instanceof Error && error.name === 'AlreadyExistsException') {
      console.log(JSON.stringify({
        level: 'DEBUG',
        event: 'PARTITION_EXISTS',
        partition: `${year}/${month}/${day}`,
        message: 'Partition already exists, skipping creation',
      }));
    } else {
      throw error;
    }
  }
}

/**
 * Emits custom CloudWatch metrics for ingestion monitoring.
 */
async function emitMetrics(params: { success: boolean; latencyMs: number }): Promise<void> {
  const timestamp = new Date();

  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: METRICS_NAMESPACE,
      MetricData: [
        {
          MetricName: 'IngestionRate',
          Value: 1,
          Unit: 'Count',
          Timestamp: timestamp,
        },
        {
          MetricName: 'IngestionLatency',
          Value: params.latencyMs,
          Unit: 'Milliseconds',
          Timestamp: timestamp,
        },
        ...(params.success
          ? []
          : [
              {
                MetricName: 'IngestionFailures',
                Value: 1,
                Unit: 'Count' as const,
                Timestamp: timestamp,
              },
            ]),
      ],
    }));
  } catch (metricsError) {
    // Don't fail the entire processing if metrics emission fails
    console.error('Failed to emit CloudWatch metrics:', metricsError);
  }
}
