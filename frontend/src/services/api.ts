import axios from 'axios';
import { fetchAuthSession } from 'aws-amplify/auth';
import { config } from '../config';
import type {
  SearchQuery,
  SearchResult,
  EmailDetail,
  ExportJob,
  RetentionPolicy,
  RetentionPolicyInput,
} from '../types';

/**
 * Custom error thrown when the server returns a 403 Forbidden response.
 * UI components can catch this to display an access denied message.
 */
export class AccessDeniedError extends Error {
  constructor(message = 'Access denied. You do not have permission to perform this action.') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Axios instance configured with the API base URL and auth interceptors.
 */
const api = axios.create({
  baseURL: config.apiUrl,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Request interceptor: attaches the Cognito ID token as a Bearer token
 * on every outgoing request. API Gateway Cognito authorizer validates ID tokens.
 */
api.interceptors.request.use(async (requestConfig) => {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (token) {
      requestConfig.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // If we can't get a session, proceed without the token.
    // The server will return 401 and the response interceptor will handle it.
  }
  return requestConfig;
});

/**
 * Response interceptor: handles authentication/authorization errors.
 * - 401 Unauthorized → redirect to login page
 * - 403 Forbidden → throw AccessDeniedError for UI display
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error) && error.response) {
      const { status } = error.response;

      if (status === 401) {
        window.location.href = '/login';
        return Promise.reject(error);
      }

      if (status === 403) {
        return Promise.reject(
          new AccessDeniedError(
            error.response.data?.message ||
              'Access denied. You do not have permission to perform this action.'
          )
        );
      }
    }
    return Promise.reject(error);
  }
);

// ---------------------------------------------------------------------------
// Typed service functions
// ---------------------------------------------------------------------------

/**
 * Execute a metadata search query against the email archive.
 */
export async function searchEmails(query: SearchQuery): Promise<SearchResult> {
  const response = await api.post<SearchResult>('/search', query);
  return response.data;
}

/**
 * Retrieve full email details including body and attachment metadata.
 */
export async function getEmail(emailId: string): Promise<EmailDetail> {
  const response = await api.get<EmailDetail>(`/emails/${encodeURIComponent(emailId)}`);
  return response.data;
}

/**
 * Get a presigned download URL for a specific email attachment.
 */
export async function getAttachmentUrl(emailId: string, attachmentId: string): Promise<string> {
  const response = await api.get<{ presignedUrl: string }>(
    `/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  return response.data.presignedUrl;
}

/**
 * Create a new export job for the given search query.
 * Returns the export ID to poll for status.
 */
export async function createExport(searchQuery: SearchQuery): Promise<{ exportId: string }> {
  const response = await api.post<{ exportId: string }>('/exports', { searchQuery });
  return response.data;
}

/**
 * Get the current status of an export job.
 */
export async function getExportStatus(exportId: string): Promise<ExportJob> {
  const response = await api.get<ExportJob>(`/exports/${encodeURIComponent(exportId)}`);
  return response.data;
}

/**
 * List all retention policies. Requires Administrator role.
 */
export async function listRetentionPolicies(): Promise<RetentionPolicy[]> {
  const response = await api.get<RetentionPolicy[]>('/retention-policies');
  return response.data;
}

/**
 * Create a new retention policy. Requires Administrator role.
 */
export async function createRetentionPolicy(input: RetentionPolicyInput): Promise<RetentionPolicy> {
  const response = await api.post<RetentionPolicy>('/retention-policies', input);
  return response.data;
}

/**
 * Update an existing retention policy. Requires Administrator role.
 */
export async function updateRetentionPolicy(
  id: string,
  input: RetentionPolicyInput
): Promise<RetentionPolicy> {
  const response = await api.put<RetentionPolicy>(
    `/retention-policies/${encodeURIComponent(id)}`,
    input
  );
  return response.data;
}

export default api;
