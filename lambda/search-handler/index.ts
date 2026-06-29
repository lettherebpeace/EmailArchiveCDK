import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';

/**
 * Search Handler Lambda function.
 *
 * Accepts a SearchQuery, validates filters, builds parameterized Athena SQL,
 * executes the query, polls for completion, and returns paginated results.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.7, 3.8, 3.9
 */

// Environment variables
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP!;
const GLUE_DATABASE = process.env.GLUE_DATABASE!;
const GLUE_TABLE = process.env.GLUE_TABLE!;
const ATHENA_RESULTS_BUCKET = process.env.ATHENA_RESULTS_BUCKET!;

// Constants
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const ATHENA_QUERY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

// AWS SDK client
const athena = new AthenaClient({});

// --- Types (mirroring lib/types/search.ts for Lambda runtime) ---

interface SearchQuery {
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

interface SearchResult {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  queryExecutionId: string;
  results: SearchResultItem[];
}

interface SearchResultItem {
  emailId: string;
  sender: string;
  recipients: string[];
  date: string;
  subject: string;
  hasAttachments: boolean;
  attachmentCount: number;
}

interface SearchResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

// --- Handler ---

export async function handler(event: SearchQuery): Promise<SearchResponse> {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    // Step 1: Validate input — at least one filter must be provided
    const validationError = validateQuery(event);
    if (validationError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: validationError }),
        headers,
      };
    }

    // Step 2: Normalize pagination parameters
    const page = Math.max(1, event.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, event.pageSize ?? DEFAULT_PAGE_SIZE));
    const sortField = event.sortField ?? 'date';
    const sortOrder = event.sortOrder ?? 'desc';

    // Step 3: Build parameterized SQL query
    const { sql, parameters } = buildQuery(event, page, pageSize, sortField, sortOrder);

    console.log(JSON.stringify({
      level: 'INFO',
      event: 'SEARCH_QUERY',
      sql,
      parameterCount: parameters.length,
      page,
      pageSize,
    }));

    // Step 4: Execute Athena query
    const queryExecutionId = await startQuery(sql, parameters);

    // Step 5: Poll for query completion (max 30s)
    const state = await pollQueryExecution(queryExecutionId);

    if (state === QueryExecutionState.FAILED) {
      // Check if the failure was due to bytes scanned limit
      const executionDetails = await athena.send(new GetQueryExecutionCommand({
        QueryExecutionId: queryExecutionId,
      }));
      const reason = executionDetails.QueryExecution?.Status?.StateChangeReason || '';

      if (reason.toLowerCase().includes('bytes scanned limit')) {
        return {
          statusCode: 413,
          body: JSON.stringify({
            error: 'Query exceeded the maximum data scan limit. Please narrow your search criteria.',
            queryExecutionId,
          }),
          headers,
        };
      }

      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Search query failed. Please try again.',
          queryExecutionId,
        }),
        headers,
      };
    }

    if (state === QueryExecutionState.CANCELLED) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Search query was cancelled.',
          queryExecutionId,
        }),
        headers,
      };
    }

    if (state === 'TIMEOUT') {
      return {
        statusCode: 504,
        body: JSON.stringify({
          error: 'Search query timed out. Please narrow your search criteria and try again.',
          queryExecutionId,
        }),
        headers,
      };
    }

    // Step 6: Read results
    const allResults = await getQueryResults(queryExecutionId);

    // Client-side pagination: skip rows for earlier pages
    const startIdx = (page - 1) * pageSize;
    const results = allResults.slice(startIdx, startIdx + pageSize);

    // Step 7: Build count query to get total count
    const { sql: countSql, parameters: countParams } = buildCountQuery(event);
    const countQueryExecutionId = await startQuery(countSql, countParams);
    const countState = await pollQueryExecution(countQueryExecutionId);

    let totalCount = allResults.length;
    if (countState === QueryExecutionState.SUCCEEDED) {
      totalCount = await getCountResult(countQueryExecutionId);
    }

    const totalPages = Math.ceil(totalCount / pageSize);

    // Step 8: Return response
    const searchResult: SearchResult = {
      totalCount,
      page,
      pageSize,
      totalPages,
      queryExecutionId,
      results,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(searchResult),
      headers,
    };
  } catch (error) {
    console.error('Search handler error:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'An unexpected error occurred while processing your search. Please try again.',
      }),
      headers,
    };
  }
}

// --- Validation ---

/**
 * Validates that at least one filter is provided.
 * Returns an error message if invalid, or null if valid.
 */
export function validateQuery(query: SearchQuery): string | null {
  const hasFilter =
    (query.sender != null && query.sender.trim() !== '') ||
    (query.recipient != null && query.recipient.trim() !== '') ||
    (query.subjectContains != null && query.subjectContains.trim() !== '') ||
    (query.dateFrom != null && query.dateFrom.trim() !== '') ||
    (query.dateTo != null && query.dateTo.trim() !== '') ||
    query.hasAttachments != null;

  if (!hasFilter) {
    return 'At least one search filter must be provided. Please specify sender, recipient, subject, date range, or attachment filter.';
  }

  // Validate page size range
  if (query.pageSize != null && (query.pageSize < 1 || query.pageSize > MAX_PAGE_SIZE)) {
    return `Page size must be between 1 and ${MAX_PAGE_SIZE}.`;
  }

  // Validate date formats if provided
  if (query.dateFrom && !isValidISODate(query.dateFrom)) {
    return 'dateFrom must be a valid ISO 8601 date string.';
  }
  if (query.dateTo && !isValidISODate(query.dateTo)) {
    return 'dateTo must be a valid ISO 8601 date string.';
  }

  // Validate sortField
  if (query.sortField && !['date', 'sender', 'subject'].includes(query.sortField)) {
    return 'sortField must be one of: date, sender, subject.';
  }

  // Validate sortOrder
  if (query.sortOrder && !['asc', 'desc'].includes(query.sortOrder)) {
    return 'sortOrder must be one of: asc, desc.';
  }

  return null;
}

function isValidISODate(dateStr: string): boolean {
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

// --- Query Construction ---

interface QueryParts {
  sql: string;
  parameters: string[];
}

/**
 * Builds a parameterized Athena SQL query dynamically based on provided filters.
 * Uses AND logic for combining multiple filters.
 * All user input is passed via execution parameters — never embedded in SQL.
 */
export function buildQuery(
  query: SearchQuery,
  page: number,
  pageSize: number,
  sortField: string,
  sortOrder: string,
): QueryParts {
  const conditions: string[] = [];
  const parameters: string[] = [];

  // Sender filter (exact match, case-insensitive)
  if (query.sender && query.sender.trim() !== '') {
    conditions.push('LOWER(sender) = LOWER(?)');
    parameters.push(query.sender.trim());
  }

  // Recipient filter (check if recipient is in the recipients array)
  if (query.recipient && query.recipient.trim() !== '') {
    conditions.push('contains(recipients, ?)');
    parameters.push(query.recipient.trim());
  }

  // Subject contains filter (case-insensitive LIKE)
  if (query.subjectContains && query.subjectContains.trim() !== '') {
    conditions.push('LOWER(subject) LIKE LOWER(?)');
    parameters.push(`%${query.subjectContains.trim()}%`);
  }

  // Date range filters using partition keys for efficient querying
  if (query.dateFrom && query.dateFrom.trim() !== '') {
    conditions.push("date >= ?");
    parameters.push(query.dateFrom.trim());
  }

  if (query.dateTo && query.dateTo.trim() !== '') {
    conditions.push("date <= ?");
    parameters.push(query.dateTo.trim());
  }

  // Has attachments filter
  if (query.hasAttachments != null) {
    conditions.push('hasAttachments = ?');
    parameters.push(String(query.hasAttachments));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Map sortField to actual column name
  const sortColumn = sortField === 'date' ? 'date' : sortField;
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Athena doesn't support OFFSET. For pagination, we fetch more rows and skip client-side.
  // For a production system, cursor-based pagination would be better.
  const fetchLimit = page * pageSize;

  const sql = `SELECT emailId, sender, recipients, subject, date, hasAttachments, attachmentCount ` +
    `FROM "${GLUE_DATABASE}"."${GLUE_TABLE}" ` +
    `${whereClause} ` +
    `ORDER BY ${sortColumn} ${order} ` +
    `LIMIT ${fetchLimit}`;

  return { sql, parameters };
}

/**
 * Builds a COUNT query to get total matching results for pagination.
 */
export function buildCountQuery(query: SearchQuery): QueryParts {
  const conditions: string[] = [];
  const parameters: string[] = [];

  if (query.sender && query.sender.trim() !== '') {
    conditions.push('LOWER(sender) = LOWER(?)');
    parameters.push(query.sender.trim());
  }

  if (query.recipient && query.recipient.trim() !== '') {
    conditions.push('contains(recipients, ?)');
    parameters.push(query.recipient.trim());
  }

  if (query.subjectContains && query.subjectContains.trim() !== '') {
    conditions.push('LOWER(subject) LIKE LOWER(?)');
    parameters.push(`%${query.subjectContains.trim()}%`);
  }

  if (query.dateFrom && query.dateFrom.trim() !== '') {
    conditions.push("date >= ?");
    parameters.push(query.dateFrom.trim());
  }

  if (query.dateTo && query.dateTo.trim() !== '') {
    conditions.push("date <= ?");
    parameters.push(query.dateTo.trim());
  }

  if (query.hasAttachments != null) {
    conditions.push('hasAttachments = ?');
    parameters.push(String(query.hasAttachments));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT COUNT(*) as total FROM "${GLUE_DATABASE}"."${GLUE_TABLE}" ${whereClause}`;

  return { sql, parameters };
}

// --- Athena Execution ---

/**
 * Starts an Athena query execution with parameterized queries.
 */
async function startQuery(sql: string, parameters: string[]): Promise<string> {
  const response = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: ATHENA_WORKGROUP,
    QueryExecutionContext: {
      Database: GLUE_DATABASE,
    },
    ExecutionParameters: parameters,
    ResultConfiguration: {
      OutputLocation: `s3://${ATHENA_RESULTS_BUCKET}/`,
    },
  }));

  if (!response.QueryExecutionId) {
    throw new Error('Athena did not return a QueryExecutionId');
  }

  return response.QueryExecutionId;
}

/**
 * Polls Athena query execution until it completes, fails, or times out (30s).
 */
async function pollQueryExecution(queryExecutionId: string): Promise<string> {
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= ATHENA_QUERY_TIMEOUT_MS) {
      return 'TIMEOUT';
    }

    const response = await athena.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryExecutionId,
    }));

    const state = response.QueryExecution?.Status?.State;

    if (state === QueryExecutionState.SUCCEEDED ||
        state === QueryExecutionState.FAILED ||
        state === QueryExecutionState.CANCELLED) {
      return state;
    }

    // Wait before polling again
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Reads query results from Athena and maps them to SearchResultItem objects.
 */
async function getQueryResults(queryExecutionId: string): Promise<SearchResultItem[]> {
  const results: SearchResultItem[] = [];
  let nextToken: string | undefined;

  do {
    const response = await athena.send(new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId,
      NextToken: nextToken,
    }));

    const rows = response.ResultSet?.Rows || [];
    // First row is the header row on the first page (no NextToken)
    const startIndex = nextToken ? 0 : 1;

    for (let i = startIndex; i < rows.length; i++) {
      const row = rows[i];
      const data = row.Data || [];

      const item: SearchResultItem = {
        emailId: data[0]?.VarCharValue || '',
        sender: data[1]?.VarCharValue || '',
        recipients: parseArrayField(data[2]?.VarCharValue || '[]'),
        subject: data[3]?.VarCharValue || '',
        date: data[4]?.VarCharValue || '',
        hasAttachments: data[5]?.VarCharValue === 'true',
        attachmentCount: parseInt(data[6]?.VarCharValue || '0', 10),
      };

      results.push(item);
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return results;
}

/**
 * Reads the total count from a COUNT query result.
 */
async function getCountResult(queryExecutionId: string): Promise<number> {
  const response = await athena.send(new GetQueryResultsCommand({
    QueryExecutionId: queryExecutionId,
  }));

  const rows = response.ResultSet?.Rows || [];
  // Row 0 is the header, Row 1 is the count value
  if (rows.length >= 2 && rows[1].Data && rows[1].Data[0]?.VarCharValue) {
    return parseInt(rows[1].Data[0].VarCharValue, 10);
  }

  return 0;
}

/**
 * Parses an Athena array field (returned as string representation).
 * Athena returns arrays like: [value1, value2, value3]
 */
function parseArrayField(value: string): string[] {
  if (!value || value === '[]') return [];

  // Athena returns arrays as "[val1, val2, val3]"
  const trimmed = value.replace(/^\[|\]$/g, '').trim();
  if (trimmed === '') return [];

  return trimmed.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
