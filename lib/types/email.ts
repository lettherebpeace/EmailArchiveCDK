/**
 * Email-related interfaces for the Email Archive Solution.
 */

/** Metadata extracted during email ingestion (used by processor Lambda). */
export interface EmailMetadata {
  emailId: string;          // UUID v4
  messageId: string;        // RFC 5322 Message-ID
  sender: string;
  recipients: string[];
  ccRecipients: string[];
  bccRecipients: string[];
  subject: string;
  date: string;             // ISO 8601
  archivedAt: string;       // ISO 8601
  bodyS3Key: string;
  attachments: AttachmentMeta[];
  rawS3Key: string;
  sizeBytes: number;
  retentionPolicyId: string;
  retentionExpiresAt?: string;
}

/** Attachment metadata captured during ingestion. */
export interface AttachmentMeta {
  attachmentId: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  s3Key: string;
}

/** Full email record stored in DynamoDB. */
export interface EmailRecord {
  emailId: string;
  messageId: string;
  sender: string;
  recipients: string[];
  ccRecipients: string[];
  bccRecipients: string[];
  subject: string;
  date: string;
  archivedAt: string;
  rawS3Key: string;
  bodyS3Key: string;
  bodyHtmlS3Key?: string;
  attachments: AttachmentRecord[];
  totalSizeBytes: number;
  attachmentCount: number;
  retentionPolicyId: string;
  retentionExpiresAt?: string;
  purgeEligible: boolean;
  lastAccessedAt?: string;
  lastAccessedBy?: string;
}

/** Attachment record stored in DynamoDB as part of an EmailRecord. */
export interface AttachmentRecord {
  attachmentId: string;
  fileName: string;
  fileType: string;         // MIME type
  sizeBytes: number;
  s3Key: string;
  contentHash: string;      // SHA-256 for integrity
}
