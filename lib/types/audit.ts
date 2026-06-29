/**
 * Audit logging interfaces for the Email Archive Solution.
 */

/** Audit trail entry for tracking user operations. */
export interface AuditEntry {
  auditId: string;
  userId: string;
  userRole: string;
  timestamp: string;
  operation:
    | 'SEARCH'
    | 'VIEW_EMAIL'
    | 'DOWNLOAD_ATTACHMENT'
    | 'CREATE_POLICY'
    | 'UPDATE_POLICY'
    | 'LOGIN'
    | 'LOGOUT';
  resourceId?: string;
  requestDetails: Record<string, unknown>;
  sourceIp: string;
  userAgent: string;
}
