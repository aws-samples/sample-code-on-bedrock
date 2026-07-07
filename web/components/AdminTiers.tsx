'use client';
import { useEffect, useState, FormEvent } from 'react';
import { apiFetch, apiPost, apiPut, apiDelete } from '@/lib/api';
import { ModelMultiSelect, ModelOption } from '@/components/ModelMultiSelect';

interface Tier {
  tierId: string;
  dailyUsd: number;
  monthlyUsd: number;
  allowedModels?: string[];
}

interface ModelRate {
  modelId: string;
  displayName?: string;
}

export function AdminTiers({ token }: { token: string }) {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [newId, setNewId] = useState('');
  const [newDaily, setNewDaily] = useState('');
  const [newMonthly, setNewMonthly] = useState('');
  const [newModels, setNewModels] = useState<string[]>([]);

  const [editId, setEditId] = useState<string | null>(null);
  const [editDaily, setEditDaily] = useState('');
  const [editMonthly, setEditMonthly] = useState('');
  const [editModels, setEditModels] = useState<string[]>([]);

  useEffect(() => { loadTiers(); loadModels(); }, [token]);

  function loadTiers() {
    apiFetch<{ tiers: Tier[] }>('/admin/tiers', token)
      .then((d) => setTiers(d.tiers))
      .catch((e) => setError(e.message));
  }

  function loadModels() {
    apiFetch<{ rates: ModelRate[] }>('/admin/model-rates', token)
      .then((d) => setModels((d.rates ?? []).map((r) => ({ modelId: r.modelId, displayName: r.displayName }))))
      .catch(() => { /* non-fatal: selector just shows existing selections */ });
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      await apiPost('/admin/tiers', token, {
        tierId: newId,
        dailyUsd: parseFloat(newDaily),
        monthlyUsd: parseFloat(newMonthly),
        allowedModels: newModels,
      });
      setMessage(`Tier "${newId}" created`);
      setNewId(''); setNewDaily(''); setNewMonthly(''); setNewModels([]);
      loadTiers();
    } catch (err) {
      setMessage(`Failed: ${(err as Error).message}`);
    }
  }

  async function handleUpdate(tierId: string) {
    setMessage(null);
    const body: Record<string, number | string[]> = {};
    if (editDaily) body.dailyUsd = parseFloat(editDaily);
    if (editMonthly) body.monthlyUsd = parseFloat(editMonthly);
    // Always send allowedModels so the admin can also clear it (empty array).
    body.allowedModels = editModels;
    try {
      await apiPut(`/admin/tiers/${tierId}`, token, body);
      setMessage(`Tier "${tierId}" updated`);
      setEditId(null); setEditDaily(''); setEditMonthly(''); setEditModels([]);
      loadTiers();
    } catch (err) {
      setMessage(`Failed: ${(err as Error).message}`);
    }
  }

  async function handleDelete(tierId: string) {
    setMessage(null);
    try {
      await apiDelete(`/admin/tiers/${tierId}`, token);
      setMessage(`Tier "${tierId}" deleted`);
      loadTiers();
    } catch (err) {
      setMessage(`Failed: ${(err as Error).message}`);
    }
  }

  if (error) return <p className="error" role="alert">Failed to load tiers: {error}</p>;

  return (
    <div className="card">
      <h2>Tiers</h2>
      {message && <p className="message" role="status">{message}</p>}

      <h3>Create Tier</h3>
      <form onSubmit={handleCreate}>
        <div className="form-row">
          <label>Tier ID <input type="text" value={newId} onChange={(e) => setNewId(e.target.value)} required /></label>
          <label>Daily USD <input type="number" step="0.01" value={newDaily} onChange={(e) => setNewDaily(e.target.value)} required /></label>
          <label>Monthly USD <input type="number" step="0.01" value={newMonthly} onChange={(e) => setNewMonthly(e.target.value)} required /></label>
          <button className="btn-primary" type="submit">Create</button>
        </div>
        <div className="form-row">
          <ModelMultiSelect
            label="Allowed models (leave empty for all models)"
            ariaLabel="Allowed models"
            available={models}
            selected={newModels}
            onChange={setNewModels}
          />
        </div>
      </form>

      <h3>Tier List</h3>
      <table>
        <thead>
          <tr><th>Tier ID</th><th>Daily USD</th><th>Monthly USD</th><th>Allowed Models</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.tierId}>
              <td>{t.tierId}</td>
              <td>{`$${t.dailyUsd.toFixed(2)}`}</td>
              <td>{`$${t.monthlyUsd.toFixed(2)}`}</td>
              <td>{t.allowedModels && t.allowedModels.length > 0 ? t.allowedModels.join(', ') : 'All models'}</td>
              <td>
                <button onClick={() => { setEditId(editId === t.tierId ? null : t.tierId); setEditDaily(String(t.dailyUsd)); setEditMonthly(String(t.monthlyUsd)); setEditModels(t.allowedModels ?? []); }}>Edit</button>{' '}
                <button onClick={() => handleDelete(t.tierId)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editId && (
        <div style={{ marginTop: '1rem' }}>
          <h3>Edit Tier: {editId}</h3>
          <div className="form-row">
            <label>Daily USD <input type="number" step="0.01" value={editDaily} onChange={(e) => setEditDaily(e.target.value)} /></label>
            <label>Monthly USD <input type="number" step="0.01" value={editMonthly} onChange={(e) => setEditMonthly(e.target.value)} /></label>
          </div>
          <div className="form-row">
            <ModelMultiSelect
              label="Allowed models (leave empty for all models)"
              ariaLabel="Edit allowed models"
              available={models}
              selected={editModels}
              onChange={setEditModels}
            />
          </div>
          <div className="form-row">
            <button className="btn-primary" onClick={() => handleUpdate(editId)}>Save</button>
            <button onClick={() => setEditId(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
