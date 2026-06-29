// Shared TypeScript interfaces for the Email Archive frontend

export interface EmailMetadata {
  emailId: string;
  messageId: string;
  sender: string;
  recipients: string[];
  ccRecipients: string[];
  bccRecipients: string[];
  subject: string;
  date: string;
  archivedAt: string;
  bodyS3Key: string;
  attachments: AttachmentMeta[];
  rawS3Key: string;
  sizeBytes: number;
  retentionPolicyId: string;
  retentionExpiresAt?: string;
}

export interface AttachmentMeta {
  attachmentId: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  s3Key: string;
}

export interface SearchQuery {
  sender?: string;
  recipient?: string;
  subjectContains?: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachments?: boolean;
  page?: number;
  pageSize?: number;
  sortField?: 'date' | 'sender' | 'subject';
  sortOrder?: 'asc' | 'desc';
}

export interface SearchResult {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  queryExecutionId: string;
  results: SearchResultItem[];
}

export interface SearchResultItem {
  emailId: string;
  sender: string;
  recipients: string[];
  date: string;
  subject: string;
  hasAttachments: boolean;
  attachmentCount: number;
}

export interface ExportJob {
  exportId: string;
  userId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  searchQuery: SearchQuery;
  fileCount: number;
  totalSizeBytes: number;
  s3Key?: string;
  presignedUrl?: string;
  expiresAt?: string;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface RetentionPolicy {
  policyId: string;
  name: string;
  durationDays: number;
  isIndefinite: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  emailCount?: number;
}

export interface EmailDetail {
  emailId: string;
  messageId: string;
  sender: string;
  recipients: string[];
  ccRecipients: string[];
  bccRecipients: string[];
  subject: string;
  date: string;
  archivedAt: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments: AttachmentMeta[];
  sizeBytes: number;
  retentionPolicyId: string;
  retentionExpiresAt?: string;
}

export interface RetentionPolicyInput {
  name: string;
  durationDays: number;
  isIndefinite?: boolean;
}

export interface UserSession {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  userGroups: string[];
  username: string;
}
