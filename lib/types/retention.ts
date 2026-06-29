/**
 * Retention policy interfaces for the Email Archive Solution.
 */

/** Retention policy definition (used for CRUD operations). */
export interface RetentionPolicy {
  policyId: string;
  name: string;
  durationDays: number;     // 1-36500, or -1 for indefinite
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** Retention policy record stored in DynamoDB. */
export interface RetentionPolicyRecord {
  policyId: string;                   // PK - UUID v4
  name: string;
  durationDays: number;               // 1-36500, or -1 for indefinite
  isIndefinite: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;                  // Cognito user ID
  emailCount?: number;                // Approximate count of emails under this policy
}
