'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

interface LimitsData {
  dailyUsd: number;
  monthlyUsd: number;
  blocked: boolean;
  tier?: string | null;
  allowedModels?: string[];
}

export function MyLimits({ token }: { token: string }) {
  const [data, setData] = useState<LimitsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<LimitsData>('/me/limits', token).then(setData).catch((e) => setError(e.message));
  }, [token]);

  if (error) return <p className="error" role="alert">Failed to load limits: {error}</p>;
  if (!data) return <p>Loading...</p>;

  const allowedModels = data.allowedModels ?? [];

  return (
    <div className="card">
      <h2>My Limits</h2>
      <p>Tier: {data.tier ?? 'None'}</p>
      <p>Daily budget: {`$${data.dailyUsd.toFixed(2)}`}</p>
      <p>Monthly budget: {`$${data.monthlyUsd.toFixed(2)}`}</p>
      <p>Allowed models: {allowedModels.length > 0 ? allowedModels.join(', ') : 'All models'}</p>
      <p>Status: <span className={data.blocked ? 'status-blocked' : 'status-active'}>{data.blocked ? 'Blocked' : 'Active'}</span></p>
    </div>
  );
}
