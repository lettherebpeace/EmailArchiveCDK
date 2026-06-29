/**
 * Export-related interfaces for the Email Archive Solution.
 */

import { SearchQuery } from './search';

/** Export job record stored in DynamoDB. */
export interface ExportJob {
  exportId: string;           // UUID v4
  userId: string;             // Cognito user ID
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  searchQuery: SearchQuery;   // Original query that produced results
  fileCount: number;
  totalSizeBytes: number;
  s3Key?: string;             // Key of ZIP in exports bucket
  presignedUrl?: string;      // Presigned download URL
  expiresAt?: string;         // URL expiry time (ISO 8601)
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
}
