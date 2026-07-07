'use client';
import { useEffect, useState, FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch, apiPost, apiDelete } from '@/lib/api';
import { AdminUserEdit } from '@/components/AdminUserEdit';

interface UserEntry {
  sub: string;
  email: string;
  tier: string;
  createdAt: string;
  blocked: boolean;
  dailyUsd: number;
  monthlyUsd: number;
  allowedModels?: string[];
}

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

export function AdminUsers({ token }: { token: string }) {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [models, setModels] = useState<{ modelId: string; displayName?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState('');

  const [newEmail, setNewEmail] = useState('');
  const [newTier, setNewTier] = useState('');
  const [creating, setCreating] = useState(false);

  const [editSub, setEditSub] = useState<string | null>(null);

  const [message, setMessage] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<{ sub: string; email: string } | null>(null);

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin, token, tierFilter]);

  useEffect(() => {
    if (isAdmin) loadTiers();
  }, [isAdmin, token]);

  useEffect(() => {
    if (isAdmin) loadModels();
  }, [isAdmin, token]);

  function loadUsers() {
    const query = tierFilter ? `?tier=${tierFilter}` : '';
    apiFetch<{ users: UserEntry[] }>(`/admin/users${query}`, token)
      .then((d) => setUsers(d?.users ?? []))
      .catch((e) => setError(e.message));
  }

  function loadTiers() {
    apiFetch<{ tiers: Tier[] }>('/admin/tiers', token)
      .then((d) => {
        const list = d?.tiers ?? [];
        setTiers(list);
        setNewTier((current) => current || list[0]?.tierId || '');
      })
      .catch((e) => setError(e.message));
  }

  function loadModels() {
    apiFetch<{ rates: ModelRate[] }>('/admin/model-rates', token)
      .then((d) => setModels((d?.rates ?? []).map((r) => ({ modelId: r.modelId, displayName: r.displayName }))))
      .catch(() => { /* non-fatal: selector still shows existing selections */ });
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setMessage(null);
    try {
      await apiPost('/admin/users', token, { email: newEmail, tier: newTier });
      setMessage(`User ${newEmail} created`);
      setNewEmail('');
      loadUsers();
    } catch (err) {
      setMessage(`Failed to create user: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleUserSaved(msg: string) {
    setMessage(msg);
    setEditSub(null);
    loadUsers();
  }

  async function handleToggleBlock(sub: string, currentlyBlocked: boolean) {
    setMessage(null);
    const action = currentlyBlocked ? 'unblock' : 'block';
    try {
      await apiPost(`/admin/users/${sub}/${action}`, token, {});
      setMessage(`User ${sub} ${currentlyBlocked ? 'unblocked' : 'blocked'}`);
      loadUsers();
    } catch (err) {
      setMessage(`Failed to ${action}: ${(err as Error).message}`);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    setMessage(null);
    try {
      await apiDelete(`/admin/users/${confirmDelete.sub}`, token);
      setMessage(`User ${confirmDelete.email} deleted`);
      setConfirmDelete(null);
      loadUsers();
    } catch (err) {
      setMessage(`Failed to delete: ${(err as Error).message}`);
      setConfirmDelete(null);
    }
  }

  if (!isAdmin) return null;
  if (error) return <p className="error" role="alert">Failed to load users: {error}</p>;

  return (
    <div className="card">
      <h2>Users</h2>

      {message && <p className="message" role="status">{message}</p>}

      <h3>Create User</h3>
      <form onSubmit={handleCreate}>
        <div className="form-row">
          <label>Email <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required /></label>
          <label>Tier
            <select value={newTier} onChange={(e) => setNewTier(e.target.value)} required>
              {tiers.length === 0 && <option value="" disabled>No tiers available</option>}
              {tiers.map((t) => (
                <option key={t.tierId} value={t.tierId}>{t.tierId}</option>
              ))}
            </select>
          </label>
          <button className="btn-primary" type="submit" disabled={creating || tiers.length === 0}>{creating ? 'Creating...' : 'Create'}</button>
        </div>
      </form>

      <h3>User List</h3>
      <div className="form-row">
        <label>Filter by tier
          <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
            <option value="">All</option>
            {tiers.map((t) => (
              <option key={t.tierId} value={t.tierId}>{t.tierId}</option>
            ))}
          </select>
        </label>
      </div>
      <table>
        <thead>
          <tr><th>Email</th><th>Tier</th><th>Created</th><th>Daily Limit</th><th>Monthly Limit</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.sub}>
              <td>{u.email}</td>
              <td>{u.tier ? u.tier : 'Manual'}</td>
              <td>{u.createdAt?.slice(0, 10)}</td>
              <td>{`$${(u.dailyUsd ?? 0).toFixed(2)}`}</td>
              <td>{`$${(u.monthlyUsd ?? 0).toFixed(2)}`}</td>
              <td><span className={u.blocked ? 'status-blocked' : 'status-active'}>{u.blocked ? 'Blocked' : 'Active'}</span></td>
              <td>
                <button onClick={() => handleToggleBlock(u.sub, !!u.blocked)}>{u.blocked ? 'Unblock' : 'Block'}</button>{' '}
                <button onClick={() => setEditSub(editSub === u.sub ? null : u.sub)}>Edit</button>{' '}
                <button className="btn-danger" onClick={() => setConfirmDelete({ sub: u.sub, email: u.email })}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editSub && (() => {
        const editUser = users.find((u) => u.sub === editSub);
        if (!editUser) return null;
        return (
          <AdminUserEdit
            token={token}
            user={editUser}
            tiers={tiers}
            availableModels={models}
            onSaved={handleUserSaved}
            onCancel={() => setEditSub(null)}
          />
        );
      })()}

      {confirmDelete && (
        <div className="modal-overlay" role="dialog" aria-labelledby="confirm-delete-title" aria-modal="true">
          <div className="modal">
            <h3 id="confirm-delete-title">Confirm Delete</h3>
            <p>Are you sure you want to permanently delete user <strong>{confirmDelete.email}</strong>? This will remove their Cognito account, IAM role, and all associated data. This action cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn-danger" onClick={handleDelete}>Delete</button>
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
