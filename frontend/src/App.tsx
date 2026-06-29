import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login, Search, EmailDetail, RetentionPolicies, Dashboard } from './pages';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <Search />
              </ProtectedRoute>
            }
          />
          <Route
            path="/emails/:emailId"
            element={
              <ProtectedRoute>
                <EmailDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/retention-policies"
            element={
              <ProtectedRoute requiredGroups={['Administrator']}>
                <RetentionPolicies />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/dashboard"
            element={
              <ProtectedRoute requiredGroups={['Administrator']}>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/search" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
