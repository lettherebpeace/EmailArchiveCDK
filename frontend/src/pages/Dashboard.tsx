import { useState, useEffect, useCallback } from 'react';
import type { FC } from 'react';

/**
 * Dashboard metrics interface.
 * In production, these would come from a backend endpoint that queries CloudWatch.
 * For now, the page provides a display framework with mock data fallback.
 */
interface DashboardMetrics {
  ingestionRate: number;        // emails/minute
  ingestionFailures: number;    // count in last hour
  storageUtilization: number;   // percentage (0-100)
  storageTotalBytes: number;    // total bytes stored
  searchLatencyP50: number;     // ms
  searchLatencyP95: number;     // ms
  searchLatencyP99: number;     // ms
  dlqDepth: number;             // number of messages in DLQ
  activeErrors: number;         // errors in last hour
}

const MOCK_METRICS: DashboardMetrics = {
  ingestionRate: 12.4,
  ingestionFailures: 0,
  storageUtilization: 34.2,
  storageTotalBytes: 524_288_000_000, // ~524 GB
  searchLatencyP50: 1200,
  searchLatencyP95: 3400,
  searchLatencyP99: 8100,
  dlqDepth: 0,
  activeErrors: 0,
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(1)} ${units[exponent]}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  status?: 'normal' | 'warning' | 'critical';
}

const MetricCard: FC<MetricCardProps> = ({ title, value, subtitle, status = 'normal' }) => {
  const borderColor =
    status === 'critical' ? '#d32f2f' : status === 'warning' ? '#f57c00' : '#e0e0e0';
  const bgColor =
    status === 'critical' ? '#fdecea' : status === 'warning' ? '#fff3e0' : '#fafafa';

  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        borderRadius: '8px',
        padding: '20px',
        backgroundColor: bgColor,
      }}
    >
      <p style={{ margin: '0 0 8px', fontSize: '14px', color: '#666' }}>{title}</p>
      <p style={{ margin: 0, fontSize: '28px', fontWeight: 'bold' }}>{value}</p>
      {subtitle && (
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>{subtitle}</p>
      )}
    </div>
  );
};

const Dashboard: FC = () => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // In production, this would call: const data = await api.get('/admin/metrics');
      // For now, we use mock data to demonstrate the dashboard layout.
      // The actual CloudWatch integration is handled backend-side.
      await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate network delay
      setMetrics(MOCK_METRICS);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to load dashboard metrics.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const getStorageStatus = (utilization: number): 'normal' | 'warning' | 'critical' => {
    if (utilization >= 100) return 'critical';
    if (utilization >= 80) return 'warning';
    return 'normal';
  };

  const getDlqStatus = (depth: number): 'normal' | 'warning' | 'critical' => {
    if (depth > 10) return 'critical';
    if (depth > 0) return 'warning';
    return 'normal';
  };

  const getErrorStatus = (count: number): 'normal' | 'warning' | 'critical' => {
    if (count > 5) return 'critical';
    if (count > 0) return 'warning';
    return 'normal';
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ margin: 0 }}>System Dashboard</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {lastUpdated && (
            <span style={{ fontSize: '12px', color: '#888' }}>
              Last updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={fetchMetrics}
            disabled={loading}
            style={{ padding: '8px 16px', cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" style={{ padding: '12px', marginBottom: '16px', backgroundColor: '#fdecea', borderRadius: '4px', color: '#611a15' }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !metrics && <p>Loading metrics...</p>}

      {/* Metrics Grid */}
      {metrics && (
        <>
          {/* Ingestion Section */}
          <h2 style={{ fontSize: '18px', marginBottom: '12px', color: '#333' }}>Ingestion</h2>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '32px' }}
            aria-label="Ingestion metrics"
          >
            <MetricCard
              title="Ingestion Rate"
              value={`${metrics.ingestionRate.toFixed(1)}/min`}
              subtitle="Emails processed per minute"
            />
            <MetricCard
              title="Ingestion Failures"
              value={String(metrics.ingestionFailures)}
              subtitle="Failures in last hour"
              status={getErrorStatus(metrics.ingestionFailures)}
            />
            <MetricCard
              title="DLQ Depth"
              value={String(metrics.dlqDepth)}
              subtitle="Messages in dead-letter queue"
              status={getDlqStatus(metrics.dlqDepth)}
            />
          </div>

          {/* Storage Section */}
          <h2 style={{ fontSize: '18px', marginBottom: '12px', color: '#333' }}>Storage</h2>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '32px' }}
            aria-label="Storage metrics"
          >
            <MetricCard
              title="Storage Utilization"
              value={`${metrics.storageUtilization.toFixed(1)}%`}
              subtitle={formatBytes(metrics.storageTotalBytes)}
              status={getStorageStatus(metrics.storageUtilization)}
            />
            <MetricCard
              title="Active Errors"
              value={String(metrics.activeErrors)}
              subtitle="System errors in last hour"
              status={getErrorStatus(metrics.activeErrors)}
            />
          </div>

          {/* Search Performance Section */}
          <h2 style={{ fontSize: '18px', marginBottom: '12px', color: '#333' }}>Search Performance</h2>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '32px' }}
            aria-label="Search performance metrics"
          >
            <MetricCard
              title="Latency (p50)"
              value={formatMs(metrics.searchLatencyP50)}
              subtitle="Median query time"
            />
            <MetricCard
              title="Latency (p95)"
              value={formatMs(metrics.searchLatencyP95)}
              subtitle="95th percentile"
              status={metrics.searchLatencyP95 > 30000 ? 'critical' : 'normal'}
            />
            <MetricCard
              title="Latency (p99)"
              value={formatMs(metrics.searchLatencyP99)}
              subtitle="99th percentile"
              status={metrics.searchLatencyP99 > 30000 ? 'critical' : 'normal'}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default Dashboard;
