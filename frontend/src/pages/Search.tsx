import { useState, useCallback, useEffect, useRef } from 'react';
import type { FC, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchEmails, createExport, getExportStatus } from '../services/api';
import type { SearchQuery, SearchResult, SearchResultItem } from '../types';

const PAGE_SIZE = 25;

const Search: FC = () => {
  const navigate = useNavigate();

  // Form inputs
  const [sender, setSender] = useState('');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // State
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportDownloadUrl, setExportDownloadUrl] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const exportPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (exportPollRef.current) clearInterval(exportPollRef.current);
    };
  }, []);

  const buildQuery = useCallback(
    (page: number): SearchQuery => {
      const query: SearchQuery = {
        page,
        pageSize: PAGE_SIZE,
        sortField: 'date',
        sortOrder: 'desc',
      };
      if (sender.trim()) query.sender = sender.trim();
      if (recipient.trim()) query.recipient = recipient.trim();
      if (subject.trim()) query.subjectContains = subject.trim();
      if (dateFrom) query.dateFrom = dateFrom;
      if (dateTo) query.dateTo = dateTo;
      return query;
    },
    [sender, recipient, subject, dateFrom, dateTo]
  );

  const hasAtLeastOneFilter = (): boolean => {
    return !!(
      sender.trim() ||
      recipient.trim() ||
      subject.trim() ||
      dateFrom ||
      dateTo
    );
  };

  const executeSearch = useCallback(
    async (page: number) => {
      setLoading(true);
      setError(null);
      setExportMessage(null);

      try {
        const query = buildQuery(page);
        const result = await searchEmails(query);
        setResults(result);
        setCurrentPage(page);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Search could not be completed. Please try again.';
        setError(message);
        // Preserve query inputs on error (inputs remain in state)
      } finally {
        setLoading(false);
      }
    },
    [buildQuery]
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!hasAtLeastOneFilter()) {
      setValidationError('At least one search filter must be provided.');
      return;
    }

    executeSearch(1);
  };

  const handlePrevious = () => {
    if (currentPage > 1) {
      executeSearch(currentPage - 1);
    }
  };

  const handleNext = () => {
    if (results && currentPage < results.totalPages) {
      executeSearch(currentPage + 1);
    }
  };

  const handleExport = async () => {
    if (!hasAtLeastOneFilter()) return;

    setExportMessage(null);
    setExportDownloadUrl(null);
    if (exportPollRef.current) clearInterval(exportPollRef.current);

    try {
      const query = buildQuery(1);
      delete query.page;
      delete query.pageSize;
      const exportJob = await createExport(query);
      setExportMessage(`Export in progress (ID: ${exportJob.exportId})...`);

      // Poll for completion every 3 seconds
      exportPollRef.current = setInterval(async () => {
        try {
          const status = await getExportStatus(exportJob.exportId);
          if (status.status === 'COMPLETED' && status.presignedUrl) {
            setExportMessage(`Export ready! ${status.fileCount} email(s) packaged.`);
            setExportDownloadUrl(status.presignedUrl);
            if (exportPollRef.current) clearInterval(exportPollRef.current);
          } else if (status.status === 'FAILED') {
            setExportMessage(`Export failed: ${status.errorMessage || 'Unknown error'}`);
            if (exportPollRef.current) clearInterval(exportPollRef.current);
          }
        } catch {
          // Keep polling on transient errors
        }
      }, 3000);

      // Stop polling after 5 minutes
      setTimeout(() => {
        if (exportPollRef.current) {
          clearInterval(exportPollRef.current);
          if (!exportDownloadUrl) {
            setExportMessage((prev) => prev?.includes('progress') ? 'Export timed out. Please try again.' : prev || null);
          }
        }
      }, 300000);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to create export. Please try again.';
      setExportMessage(`Export failed: ${message}`);
    }
  };

  const handleRowClick = (emailId: string) => {
    navigate(`/emails/${emailId}`);
  };

  const formatDate = (dateStr: string): string => {
    try {
      // Athena returns dates as "2026-06-27 05:54:35.000" (space-separated)
      // Convert to ISO format by replacing the space with 'T' and adding 'Z'
      const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
      const date = new Date(normalized);
      if (isNaN(date.getTime())) return dateStr;
      return date.toLocaleString();
    } catch {
      return dateStr;
    }
  };

  const formatRecipients = (recipients: string[]): string => {
    if (recipients.length === 0) return '—';
    if (recipients.length <= 2) return recipients.join(', ');
    return `${recipients[0]}, ${recipients[1]} +${recipients.length - 2} more`;
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
      <h1>Search Emails</h1>

      {/* Search Form */}
      <form onSubmit={handleSubmit} aria-label="Email search form">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
          <div>
            <label htmlFor="sender">Sender</label>
            <input
              id="sender"
              type="text"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              placeholder="sender@example.com"
              style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label htmlFor="recipient">Recipient</label>
            <input
              id="recipient"
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="recipient@example.com"
              style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label htmlFor="subject">Subject</label>
            <input
              id="subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Search in subject..."
              style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div>
              <label htmlFor="dateFrom">Date From</label>
              <input
                id="dateFrom"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label htmlFor="dateTo">Date To</label>
              <input
                id="dateTo"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                style={{ width: '100%', padding: '8px', marginTop: '4px', boxSizing: 'border-box' }}
              />
            </div>
          </div>
        </div>

        {validationError && (
          <p role="alert" style={{ color: '#d32f2f', marginBottom: '12px' }}>
            {validationError}
          </p>
        )}

        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
          <button type="submit" disabled={loading} style={{ padding: '10px 24px', cursor: 'pointer' }}>
            {loading ? 'Searching...' : 'Search'}
          </button>
          {results && results.totalCount > 0 && (
            <button
              type="button"
              onClick={handleExport}
              style={{ padding: '10px 24px', cursor: 'pointer' }}
            >
              Export
            </button>
          )}
        </div>
      </form>

      {/* Export Message */}
      {exportMessage && (
        <div role="status" style={{ padding: '12px', marginBottom: '16px', backgroundColor: '#e3f2fd', borderRadius: '4px' }}>
          {exportMessage}
          {exportDownloadUrl && (
            <a
              href={exportDownloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block', marginTop: '8px', padding: '8px 16px', backgroundColor: '#1976d2', color: '#fff', textDecoration: 'none', borderRadius: '4px' }}
            >
              Download ZIP
            </a>
          )}
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div role="alert" style={{ padding: '12px', marginBottom: '16px', backgroundColor: '#fdecea', borderRadius: '4px', color: '#611a15' }}>
          {error}
        </div>
      )}

      {/* Results */}
      {results && results.totalCount === 0 && (
        <div role="status" style={{ padding: '24px', textAlign: 'center', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
          <p style={{ margin: 0, fontSize: '16px' }}>No results found.</p>
          <p style={{ margin: '8px 0 0', color: '#666' }}>
            Try modifying your search criteria — adjust the date range, check spelling, or use fewer filters.
          </p>
        </div>
      )}

      {results && results.totalCount > 0 && (
        <>
          <p style={{ marginBottom: '8px', color: '#555' }}>
            Showing page {results.page} of {results.totalPages} ({results.totalCount} total results)
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Search results">
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                  <th style={{ padding: '12px 8px' }}>Date</th>
                  <th style={{ padding: '12px 8px' }}>From</th>
                  <th style={{ padding: '12px 8px' }}>To</th>
                  <th style={{ padding: '12px 8px' }}>Subject</th>
                  <th style={{ padding: '12px 8px', textAlign: 'center' }}>Attachments</th>
                </tr>
              </thead>
              <tbody>
                {results.results.map((item: SearchResultItem) => (
                  <tr
                    key={item.emailId}
                    onClick={() => handleRowClick(item.emailId)}
                    style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
                    tabIndex={0}
                    role="link"
                    aria-label={`View email from ${item.sender}: ${item.subject}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleRowClick(item.emailId);
                      }
                    }}
                  >
                    <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>
                      {formatDate(item.date)}
                    </td>
                    <td style={{ padding: '10px 8px' }}>{item.sender}</td>
                    <td style={{ padding: '10px 8px' }}>{formatRecipients(item.recipients)}</td>
                    <td style={{ padding: '10px 8px' }}>{item.subject}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                      {item.hasAttachments ? '📎' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div
            style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '16px', marginTop: '16px' }}
            aria-label="Pagination"
          >
            <button
              type="button"
              onClick={handlePrevious}
              disabled={currentPage <= 1 || loading}
              style={{ padding: '8px 16px', cursor: currentPage <= 1 ? 'not-allowed' : 'pointer' }}
            >
              Previous
            </button>
            <span>
              Page {currentPage} of {results.totalPages}
            </span>
            <button
              type="button"
              onClick={handleNext}
              disabled={currentPage >= results.totalPages || loading}
              style={{ padding: '8px 16px', cursor: currentPage >= results.totalPages ? 'not-allowed' : 'pointer' }}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default Search;
