import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthContext } from '../context/AuthContext';

interface ProtectedRouteProps {
  children: ReactNode;
  requiredGroups?: string[];
}

/**
 * Route guard that redirects unauthenticated users to /login.
 * Optionally restricts access to users belonging to specific Cognito groups.
 */
export function ProtectedRoute({ children, requiredGroups }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, user } = useAuthContext();
  const location = useLocation();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <p>Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Check group-based access if required
  if (requiredGroups && requiredGroups.length > 0 && user) {
    const hasRequiredGroup = requiredGroups.some((group) =>
      user.groups.includes(group)
    );
    if (!hasRequiredGroup) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <h2>Access Denied</h2>
          <p>You do not have permission to access this page.</p>
        </div>
      );
    }
  }

  return <>{children}</>;
}
