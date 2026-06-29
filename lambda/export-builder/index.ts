import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient, UpdateItemCommand, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';
import { Readable } from 'stream';
import { deflateRawSync } from 'zlib';

// Environment variables
const RAW_BUCKET = process.env.RAW_BUCKET!;
const EXPORTS_BUCKET = process.env.EXPORTS_BUCKET!;
const EXPORT_JOBS_TABLE = process.env.EXPORT_JOBS_TABLE!;
const EMAIL_TABLE = process.env.EMAIL_TABLE || 'EmailMetadata';

// AWS SDK clients
const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

/** Presigned URL expiry in seconds (15 minutes). */
const PRESIGNED_URL_EXPIRY_SECONDS = 900;

/**
 * Input event from Step Functions.
 * emailIds come from the query Lambda; s3Keys are looked up from DynamoDB.
 */
interface ExportBuilderEvent {
  exportId: string;
  emailIds: string[];
  s3Keys?: string[]; // Optional — will be looked up from DynamoDB if not provided
}

/**
 * Output returned to Step Functions on success.
 */
interface ExportBuilderResult {
  exportId: string;
  status: 'COMPLETED';
  s3Key: string;
  presignedUrl: string;
  expiresAt: string;
  fileCount: number;
  totalSizeBytes: number;
}

/**
 * Export Builder Lambda handler.
 *
 * Reads matching .eml files from the raw S3 bucket, packages them into a
 * ZIP archive, uploads the ZIP to the exports S3 bucket, generates a
 * presigned URL with 1-hour expiry, and updates the ExportJobs DynamoDB table.
 *
 * Requirements: 3.6
 */
export async function handler(event: ExportBuilderEvent): Promise<ExportBuilderResult> {
  const { exportId, emailIds } = event;

  // Look up S3 keys from DynamoDB if not provided in the event
  let s3Keys = event.s3Keys;
  if (!s3Keys || s3Keys.length === 0) {
    s3Keys = await lookupS3Keys(emailIds);
  }

  console.log(JSON.stringify({
    level: 'INFO',
    event: 'EXPORT_STARTED',
    exportId,
    fileCount: s3Keys.length,
    message: `Starting export ${exportId} with ${s3Keys.length} files`,
  }));

  try {
    // Update status to RUNNING
    await updateExportJobStatus(exportId, 'RUNNING');

    // Build ZIP archive from .eml files
    const zipS3Key = `exports/${exportId}.zip`;
    const totalSizeBytes = await buildZipArchive(s3Keys, emailIds, zipS3Key);

    // Generate presigned URL for download (1-hour expiry)
    const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();
    const presignedUrl = await generatePresignedUrl(zipS3Key);

    // Update export job status to COMPLETED
    await updateExportJobCompleted(exportId, zipS3Key, presignedUrl, expiresAt, s3Keys.length, totalSizeBytes);

    console.log(JSON.stringify({
      level: 'INFO',
      event: 'EXPORT_COMPLETED',
      exportId,
      s3Key: zipS3Key,
      fileCount: s3Keys.length,
      totalSizeBytes,
      message: `Export ${exportId} completed successfully`,
    }));

    return {
      exportId,
      status: 'COMPLETED',
      s3Key: zipS3Key,
      presignedUrl,
      expiresAt,
      fileCount: s3Keys.length,
      totalSizeBytes,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'EXPORT_FAILED',
      exportId,
      error: errorMessage,
      message: `Export ${exportId} failed: ${errorMessage}`,
    }));

    // Update export job status to FAILED with error message
    await updateExportJobFailed(exportId, errorMessage);

    throw error;
  }
}

/**
 * Reads .eml files from S3 and packages them into a ZIP archive uploaded to the exports bucket.
 * Returns the total uncompressed size of all .eml files.
 */
async function buildZipArchive(s3Keys: string[], emailIds: string[], zipS3Key: string): Promise<number> {
  let totalSizeBytes = 0;

  // Build ZIP in memory using Node.js zlib (pure implementation, no external deps)
  const files: { name: string; content: Buffer }[] = [];

  for (let i = 0; i < s3Keys.length; i++) {
    const s3Key = s3Keys[i];
    const emailId = emailIds[i] || `email-${i}`;
    const emailContent = await getEmailFromS3(s3Key);
    totalSizeBytes += emailContent.length;
    files.push({ name: `${emailId}.eml`, content: emailContent });
  }

  // Create ZIP buffer using minimal ZIP format
  const zipBuffer = createZipBuffer(files);

  // Upload to S3
  await s3.send(new PutObjectCommand({
    Bucket: EXPORTS_BUCKET,
    Key: zipS3Key,
    Body: zipBuffer,
    ContentType: 'application/zip',
  }));

  return totalSizeBytes;
}

/**
 * Creates a valid ZIP file buffer from an array of files.
 * Uses DEFLATE compression via Node.js built-in zlib.
 * Implements ZIP format per PKWARE APPNOTE spec.
 */
function createZipBuffer(files: { name: string; content: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.content, { level: 6 });
    const crc = crc32(file.content);

    // Local file header (30 bytes + filename + compressed data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);  // Local file header signature
    localHeader.writeUInt16LE(20, 4);           // Version needed (2.0)
    localHeader.writeUInt16LE(0, 6);            // General purpose flags
    localHeader.writeUInt16LE(8, 8);            // Compression method (DEFLATE)
    localHeader.writeUInt16LE(0, 10);           // Last mod time
    localHeader.writeUInt16LE(0, 12);           // Last mod date
    localHeader.writeUInt32LE(crc, 14);         // CRC-32
    localHeader.writeUInt32LE(compressed.length, 18); // Compressed size
    localHeader.writeUInt32LE(file.content.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // Filename length
    localHeader.writeUInt16LE(0, 28);           // Extra field length

    const localEntry = Buffer.concat([localHeader, nameBuffer, compressed]);
    localHeaders.push(localEntry);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed
    centralHeader.writeUInt16LE(0, 8);          // General purpose flags
    centralHeader.writeUInt16LE(8, 10);         // Compression method (DEFLATE)
    centralHeader.writeUInt16LE(0, 12);         // Last mod time
    centralHeader.writeUInt16LE(0, 14);         // Last mod date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(compressed.length, 20); // Compressed size
    centralHeader.writeUInt32LE(file.content.length, 24); // Uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28); // Filename length
    centralHeader.writeUInt16LE(0, 30);         // Extra field length
    centralHeader.writeUInt16LE(0, 32);         // File comment length
    centralHeader.writeUInt16LE(0, 34);         // Disk number start
    centralHeader.writeUInt16LE(0, 36);         // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);         // External file attributes
    centralHeader.writeUInt32LE(offset, 42);    // Relative offset of local header

    centralHeaders.push(Buffer.concat([centralHeader, nameBuffer]));
    offset += localEntry.length;
  }

  // End of central directory record (22 bytes)
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);       // End of central directory signature
  endRecord.writeUInt16LE(0, 4);                // Disk number
  endRecord.writeUInt16LE(0, 6);                // Disk with central directory
  endRecord.writeUInt16LE(files.length, 8);     // Entries on this disk
  endRecord.writeUInt16LE(files.length, 10);    // Total entries
  endRecord.writeUInt32LE(centralDirSize, 12);  // Size of central directory
  endRecord.writeUInt32LE(offset, 16);          // Offset of central directory
  endRecord.writeUInt16LE(0, 20);               // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, endRecord]);
}

/**
 * Computes CRC-32 checksum for a buffer (required by ZIP format).
 */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Retrieves a raw email file from S3.
 */
async function getEmailFromS3(s3Key: string): Promise<Buffer> {
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
 * Generates a presigned URL for downloading the ZIP from the exports bucket.
 */
async function generatePresignedUrl(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: EXPORTS_BUCKET,
    Key: s3Key,
  });

  return getSignedUrl(s3, command, { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS });
}

/**
 * Updates the export job status in DynamoDB.
 */
async function updateExportJobStatus(exportId: string, status: string): Promise<void> {
  await dynamodb.send(new UpdateItemCommand({
    TableName: EXPORT_JOBS_TABLE,
    Key: { exportId: { S: exportId } },
    UpdateExpression: 'SET #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': { S: status } },
  }));
}

/**
 * Updates the export job with COMPLETED status and all result fields.
 */
async function updateExportJobCompleted(
  exportId: string,
  s3Key: string,
  presignedUrl: string,
  expiresAt: string,
  fileCount: number,
  totalSizeBytes: number,
): Promise<void> {
  await dynamodb.send(new UpdateItemCommand({
    TableName: EXPORT_JOBS_TABLE,
    Key: { exportId: { S: exportId } },
    UpdateExpression: 'SET #status = :status, s3Key = :s3Key, presignedUrl = :presignedUrl, expiresAt = :expiresAt, fileCount = :fileCount, totalSizeBytes = :totalSizeBytes, completedAt = :completedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: 'COMPLETED' },
      ':s3Key': { S: s3Key },
      ':presignedUrl': { S: presignedUrl },
      ':expiresAt': { S: expiresAt },
      ':fileCount': { N: String(fileCount) },
      ':totalSizeBytes': { N: String(totalSizeBytes) },
      ':completedAt': { S: new Date().toISOString() },
    },
  }));
}

/**
 * Updates the export job with FAILED status and error message.
 */
async function updateExportJobFailed(exportId: string, errorMessage: string): Promise<void> {
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: EXPORT_JOBS_TABLE,
      Key: { exportId: { S: exportId } },
      UpdateExpression: 'SET #status = :status, errorMessage = :errorMessage, completedAt = :completedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: 'FAILED' },
        ':errorMessage': { S: errorMessage },
        ':completedAt': { S: new Date().toISOString() },
      },
    }));
  } catch (updateError) {
    // Log but don't throw — we don't want to mask the original error
    console.error('Failed to update export job status to FAILED:', updateError);
  }
}

/**
 * Looks up rawS3Key values from DynamoDB for a list of email IDs.
 * Uses BatchGetItem for efficiency.
 */
async function lookupS3Keys(emailIds: string[]): Promise<string[]> {
  const s3Keys: string[] = [];

  // BatchGetItem supports max 100 items per request
  const batchSize = 100;
  for (let i = 0; i < emailIds.length; i += batchSize) {
    const batch = emailIds.slice(i, i + batchSize);
    const keys = batch.map(id => ({ emailId: { S: id } }));

    const result = await dynamodb.send(new BatchGetItemCommand({
      RequestItems: {
        [EMAIL_TABLE]: {
          Keys: keys,
          ProjectionExpression: 'emailId, rawS3Key',
        },
      },
    }));

    const items = result.Responses?.[EMAIL_TABLE] || [];
    for (const item of items) {
      const rawS3Key = item.rawS3Key?.S;
      if (rawS3Key) {
        s3Keys.push(rawS3Key);
      }
    }
  }

  return s3Keys;
}
