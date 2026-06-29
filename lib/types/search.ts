/**
 * Search-related interfaces for the Email Archive Solution.
 */

/** Query parameters for email metadata search via Athena. */
export interface SearchQuery {
  sender?: string;                    // Exact match on sender address
  recipient?: string;                 // Exact match within recipients array
  subjectContains?: string;           // LIKE/contains match on subject
  dateFrom?: string;                  // ISO 8601 (inclusive)
  dateTo?: string;                    // ISO 8601 (inclusive)
  hasAttachments?: boolean;
  page?: number;                      // Default: 1
  pageSize?: number;                  // Default: 25, max: 100
  sortField?: 'date' | 'sender' | 'subject';
  sortOrder?: 'asc' | 'desc';        // Default: desc
}

/** Paginated search result returned by the Query Service. */
export interface SearchResult {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  queryExecutionId: string;           // Athena query execution ID (for debugging)
  results: SearchResultItem[];
}

/** Individual item within search results. */
export interface SearchResultItem {
  emailId: string;
  sender: string;
  recipients: string[];
  date: string;
  subject: string;
  hasAttachments: boolean;
  attachmentCount: number;
}
