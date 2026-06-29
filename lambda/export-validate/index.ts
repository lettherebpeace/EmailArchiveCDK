import { Context } from 'aws-lambda';

/**
 * ValidateRequest Lambda — validates the export request payload.
 * Ensures required fields are present (searchQuery, userId, exportId).
 */

export interface ExportRequest {
  exportId: string;
  userId: string;
  searchQuery: {
    sender?: string;
    recipient?: string;
    subjectContains?: string;
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface ValidateResult extends ExportRequest {
  validated: true;
}

export const handler = async (event: ExportRequest, _context: Context): Promise<ValidateResult> => {
  if (!event.exportId) {
    throw new Error('Missing required field: exportId');
  }
  if (!event.userId) {
    throw new Error('Missing required field: userId');
  }
  if (!event.searchQuery) {
    throw new Error('Missing required field: searchQuery');
  }

  const { sender, recipient, subjectContains, dateFrom, dateTo } = event.searchQuery;
  const hasFilter = !!(sender || recipient || subjectContains || dateFrom || dateTo);

  if (!hasFilter) {
    throw new Error('Search query must have at least one filter criterion');
  }

  return {
    ...event,
    validated: true,
  };
};
