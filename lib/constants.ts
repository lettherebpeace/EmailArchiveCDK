/**
 * Shared constants for the Email Archive Solution.
 */

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

/** Maximum email size in bytes (40 MB). */
export const MAX_EMAIL_SIZE_BYTES = 41_943_040;

/** Maximum number of attachments per email. */
export const MAX_ATTACHMENTS_PER_EMAIL = 500;

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

/** Maximum number of retry attempts for failed email processing. */
export const MAX_RETRY_ATTEMPTS = 5;

/** Initial backoff delay in seconds for retry logic. */
export const INITIAL_BACKOFF_SECONDS = 30;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Default page size for search results. */
export const DEFAULT_PAGE_SIZE = 25;

/** Maximum page size allowed for search queries. */
export const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Maximum number of email files in a single export. */
export const MAX_EXPORT_FILES = 1000;

/** Presigned URL expiry duration for export downloads (in hours). */
export const EXPORT_URL_EXPIRY_HOURS = 1;

// ---------------------------------------------------------------------------
// Authentication / session
// ---------------------------------------------------------------------------

/** Session idle timeout in minutes. */
export const SESSION_TIMEOUT_MINUTES = 30;

/** Number of consecutive failed login attempts before account lockout. */
export const LOCKOUT_THRESHOLD = 5;

/** Account lockout duration in minutes. */
export const LOCKOUT_DURATION_MINUTES = 15;

// ---------------------------------------------------------------------------
// Athena / search
// ---------------------------------------------------------------------------

/** Athena query execution timeout in milliseconds (30 seconds). */
export const ATHENA_QUERY_TIMEOUT_MS = 30_000;

/** Athena bytes-scanned limit per query (10 GB). */
export const ATHENA_BYTES_SCAN_LIMIT = 10_737_418_240;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Minimum retention period in days. */
export const RETENTION_MIN_DAYS = 1;

/** Maximum retention period in days (~100 years). */
export const RETENTION_MAX_DAYS = 36_500;

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

/** CloudWatch custom metrics namespace. */
export const METRICS_NAMESPACE = 'EmailArchive';

// ---------------------------------------------------------------------------
// Bucket naming
// ---------------------------------------------------------------------------

/**
 * Generates a tenant-scoped S3 bucket name.
 *
 * Format: `email-archive-{purpose}-{accountId}`
 *
 * @param purpose - The bucket purpose (e.g. 'raw', 'parsed', 'metadata', 'exports', 'athena-results', 'web')
 * @param accountId - The AWS account ID for tenant isolation
 */
export function bucketName(purpose: string, accountId: string): string {
  return `email-archive-${purpose}-${accountId}`;
}
