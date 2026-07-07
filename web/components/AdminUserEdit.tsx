'use client';
import { useState } from 'react';
import { apiPut } from '@/lib/api';
import { ModelMultiSelect, ModelOption } from '@/components/ModelMultiSelect';

export interface EditableUser {
  sub: string;
  email: string;
  tier: string;
  blocked: boolean;
  dailyUsd: number;
  monthlyUsd: number;
  allowedModels?: string[];
}

export interface EditTier {
  tierId: string;
  dailyUsd: number;
  monthlyUsd: number;
  allowedModels?: string[];
}

type Mode = 'tier' | 'manual';

export function AdminUserEdit({
  token,
  user,
  tiers,
  availableModels = [],
  onSaved,
  onCancel,
}: {
  token: string;
  user: EditableUser;
  tiers: EditTier[];
  availableModels?: ModelOption[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  // A user with a non-empty tier is tier-managed; otherwise their limits are manual.
  const [mode, setMode] = useState<Mode>(user.tier ? 'tier' : 'manual');
  const [selectedTier, setSelectedTier] = useState(user.tier || tiers[0]?.tierId || '');
  const [dailyUsd, setDailyUsd] = useState(String(user.dailyUsd ?? ''));
  const [monthlyUsd, setMonthlyUsd] = useState(String(user.monthlyUsd ?? ''));
  const [allowedModels, setAllowedModels] = useState<string[]>(user.allowedModels ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTierObj = tiers.find((t) => t.tierId === selectedTier);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'tier') {
        if (!selectedTier) {
          setError('Select a tier');
          setSaving(false);
          return;
        }
        await apiPut(`/admin/users/${user.sub}/tier`, token, { tier: selectedTier });
        onSaved(`${user.email} set to tier "${selectedTier}"`);
      } else {
        const body: Record<string, number | string[]> = {};
        if (dailyUsd !== '') body.dailyUsd = parseFloat(dailyUsd);
        if (monthlyUsd !== '') body.monthlyUsd = parseFloat(monthlyUsd);
        // Always send allowedModels so the admin can also clear it (empty array).
        body.allowedModels = allowedModels;
        await apiPut(`/admin/users/${user.sub}/limits`, token, body);
        onSaved(`Manual limits set for ${user.email}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '1rem' }} role="region" aria-label="Edit user">
      <h3>Edit User: {user.email}</h3>
      <p>
        Current:{' '}
        {user.tier ? `Tier "${user.tier}"` : 'Manual limits'}
        {` — $${(user.dailyUsd ?? 0).toFixed(2)}/day, $${(user.monthlyUsd ?? 0).toFixed(2)}/month`}
      </p>

      {error && <p className="error" role="alert">{error}</p>}

      <fieldset>
        <legend>Limit source</legend>
        <label>
          <input
            type="radio"
            name="limit-mode"
            value="tier"
            checked={mode === 'tier'}
            onChange={() => setMode('tier')}
          />{' '}
          Tier
        </label>{' '}
        <label>
          <input
            type="radio"
            name="limit-mode"
            value="manual"
            checked={mode === 'manual'}
            onChange={() => setMode('manual')}
          />{' '}
          Manual
        </label>
      </fieldset>

      {mode === 'tier' ? (
        <div className="form-row">
          <label>
            Tier
            <select value={selectedTier} onChange={(e) => setSelectedTier(e.target.value)}>
              {tiers.length === 0 && <option value="" disabled>No tiers available</option>}
              {tiers.map((t) => (
                <option key={t.tierId} value={t.tierId}>
                  {t.tierId} (${t.dailyUsd.toFixed(2)}/day, ${t.monthlyUsd.toFixed(2)}/month)
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            Allowed models:{' '}
            {selectedTierObj && selectedTierObj.allowedModels && selectedTierObj.allowedModels.length > 0
              ? selectedTierObj.allowedModels.join(', ')
              : 'All models'}
          </p>
          <p className="hint">Limits and allowed models will sync to the tier and update automatically when the tier changes.</p>
        </div>
      ) : (
        <div className="form-row">
          <label>
            Daily USD
            <input type="number" step="0.01" value={dailyUsd} onChange={(e) => setDailyUsd(e.target.value)} />
          </label>
          <label>
            Monthly USD
            <input type="number" step="0.01" value={monthlyUsd} onChange={(e) => setMonthlyUsd(e.target.value)} />
          </label>
          <ModelMultiSelect
            label="Allowed models (leave empty for all models)"
            ariaLabel="Allowed models"
            available={availableModels}
            selected={allowedModels}
            onChange={setAllowedModels}
          />
          <p className="hint">Manual limits detach this user from any tier.</p>
        </div>
      )}

      <div className="form-row">
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || (mode === 'tier' && tiers.length === 0)}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}
