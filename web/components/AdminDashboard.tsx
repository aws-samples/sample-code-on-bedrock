'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';

interface TierBreakdown {
  tier: string;
  totalCostUsd: number;
  userCount: number;
}

interface TopUser {
  sub: string;
  costUsd: number;
}

interface DashboardData {
  totalMonthCostUsd: number;
  byTier: TierBreakdown[];
  topUsers: TopUser[];
  activeUsers: number;
  blockedUsers: number;
}

export function AdminDashboard({ token }: { token: string }) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin) {
      apiFetch<DashboardData>('/admin/dashboard', token)
        .then(setData)
        .catch((e) => setError(e.message));
    }
  }, [isAdmin, token]);

  if (!isAdmin) return null;
  if (error) return <p className="error" role="alert">Failed to load dashboard: {error}</p>;
  if (!data) return <p>Loading dashboard...</p>;

  return (
    <div className="card">
      <h2>Admin Dashboard</h2>
      <div className="summary-cards">
        <div className="summary-card">
          <span className="label">Total Spend</span>
          <span className="value">{`$${data.totalMonthCostUsd.toFixed(2)}`}</span>
        </div>
        <div className="summary-card">
          <span className="label">Active Users</span>
          <span className="value">{data.activeUsers}</span>
        </div>
        <div className="summary-card">
          <span className="label">Blocked Users</span>
          <span className="value">{data.blockedUsers}</span>
        </div>
      </div>

      <h3>Spend by Tier</h3>
      <table>
        <thead>
          <tr><th>Tier</th><th>Cost (USD)</th><th>Users</th></tr>
        </thead>
        <tbody>
          {data.byTier.map((t) => (
            <tr key={t.tier}>
              <td>{t.tier}</td>
              <td>{`$${t.totalCostUsd.toFixed(2)}`}</td>
              <td>{t.userCount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Top Spenders</h3>
      <ol>
        {data.topUsers.map((u) => (
          <li key={u.sub}>{`${u.sub} — $${u.costUsd.toFixed(2)}`}</li>
        ))}
      </ol>
    </div>
  );
}
