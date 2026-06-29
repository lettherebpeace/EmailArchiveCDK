import { useState, useCallback } from 'react';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
} from 'aws-amplify/auth';

export interface AuthUser {
  username: string;
  userId: string;
  groups: string[];
}

export interface AuthTokens {
  accessToken: string;
  idToken: string;
}

interface UseAuthReturn {
  signInUser: (email: string, password: string) => Promise<AuthUser>;
  signOutUser: () => Promise<void>;
  getUser: () => Promise<AuthUser | null>;
  getSession: () => Promise<AuthTokens | null>;
  refreshSession: () => Promise<AuthTokens | null>;
}

/**
 * Custom hook wrapping AWS Amplify Auth operations.
 * Tokens are kept in memory (returned from fetchAuthSession) — never persisted to localStorage.
 */
export function useAuth(): UseAuthReturn {
  // Suppress unused warning — state kept for potential future error tracking
  const [, setError] = useState<string | null>(null);

  const signInUser = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    setError(null);
    const result = await signIn({ username: email, password });
    if (!result.isSignedIn) {
      throw new Error('Sign-in was not completed. Additional steps may be required.');
    }
    const session = await fetchAuthSession({ forceRefresh: false });
    const payload = session.tokens?.idToken?.payload;
    const groups = (payload?.['cognito:groups'] as string[] | undefined) ?? [];
    const user = await getCurrentUser();
    return {
      username: user.username,
      userId: user.userId,
      groups,
    };
  }, []);

  const signOutUser = useCallback(async (): Promise<void> => {
    await signOut();
  }, []);

  const getUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const user = await getCurrentUser();
      const session = await fetchAuthSession({ forceRefresh: false });
      const payload = session.tokens?.idToken?.payload;
      const groups = (payload?.['cognito:groups'] as string[] | undefined) ?? [];
      return {
        username: user.username,
        userId: user.userId,
        groups,
      };
    } catch {
      return null;
    }
  }, []);

  const getSession = useCallback(async (): Promise<AuthTokens | null> => {
    try {
      const session = await fetchAuthSession({ forceRefresh: false });
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      if (!accessToken || !idToken) return null;
      return { accessToken, idToken };
    } catch {
      return null;
    }
  }, []);

  const refreshSession = useCallback(async (): Promise<AuthTokens | null> => {
    try {
      const session = await fetchAuthSession({ forceRefresh: true });
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      if (!accessToken || !idToken) return null;
      return { accessToken, idToken };
    } catch {
      return null;
    }
  }, []);

  return { signInUser, signOutUser, getUser, getSession, refreshSession };
}
