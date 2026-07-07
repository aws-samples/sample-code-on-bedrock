'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { UsageChart } from './UsageChart';

interface UserUsage {
  sub: string;
  email: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface HistoryDay {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

export function UsageOverview({ token }: { token: string }) {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<UserUsage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [history, setHistory] = useState<HistoryDay[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin) {
      apiFetch<{ users: UserUsage[] }>('/admin/usage', token)
        .then((d) => setUsers(d.users))
        .catch((e) => setError(e.message));
    }
  }, [isAdmin, token]);

  useEffect(() => {
    if (selectedSub) {
      apiFetch<{ days: HistoryDay[] }>(`/admin/usage/history?sub=${selectedSub}&from=${from}&to=${to}`, token)
        .then((d) => { setHistory(d.days); setHistoryError(null); })
        .catch((e) => setHistoryError(e.message));
    }
  }, [selectedSub, from, to, token]);

  if (!isAdmin) return null;
  if (error) return <p className="error" role="alert">Failed to load usage overview: {error}</p>;

  return (
    <div className="card">
      <h2>Usage Overview</h2>
      <table>
        <thead>
          <tr><th>Email</th><th>Cost (USD)</th><th>Input Tokens</th><th>Output Tokens</th><th>History</th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.sub}>
              <td>{u.email}</td>
              <td>{`$${u.costUsd.toFixed(2)}`}</td>
              <td>{u.inputTokens.toLocaleString('en-US')}</td>
              <td>{u.outputTokens.toLocaleString('en-US')}</td>
              <td><button onClick={() => setSelectedSub(u.sub)}>View</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {selectedSub && (
        <div>
          <h3>History for {users.find(u => u.sub === selectedSub)?.email ?? selectedSub}</h3>
          <div className="date-range">
            <label>From: <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To: <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          {historyError && <p className="error" role="alert">Failed to load history: {historyError}</p>}
          <UsageChart data={history} />
          {history.length > 0 ? (
            <table>
              <thead>
                <tr><th>Date</th><th>Cost</th><th>Input Tokens</th><th>Output Tokens</th></tr>
              </thead>
              <tbody>
                {history.map(d => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{`$${d.costUsd.toFixed(2)}`}</td>
                    <td>{d.inputTokens.toLocaleString('en-US')}</td>
                    <td>{d.outputTokens.toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            !historyError && <p>No history data for this range.</p>
          )}
        </div>
      )}
    </div>
  );
}
