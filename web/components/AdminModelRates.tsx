'use client';
import { useEffect, useState, FormEvent } from 'react';
import { apiFetch, apiPost, apiPut, apiDelete } from '@/lib/api';

interface ModelRate {
  modelId: string;
  inputUsdPer1k: number;
  outputUsdPer1k: number;
  displayName?: string;
}

export function AdminModelRates({ token }: { token: string }) {
  const [rates, setRates] = useState<ModelRate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [newModelId, setNewModelId] = useState('');
  const [newInput, setNewInput] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [newDisplay, setNewDisplay] = useState('');

  const [editId, setEditId] = useState<string | null>(null);
  const [editInput, setEditInput] = useState('');
  const [editOutput, setEditOutput] = useState('');
  const [editDisplay, setEditDisplay] = useState('');

  useEffect(() => { loadRates(); }, [token]);

  function loadRates() {
    apiFetch<{ rates: ModelRate[] }>('/admin/model-rates', token)
      .then((d) => setRates(d.rates))
      .catch((e) => setError(e.message));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        modelId: newModelId,
        inputUsdPer1k: parseFloat(newInput),
        outputUsdPer1k: parseFloat(newOutput),
      };
      if (newDisplay) body.displayName = newDisplay;
      await apiPost('/admin/model-rates', token, body);
      setMessage(`Model rate "${newModelId}" created`);
      setNewModelId(''); setNewInput(''); setNewOutput(''); setNewDisplay('');
      loadRates();
    } catch (err) {
      setMessage(`Failed: ${(err as Error).message}`);
    }
  }

  async function handleUpdate(modelId: string) {
    setMessage(null);
    const body: Record<string, unknown> = {};
    if (editInput) body.inputUsdPer1k = parseFloat(editInput);
    if (editOutput) body.outputUsdPer1k = parseFloat(editOutput);
    if (editDisplay !== undefined) body.displayName = editDisplay;
    try {
      await apiPut(`/admin/model-rates/${encodeURIComponent(modelId)}`, token, body);
      setMessage(`Model rate "${modelId}" updated`);
      setEditId(null); setEditInput(''); setEditOutput(''); setEditDisplay('');
      loadRates();
    } catch (err) {
      setMessage(`Failed: ${(err as Error).message}`);
    }
  }

  async function handleDelete(modelId: string) {
    setMessage(null);
    try {
      await apiDelete(`/admin/model-rates/${encodeURIComponent(modelId)}`, token);
      setMessage(`Model rate "${modelId}" deleted`);
      loadRates();
    } catch (err) {
      setMessage(`Failed: ${(err as Error).message}`);
    }
  }

  if (error) return <p className="error" role="alert">Failed to load model rates: {error}</p>;

  return (
    <div className="card">
      <h2>Model Rates</h2>
      {message && <p className="message" role="status">{message}</p>}

      <h3>Add Model Rate</h3>
      <form onSubmit={handleCreate}>
        <div className="form-row">
          <label>Model ID <input type="text" value={newModelId} onChange={(e) => setNewModelId(e.target.value)} required /></label>
          <label>Input $/1k <input type="number" step="0.000001" value={newInput} onChange={(e) => setNewInput(e.target.value)} required /></label>
          <label>Output $/1k <input type="number" step="0.000001" value={newOutput} onChange={(e) => setNewOutput(e.target.value)} required /></label>
          <label>Display Name <input type="text" value={newDisplay} onChange={(e) => setNewDisplay(e.target.value)} /></label>
          <button className="btn-primary" type="submit">Create</button>
        </div>
      </form>

      <h3>Configured Models</h3>
      <table>
        <thead>
          <tr><th>Model ID</th><th>Display Name</th><th>Input $/1k</th><th>Output $/1k</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {rates.map((r) => (
            <tr key={r.modelId}>
              <td>{r.modelId}</td>
              <td>{r.displayName ?? '—'}</td>
              <td>{`$${r.inputUsdPer1k}`}</td>
              <td>{`$${r.outputUsdPer1k}`}</td>
              <td>
                <button onClick={() => { setEditId(editId === r.modelId ? null : r.modelId); setEditInput(String(r.inputUsdPer1k)); setEditOutput(String(r.outputUsdPer1k)); setEditDisplay(r.displayName ?? ''); }}>Edit</button>{' '}
                <button onClick={() => handleDelete(r.modelId!)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editId && (
        <div style={{ marginTop: '1rem' }}>
          <h3>Edit: {editId}</h3>
          <div className="form-row">
            <label>Input $/1k <input type="number" step="0.000001" value={editInput} onChange={(e) => setEditInput(e.target.value)} /></label>
            <label>Output $/1k <input type="number" step="0.000001" value={editOutput} onChange={(e) => setEditOutput(e.target.value)} /></label>
            <label>Display Name <input type="text" value={editDisplay} onChange={(e) => setEditDisplay(e.target.value)} /></label>
            <button className="btn-primary" onClick={() => handleUpdate(editId)}>Save</button>
            <button onClick={() => setEditId(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
