import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useAuth, type AuthUser, type AuthTokens } from '../hooks/useAuth';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const TOKEN_REFRESH_INTERVAL_MS = 25 * 60 * 1000; // 25 minutes (refresh before 30-min expiry)

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { signInUser, signOutUser, getUser, getSession, refreshSession } = useAuth();

  // Refs for timers
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tokensRef = useRef<AuthTokens | null>(null);

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const handleIdleTimeout = useCallback(async () => {
    clearTimers();
    setUser(null);
    tokensRef.current = null;
    await signOutUser();
  }, [clearTimers, signOutUser]);

  const resetIdleTimer = useCallback(() => {
    if (!user) return;
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => {
      void handleIdleTimeout();
    }, IDLE_TIMEOUT_MS);
  }, [user, handleIdleTimeout]);

  // Set up idle timeout listeners
  useEffect(() => {
    if (!user) return;

    const events = ['mousemove', 'keypress', 'click', 'scroll', 'touchstart'];
    const handleActivity = () => resetIdleTimer();

    events.forEach((event) => {
      window.addEventListener(event, handleActivity, { passive: true });
    });

    // Start the idle timer initially
    resetIdleTimer();

    return () => {
      events.forEach((event) => {
        window.removeEventListener(event, handleActivity);
      });
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    };
  }, [user, resetIdleTimer]);

  // Set up automatic token refresh
  useEffect(() => {
    if (!user) return;

    refreshTimerRef.current = setInterval(async () => {
      const tokens = await refreshSession();
      if (tokens) {
        tokensRef.current = tokens;
      } else {
        // Token refresh failed — force logout
        await handleIdleTimeout();
      }
    }, TOKEN_REFRESH_INTERVAL_MS);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [user, refreshSession, handleIdleTimeout]);

  // Check for existing session on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const existingUser = await getUser();
        if (existingUser) {
          const tokens = await getSession();
          if (tokens) {
            tokensRef.current = tokens;
            setUser(existingUser);
          }
        }
      } catch {
        // No valid session — user stays unauthenticated
      } finally {
        setIsLoading(false);
      }
    };
    void checkSession();
  }, [getUser, getSession]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    setIsLoading(true);
    try {
      const authUser = await signInUser(email, password);
      const tokens = await getSession();
      tokensRef.current = tokens;
      setUser(authUser);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [signInUser, getSession]);

  const logout = useCallback(async () => {
    clearTimers();
    tokensRef.current = null;
    setUser(null);
    setError(null);
    await signOutUser();
  }, [clearTimers, signOutUser]);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    // Return in-memory token; Amplify handles refresh internally
    if (tokensRef.current?.accessToken) {
      return tokensRef.current.accessToken;
    }
    // Try fetching fresh session
    const tokens = await getSession();
    if (tokens) {
      tokensRef.current = tokens;
      return tokens.accessToken;
    }
    return null;
  }, [getSession]);

  const value: AuthState = {
    user,
    isAuthenticated: user !== null,
    isLoading,
    error,
    login,
    logout,
    getAccessToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthState {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}
