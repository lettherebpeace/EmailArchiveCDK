import { useState, useEffect, useCallback } from 'react';
import type { FC, FormEvent } from 'react';
import {
  listRetentionPolicies,
  createRetentionPolicy,
  updateRetentionPolicy,
} from '../services/api';
import type { RetentionPolicy, RetentionPolicyInput } from '../types';

const MIN_DURATION_DAYS = 1;
const MAX_DURATION_DAYS = 36500;

interface PolicyFormState {
  name: string;
  durationDays: string;
  isIndefinite: boolean;
}

const emptyForm: PolicyFormState = {
  name: '',
  durationDays: '',
  isIndefinite: false,
};

const RetentionPolicies: FC = () => {
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<RetentionPolicy | null>(null);
  const [form, setForm] = useState<PolicyFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRetentionPolicies();
      setPolicies(data);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to load retention policies.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const openCreateModal = () => {
    setEditingPolicy(null);
    setForm(emptyForm);
    setFormError(null);
    setShowModal(true);
  };

  const openEditModal = (policy: RetentionPolicy) => {
    setEditingPolicy(policy);
    setForm({
      name: policy.name,
      durationDays: policy.isIndefinite ? '' : String(policy.durationDays),
      isIndefinite: policy.isIndefinite,
    });
    setFormError(null);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingPolicy(null);
    setForm(emptyForm);
    setFormError(null);
  };

  const validateForm = (): RetentionPolicyInput | null => {
    if (!form.name.trim()) {
      setFormError('Policy name is required.');
      return null;
    }

    if (form.isIndefinite) {
      return {
        name: form.name.trim(),
        durationDays: -1,
        isIndefinite: true,
      };
    }

    const duration = Number(form.durationDays);
    if (!form.durationDays || isNaN(duration) || !Number.isInteger(duration)) {
      setFormError('Duration must be a whole number of days.');
      return null;
    }

    if (duration < MIN_DURATION_DAYS || duration > MAX_DURATION_DAYS) {
      setFormError(
        `Duration must be between ${MIN_DURATION_DAYS} and ${MAX_DURATION_DAYS} days.`
      );
      return null;
    }

    return {
      name: form.name.trim(),
      durationDays: duration,
      isIndefinite: false,
    };
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const input = validateForm();
    if (!input) return;

    setSaving(true);
    try {
      if (editingPolicy) {
        await updateRetentionPolicy(editingPolicy.policyId, input);
      } else {
        await createRetentionPolicy(input);
      }
      closeModal();
      await fetchPolicies();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to save retention policy.';
      setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (dateStr: string): string => {
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  const formatDuration = (policy: RetentionPolicy): string => {
    if (policy.isIndefinite) return 'Indefinite';
    if (policy.durationDays === 1) return '1 day';
    return `${policy.durationDays} days`;
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ margin: 0 }}>Retention Policies</h1>
        <button
          type="button"
          onClick={openCreateModal}
          style={{ padding: '10px 24px', cursor: 'pointer' }}
        >
          Create Policy
        </button>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" style={{ padding: '12px', marginBottom: '16px', backgroundColor: '#fdecea', borderRadius: '4px', color: '#611a15' }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && <p>Loading policies...</p>}

      {/* Empty State */}
      {!loading && !error && policies.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
          <p style={{ margin: 0 }}>No retention policies configured yet.</p>
          <p style={{ margin: '8px 0 0', color: '#666' }}>
            Create a policy to define how long archived emails are retained.
          </p>
        </div>
      )}

      {/* Policies Table */}
      {!loading && policies.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Retention policies">
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                <th style={{ padding: '12px 8px' }}>Name</th>
                <th style={{ padding: '12px 8px' }}>Duration</th>
                <th style={{ padding: '12px 8px' }}>Created</th>
                <th style={{ padding: '12px 8px' }}>Updated</th>
                <th style={{ padding: '12px 8px', textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.policyId} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '10px 8px' }}>{policy.name}</td>
                  <td style={{ padding: '10px 8px' }}>{formatDuration(policy)}</td>
                  <td style={{ padding: '10px 8px' }}>{formatDate(policy.createdAt)}</td>
                  <td style={{ padding: '10px 8px' }}>{formatDate(policy.updatedAt)}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                    <button
                      type="button"
                      onClick={() => openEditModal(policy)}
                      style={{ padding: '6px 16px', cursor: 'pointer' }}
                      aria-label={`Edit policy ${policy.name}`}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Overlay */}
      {showModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
          onClick={closeModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="policy-modal-title"
        >
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '8px',
              padding: '32px',
              width: '100%',
              maxWidth: '480px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="policy-modal-title" style={{ marginTop: 0, marginBottom: '24px' }}>
              {editingPolicy ? 'Edit Retention Policy' : 'Create Retention Policy'}
            </h2>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '16px' }}>
                <label htmlFor="policy-name" style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>
                  Policy Name
                </label>
                <input
                  id="policy-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g., 7-Year Compliance"
                  style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                  required
                />
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.isIndefinite}
                    onChange={(e) => setForm((f) => ({ ...f, isIndefinite: e.target.checked }))}
                  />
                  Indefinite retention (no expiration)
                </label>
              </div>

              {!form.isIndefinite && (
                <div style={{ marginBottom: '16px' }}>
                  <label htmlFor="policy-duration" style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>
                    Duration (days)
                  </label>
                  <input
                    id="policy-duration"
                    type="number"
                    min={MIN_DURATION_DAYS}
                    max={MAX_DURATION_DAYS}
                    value={form.durationDays}
                    onChange={(e) => setForm((f) => ({ ...f, durationDays: e.target.value }))}
                    placeholder={`${MIN_DURATION_DAYS} - ${MAX_DURATION_DAYS}`}
                    style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                    required
                  />
                  <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#666' }}>
                    Valid range: {MIN_DURATION_DAYS} to {MAX_DURATION_DAYS} days (approximately 100 years).
                  </p>
                </div>
              )}

              {/* Form Error */}
              {formError && (
                <p role="alert" style={{ color: '#d32f2f', marginBottom: '12px' }}>
                  {formError}
                </p>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '24px' }}>
                <button
                  type="button"
                  onClick={closeModal}
                  style={{ padding: '10px 24px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  style={{ padding: '10px 24px', cursor: saving ? 'not-allowed' : 'pointer' }}
                >
                  {saving ? 'Saving...' : editingPolicy ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default RetentionPolicies;
