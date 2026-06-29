import { useState, useEffect, useCallback, useRef } from 'react';
import type { FC } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getEmail, getAttachmentUrl } from '../services/api';
import type { EmailDetail as EmailDetailType, AttachmentMeta } from '../types';

const EmailDetail: FC = () => {
  const { emailId } = useParams<{ emailId: string }>();

  const [email, setEmail] = useState<EmailDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingAttachments, setDownloadingAttachments] = useState<Set<string>>(new Set());

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const fetchEmail = useCallback(async () => {
    if (!emailId) return;

    setLoading(true);
    setError(null);

    try {
      const data = await getEmail(emailId);
      setEmail(data);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to load email. Please try again.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [emailId]);

  useEffect(() => {
    fetchEmail();
  }, [fetchEmail]);

  useEffect(() => {
    if (email?.bodyHtml && iframeRef.current) {
      const iframe = iframeRef.current;
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        doc.open();
        doc.write(email.bodyHtml);
        doc.close();

        // Set iframe height once after content loads (no ResizeObserver to avoid flicker)
        const setHeight = () => {
          const height = doc.documentElement?.scrollHeight || doc.body?.scrollHeight || 400;
          iframe.style.height = `${Math.min(height + 20, 2000)}px`;
        };

        // Wait for content to render
        setTimeout(setHeight, 200);
      }
    }
  }, [email?.bodyHtml]);

  const handleDownloadEml = async () => {
    if (!emailId) return;
    try {
      // Use the raw email endpoint — we'll add a /raw path to the API
      const url = await getAttachmentUrl(emailId, '_raw');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to download .eml file');
    }
  };

  const handleDownloadAttachment = async (attachment: AttachmentMeta) => {
    if (!emailId) return;

    setDownloadingAttachments((prev) => new Set(prev).add(attachment.attachmentId));

    try {
      const url = await getAttachmentUrl(emailId, attachment.attachmentId);
      // Open the presigned URL in a new tab/window to trigger download
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to download attachment.';
      alert(message);
    } finally {
      setDownloadingAttachments((prev) => {
        const next = new Set(prev);
        next.delete(attachment.attachmentId);
        return next;
      });
    }
  };

  const formatDate = (dateStr: string): string => {
    try {
      const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
      const date = new Date(normalized);
      if (isNaN(date.getTime())) return dateStr;
      return date.toLocaleString();
    } catch {
      return dateStr;
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  if (loading) {
    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px' }}>
        <p>Loading email...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px' }}>
        <Link to="/search" style={{ display: 'inline-block', marginBottom: '16px' }}>
          ← Back to Search
        </Link>
        <div
          role="alert"
          style={{
            padding: '12px',
            backgroundColor: '#fdecea',
            borderRadius: '4px',
            color: '#611a15',
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  if (!email) {
    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px' }}>
        <Link to="/search" style={{ display: 'inline-block', marginBottom: '16px' }}>
          ← Back to Search
        </Link>
        <p>Email not found.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <Link to="/search">← Back to Search</Link>
        <button
          type="button"
          onClick={handleDownloadEml}
          style={{ padding: '8px 16px', cursor: 'pointer', backgroundColor: '#1976d2', color: '#fff', border: 'none', borderRadius: '4px' }}
          aria-label="Download original email as .eml file"
        >
          Download .eml
        </button>
      </div>

      <h1 style={{ fontSize: '1.5rem', marginBottom: '24px', wordBreak: 'break-word' }}>
        {email.subject || '(No Subject)'}
      </h1>

      {/* Metadata Section */}
      <section aria-label="Email metadata" style={{ marginBottom: '24px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <td style={metadataLabelStyle}>From</td>
              <td style={metadataValueStyle}>{email.sender}</td>
            </tr>
            <tr>
              <td style={metadataLabelStyle}>To</td>
              <td style={metadataValueStyle}>
                {email.recipients.length > 0 ? email.recipients.join(', ') : '—'}
              </td>
            </tr>
            {email.ccRecipients.length > 0 && (
              <tr>
                <td style={metadataLabelStyle}>Cc</td>
                <td style={metadataValueStyle}>{email.ccRecipients.join(', ')}</td>
              </tr>
            )}
            {email.bccRecipients.length > 0 && (
              <tr>
                <td style={metadataLabelStyle}>Bcc</td>
                <td style={metadataValueStyle}>{email.bccRecipients.join(', ')}</td>
              </tr>
            )}
            <tr>
              <td style={metadataLabelStyle}>Date</td>
              <td style={metadataValueStyle}>{formatDate(email.date)}</td>
            </tr>
            <tr>
              <td style={metadataLabelStyle}>Subject</td>
              <td style={metadataValueStyle}>{email.subject || '(No Subject)'}</td>
            </tr>
            <tr>
              <td style={metadataLabelStyle}>Message ID</td>
              <td style={{ ...metadataValueStyle, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {email.messageId}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Attachments Section */}
      {email.attachments.length > 0 && (
        <section aria-label="Attachments" style={{ marginBottom: '24px' }}>
          <h2 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>
            Attachments ({email.attachments.length})
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {email.attachments.map((attachment) => (
              <li
                key={attachment.attachmentId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderBottom: '1px solid #eee',
                }}
              >
                <div>
                  <span style={{ fontWeight: 500 }}>{attachment.fileName}</span>
                  <span style={{ marginLeft: '12px', color: '#666', fontSize: '0.85rem' }}>
                    {attachment.fileType} — {formatFileSize(attachment.sizeBytes)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDownloadAttachment(attachment)}
                  disabled={downloadingAttachments.has(attachment.attachmentId)}
                  style={{ padding: '6px 14px', cursor: 'pointer' }}
                  aria-label={`Download ${attachment.fileName}`}
                >
                  {downloadingAttachments.has(attachment.attachmentId)
                    ? 'Downloading...'
                    : 'Download'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Email Body Section */}
      <section aria-label="Email body" style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>Message Body</h2>
        {email.bodyHtml ? (
          <iframe
            ref={iframeRef}
            title="Email body"
            sandbox="allow-same-origin"
            style={{
              width: '100%',
              minHeight: '300px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              backgroundColor: '#fff',
            }}
          />
        ) : email.bodyText ? (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              padding: '16px',
              backgroundColor: '#f9f9f9',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.9rem',
              lineHeight: '1.5',
              overflow: 'auto',
              maxHeight: '600px',
            }}
          >
            {email.bodyText}
          </pre>
        ) : (
          <p style={{ color: '#666', fontStyle: 'italic' }}>No message body available.</p>
        )}
      </section>
    </div>
  );
};

// Styles for metadata table
const metadataLabelStyle: React.CSSProperties = {
  padding: '8px 12px 8px 0',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
  width: '100px',
  color: '#555',
};

const metadataValueStyle: React.CSSProperties = {
  padding: '8px 0',
  wordBreak: 'break-word',
};

export default EmailDetail;
