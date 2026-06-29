import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';

/**
 * QueryMatchingEmails Lambda — runs an Athena query to find email IDs matching the search criteria.
 * Returns the list of matching email IDs and their S3 keys along with the fileCount.
 */

const athenaClient = new AthenaClient({});

const GLUE_DATABASE = process.env.GLUE_DATABASE_NAME!;
const GLUE_TABLE = process.env.GLUE_TABLE_NAME!;
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP!;

export interface QueryInput {
  exportId: string;
  userId: string;
  validated: true;
  searchQuery: {
    sender?: string;
    recipient?: string;
    subjectContains?: string;
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface QueryResult {
  exportId: string;
  userId: string;
  searchQuery: QueryInput['searchQuery'];
  fileCount: number;
  emailIds: string[];
}

export const handler = async (event: QueryInput): Promise<QueryResult> => {
  const { searchQuery, exportId, userId } = event;

  // Build WHERE clauses
  const conditions: string[] = [];
  const params: string[] = [];

  if (searchQuery.sender) {
    conditions.push(`sender = ?`);
    params.push(searchQuery.sender);
  }
  if (searchQuery.recipient) {
    conditions.push(`contains(recipients, ?)`);
    params.push(searchQuery.recipient);
  }
  if (searchQuery.subjectContains) {
    conditions.push(`subject LIKE ?`);
    params.push(`%${searchQuery.subjectContains}%`);
  }
  if (searchQuery.dateFrom) {
    conditions.push(`date >= ?`);
    params.push(searchQuery.dateFrom);
  }
  if (searchQuery.dateTo) {
    conditions.push(`date <= ?`);
    params.push(searchQuery.dateTo);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT emailId FROM "${GLUE_DATABASE}"."${GLUE_TABLE}" ${whereClause}`;

  // Start Athena query execution with parameterized query
  const startResponse = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: ATHENA_WORKGROUP,
      ExecutionParameters: params,
    })
  );

  const queryExecutionId = startResponse.QueryExecutionId!;

  // Poll for query completion
  let status = 'RUNNING';
  while (status === 'RUNNING' || status === 'QUEUED') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusResponse = await athenaClient.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );
    status = statusResponse.QueryExecution?.Status?.State || 'FAILED';
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Athena query failed with status: ${status}`);
  }

  // Fetch results
  const resultsResponse = await athenaClient.send(
    new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId })
  );

  const rows = resultsResponse.ResultSet?.Rows || [];
  // Skip header row
  const emailIds = rows.slice(1).map((row) => row.Data?.[0]?.VarCharValue || '').filter(Boolean);

  return {
    exportId,
    userId,
    searchQuery,
    fileCount: emailIds.length,
    emailIds,
  };
};
